import fs from 'node:fs'
import path from 'node:path'

export const PROVIDERS = {
  openai: {
    publisher: 'openai',
    feedFile: 'openai.json',
    modelsUrl: 'https://api.openai.com/v1/models',
    deprecationsUrl: 'https://developers.openai.com/api/docs/deprecations',
    keyEnv: 'OPENAI_API_KEY',
    headers: {},
  },
  anthropic: {
    publisher: 'anthropic',
    feedFile: 'anthropic.json',
    modelsUrl: 'https://api.anthropic.com/v1/models',
    deprecationsUrl: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
    keyEnv: 'ANTHROPIC_API_KEY',
    headers: {
      'anthropic-version': '2023-06-01',
    },
  },
  google: {
    publisher: 'google',
    feedFile: 'google.json',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    deprecationsUrl: 'https://ai.google.dev/gemini-api/docs/deprecations',
    keyEnv: 'GEMINI_API_KEY',
    keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyHeader: 'x-goog-api-key',
    headers: {},
  },
}

const DATE_PATTERN = /\b((?:19|20)\d{2})[-‐‑‒–\u2014−](\d{1,2})[-‐‑‒–\u2014−](\d{1,2})\b/
const HUMAN_DATE_PATTERN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+((?:19|20)\d{2})\b/i
const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const REPLACEMENT_TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9._-]*(?:\*)?/g

function pad(number) {
  return String(number).padStart(2, '0')
}

export function assertIsoDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year >= 0 && year <= 99) date.setUTCFullYear(year)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new Error(`${label} must be a real calendar date`)
  }
  return value
}

function validDate(year, month, day) {
  const candidate = `${year}-${pad(month)}-${pad(day)}`
  try {
    return assertIsoDate(candidate)
  } catch {
    return undefined
  }
}

function decodeEntities(text) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ndash', '-'], ['mdash', '-'], ['minus', '-'],
  ])
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/gi, (match, name) => named.get(name.toLowerCase()) ?? match)
}

function plainText(fragment) {
  return decodeEntities(String(fragment)
    .replace(/<!--(?:[\s\S]*?)-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[‐‑‒–\u2014−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function dateCandidates(text) {
  const normalised = plainText(text)
  const candidates = []
  for (const match of normalised.matchAll(new RegExp(DATE_PATTERN.source, 'g'))) {
    const date = validDate(match[1], match[2], match[3])
    if (!date) throw new Error(`invalid date "${match[0]}"`)
    candidates.push({ date, index: match.index })
  }
  for (const match of normalised.matchAll(new RegExp(HUMAN_DATE_PATTERN.source, 'gi'))) {
    const month = MONTHS.get(match[1].toLowerCase().slice(0, 4)) ?? MONTHS.get(match[1].toLowerCase().slice(0, 3))
    const date = validDate(match[3], month, match[2])
    if (!date) throw new Error(`invalid date "${match[0]}"`)
    candidates.push({ date, index: match.index })
  }
  return candidates.sort((left, right) => left.index - right.index)
}

export function dateFromText(text) {
  return dateCandidates(text)[0]?.date
}

function codeText(fragment) {
  return [...String(fragment).matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
    .map(match => plainText(match[1]))
    .filter(Boolean)
}

function modelId(fragment) {
  const fromCode = codeText(fragment)[0]
  if (fromCode) return fromCode.replace(/^`|`$/g, '').trim()
  const text = plainText(fragment).replace(/^`|`$/g, '').trim()
  if (!text) return undefined
  const fromBackticks = text.match(/`([^`]+)`/)
  if (fromBackticks) return fromBackticks[1].trim()
  return text.replace(/\s+\(including\b[\s\S]*$/i, '').trim()
}

const likelyReplacementToken = token => /[-_]/.test(token) || /\d/.test(token)

const addUnique = (values, value) => {
  if (value && !values.includes(value)) values.push(value)
}

function replacementCodeTokens(codes) {
  const valid = []
  for (const code of codes) {
    const exact = code.trim()
    if (MODEL_ID_PATTERN.test(exact)) {
      addUnique(valid, exact)
      continue
    }
    const parts = exact
      .split(/\s*(?:,|;|\||\bor\b|\band\b)\s*/i)
      .map(part => part.replace(/^[()[\]{}]+|[()[\]{}]+$/g, '').trim())
      .filter(Boolean)
    if (parts.length > 1) {
      for (const part of parts) {
        if (MODEL_ID_PATTERN.test(part)) addUnique(valid, part)
      }
    }
  }
  return valid
}

function replacementTextTokens(text) {
  if (MODEL_ID_PATTERN.test(text)) return [text]
  const parts = text
    .split(/\s*(?:,|;|\||\bor\b|\band\b)\s*/i)
    .map(part => part.replace(/^[()[\]{}]+|[()[\]{}]+$/g, '').trim())
    .filter(Boolean)
  if (parts.length > 1 && parts.every(part => MODEL_ID_PATTERN.test(part))) return [...new Set(parts)]
  const valid = []
  for (const match of text.matchAll(REPLACEMENT_TOKEN_PATTERN)) {
    const token = match[0]
    if (likelyReplacementToken(token) && MODEL_ID_PATTERN.test(token)) addUnique(valid, token)
  }
  return valid
}

function replacementNote(text, tokens) {
  let residual = text
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    residual = residual.replaceAll(token, ' ')
  }
  residual = residual
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[;,|/]/g, ' ')
  if (tokens.length) residual = residual.replace(/\b(?:or|and)\b/gi, ' ')
  return residual.replace(/\s+/g, ' ').trim() || undefined
}

export function extractReplacementFields(fragment) {
  const text = plainText(fragment)
  if (!text || /^[-]+$/.test(text) || /^(?:n\/?a|none)$/i.test(text)) return {}
  const codes = codeText(fragment)
  const tokens = codes.length ? replacementCodeTokens(codes) : replacementTextTokens(text)
  const canPromote = codes.length > 0 || MODEL_ID_PATTERN.test(text)
  const fields = {}
  if (tokens.length === 1) {
    if (canPromote) fields.replacement = tokens[0]
    else fields.replacement_options = tokens
  }
  if (tokens.length > 1) fields.replacement_options = tokens
  const note = replacementNote(text, tokens)
  if (note) fields.replacement_note = note
  return fields
}

const replacementPayload = record => ({
  replacement: record.replacement,
  replacement_options: record.replacement_options,
  replacement_note: record.replacement_note,
})

const hasReplacementPayload = record => Object.keys(replacementPayload(record)).some(key => record[key] !== undefined)

const sameReplacementPayload = (left, right) =>
  JSON.stringify(replacementPayload(left)) === JSON.stringify(replacementPayload(right))

const copyReplacementPayload = (target, source) => {
  for (const key of ['replacement', 'replacement_options', 'replacement_note']) {
    if (source[key] !== undefined) target[key] = source[key]
  }
}

// Same model, same dates, different guidance (base vs fine-tuned tables): keep the union, not the first row.
const mergeReplacementPayloads = (target, source) => {
  const tokens = []
  for (const record of [target, source]) {
    if (record.replacement) tokens.push(record.replacement)
    for (const option of record.replacement_options ?? []) tokens.push(option)
  }
  const union = [...new Set(tokens)]
  const notes = [...new Set([target.replacement_note, source.replacement_note].filter(Boolean))]
  for (const key of ['replacement', 'replacement_options', 'replacement_note']) delete target[key]
  if (union.length === 1) target.replacement = union[0]
  else if (union.length) target.replacement_options = union
  if (notes.length) target.replacement_note = notes.join('; ')
}

const endpointLikeLabel = label =>
  /\b(?:endpoint|product|service|operation|capability)\b/i.test(label) ||
  (/\bapi\b/i.test(label) && !/\bmodel\b/i.test(label))

const endpointLikeLabels = labels => labels.some(endpointLikeLabel)

function tableRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
    const cells = [...row[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    return {
      html: row[1],
      cells: cells.map(cell => ({
        kind: cell[1].toLowerCase(),
        html: cell[2],
        text: plainText(cell[2]),
      })),
    }
  })
}

function headerIndexes(rows) {
  for (const [index, row] of rows.entries()) {
    const labels = row.cells.map(cell => cell.text.toLowerCase())
    const date = labels.findIndex(label => /(shutdown|retirement|sunset|removal).*date|date.*(shutdown|retirement|sunset|removal)/i.test(label))
    const model = labels.findIndex(label => /\bmodel\b|\bsystem\b/i.test(label))
    const endpointLike = endpointLikeLabels(labels)
    const recommended = labels.findIndex(label => /recommended\s+replacement|replacement|successor/i.test(label))
    if (date >= 0 && endpointLike) {
      return { rejectedReason: 'endpoint-or-product-deprecation-table' }
    }
    if (date >= 0 && model >= 0 && recommended >= 0) {
      return { row: index, date, model, recommended }
    }
  }
  return undefined
}

function announcementDate(html, tableStart, provider) {
  const before = html.slice(0, tableStart)
  const headings = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
  const heading = headings.at(-1)
  const headingDates = heading ? dateCandidates(heading[1]) : []
  if (headingDates.length > 1) {
    throw new Error(`${provider} deprecations table has ambiguous-announcement-date context`)
  }
  if (headingDates.length === 1) return headingDates[0].date
  const segmentStart = heading ? heading.index + heading[0].length : Math.max(0, before.length - 6000)
  const contextDates = dateCandidates(before.slice(segmentStart))
  if (contextDates.length > 1) {
    throw new Error(`${provider} deprecations table has ambiguous-announcement-date context`)
  }
  return contextDates[0]?.date
}

/** Parse an HTML deprecations page into lifecycle records. */
export function parseDeprecationsHtml(html, sourceUrl, provider = 'provider') {
  if (typeof html !== 'string' || !html.trim()) throw new Error(`${provider} deprecations page is empty`)
  try {
    new URL(sourceUrl)
  } catch {
    throw new Error(`${provider} deprecations source is not a URL: ${sourceUrl}`)
  }

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  const skippedReasons = new Set()
  let recognisedTables = 0
  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = headerIndexes(rows)
    if (!headers) continue
    if (headers.rejectedReason) {
      skippedReasons.add(headers.rejectedReason)
      continue
    }
    recognisedTables++
    const tableAnnounced = announcementDate(html, table.index, provider)
    if (!tableAnnounced) {
      throw new Error(`${provider} deprecations table has no announcement date`)
    }
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) continue
      const id = modelId(modelCell.html)
      if (!id) throw new Error(`${provider} deprecations table contains a row without a model id`)
      if (!MODEL_ID_PATTERN.test(id)) {
        const reason = /[\s/]/.test(id) ? 'endpoint-or-product-row' : 'invalid-model-id'
        throw new Error(`${provider} deprecations table refused row: ${reason}: ${id}`)
      }
      const shutdownCell = row.cells[headers.date]
      const shutdown = shutdownCell ? dateFromText(shutdownCell.text) : undefined
      if (!shutdown) throw new Error(`${provider} deprecations entry ${id} has no valid shutdown date`)
      const replacementCell = headers.recommended >= 0 ? row.cells[headers.recommended] : undefined
      const item = { id, announced: tableAnnounced, shutdown, source: sourceUrl }
      if (replacementCell) Object.assign(item, extractReplacementFields(replacementCell.html))
      if (item.announced && item.shutdown < item.announced) {
        throw new Error(`${provider} deprecations entry ${id} has shutdown before announcement`)
      }
      records.push(item)
    }
  }

  if (!recognisedTables) {
    const reason = skippedReasons.size ? `: ${[...skippedReasons].join(', ')}` : ''
    throw new Error(`${provider} deprecations page has no recognised model tables${reason}`)
  }
  if (!records.length) throw new Error(`${provider} deprecations page has no model entries`)

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.id)
    if (!previous) {
      unique.set(record.id, record)
      continue
    }
    const sameLifecycle = previous.announced === record.announced && previous.shutdown === record.shutdown
    if (!sameLifecycle || (hasReplacementPayload(previous) && hasReplacementPayload(record) && !sameReplacementPayload(previous, record))) {
      throw new Error(`${provider} deprecations page has conflicting rows for ${record.id}`)
    }
    if (!hasReplacementPayload(previous) && hasReplacementPayload(record)) copyReplacementPayload(previous, record)
  }
  return [...unique.values()]
}

function openAIHeaderIndexes(rows) {
  for (const [index, row] of rows.entries()) {
    const labels = row.cells.map(cell => cell.text.toLowerCase())
    const date = labels.findIndex(label => /(shutdown|retirement|sunset|removal).*date|date.*(shutdown|retirement|sunset|removal)/i.test(label))
    const model = labels.findIndex(label => /\b(model|system)\b/i.test(label) && !/replacement|substitute/i.test(label))
    const replacement = labels.findIndex(label => /recommended\s+replacement|replacement|substitute\s+model|successor/i.test(label))
    if (date >= 0 && endpointLikeLabels(labels)) return { rejectedReason: 'endpoint-or-product-deprecation-table' }
    if (date >= 0 && model >= 0 && replacement >= 0) return { row: index, date, model, replacement }
  }
  return undefined
}

function stripOpenAIChrome(html) {
  return html.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

function openAIHeadings(html) {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(match => ({
    index: match.index,
    level: Number(match[1]),
    date: dateFromText(match[2]),
  }))
}

function openAIAnnouncementDate(headings, tableStart) {
  const preceding = headings.filter(heading => heading.index < tableStart)
  let heading = preceding.at(-1)
  while (heading && !heading.date) {
    const position = preceding.indexOf(heading)
    heading = preceding.slice(0, position).reverse().find(candidate => candidate.level < heading.level)
  }
  return heading?.date
}

function openAIModelIds(fragment) {
  const codes = codeText(fragment)
  const tokens = [...new Set((codes.length ? codes : [modelId(fragment)]).filter(Boolean).map(token => token.trim()))]
  if (!tokens.length) return undefined
  const canonical = tokens.find(token => /\b(?:19|20)\d{2}[-_]\d{2}[-_]\d{2}\b/.test(token)) ?? tokens[0]
  return {
    id: canonical,
    aliases: tokens.filter(token => token !== canonical),
  }
}

const openAIReplacement = extractReplacementFields

/** Parse the OpenAI docs page, whose announcement date is a section heading. */
export function parseOpenAIDeprecations(html, sourceUrl = PROVIDERS.openai.deprecationsUrl) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('openai deprecations page is empty')
  try {
    new URL(sourceUrl)
  } catch {
    throw new Error(`openai deprecations source is not a URL: ${sourceUrl}`)
  }

  const content = stripOpenAIChrome(html)
  const headings = openAIHeadings(content)
  const tables = [...content.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  const skippedReasons = new Set()
  let recognisedTables = 0

  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = openAIHeaderIndexes(rows)
    if (!headers) continue
    if (headers.rejectedReason) {
      skippedReasons.add(headers.rejectedReason)
      continue
    }
    recognisedTables++

    const announced = openAIAnnouncementDate(headings, table.index)
    if (!announced) throw new Error('openai deprecations table has no announcement date')

    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) continue
      const parsedModel = openAIModelIds(modelCell.html)
      if (!parsedModel) throw new Error('openai deprecations table contains a row without a model id')
      const modelTokens = [parsedModel.id, ...parsedModel.aliases]
      if (modelTokens.some(token => !MODEL_ID_PATTERN.test(token))) {
        const invalid = modelTokens.find(token => !MODEL_ID_PATTERN.test(token))
        skippedReasons.add(/[\s/]/.test(invalid) ? 'endpoint-or-product-row' : 'invalid-model-id')
        continue
      }

      const shutdownCell = row.cells[headers.date]
      const shutdown = shutdownCell ? dateFromText(shutdownCell.text) : undefined
      if (!shutdown) throw new Error(`openai deprecations entry ${parsedModel.id} has no valid shutdown date`)

      const replacementCell = row.cells[headers.replacement]
      const item = { id: parsedModel.id, announced, shutdown, source: sourceUrl }
      if (parsedModel.aliases.length) item.aliases = parsedModel.aliases
      if (replacementCell) Object.assign(item, openAIReplacement(replacementCell.html))
      if (item.shutdown < item.announced) {
        throw new Error(`openai deprecations entry ${parsedModel.id} has shutdown before announcement`)
      }
      records.push(item)
    }
  }

  if (!recognisedTables) {
    const reason = skippedReasons.size ? `: ${[...skippedReasons].join(', ')}` : ''
    throw new Error(`openai deprecations page has no recognisable deprecations content${reason}`)
  }
  if (!records.length) {
    const reason = skippedReasons.size ? `: ${[...skippedReasons].join(', ')}` : ''
    throw new Error(`openai deprecations page has no model entries${reason}`)
  }

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.id)
    if (!previous) {
      unique.set(record.id, record)
      continue
    }
    const sameLifecycle = previous.announced === record.announced && previous.shutdown === record.shutdown
    if (sameLifecycle && !sameReplacementPayload(previous, record)) {
      mergeReplacementPayloads(previous, record)
    }
    if (sameLifecycle) {
      previous.aliases = [...new Set([...(previous.aliases ?? []), ...(record.aliases ?? [])])]
        .filter(alias => alias !== previous.id)
      if (!previous.aliases.length) delete previous.aliases
      continue
    }
    if (record.announced > previous.announced) {
      record.aliases = [...new Set([...(record.aliases ?? []), ...(previous.aliases ?? [])])]
        .filter(alias => alias !== record.id)
      if (!record.aliases.length) delete record.aliases
      unique.set(record.id, record)
      continue
    }
    if (record.announced < previous.announced) {
      previous.aliases = [...new Set([...(previous.aliases ?? []), ...(record.aliases ?? [])])]
        .filter(alias => alias !== previous.id)
      if (!previous.aliases.length) delete previous.aliases
      continue
    }
    if (record.shutdown !== previous.shutdown) {
      throw new Error(`openai deprecations page has conflicting rows for ${record.id}`)
    }
    previous.aliases = [...new Set([...(previous.aliases ?? []), ...(record.aliases ?? [])])]
      .filter(alias => alias !== previous.id)
    if (!previous.aliases.length) delete previous.aliases
  }
  return [...unique.values()]
}

function anthropicStatusHeaderIndexes(rows) {
  for (const [index, row] of rows.entries()) {
    const labels = new Map()
    for (const [cellIndex, cell] of row.cells.entries()) {
      if (cell.kind === 'th') labels.set(plainText(cell.text).toLowerCase(), cellIndex)
    }
    if (!labels.has('tentative retirement date')) continue
    const required = ['api model name', 'current state', 'deprecated', 'tentative retirement date']
    const missing = required.filter(label => !labels.has(label))
    if (missing.length) {
      throw new Error(`anthropic model status table header is missing required columns: ${missing.join(', ')}`)
    }
    return {
      row: index,
      model: labels.get('api model name'),
      state: labels.get('current state'),
      deprecated: labels.get('deprecated'),
      retirement: labels.get('tentative retirement date'),
    }
  }
  return undefined
}

function anthropicStatusDate(text, id, field, cellText = text) {
  const value = plainText(text)
  let date
  try {
    date = dateFromText(value)
  } catch {}
  const residual = value.replace(DATE_PATTERN, '').replace(HUMAN_DATE_PATTERN, '').trim()
  if (!date || residual) {
    throw new Error(`anthropic model status row ${id} has an unrecognised ${field}: ${plainText(cellText) || '(empty)'}`)
  }
  return date
}

function anthropicTentativeShutdown(text, id) {
  const value = plainText(text)
  if (!value || /^n\/a$/i.test(value)) return undefined
  const match = value.match(/^not sooner than\s+(.+)$/i)
  if (!match) throw new Error(`anthropic model status row ${id} has an unrecognised tentative retirement date: ${value}`)
  return anthropicStatusDate(match[1], id, 'tentative retirement date', value)
}

const anthropicStatusStates = new WeakMap()

function parseAnthropicStatusTables(html, sourceUrl, announcementIds) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  let recognisedTables = 0
  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = anthropicStatusHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell?.text) continue
      const id = modelId(modelCell.html)
      if (!id) throw new Error('anthropic model status table contains a row without a model id')
      if (!MODEL_ID_PATTERN.test(id)) {
        const reason = /[\s/]/.test(id) ? 'endpoint-or-product-row' : 'invalid-model-id'
        throw new Error(`anthropic model status table refused row: ${reason}: ${id}`)
      }
      const stateText = plainText(row.cells[headers.state]?.text)
      const state = stateText.toLowerCase()
      if (!['active', 'deprecated', 'retired'].includes(state)) {
        throw new Error(`anthropic model status row ${id} has an unrecognised state: ${stateText || '(empty)'}`)
      }
      const deprecatedText = plainText(row.cells[headers.deprecated]?.text)
      const retirementText = plainText(row.cells[headers.retirement]?.text)
      const item = { id, source: sourceUrl }
      if (state === 'active') {
        if (deprecatedText && !/^n\/a$/i.test(deprecatedText)) {
          throw new Error(`anthropic model status row ${id} is active with a deprecated date: ${deprecatedText}`)
        }
        const shutdown = anthropicTentativeShutdown(retirementText, id)
        if (shutdown) Object.assign(item, { shutdown, date_precision: 'tentative' })
      } else {
        item.announced = anthropicStatusDate(deprecatedText, id, 'deprecated date')
        if (!/^n\/a$/i.test(retirementText)) {
          item.shutdown = anthropicStatusDate(retirementText, id, 'retirement date')
          if (item.shutdown < item.announced) {
            throw new Error(`anthropic model status row ${id} has retirement before deprecated date: ${retirementText}`)
          }
        } else if (state === 'retired') {
          throw new Error(`anthropic model status row ${id} is retired without a shutdown date: ${retirementText}`)
        }
      }
      if (announcementIds.has(id)) continue
      anthropicStatusStates.set(item, state)
      records.push(item)
    }
  }
  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.id)
    if (!previous) {
      unique.set(record.id, record)
      continue
    }
    if (
      anthropicStatusStates.get(previous) !== anthropicStatusStates.get(record) ||
      previous.announced !== record.announced ||
      previous.shutdown !== record.shutdown ||
      previous.date_precision !== record.date_precision
    ) {
      throw new Error(`anthropic model status table has conflicting rows for ${record.id}`)
    }
  }
  return { records: [...unique.values()], recognisedTables }
}

export function parseAnthropicDeprecations(html, sourceUrl = PROVIDERS.anthropic.deprecationsUrl) {
  let announcements = []
  try {
    announcements = parseDeprecationsHtml(html, sourceUrl, 'anthropic')
  } catch (error) {
    if (!error.message.includes('has no recognised model tables')) throw error
  }
  const announcementIds = new Set(announcements.map(record => record.id))
  const status = parseAnthropicStatusTables(html, sourceUrl, announcementIds)
  if (!status.recognisedTables) throw new Error('anthropic deprecations page has no model status table')
  const records = [...announcements, ...status.records]
  if (!records.length) throw new Error('anthropic deprecations page has no model entries')
  return records
}

function googleModelId(fragment) {
  const fromCode = codeText(fragment)[0]
  if (fromCode) return fromCode.trim()
  const text = plainText(fragment)
  if (!text || /\s/.test(text)) return undefined
  return text
}

function googleShutdown(text, id) {
  if (!text || /^no\s+shutdown\s+date(?:\s+announced)?$/i.test(text) || /^[-\u2013\u2014]+$/.test(text)) return undefined
  const parsed = dateFromText(text)
  if (!parsed) throw new Error(`google deprecations entry ${id} has an unrecognised shutdown date: ${text}`)
  return parsed
}

function googleDatePrecision(html, shutdownText) {
  return /earliest\s+possible|not\s+(?:be\s+)?moved\s+to\s+an\s+earlier\s+date|or\s+later|no\s+sooner\s+than/i.test(`${plainText(html)} ${shutdownText}`)
    ? 'earliest'
    : undefined
}

/** Parse Google's Gemini deprecations tables. */
export function parseGoogleDeprecations(html, sourceUrl = PROVIDERS.google.deprecationsUrl) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('google deprecations page is empty')
  try {
    new URL(sourceUrl)
  } catch {
    throw new Error(`google deprecations source is not a URL: ${sourceUrl}`)
  }

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  const skippedReasons = new Set()
  let recognisedTables = 0
  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = headerIndexes(rows)
    if (!headers) continue
    if (headers.rejectedReason) {
      skippedReasons.add(headers.rejectedReason)
      continue
    }
    recognisedTables++
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      const shutdownCell = row.cells[headers.date]
      if (!modelCell || !shutdownCell || !modelCell.text) continue
      const id = googleModelId(modelCell.html)
      if (!id) continue
      if (!MODEL_ID_PATTERN.test(id)) {
        const reason = /[\s/]/.test(id) ? 'endpoint-or-product-row' : 'invalid-model-id'
        throw new Error(`google deprecations table refused row: ${reason}: ${id}`)
      }
      const shutdownText = shutdownCell.text
      const shutdown = googleShutdown(shutdownText, id)
      const item = { id, source: sourceUrl }
      if (shutdown) {
        item.shutdown = shutdown
        const precision = googleDatePrecision(html, shutdownText)
        if (precision) item.date_precision = precision
      }
      const replacementCell = row.cells[headers.recommended]
      if (replacementCell) Object.assign(item, extractReplacementFields(replacementCell.html))
      records.push(item)
    }
  }

  if (!recognisedTables) {
    const reason = skippedReasons.size ? `: ${[...skippedReasons].join(', ')}` : ''
    throw new Error(`google deprecations page has no recognised model tables${reason}`)
  }
  if (!records.length) throw new Error('google deprecations page has no model entries')

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.id)
    if (!previous) {
      unique.set(record.id, record)
      continue
    }
    const same = previous.announced === record.announced &&
      previous.shutdown === record.shutdown &&
      previous.date_precision === record.date_precision &&
      sameReplacementPayload(previous, record)
    if (!same) throw new Error(`google deprecations page has conflicting rows for ${record.id}`)
  }
  return [...unique.values()]
}

export const parseGoogleGeminiDeprecations = parseGoogleDeprecations

const MAX_MODEL_PAGES = 20
const GOOGLE_MODEL_PAGE_SIZE = 1000

function parseModelsPage(body, provider) {
  let parsed
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body
  } catch (error) {
    throw new Error(`${provider} models response is not valid JSON: ${error.message}`)
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.data
  if (!Array.isArray(rows)) throw new Error(`${provider} models response has no data array`)
  const ids = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) {
      throw new Error(`${provider} models response contains an entry without a model id`)
    }
    const id = row.id.trim()
    if (seen.has(id)) throw new Error(`${provider} models response contains duplicate model id ${id}`)
    seen.add(id)
    ids.push(id)
  }
  if (parsed && !Array.isArray(parsed) && parsed.has_more !== undefined && typeof parsed.has_more !== 'boolean') {
    throw new Error(`${provider} models response has a non-boolean has_more value`)
  }
  const lastId = parsed && !Array.isArray(parsed) ? parsed.last_id : undefined
  if (lastId !== undefined && lastId !== null && (typeof lastId !== 'string' || !lastId.trim())) {
    throw new Error(`${provider} models response has an invalid last_id value`)
  }
  return {
    ids,
    hasMore: parsed && !Array.isArray(parsed) ? parsed.has_more === true : false,
    lastId: typeof lastId === 'string' && lastId.trim() ? lastId.trim() : ids.at(-1),
  }
}

/** Parse the JSON response returned by a provider's models endpoint. */
export function parseModelsResponse(body, provider = 'provider') {
  return parseModelsPage(body, provider).ids
}

function parseGoogleModelsPage(body) {
  let parsed
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body
  } catch (error) {
    throw new Error(`google models response is not valid JSON: ${error.message}`)
  }
  const rows = parsed?.models
  if (!Array.isArray(rows)) throw new Error('google models response has no models array')
  const ids = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !row.name.trim()) {
      throw new Error('google models response contains an entry without a model name')
    }
    const name = row.name.trim()
    if (!name.startsWith('models/')) {
      throw new Error(`google models response contains an invalid model resource name ${name}`)
    }
    const id = name.slice('models/'.length)
    if (!id) throw new Error('google models response contains an empty model id')
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  const nextPageToken = parsed?.nextPageToken
  if (nextPageToken !== undefined && (typeof nextPageToken !== 'string' || !nextPageToken.trim())) {
    throw new Error('google models response has an invalid nextPageToken value')
  }
  return { ids, nextPageToken }
}

/** Parse Google's models endpoint response and remove its resource prefix. */
export function parseGoogleModelsResponse(body) {
  return parseGoogleModelsPage(body).ids
}

export const parseOpenAIModels = body => parseModelsResponse(body, 'openai')
export const parseAnthropicModels = body => parseModelsResponse(body, 'anthropic')
export const parseGoogleModels = parseGoogleModelsResponse
export const parseGoogleModelsEndpoint = parseGoogleModelsResponse

function nextPageUrl(url, parameter, cursor) {
  const next = new URL(url)
  next.searchParams.set(parameter, cursor)
  return next.toString()
}

async function fetchPaginatedGoogleModels(config, headers, fetchImpl) {
  const ids = []
  const seenIds = new Set()
  const seenTokens = new Set()
  const firstPage = new URL(config.modelsUrl)
  firstPage.searchParams.delete('pageToken')
  if (!firstPage.searchParams.has('pageSize')) firstPage.searchParams.set('pageSize', String(GOOGLE_MODEL_PAGE_SIZE))
  let url = firstPage.toString()

  for (let page = 1; page <= MAX_MODEL_PAGES; page++) {
    const body = await fetchBody(url, headers, config.publisher, fetchImpl)
    const parsed = parseGoogleModelsPage(body)
    for (const id of parsed.ids) {
      if (seenIds.has(id)) continue
      seenIds.add(id)
      ids.push(id)
    }
    if (parsed.nextPageToken === undefined) return ids
    if (page === MAX_MODEL_PAGES) {
      throw new Error(`google models endpoint exceeded pagination cap of ${MAX_MODEL_PAGES} pages`)
    }
    if (seenTokens.has(parsed.nextPageToken)) {
      throw new Error('google models pagination token repeated')
    }
    seenTokens.add(parsed.nextPageToken)
    url = nextPageUrl(firstPage, 'pageToken', parsed.nextPageToken)
  }
  throw new Error('google models endpoint pagination failed')
}

async function fetchPaginatedModels(config, headers, fetchImpl) {
  const cursorParameter = config.publisher === 'openai' ? 'after' : 'after_id'
  const ids = []
  const seen = new Set()
  let url = config.modelsUrl
  let cursor
  for (let page = 1; page <= MAX_MODEL_PAGES; page++) {
    const body = await fetchBody(url, headers, config.publisher, fetchImpl)
    const parsed = parseModelsPage(body, config.publisher)
    for (const id of parsed.ids) {
      if (seen.has(id)) throw new Error(`${config.publisher} models response contains duplicate model id across pages: ${id}`)
      seen.add(id)
      ids.push(id)
    }
    if (!parsed.hasMore) return ids
    if (page === MAX_MODEL_PAGES) {
      throw new Error(`${config.publisher} models endpoint exceeded pagination cap of ${MAX_MODEL_PAGES} pages`)
    }
    if (!parsed.lastId) throw new Error(`${config.publisher} models response has_more is true without a last_id`)
    if (parsed.lastId === cursor) throw new Error(`${config.publisher} models pagination cursor did not advance`)
    cursor = parsed.lastId
    url = nextPageUrl(config.modelsUrl, cursorParameter, cursor)
  }
  throw new Error(`${config.publisher} models endpoint pagination failed`)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function identityIndex(models) {
  const index = new Map()
  for (const model of models) {
    for (const key of [model.id, ...(model.aliases ?? [])]) {
      if (!key) continue
      const previous = index.get(key)
      if (previous && previous !== model) throw new Error(`models have an ambiguous id or alias: ${key}`)
      index.set(key, model)
    }
  }
  return index
}

function replacementInput(model) {
  if (Array.isArray(model.replacement_options)) {
    return { tokens: [...model.replacement_options], note: model.replacement_note, mayPromote: false }
  }
  if (typeof model.replacement === 'string' && model.replacement.trim()) {
    const raw = model.replacement.trim()
    const parsed = MODEL_ID_PATTERN.test(raw)
      ? { replacement: raw }
      : extractReplacementFields(raw)
    return {
      tokens: parsed.replacement ? [parsed.replacement] : [...(parsed.replacement_options ?? [])],
      note: model.replacement_note ?? parsed.replacement_note,
      mayPromote: true,
    }
  }
  if (model.replacement_note !== undefined) return { tokens: [], note: model.replacement_note, mayPromote: false }
  return undefined
}

function routeReplacementFields(models) {
  const index = identityIndex(models)
  for (const model of models) {
    const input = replacementInput(model)
    if (!input) continue
    delete model.replacement
    delete model.replacement_options
    delete model.replacement_note
    const tokens = [...new Set(input.tokens)]
    if (tokens.length === 1 && input.mayPromote && index.has(tokens[0])) model.replacement = tokens[0]
    else if (tokens.length) model.replacement_options = tokens
    if (input.note) model.replacement_note = input.note
  }
}

/**
 * Merge source records into a committed feed without deleting any committed
 * entry. The endpoint argument is null when credentials were unavailable and
 * an empty array when the endpoint explicitly returned no models.
 */
export function mergeFeed(committed, { deprecations = [], currentIds = null, generated, provider }) {
  if (!committed || !Array.isArray(committed.models)) throw new Error('committed feed has no models array')
  const models = committed.models.map(clone)
  const committedEntries = committed.models.map((old, index) => ({ id: old.id, model: models[index] }))
  const confirmed = new Set()
  const deprecationConfirmed = new Set()
  let index = identityIndex(models)

  const locate = id => index.get(id)
  const add = model => {
    models.push(model)
    index = identityIndex(models)
    return model
  }
  const absorb = (target, other, aliases) => {
    if (target === other) return
    aliases.add(other.id)
    for (const alias of other.aliases ?? []) aliases.add(alias)
    const metadata = new Set(['announced', 'shutdown', 'date_precision', 'replacement', 'replacement_options', 'replacement_note', 'source'])
    for (const [field, value] of Object.entries(other)) {
      if (field === 'id' || field === 'aliases' || metadata.has(field)) continue
      if (target[field] === undefined) {
        target[field] = clone(value)
      } else if (JSON.stringify(target[field]) !== JSON.stringify(value)) {
        throw new Error(`merge found conflicting fields while joining ${target.id} and ${other.id}`)
      }
    }
    const otherIndex = models.indexOf(other)
    if (otherIndex < 0) throw new Error(`merge could not locate model ${other.id} while joining aliases`)
    for (const entry of committedEntries) {
      if (entry.model === other) entry.model = target
    }
    models.splice(otherIndex, 1)
    index = identityIndex(models)
  }

  for (const record of deprecations) {
    let target = locate(record.id)
    if (!target) target = add({ id: record.id })

    const canonicalId = target.id
    const aliases = new Set(target.aliases ?? [])
    for (const alias of [record.id, ...(record.aliases ?? [])]) {
      if (!alias || alias === canonicalId) continue
      const owner = locate(alias)
      if (owner && owner !== target) absorb(target, owner, aliases)
      aliases.add(alias)
    }
    const anthropicStatus = provider.publisher === 'anthropic'
      ? anthropicStatusStates.get(record)
      : undefined
    if (anthropicStatus) {
      if (anthropicStatus === 'active') {
        for (const field of ['announced', 'shutdown', 'date_precision', 'replacement', 'replacement_options', 'replacement_note']) delete target[field]
        if (record.shutdown !== undefined) target.shutdown = record.shutdown
        if (record.date_precision !== undefined) target.date_precision = record.date_precision
      } else {
        for (const field of ['announced', 'shutdown', 'date_precision']) delete target[field]
        target.announced = record.announced
        if (record.shutdown !== undefined) target.shutdown = record.shutdown
      }
      if (target.source === undefined && record.source !== undefined) target.source = record.source
      if (aliases.size) target.aliases = [...aliases].filter(alias => alias !== canonicalId)
      else delete target.aliases
      confirmed.add(target.id)
      deprecationConfirmed.add(target.id)
      index = identityIndex(models)
      continue
    }
    for (const field of ['announced', 'shutdown', 'date_precision', 'replacement', 'replacement_options', 'replacement_note']) delete target[field]
    Object.assign(target, clone(record), { id: canonicalId })
    if (aliases.size) target.aliases = [...aliases].filter(alias => alias !== canonicalId)
    else delete target.aliases
    confirmed.add(target.id)
    deprecationConfirmed.add(target.id)
    index = identityIndex(models)
  }

  if (currentIds !== null) {
    for (const id of currentIds) {
      let target = locate(id)
      if (!target) target = add({ id })
      if (!deprecationConfirmed.has(target.id)) {
        // Presence in the endpoint is affirmative current-model data. A
        // lifecycle record from the old feed is stale unless the page still
        // confirms it in this refresh.
        for (const field of ['announced', 'shutdown', 'date_precision', 'replacement', 'replacement_options', 'replacement_note']) delete target[field]
      }
      confirmed.add(target.id)
    }
  }

  // This is deliberately an assertion rather than a filter. A future change
  // that accidentally removes an old entry must fail before any output write.
  const finalIndex = identityIndex(models)
  for (const old of committedEntries) {
    if (finalIndex.get(old.id) !== old.model) {
      throw new Error(`merge would detach committed canonical model ${old.id}`)
    }
  }

  routeReplacementFields(models)

  const feed = {
    ...clone(committed),
    spec: 'model-eol/0.1',
    publisher: provider.publisher,
    generated: generated ?? new Date().toISOString(),
    source: provider.deprecationsUrl,
    models,
  }
  return {
    feed,
    unconfirmedIds: models.filter(model => !confirmed.has(model.id)).map(model => model.id),
  }
}

const fixtureNames = {
  models: [
    '{provider}-models.json',
    '{provider}-models-response.json',
    '{provider}-models-endpoint.json',
    '{provider}.models.json',
    '{provider}/models.json',
    '{provider}/models-response.json',
  ],
  deprecations: [
    '{provider}-deprecations.html',
    '{provider}-deprecations.htm',
    '{provider}-deprecations.md',
    '{provider}.deprecations.html',
    '{provider}/deprecations.html',
    '{provider}/deprecations.htm',
    '{provider}/deprecations.md',
  ],
}

export function findFixture(dir, provider, kind) {
  if (!dir) return undefined
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`fixtures directory does not exist: ${dir}`)
  }
  for (const template of fixtureNames[kind] ?? []) {
    const candidate = path.join(root, template.replace('{provider}', provider))
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`missing ${provider} ${kind} fixture in ${dir}`)
}

async function fetchBody(url, headers, provider, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  let response
  try {
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    response = await fetchImpl(url, { headers: { 'accept-language': 'en', ...headers } })
  } catch (error) {
    throw new Error(`${provider} fetch failed for ${url}: ${error.message}`)
  }
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.text()).trim().slice(0, 300) } catch {}
    throw new Error(`${provider} fetch failed for ${url}: HTTP ${response.status}${detail ? ` - ${detail}` : ''}`)
  }
  const body = await response.text()
  if (!body.trim()) throw new Error(`${provider} fetch returned an empty response for ${url}`)
  return body
}

/** Load and parse both source classes for one provider. */
export async function loadProviderSources(config, options = {}) {
  const { fixtures, env = process.env, fetchImpl = globalThis.fetch, notice = console.error } = options
  let currentIds = null
  let endpointAvailable = false

  if (fixtures) {
    const modelFixture = findFixture(fixtures, config.publisher, 'models')
    const modelBody = fs.readFileSync(modelFixture, 'utf8')
    currentIds = config.publisher === 'google'
      ? parseGoogleModelsResponse(modelBody)
      : parseModelsResponse(modelBody, config.publisher)
    endpointAvailable = true
    notice(`notice: ${config.publisher} models endpoint fixture: ${path.relative(process.cwd(), modelFixture)}`)
  } else {
    const keyEnvs = config.keyEnvs ?? [config.keyEnv]
    const keyEnv = keyEnvs.find(name => env[name])
    const key = keyEnv ? env[keyEnv] : undefined
    if (!key) {
      notice(`notice: ${keyEnvs.join(' or ')} is unset; skipping ${config.publisher} models endpoint and preserving committed entries`)
    } else {
      const headers = { ...config.headers }
      if (config.publisher === 'openai') headers.Authorization = `Bearer ${key}`
      if (config.publisher === 'anthropic') headers['x-api-key'] = key
      if (config.keyHeader) headers[config.keyHeader] = key
      if (config.publisher === 'google') {
        currentIds = await fetchPaginatedGoogleModels(config, headers, fetchImpl)
      } else {
        currentIds = await fetchPaginatedModels(config, headers, fetchImpl)
      }
      endpointAvailable = true
    }
  }

  let html
  let fixturePath
  if (fixtures) {
    fixturePath = findFixture(fixtures, config.publisher, 'deprecations')
    html = fs.readFileSync(fixturePath, 'utf8')
    notice(`notice: ${config.publisher} deprecations fixture: ${path.relative(process.cwd(), fixturePath)}`)
  } else {
    html = await fetchBody(config.deprecationsUrl, {}, config.publisher, fetchImpl)
  }

  const deprecations = config.publisher === 'openai'
    ? parseOpenAIDeprecations(html, config.deprecationsUrl)
    : config.publisher === 'google'
      ? parseGoogleDeprecations(html, config.deprecationsUrl)
      : config.publisher === 'anthropic'
        ? parseAnthropicDeprecations(html, config.deprecationsUrl)
        : parseDeprecationsHtml(html, config.deprecationsUrl, config.publisher)
  return { currentIds, endpointAvailable, deprecations }
}
