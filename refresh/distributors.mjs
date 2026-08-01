import fs from 'node:fs'
import path from 'node:path'

import { dateFromText } from './providers.mjs'

export const BEDROCK_LIFECYCLE_URL = 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle.html'
export const VERTEX_MODEL_VERSIONS_URL = 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions'
export const VERTEX_LIFECYCLE_URL = VERTEX_MODEL_VERSIONS_URL

export const DISTRIBUTORS = {
  'aws-bedrock': {
    name: 'aws-bedrock',
    sourceUrl: BEDROCK_LIFECYCLE_URL,
    fixture: 'bedrock-lifecycle.html',
  },
  'vertex-ai': {
    name: 'vertex-ai',
    sourceUrl: VERTEX_MODEL_VERSIONS_URL,
    fixture: 'vertex-model-versions.html',
  },
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

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

function headerIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const model = labels.findIndex(label => /\bmodel\s+(?:id|identifier)\b/i.test(label))
    const legacy = labels.findIndex(label => /\blegacy\b.*\bdate\b|\bdate\b.*\blegacy\b/i.test(label))
    const eol = labels.findIndex(label => (
      /\beol\b.*\bdate\b|\bdate\b.*\beol\b/i.test(label) ||
      /end\s*[- ]?of\s*[- ]?life.*\bdate\b|\bdate\b.*end\s*[- ]?of\s*[- ]?life/i.test(label) ||
      /\b(?:retirement|discontinuation)\b.*\bdate\b|\bdate\b.*\b(?:retirement|discontinuation)\b/i.test(label)
    ))
    if (model >= 0 && legacy >= 0 && eol >= 0) return { row, model, legacy, eol }
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

function vertexHeaderIndexes(rows) {
  for (const [row, candidate] of rows.entries()) {
    const labels = candidate.cells.map(cell => cell.text.toLowerCase())
    const model = labels.findIndex(label => /\bmodel\s+(?:id|identifier)\b/i.test(label))
    const retirement = labels.findIndex(label => /\b(?:retirement|discontinuation)\b.*\bdate\b|\bdate\b.*\b(?:retirement|discontinuation)\b/i.test(label))
    if (model >= 0 && retirement >= 0) return { row, model, eol: retirement }
  }
  return undefined
}

function sameRecord(left, right) {
  return left.bedrockId === right.bedrockId &&
    left.legacy === right.legacy &&
    left.eol === right.eol
}

/** Parse AWS Bedrock's model lifecycle table into distributor records. */
export function parseBedrockLifecycleHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new Error('aws-bedrock lifecycle page is empty')

  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
  const records = []
  let recognisedTables = 0

  for (const table of tables) {
    const rows = expandRows(tableRows(table[1]))
    const headers = headerIndexes(rows)
    if (!headers) continue
    recognisedTables++

    let tableRecords = 0
    for (const row of rows.slice(headers.row + 1)) {
      const hasContent = row.cells.some(cell => cell.text)
      if (!hasContent) continue
      const modelCell = row.cells[headers.model]
      if (!modelCell || !modelCell.text) {
        throw new Error('aws-bedrock lifecycle table contains a row without a model id')
      }
      const bedrockId = modelCell.text.trim()
      if (!bedrockId || /\s/.test(bedrockId) || !bedrockId.includes('.')) {
        throw new Error(`aws-bedrock lifecycle table contains an invalid model id: ${bedrockId || '(empty)'}`)
      }
      if (!row.cells[headers.legacy] || !row.cells[headers.eol]) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} is missing lifecycle columns`)
      }

      const legacy = lifecycleDate(row.cells[headers.legacy], 'legacy', bedrockId)
      const eol = lifecycleDate(row.cells[headers.eol], 'EOL', bedrockId)
      if (legacy && eol && eol < legacy) {
        throw new Error(`aws-bedrock lifecycle entry ${bedrockId} has EOL before legacy date`)
      }
      const record = { bedrockId }
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
    } else if (!sameRecord(previous, record)) {
      throw new Error(`aws-bedrock lifecycle page has conflicting rows for ${record.bedrockId}`)
    }
  }
  return [...unique.values()]
}

export const parseAwsBedrockLifecycle = parseBedrockLifecycleHtml
export const parseAWSBedrockLifecycle = parseBedrockLifecycleHtml

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

/**
 * Convert a Bedrock model ID to the publisher ID used by a feed. Bedrock
 * namespaces are intentionally treated generically so a future provider does
 * not require a parser change just to remove its namespace.
 */
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
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new Error(`${via} record ${modelId} has an invalid ${field} date`)
  }
  return value
}

function precisionField(value, modelId, via) {
  if (value === undefined) return undefined
  if (!['exact', 'earliest'].includes(value)) {
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
  const idField = isBedrock ? 'bedrockId' : 'vertexId'
  const rawId = isBedrock ? record?.bedrockId : record?.vertexId ?? record?.modelId ?? record?.id
  if (typeof rawId !== 'string' || !rawId.trim()) {
    throw new Error(`${via} record is missing ${idField}`)
  }
  const sourceId = rawId.trim()
  const announcedValue = isBedrock ? record.legacy : record.announced
  const shutdownValue = isBedrock ? record.eol : record.shutdown ?? record.retirement
  const announced = dateField(announcedValue, isBedrock ? 'legacy' : 'announced', sourceId, via)
  const shutdown = dateField(shutdownValue, isBedrock ? 'EOL' : 'retirement', sourceId, via)
  if (announced && shutdown && shutdown < announced) {
    throw new Error(`${via} record ${sourceId} has shutdown before announced`)
  }
  return {
    idField,
    sourceId,
    normalizedId: isBedrock ? normalizeBedrockId(sourceId) : normalizeVertexId(sourceId),
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
        identity.set(key, { feedIndex, model })
      }
    }
  }

  const unmatched = []
  const confirmed = new Set()
  const matchedRecords = new Map()
  for (const raw of records) {
    const record = recordForMerge(raw, via)
    const target = identity.get(record.normalizedId)
    if (!target) {
      const item = { normalizedId: record.normalizedId, [record.idField]: record.sourceId }
      if (record.idField === 'vertexId') item.modelId = record.sourceId
      unmatched.push(item)
      continue
    }

    const targetKey = `${target.feedIndex}:${target.model.id}`
    const priorRecord = matchedRecords.get(targetKey)
    if (priorRecord && (
      priorRecord.announced !== record.announced ||
      priorRecord.shutdown !== record.shutdown ||
      priorRecord.date_precision !== record.date_precision ||
      priorRecord.status !== record.status
    )) {
      throw new Error(`${via} records map to ${target.model.id} with conflicting dates`)
    }
    matchedRecords.set(targetKey, record)

    const existing = distributionFor(target.model, via)
    const distribution = { via }
    if (record.announced !== undefined) distribution.announced = record.announced
    if (record.shutdown !== undefined) distribution.shutdown = record.shutdown
    if (record.date_precision !== undefined) distribution.date_precision = record.date_precision
    if (record.status !== undefined) distribution.status = record.status
    distribution.source = source
    if (existing) {
      target.model.distributions[existing.index] = distribution
    } else {
      if (!Array.isArray(target.model.distributions)) target.model.distributions = []
      target.model.distributions.push(distribution)
    }
    confirmed.add(targetKey)
  }

  const unconfirmedDistributions = []
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

  unmatched.sort((a, b) => `${a.bedrockId ?? a.vertexId}`.localeCompare(`${b.bedrockId ?? b.vertexId}`))
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
  let response
  try {
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    response = await fetchImpl(url, { headers: { 'accept-language': 'en' } })
  } catch (error) {
    throw new Error(`${distributor} fetch failed for ${url}: ${error.message}`)
  }
  if (!response.ok) throw new Error(`distributor fetch failed for ${url}: HTTP ${response.status}`)
  const body = await response.text()
  if (!body.trim()) throw new Error(`${distributor} fetch returned an empty response for ${url}`)
  return body
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
  return {
    ...config,
    fixturePath,
    records: distributor === 'aws-bedrock'
      ? parseBedrockLifecycleHtml(html)
      : parseVertexModelVersionsHtml(html),
  }
}
