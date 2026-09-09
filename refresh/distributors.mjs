import fs from 'node:fs'
import path from 'node:path'

import { assertIsoDate, dateFromText, MODEL_ID_PATTERN } from './providers.mjs'

export const BEDROCK_LIFECYCLE_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html'
export const BEDROCK_MODEL_CARDS_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html'
export const MAX_BEDROCK_MODEL_CARDS = 400
export const MAX_DISTRIBUTOR_BODY_BYTES = 8 * 1024 * 1024
export const VERTEX_MODEL_VERSIONS_URL = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions'
export const VERTEX_LIFECYCLE_URL = VERTEX_MODEL_VERSIONS_URL
export const AZURE_MODEL_RETIREMENT_SCHEDULE_URL = 'https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule'
export const AZURE_PUBLISHER_BY_SECTION = new Map([
  ['Azure OpenAI', 'openai'],
  ['Anthropic', 'anthropic'],
])

export const DISTRIBUTORS = {
  'aws-bedrock': {
    name: 'aws-bedrock',
    sourceUrl: BEDROCK_LIFECYCLE_URL,
    fixture: 'bedrock-lifecycle.html',
    indexUrl: BEDROCK_MODEL_CARDS_URL,
    indexFixture: 'bedrock-model-cards.html',
    cardFixtureDir: 'bedrock-model-cards',
  },
  'vertex-ai': {
    name: 'vertex-ai',
    sourceUrl: VERTEX_MODEL_VERSIONS_URL,
    fixture: 'vertex-model-versions.html',
  },
  'azure-ai-foundry': {
    name: 'azure-ai-foundry',
    sourceUrl: AZURE_MODEL_RETIREMENT_SCHEDULE_URL,
    fixture: 'azure-model-retirement-schedule.html',
  },
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
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[‐‑‒–\u2014−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

function tableRows(table) {
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
    const cells = [...row[1].matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
    return {
      cells: cells.map(cell => ({
        kind: cell[1].toLowerCase(),
        attrs: cell[2],
        html: cell[3],
        text: plainText(cell[3]),
      })),
    }
  })
}

function span(cell, name) {
  const match = cell.attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'))
  const value = match ? Number(match[1]) : 1
  return Number.isInteger(value) && value > 0 ? value : 1
}

// The AWS page uses rowspan for regions. Expanding it here makes the parser
// operate on logical rows and keeps the model/date columns aligned.
function expandRows(rows) {
  const active = []
  return rows.map(row => {
    const cells = []
    let column = 0
    let source = 0

    const fillActive = () => {
      while (active[column]?.remaining > 0) {
        const slot = active[column]
        cells[column] = slot.cell
        slot.remaining--
        if (slot.remaining === 0) active[column] = undefined
        column++
      }
    }

    while (source < row.cells.length) {
      fillActive()
      const cell = row.cells[source++]
      const columns = span(cell, 'colspan')
      const rowsRemaining = span(cell, 'rowspan') - 1
      for (let offset = 0; offset < columns; offset++) {
        cells[column] = cell
        if (rowsRemaining > 0) active[column] = { cell, remaining: rowsRemaining }
        column++
      }
    }
    fillActive()
    return { ...row, cells }
  })
}

function bedrockHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const model = labels.findIndex(label => /\bmodel\s+(?:id|identifier)\b/i.test(label))
    const legacy = labels.findIndex(label => /\blegacy\b.*\bdate\b|\bdate\b.*\blegacy\b/i.test(label))
    const eol = labels.findIndex(label => (
      /\beol\b.*\bdate\b|\bdate\b.*\beol\b/i.test(label) ||
      /end\s*[- ]?of\s*[- ]?life.*\bdate\b|\bdate\b.*end\s*[- ]?of\s*[- ]?life/i.test(label) ||
      /\b(?:retirement|discontinuation)\b.*\bdate\b|\bdate\b.*\b(?:retirement|discontinuation)\b/i.test(label)
    ))
    if (model < 0 || legacy < 0 || eol < 0) continue
    const extendedAccess = labels.findIndex(label => (
      /\bpublic\s+extended\s+access\b.*\bdate\b|\bdate\b.*\bpublic\s+extended\s+access\b/i.test(label)
    ))
    if (extendedAccess < 0) {
      throw new Error('aws-bedrock lifecycle table is missing the Public extended access start date column')
    }
    const status = labels.findIndex(label => /^(?:(?:model|lifecycle)\s+)*status$/i.test(label.trim()))
    return { row, model, legacy, eol, extendedAccess, status }
  }
  return undefined
}

function missingDate(text) {
  return !text || /^(?:-+|n\/?a|none|not\s+(?:available|applicable)|no\s+(?:shutdown|retirement)\s+date\s+announced)$/i.test(text)
}

function lifecycleDate(cell, field, bedrockId) {
  if (!cell || missingDate(cell.text)) return undefined
  const parsed = dateFromText(cell.text)
  if (!parsed) throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has an unrecognised ${field} date: ${cell.text}`)
  return parsed
}

function bedrockLifecycleStatus(cell, bedrockId) {
  const value = cell?.text.trim().toLowerCase().replace(/[‐‑‒–\u2014−]/g, '-').replace(/\s+/g, ' ')
  const statuses = new Map([
    ['active', 'active'],
    ['legacy', 'legacy'],
    ['extended access', 'extended-access'],
    ['public extended access', 'extended-access'],
    ['end-of-life', 'retired'],
    ['end of life', 'retired'],
    ['end-of-life (eol)', 'retired'],
    ['end of life (eol)', 'retired'],
    ['eol', 'retired'],
    ['retired', 'retired'],
  ])
  const status = statuses.get(value)
  if (!status) throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has an unsupported lifecycle status: ${cell?.text || '(empty)'}`)
  return status
}

function vertexHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const model = labels.findIndex(label => /\bmodel\s+(?:id|identifier)\b/i.test(label))
    const retirement = labels.findIndex(label => /\b(?:retirement|discontinuation)\b.*\bdate\b|\bdate\b.*\b(?:retirement|discontinuation)\b/i.test(label))
    if (model >= 0 && retirement >= 0) return { row, model, eol: retirement }
  }
  return undefined
}

function mergeRegionalBedrockRecord(left, right) {
  if (left.legacy !== right.legacy || left.eol !== right.eol) return undefined
  if (left.status === right.status) return left
  const statuses = new Set([left.status, right.status])
  if (statuses.size === 2 && statuses.has('legacy') && statuses.has('extended-access')) {
    return { ...left, status: 'extended-access' }
  }
  return undefined
}

const isBedrockModelId = value => /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9._:+-]*$/i.test(value)

// AWS occasionally omits a provider cell without a compensating rowspan. In
// that row every later cell shifts left, even though the table header does not.
// Anchor on the model ID and apply the same offset to the lifecycle columns.
function bedrockModelCell(row, expectedIndex) {
  const expected = row.cells[expectedIndex]
  if (expected && isBedrockModelId(expected.text.trim())) {
    return { cell: expected, index: expectedIndex }
  }
  const candidates = row.cells
    .map((cell, index) => ({ cell, index }))
    .filter(candidate => isBedrockModelId(candidate.cell.text.trim()))
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new Error(`aws-bedrock lifecycle table contains an ambiguous model row: ${candidates.map(candidate => candidate.cell.text.trim()).join(', ')}`)
  }
  const value = expected?.text.trim()
  throw new Error(`aws-bedrock lifecycle table contains an invalid model id: ${value || '(empty)'}`)
}

/** Parse AWS Bedrock's model lifecycle table into distributor records. */
export function parseBedrockLifecycleHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('aws-bedrock lifecycle page is empty')

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  let recognisedTables = 0

  for (const table of tables) {
    const rows = expandRows(tableRows(table[1]))
    const headers = bedrockHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++

    let tableRecords = 0
    for (const row of rows.slice(headers.row + 1)) {
      const hasContent = row.cells.some(cell => cell.text)
      if (!hasContent) continue
      const model = bedrockModelCell(row, headers.model)
      const modelCell = model.cell
      const bedrockId = modelCell.text.trim()
      const offset = model.index - headers.model
      const legacyCell = row.cells[headers.legacy + offset]
      const eolCell = row.cells[headers.eol + offset]
      const extendedAccessCell = row.cells[headers.extendedAccess + offset]
      const statusCell = headers.status >= 0 ? row.cells[headers.status + offset] : undefined
      if (!legacyCell || !eolCell || !extendedAccessCell || (headers.status >= 0 && !statusCell)) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} is missing lifecycle columns`)
      }

      const legacy = lifecycleDate(legacyCell, 'legacy', bedrockId)
      const eol = lifecycleDate(eolCell, 'EOL', bedrockId)
      const extendedAccess = lifecycleDate(extendedAccessCell, 'public extended access', bedrockId)
      if (legacy && eol && eol < legacy) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has EOL before legacy date`)
      }
      if (extendedAccess && legacy && extendedAccess < legacy) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has public extended access before legacy date`)
      }
      if (extendedAccess && eol && extendedAccess > eol) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has public extended access after EOL date`)
      }
      // The table schedules Extended Access, so preserve that signal without comparing against the runner clock.
      const status = statusCell
        ? bedrockLifecycleStatus(statusCell, bedrockId)
        : extendedAccess
          ? 'extended-access'
          : 'legacy'
      if (status === 'extended-access' && !extendedAccess) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} reports extended access without a start date`)
      }
      const record = { bedrockId, status }
      if (legacy !== undefined) record.legacy = legacy
      if (eol !== undefined) record.eol = eol
      records.push(record)
      tableRecords++
    }
    if (!tableRecords) throw new Error('aws-bedrock lifecycle table has no model entries')
  }

  if (!recognisedTables) throw new Error('aws-bedrock lifecycle page has no recognised lifecycle table')

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.bedrockId)
    if (!previous) {
      unique.set(record.bedrockId, record)
    } else {
      const merged = mergeRegionalBedrockRecord(previous, record)
      if (!merged) throw new Error(`aws-bedrock lifecycle page has conflicting rows for ${record.bedrockId}`)
      unique.set(record.bedrockId, merged)
    }
  }
  return [...unique.values()]
}

export const parseAwsBedrockLifecycle = parseBedrockLifecycleHtml
export const parseAWSBedrockLifecycle = parseBedrockLifecycleHtml

export function parseBedrockModelCardsIndexHtml(html) {
  const urls = new Set()
  for (const anchor of String(html).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<a\b[^>]*>/gi)) {
    const href = anchor[0].match(/\shref\s*=\s*(["'])(.*?)\1/i)?.[2]
    if (!href || !/^\.\/model-card-[a-z0-9_.-]+\.html$/i.test(href)) continue
    urls.add(new URL(href, BEDROCK_MODEL_CARDS_URL).href)
    if (urls.size > MAX_BEDROCK_MODEL_CARDS) {
      throw new Error(`aws-bedrock index ${BEDROCK_MODEL_CARDS_URL} exceeds ${MAX_BEDROCK_MODEL_CARDS} model cards`)
    }
  }
  if (!urls.size) throw new Error(`aws-bedrock index ${BEDROCK_MODEL_CARDS_URL} has no model card links`)
  return [...urls]
}

const BEDROCK_CARD_LABELS = ['Model launch date', 'EOL no sooner than', 'Legacy period', 'Model lifecycle policy', 'Model EOL date']
const BEDROCK_CARD_MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const BEDROCK_CARD_DAY = new RegExp(`^${BEDROCK_CARD_MONTH} \\d{1,2}, (?:19|20)\\d{2}$`, 'i')
const BEDROCK_CARD_MONTH_ONLY = new RegExp(`^${BEDROCK_CARD_MONTH} (?:19|20)\\d{2}$`, 'i')

function bedrockCardFields(html) {
  const fields = new Map()
  for (const paragraph of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = plainText(paragraph[1])
    const label = BEDROCK_CARD_LABELS.find(candidate => text.startsWith(`${candidate}:`))
    if (!label) continue
    if (fields.has(label)) throw new Error(`duplicate ${label} field`)
    const value = text.slice(label.length + 1).trim()
    if (!value) throw new Error(`empty ${label} field`)
    fields.set(label, value)
  }
  return fields
}

function bedrockCardDate(value, label, allowMonth = false) {
  if (allowMonth && BEDROCK_CARD_MONTH_ONLY.test(value)) return undefined
  if (!BEDROCK_CARD_DAY.test(value)) throw new Error(`unrecognised ${label} date: ${value}`)
  return dateFromText(value)
}

export function parseBedrockModelCardHtml(html, source) {
  try {
    if (typeof html !== 'string' || !html.trim()) throw new Error('empty page')
    const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(table => expandRows(tableRows(table[1])))
    const ids = new Set()
    let recognisedTables = 0
    for (const rows of tables) {
      const header = rows.findIndex(row => row.cells.some(cell => cell.kind === 'th' && cell.text === 'Model ID'))
      if (header < 0) continue
      recognisedTables++
      const columns = rows[header].cells.flatMap((cell, index) => cell.text === 'Model ID' ? [index] : [])
      if (columns.length !== 1) throw new Error('ambiguous Model ID columns')
      let tableIds = 0
      for (const [offset, row] of rows.slice(header + 1).entries()) {
        const id = row.cells[columns[0]]?.text ?? ''
        if (!isBedrockModelId(id)) throw new Error(`invalid Model ID in row ${header + offset + 2}: ${id || '(empty)'}`)
        ids.add(id)
        tableIds++
      }
      if (!tableIds) throw new Error('Model ID table has no entries')
    }
    if (!recognisedTables) throw new Error('no Model ID table')
    const fields = bedrockCardFields(html)
    const skip = reason => ({ records: [], skipped: [{ source, ids: [...ids], reason }] })
    if (!BEDROCK_CARD_LABELS.slice(0, 3).some(label => fields.has(label))) return skip('no lifecycle fields')

    const launch = fields.get('Model launch date')
    if (launch !== undefined) bedrockCardDate(launch, 'Model launch date', true)
    const period = fields.get('Legacy period')
    if (period !== undefined && !/^at least \d+ (?:months?|days)$/.test(period)) throw new Error(`unrecognised Legacy period: ${period}`)
    const floor = fields.get('EOL no sooner than')
    const candidates = []
    if (floor !== undefined) {
      const date = bedrockCardDate(floor, 'EOL no sooner than', true)
      if (date) candidates.push(date)
    }
    const eol = fields.get('Model EOL date')
    let exact
    let legacyField = false
    if (eol !== undefined && eol !== 'N/A') {
      const us = eol.match(/^No sooner than (\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/)
      const legacy = eol.match(/^Legacy: (.+)$/)
      if (us) candidates.push(assertIsoDate(`${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`, 'Model EOL date'))
      else if (legacy) {
        exact = bedrockCardDate(legacy[1], 'Model EOL date')
        legacyField = true
      } else exact = bedrockCardDate(eol, 'Model EOL date')
    }
    const regionDates = []
    for (const cell of tables.flatMap(rows => rows.flatMap(row => row.cells))) {
      if (cell.kind !== 'td' || !cell.text.startsWith('Legacy (EOL:')) continue
      const match = cell.text.match(/^Legacy \(EOL: (\d{4}-\d{2}-\d{2})\)$/)
      if (!match) throw new Error(`unrecognised region EOL: ${cell.text}`)
      const date = assertIsoDate(match[1], 'region EOL')
      if (exact && date !== exact) throw new Error(`region EOL ${date} differs from Model EOL date ${exact}`)
      regionDates.push(date)
    }
    if (!exact && !candidates.length) return skip('no day-precision date')
    const payload = exact
      ? { shutdown: exact, status: regionDates.length || legacyField ? 'legacy' : 'active' }
      : { shutdown: candidates.sort().at(-1), date_precision: 'tentative', status: 'active' }
    return { records: [...ids].map(bedrockId => ({ bedrockId, ...payload, source })), skipped: [] }
  } catch (error) {
    throw new Error(`aws-bedrock model card ${source}: ${error.message}`)
  }
}

function sameLifecycle(left, right) {
  return ['announced', 'shutdown', 'date_precision', 'status'].every(field => left[field] === right[field])
}

export function mergeBedrockSources(legacyRecords, cardRecords) {
  const legacy = new Map(legacyRecords.map(record => [record.bedrockId, { ...record, source: BEDROCK_LIFECYCLE_URL }]))
  const cards = new Map()
  const conflicts = []
  for (const record of cardRecords) {
    const table = legacy.get(record.bedrockId)
    if (table) {
      if (table.eol && record.shutdown && !record.date_precision && table.eol !== record.shutdown) {
        conflicts.push({ via: 'aws-bedrock', id: record.bedrockId, kept: table, discarded: record })
      }
      continue
    }
    const previous = cards.get(record.bedrockId)
    if (previous && !sameLifecycle(previous, record)) {
      throw new Error(`aws-bedrock cards conflict for ${previous.bedrockId} (${previous.source}) and ${record.bedrockId} (${record.source})`)
    }
    if (!previous) cards.set(record.bedrockId, record)
  }
  return { records: [...legacy.values(), ...cards.values()], conflicts }
}

export function skippedModelCardSummary(card) {
  return `aws-bedrock model card ${card.source}: skipped ${card.ids.join(', ')}; ${card.reason}`
}

function vertexModelId(fragment) {
  const code = [...String(fragment).matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)]
    .map(match => plainText(match[1]))
    .find(Boolean)
  const value = code ?? plainText(fragment)
  const id = value.replace(/\s*\*+$/, '').trim()
  return id && !/\s/.test(id) ? id : undefined
}

function vertexDate(cell, modelId) {
  if (!cell || missingDate(cell.text)) return undefined
  const date = dateFromText(cell.text)
  if (!date) throw new Error(`vertex-ai lifecycle entry ${modelId} has an unrecognised retirement date: ${cell.text}`)
  return date
}

function vertexDatePrecision(html, text) {
  return /earliest\s+possible|retirement\s+timelines?\s+may\s+be\s+extended|not\s+(?:be\s+)?moved\s+to\s+an\s+earlier\s+date|or\s+later|no\s+sooner\s+than/i.test(`${plainText(html)} ${text}`)
    ? 'earliest'
    : undefined
}

/** Parse Vertex model versions and lifecycle tables. */
export function parseVertexModelVersionsHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('vertex-ai lifecycle page is empty')

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  let recognisedTables = 0
  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = vertexHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) continue
      const modelId = vertexModelId(modelCell.html)
      if (!modelId) continue
      const retirementCell = row.cells[headers.eol]
      if (!retirementCell) throw new Error(`vertex-ai lifecycle entry ${modelId} is missing retirement date`)
      const shutdown = vertexDate(retirementCell, modelId)
      const record = { vertexId: modelId }
      if (shutdown) {
        record.shutdown = shutdown
        const precision = vertexDatePrecision(html, retirementCell.text)
        if (precision) record.date_precision = precision
      }
      records.push(record)
    }
  }

  if (!recognisedTables) throw new Error('vertex-ai lifecycle page has no recognised model table')
  if (!records.length) throw new Error('vertex-ai lifecycle page has no model entries')

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.vertexId)
    if (!previous) {
      unique.set(record.vertexId, record)
      continue
    }
    const same = previous.shutdown === record.shutdown && previous.date_precision === record.date_precision
    if (!same) throw new Error(`vertex-ai lifecycle page has conflicting rows for ${record.vertexId}`)
  }
  return [...unique.values()]
}

export const parseVertexLifecycleHtml = parseVertexModelVersionsHtml
export const parseVertexModelLifecycle = parseVertexModelVersionsHtml
export const parseVertexModelVersions = parseVertexModelVersionsHtml

const AZURE_LIFECYCLE_STATUSES = new Map([
  ['GA', 'active'],
  ['Preview', 'active'],
  ['Legacy', 'active'],
  ['Deprecated', 'legacy'],
  ['Retired', 'retired'],
])

function azureHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const fineTuning = ['model', 'version', 'training retirement date', 'deployment retirement date']
    if (labels.length === fineTuning.length && fineTuning.every(label => labels.includes(label))) return undefined
    if (!labels.includes('model') && !labels.includes('lifecycle')) continue
    const columns = ['model', 'version', 'lifecycle', 'retirement date', 'replacement']
    if (labels.length !== columns.length || columns.some(label => !labels.includes(label))) {
      throw new Error(`azure-ai-foundry lifecycle table has invalid header row: ${labels.join(' | ')}`)
    }
    return { row, indexes: columns.map(label => labels.indexOf(label)) }
  }
  return undefined
}

function azureIsoDate(value, label) {
  try {
    return assertIsoDate(value, label)
  } catch {
    throw new Error(`azure-ai-foundry lifecycle entry ${label} has an invalid date: ${value || '(empty)'}`)
  }
}

export function parseAzureModelRetirementScheduleHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('azure-ai-foundry lifecycle page is empty')
  let group = ''
  let section = ''
  let recognisedTables = 0
  const unique = new Map()
  const conflicts = []
  const blocks = html.matchAll(/<(h[123]|table)\b[^>]*>([\s\S]*?)<\/\1>/gi)
  for (const block of blocks) {
    const tag = block[1].toLowerCase()
    if (tag !== 'table') {
      if (tag === 'h3') section = plainText(block[2])
      else {
        group = plainText(block[2])
        section = ''
      }
      continue
    }
    const rows = tableRows(block[2])
    const headers = azureHeaderIndexes(rows)
    if (!headers) continue
    recognisedTables++
    let tableRecords = 0
    for (const row of rows.slice(headers.row + 1)) {
      if (!row.cells.some(cell => cell.text)) continue
      const [modelCell, versionCell, lifecycleCell, retirementCell] = headers.indexes.map(index => row.cells[index])
      const label = `${section || '(missing section)'}/${modelCell?.text || '(empty)'} version ${versionCell?.text || '(empty)'}`
      if (!section) throw new Error(`azure-ai-foundry lifecycle entry ${label} is missing a publisher section`)
      if (row.cells.length !== headers.indexes.length) {
        throw new Error(`azure-ai-foundry lifecycle entry ${label} is missing lifecycle columns or has extra cells`)
      }
      const modelId = modelCell.text.replace(/\s*\([^()]*\)\s*$/, '').trim()
      const publisher = AZURE_PUBLISHER_BY_SECTION.get(section)
      const validId = MODEL_ID_PATTERN.test(modelId)
      if (!validId && publisher) throw new Error(`azure-ai-foundry lifecycle entry ${label} has an invalid model id`)
      const version = versionCell.text
      const datedVersion = /^\d{4}-\d{2}-\d{2}$/.test(version)
      if (datedVersion) azureIsoDate(version, `${label} version`)
      else if (!/^(?:\d+|-)$/.test(version)) {
        throw new Error(`azure-ai-foundry lifecycle entry ${label} has an unsupported version: ${version || '(empty)'}`)
      }
      const lifecycle = lifecycleCell.text
      const status = AZURE_LIFECYCLE_STATUSES.get(lifecycle)
      if (!status) throw new Error(`azure-ai-foundry lifecycle entry ${label} has an unsupported lifecycle status: ${lifecycle || '(empty)'}`)
      const retirement = retirementCell.text
      const shutdown = retirement === '-' ? undefined : azureIsoDate(retirement, `${label} retirement`)
      const azureId = publisher === 'openai' && datedVersion ? `${modelId}-${version}` : modelId
      const record = { azureId, modelId, version, group, section, lifecycle, status }
      if (publisher) record.publisher = publisher
      if (!validId) record.reason = 'invalid model id'
      if (shutdown !== undefined) record.shutdown = shutdown
      const key = JSON.stringify(publisher ? [section, azureId] : [group, section, azureId, version])
      const previous = unique.get(key)
      if (!previous) unique.set(key, record)
      else if (previous.shutdown !== shutdown || previous.lifecycle !== lifecycle) {
        if (!previous.shutdown || !shutdown || previous.shutdown === shutdown) {
          throw new Error(`azure-ai-foundry lifecycle entry ${label} has conflicting rows without distinct retirement dates`)
        }
        const kept = previous.shutdown < shutdown ? previous : record
        const discarded = kept === previous ? record : previous
        conflicts.push({ via: 'azure-ai-foundry', section, id: azureId, kept, discarded })
        unique.set(key, kept)
      }
      tableRecords++
    }
    if (!tableRecords) throw new Error(`azure-ai-foundry lifecycle table for ${section} has no model entries`)
  }
  if (!recognisedTables) throw new Error('azure-ai-foundry lifecycle page has no recognised lifecycle table')
  return { records: [...unique.values()], conflicts }
}

export function sourceConflictSummary(conflict) {
  if (conflict.via === 'aws-bedrock') {
    return `${conflict.via} ${conflict.id}: kept ${conflict.kept.eol} (${conflict.kept.source}); discarded ${conflict.discarded.shutdown} (${conflict.discarded.source}); legacy table wins`
  }
  const row = item => `${item.shutdown} (${item.lifecycle}, version ${item.version})`
  return `${conflict.via} ${conflict.section}/${conflict.id}: kept ${row(conflict.kept)}; discarded ${row(conflict.discarded)}; earliest retirement wins`
}

const PUBLISHER_BY_NAMESPACE = new Map([
  ['anthropic', 'anthropic'],
  ['amazon', 'amazon'],
  ['openai', 'openai'],
  ['google', 'google'],
  ['cohere', 'cohere'],
  ['mistral', 'mistral'],
])

function sourceNamespace(value, via) {
  if (via === 'aws-bedrock') return value.match(/^([^.]+)\./)?.[1].toLowerCase()
  return value.match(/^publishers\/([^/]+)\/models\//i)?.[1].toLowerCase()
}

function expectedPublisher(namespace) {
  return namespace ? PUBLISHER_BY_NAMESPACE.get(namespace) : undefined
}

/** Convert a Bedrock model ID to the publisher ID used by a feed. */
export function normalizeBedrockId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Bedrock model id must be a non-empty string')
  }
  const input = value.trim()
  const separator = input.indexOf('.')
  const withoutProvider = separator > 0 ? input.slice(separator + 1) : input
  const normalized = withoutProvider.replace(/(?:-v\d+(?::\d+)?|:\d+)$/i, '')
  if (!normalized) throw new Error(`Bedrock model id has no publisher portion: ${value}`)
  return normalized
}

export const normaliseBedrockId = normalizeBedrockId

export function normalizeVertexId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Vertex model id must be a non-empty string')
  }
  return value.trim().replace(/^publishers\/[^/]+\/models\//, '')
}

export const normaliseVertexId = normalizeVertexId

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function feedParts(feeds) {
  if (Array.isArray(feeds)) return feeds.map((item, index) => {
    if (item?.feed && Array.isArray(item.feed.models)) {
      return { feed: item.feed, publisher: item.provider?.publisher ?? item.feed.publisher ?? `feed-${index}` }
    }
    if (item && Array.isArray(item.models)) return { feed: item, publisher: item.publisher ?? `feed-${index}` }
    throw new Error('distributor merge received a feed without a models array')
  })
  if (feeds && typeof feeds === 'object') return feedParts(Object.values(feeds))
  throw new Error('distributor merge requires one or more publisher feeds')
}

function dateField(value, field, modelId, via) {
  if (value === undefined) return undefined
  try {
    assertIsoDate(value, `${via} record ${modelId} ${field}`)
  } catch {
    throw new Error(`${via} record ${modelId} has an invalid ${field} date`)
  }
  return value
}

function precisionField(value, modelId, via) {
  if (value === undefined) return undefined
  if (!['exact', 'earliest', 'tentative'].includes(value)) {
    throw new Error(`${via} record ${modelId} has an invalid date_precision`)
  }
  return value
}

function statusField(value, modelId, via) {
  if (value === undefined) return undefined
  if (!['active', 'legacy', 'extended-access', 'retired'].includes(value)) {
    throw new Error(`${via} record ${modelId} has an invalid status`)
  }
  return value
}

function recordForMerge(record, via) {
  const isBedrock = via === 'aws-bedrock'
  const isAzure = via === 'azure-ai-foundry'
  const idField = isBedrock ? 'bedrockId' : isAzure ? 'azureId' : 'vertexId'
  const rawId = isBedrock ? record?.bedrockId : isAzure ? record?.azureId : record?.vertexId ?? record?.modelId ?? record?.id
  const publisher = isAzure ? AZURE_PUBLISHER_BY_SECTION.get(record?.section) : undefined
  if (typeof rawId !== 'string' || (!rawId.trim() && (!isAzure || publisher))) {
    throw new Error(`${via} record is missing ${idField}`)
  }
  const sourceId = rawId.trim()
  const announcedValue = isBedrock ? record.legacy : record.announced
  const shutdownValue = isBedrock ? record.eol ?? record.shutdown : record.shutdown ?? record.retirement
  const announced = dateField(announcedValue, isBedrock ? 'legacy' : 'announced', sourceId, via)
  const shutdown = dateField(shutdownValue, isBedrock ? 'EOL' : 'retirement', sourceId, via)
  if (announced && shutdown && shutdown < announced) {
    throw new Error(`${via} record ${sourceId} has shutdown before announced`)
  }
  const namespace = isAzure ? record.section : sourceNamespace(sourceId, via)
  return {
    idField,
    sourceId,
    namespace,
    expectedPublisher: isAzure ? publisher : expectedPublisher(namespace),
    normalizedId: isBedrock ? normalizeBedrockId(sourceId) : isAzure ? sourceId : normalizeVertexId(sourceId),
    announced,
    shutdown,
    date_precision: precisionField(record.date_precision, sourceId, via),
    status: statusField(record.status, sourceId, via),
  }
}

function withoutDistributions(model) {
  const copy = clone(model)
  delete copy.distributions
  return copy
}

function distributionFor(model, via) {
  const distributions = Array.isArray(model.distributions) ? model.distributions : []
  const indexes = distributions
    .map((distribution, index) => distribution?.via === via ? index : -1)
    .filter(index => index >= 0)
  if (indexes.length > 1) throw new Error(`model ${model.id} has duplicate ${via} distributions`)
  return indexes.length ? { index: indexes[0], value: distributions[indexes[0]] } : undefined
}

function assertDistributorPreserved(before, after, via) {
  const afterById = new Map((after.models ?? []).map(model => [model.id, model]))
  for (const oldModel of before.models ?? []) {
    const nextModel = afterById.get(oldModel.id)
    if (!nextModel) throw new Error(`${via} merge would drop committed model ${oldModel.id}`)
    if (JSON.stringify(withoutDistributions(oldModel)) !== JSON.stringify(withoutDistributions(nextModel))) {
      throw new Error(`${via} merge modified entry-level fields for ${oldModel.id}`)
    }
    const oldForeign = (oldModel.distributions ?? []).filter(distribution => distribution?.via !== via)
    const nextForeign = (nextModel.distributions ?? []).filter(distribution => distribution?.via !== via)
    if (JSON.stringify(oldForeign) !== JSON.stringify(nextForeign)) {
      throw new Error(`${via} merge modified foreign distributions for ${oldModel.id}`)
    }
  }
}

/** Upsert one distributor clock across loaded publisher feeds. */
export function mergeDistributions(feeds, {
  records = [],
  sourceUrl,
  via,
} = {}) {
  if (typeof via === 'string' && ['publisher', 'publisher-fallback'].includes(via.toLowerCase())) {
    throw new Error(`reserved distributor clock ${via}`)
  }
  if (!via || !DISTRIBUTORS[via]) throw new Error(`unknown distributor ${via || '(empty)'}`)
  const config = DISTRIBUTORS[via]
  const source = sourceUrl ?? config.sourceUrl
  try {
    new URL(source)
  } catch {
    throw new Error(`${via} source is not a URL: ${source}`)
  }
  if (!Array.isArray(records)) throw new Error(`${via} merge records must be an array`)

  const parts = feedParts(feeds)
  const working = parts.map(part => ({
    publisher: part.publisher,
    before: clone(part.feed),
    feed: clone(part.feed),
  }))
  const identity = new Map()
  for (const [feedIndex, part] of working.entries()) {
    for (const model of part.feed.models) {
      for (const key of [model.id, ...(model.aliases ?? [])]) {
        if (!key) continue
        const previous = identity.get(key)
        if (previous && (previous.model !== model || previous.feedIndex !== feedIndex)) {
          throw new Error(`publisher feeds have an ambiguous id or alias: ${key}`)
        }
        identity.set(key, { feedIndex, model, publisher: part.publisher })
      }
    }
  }

  const unmatched = []
  const unconfirmedDistributions = []
  const confirmed = new Set()
  const matchedRecords = new Map()
  for (const raw of records) {
    const record = recordForMerge(raw, via)
    const unmatchedItem = { normalizedId: record.normalizedId, [record.idField]: record.sourceId }
    if (record.idField === 'azureId') {
      unmatchedItem.section = raw.section
      if (raw.reason) unmatchedItem.reason = raw.reason
    }
    if (record.idField === 'vertexId') unmatchedItem.modelId = record.sourceId
    if ((via === 'azure-ai-foundry' || record.namespace) && !record.expectedPublisher) {
      unmatched.push(unmatchedItem)
      continue
    }
    const target = identity.get(record.normalizedId)
    if (!target) {
      if (via === 'azure-ai-foundry') {
        unconfirmedDistributions.push({
          publisher: record.expectedPublisher,
          id: record.normalizedId,
          via,
          reason: 'source model is absent from publisher feed',
        })
      } else unmatched.push(unmatchedItem)
      continue
    }
    if (record.expectedPublisher && target.publisher !== record.expectedPublisher) {
      throw new Error(`${via} namespace ${record.namespace} binds to ${record.expectedPublisher}, but normalized id ${record.normalizedId} matched the ${target.publisher} feed`)
    }

    const targetKey = `${target.feedIndex}:${target.model.id}`
    const priorRecord = matchedRecords.get(targetKey)
    if (priorRecord && !sameLifecycle(priorRecord, record)) {
      throw new Error(`${via} records ${priorRecord.sourceId} and ${record.sourceId} map to ${target.model.id} with conflicting lifecycle data`)
    }
    if (priorRecord) continue
    matchedRecords.set(targetKey, record)

    const existing = distributionFor(target.model, via)
    const distribution = { via }
    if (record.announced !== undefined) distribution.announced = record.announced
    if (record.shutdown !== undefined) distribution.shutdown = record.shutdown
    if (record.date_precision !== undefined) distribution.date_precision = record.date_precision
    if (record.status !== undefined) distribution.status = record.status
    distribution.source = raw.source ?? source
    try {
      new URL(distribution.source)
    } catch {
      throw new Error(`${via} record ${record.sourceId} source is not a URL: ${distribution.source}`)
    }
    if (existing) {
      target.model.distributions[existing.index] = distribution
    } else {
      if (!Array.isArray(target.model.distributions)) target.model.distributions = []
      target.model.distributions.push(distribution)
    }
    confirmed.add(targetKey)
  }

  for (const [feedIndex, part] of working.entries()) {
    for (const model of part.feed.models) {
      const existing = distributionFor(model, via)
      const key = `${feedIndex}:${model.id}`
      if (existing && !confirmed.has(key)) {
        unconfirmedDistributions.push({
          publisher: part.publisher,
          id: model.id,
          via,
          distribution: clone(existing.value),
        })
      }
    }
    assertDistributorPreserved(part.before, part.feed, via)
  }

  unmatched.sort((a, b) => `${a.bedrockId ?? a.vertexId ?? a.azureId}`.localeCompare(`${b.bedrockId ?? b.vertexId ?? b.azureId}`))
  unconfirmedDistributions.sort((a, b) => `${a.publisher}:${a.id}`.localeCompare(`${b.publisher}:${b.id}`))
  return {
    feeds: working.map(part => part.feed),
    noPublisherFeed: unmatched,
    noPublisherFeeds: unmatched,
    unconfirmedDistributions,
  }
}

export function mergeBedrockDistributions(feeds, options = {}) {
  return mergeDistributions(feeds, {
    ...options,
    via: options.via ?? 'aws-bedrock',
    sourceUrl: options.sourceUrl ?? BEDROCK_LIFECYCLE_URL,
  })
}

export function mergeVertexDistributions(feeds, options = {}) {
  return mergeDistributions(feeds, {
    ...options,
    via: options.via ?? 'vertex-ai',
    sourceUrl: options.sourceUrl ?? VERTEX_MODEL_VERSIONS_URL,
  })
}

export function findDistributorFixture(dir, distributor = 'aws-bedrock') {
  const config = DISTRIBUTORS[distributor]
  if (!config) throw new Error(`unknown distributor ${distributor}`)
  if (!dir) return undefined
  const root = path.resolve(dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`fixtures directory does not exist: ${dir}`)
  }
  const candidates = [config.fixture, `${distributor}.html`, `${distributor}-lifecycle.html`]
  for (const filename of candidates) {
    const candidate = path.join(root, filename)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  throw new Error(`missing ${distributor} fixture in ${dir}`)
}

async function fetchBody(url, distributor, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    const response = await fetchImpl(url, { headers: { 'accept-language': 'en' }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const tooLarge = () => new Error(`response exceeds ${MAX_DISTRIBUTOR_BODY_BYTES} bytes`)
    if (Number(response.headers?.get('content-length')) > MAX_DISTRIBUTOR_BODY_BYTES) throw tooLarge()
    const chunks = []
    let bytes = 0
    if (response.body) {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > MAX_DISTRIBUTOR_BODY_BYTES) throw tooLarge()
        chunks.push(Buffer.from(chunk))
      }
    } else {
      const chunk = Buffer.from(await response.text())
      if (chunk.byteLength > MAX_DISTRIBUTOR_BODY_BYTES) throw tooLarge()
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    if (!body.trim()) throw new Error('empty response')
    return body
  } catch (error) {
    controller.abort()
    throw new Error(`${distributor} fetch failed for ${url}: ${error.message}`)
  } finally {
    clearTimeout(timeout)
  }
}

function readBedrockCardFixture(dir, filename, url) {
  try {
    return fs.readFileSync(path.join(dir, filename), 'utf8')
  } catch (error) {
    throw new Error(`aws-bedrock missing or unreadable fixture ${filename} for ${url}: ${error.message}`)
  }
}

async function loadBedrockCards(config, options) {
  const index = options.fixtures
    ? readBedrockCardFixture(options.fixtures, config.indexFixture, config.indexUrl)
    : await fetchBody(config.indexUrl, config.name, options.fetchImpl)
  const records = []
  const skipped = []
  for (const url of parseBedrockModelCardsIndexHtml(index)) {
    const html = options.fixtures
      ? readBedrockCardFixture(options.fixtures, path.join(config.cardFixtureDir, path.basename(new URL(url).pathname)), url)
      : await fetchBody(url, config.name, options.fetchImpl)
    const parsed = parseBedrockModelCardHtml(html, url)
    records.push(...parsed.records)
    skipped.push(...parsed.skipped)
  }
  return { records, skipped }
}

export async function loadDistributorSource(distributor = 'aws-bedrock', options = {}) {
  const config = DISTRIBUTORS[distributor]
  if (!config) throw new Error(`unknown distributor ${distributor}`)
  let html
  let fixturePath
  if (options.fixtures) {
    fixturePath = findDistributorFixture(options.fixtures, distributor)
    html = fs.readFileSync(fixturePath, 'utf8')
    ;(options.notice ?? console.error)(`notice: ${distributor} lifecycle fixture: ${path.relative(process.cwd(), fixturePath)}`)
  } else {
    html = await fetchBody(config.sourceUrl, distributor, options.fetchImpl)
  }
  let parsed = distributor === 'azure-ai-foundry'
    ? parseAzureModelRetirementScheduleHtml(html)
    : { records: distributor === 'aws-bedrock' ? parseBedrockLifecycleHtml(html) : parseVertexModelVersionsHtml(html) }
  if (distributor === 'aws-bedrock') {
    const cards = await loadBedrockCards(config, options)
    parsed = { ...mergeBedrockSources(parsed.records, cards.records), skipped: cards.skipped }
  }
  for (const conflict of parsed.conflicts ?? []) {
    ;(options.notice ?? console.error)(`notice: ${sourceConflictSummary(conflict)}`)
  }
  for (const card of parsed.skipped ?? []) {
    ;(options.notice ?? console.error)(`notice: ${skippedModelCardSummary(card)}`)
  }
  return {
    ...config,
    fixturePath,
    ...parsed,
  }
}
