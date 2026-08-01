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
}

const DATE_PATTERN = /\b((?:19|20)\d{2})[-‐‑‒–\u2014−](\d{1,2})[-‐‑‒–\u2014−](\d{1,2})\b/
const HUMAN_DATE_PATTERN = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+((?:19|20)\d{2})\b/i
const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4], ['may', 5], ['jun', 6],
  ['jul', 7], ['aug', 8], ['sep', 9], ['sept', 9], ['oct', 10], ['nov', 11], ['dec', 12],
])

function pad(number) {
  return String(number).padStart(2, '0')
}

function validDate(year, month, day) {
  const candidate = `${year}-${pad(month)}-${pad(day)}`
  const parsed = new Date(`${candidate}T00:00:00Z`)
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) return undefined
  return candidate
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

function dateFromText(text) {
  const normalised = plainText(text)
  const iso = normalised.match(DATE_PATTERN)
  if (iso) {
    const date = validDate(iso[1], iso[2], iso[3])
    if (!date) throw new Error(`invalid date "${iso[0]}"`)
    return date
  }
  const human = normalised.match(HUMAN_DATE_PATTERN)
  if (human) {
    const month = MONTHS.get(human[1].toLowerCase().slice(0, 4)) ?? MONTHS.get(human[1].toLowerCase().slice(0, 3))
    const date = validDate(human[3], month, human[2])
    if (!date) throw new Error(`invalid date "${human[0]}"`)
    return date
  }
  return undefined
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

function replacement(fragment) {
  const text = plainText(fragment)
  if (!text || /^[-–\u2014]$/.test(text)) return undefined
  return text
}

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
    const model = labels.findIndex(label => /model|deprecated|system|endpoint/i.test(label))
    const recommended = labels.findIndex(label => /recommended\s+replacement|replacement|successor/i.test(label))
    if (date >= 0 && model >= 0 && recommended >= 0) return { row: index, date, model, recommended }
  }
  return undefined
}

function announcementDate(html, tableStart) {
  const before = html.slice(0, tableStart)
  const headings = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
  const heading = headings.at(-1)
  const fromHeading = heading ? dateFromText(heading[1]) : undefined
  if (fromHeading) return fromHeading
  const segmentStart = heading ? heading.index + heading[0].length : Math.max(0, before.length - 6000)
  return dateFromText(before.slice(segmentStart))
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
  let recognisedTables = 0
  for (const table of tables) {
    const rows = tableRows(table[1])
    const headers = headerIndexes(rows)
    if (!headers) continue
    recognisedTables++
    const announced = announcementDate(html, table.index)
    if (!announced) {
      throw new Error(`${provider} deprecations table has no announcement date`)
    }
    for (const row of rows.slice(headers.row + 1)) {
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) continue
      const id = modelId(modelCell.html)
      if (!id) throw new Error(`${provider} deprecations table contains a row without a model id`)
      const shutdownCell = row.cells[headers.date]
      const shutdown = shutdownCell ? dateFromText(shutdownCell.text) : undefined
      if (!shutdown) throw new Error(`${provider} deprecations entry ${id} has no valid shutdown date`)
      const replacementCell = headers.recommended >= 0 ? row.cells[headers.recommended] : undefined
      const item = { id, announced, shutdown, source: sourceUrl }
      const nextReplacement = replacementCell ? replacement(replacementCell.html) : undefined
      if (nextReplacement) item.replacement = nextReplacement
      if (item.announced && item.shutdown < item.announced) {
        throw new Error(`${provider} deprecations entry ${id} has shutdown before announcement`)
      }
      records.push(item)
    }
  }

  if (!recognisedTables) throw new Error(`${provider} deprecations page has no recognised model tables`)
  if (!records.length) throw new Error(`${provider} deprecations page has no model entries`)

  const unique = new Map()
  for (const record of records) {
    const previous = unique.get(record.id)
    if (!previous) {
      unique.set(record.id, record)
      continue
    }
    const same = previous.announced === record.announced &&
      previous.shutdown === record.shutdown &&
      previous.replacement === record.replacement
    if (!same) throw new Error(`${provider} deprecations page has conflicting rows for ${record.id}`)
  }
  return [...unique.values()]
}

export const parseOpenAIDeprecations = (html, sourceUrl = PROVIDERS.openai.deprecationsUrl) =>
  parseDeprecationsHtml(html, sourceUrl, 'openai')

export const parseAnthropicDeprecations = (html, sourceUrl = PROVIDERS.anthropic.deprecationsUrl) =>
  parseDeprecationsHtml(html, sourceUrl, 'anthropic')

/** Parse the JSON response returned by a provider's models endpoint. */
export function parseModelsResponse(body, provider = 'provider') {
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
  return ids
}

export const parseOpenAIModels = body => parseModelsResponse(body, 'openai')
export const parseAnthropicModels = body => parseModelsResponse(body, 'anthropic')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function identityIndex(models) {
  const index = new Map()
  for (const model of models) {
    for (const key of [model.id, ...(model.aliases ?? [])]) {
      if (!key) continue
      if (!index.has(key)) index.set(key, model)
    }
  }
  return index
}

/**
 * Merge source records into a committed feed without deleting any committed
 * entry. The endpoint argument is null when credentials were unavailable and
 * an empty array when the endpoint explicitly returned no models.
 */
export function mergeFeed(committed, { deprecations = [], currentIds = null, generated, provider }) {
  if (!committed || !Array.isArray(committed.models)) throw new Error('committed feed has no models array')
  const models = committed.models.map(clone)
  const confirmed = new Set()
  const deprecationConfirmed = new Set()
  let index = identityIndex(models)

  const locate = id => index.get(id)
  const add = model => {
    models.push(model)
    index = identityIndex(models)
    return model
  }

  for (const record of deprecations) {
    let target = locate(record.id)
    if (!target) target = add({ id: record.id })

    for (const field of ['announced', 'shutdown', 'replacement']) delete target[field]
    Object.assign(target, clone(record))
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
        for (const field of ['announced', 'shutdown', 'replacement']) delete target[field]
      }
      confirmed.add(target.id)
    }
  }

  // This is deliberately an assertion rather than a filter. A future change
  // that accidentally removes an old entry must fail before any output write.
  const finalIndex = identityIndex(models)
  for (const old of committed.models) {
    if (!finalIndex.get(old.id)) throw new Error(`merge would drop committed model ${old.id}`)
  }

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
    response = await fetchImpl(url, { headers })
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
    currentIds = parseModelsResponse(fs.readFileSync(modelFixture, 'utf8'), config.publisher)
    endpointAvailable = true
    notice(`notice: ${config.publisher} models endpoint fixture: ${path.relative(process.cwd(), modelFixture)}`)
  } else {
    const key = env[config.keyEnv]
    if (!key) {
      notice(`notice: ${config.keyEnv} is unset; skipping ${config.publisher} models endpoint and preserving committed entries`)
    } else {
      const headers = { ...config.headers }
      if (config.publisher === 'openai') headers.Authorization = `Bearer ${key}`
      if (config.publisher === 'anthropic') headers['x-api-key'] = key
      const body = await fetchBody(config.modelsUrl, headers, config.publisher, fetchImpl)
      currentIds = parseModelsResponse(body, config.publisher)
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

  const deprecations = parseDeprecationsHtml(html, config.deprecationsUrl, config.publisher)
  return { currentIds, endpointAvailable, deprecations }
}
