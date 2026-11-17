// Amazon Bedrock ListFoundationModels, read as a cross-check of the Bedrock legacy lifecycle page.
import { signAwsRequest } from './aws-sigv4.mjs'
import { fetchBoundedBody } from './fetch.mjs'
import { assertIsoDate } from './providers.mjs'

export const BEDROCK_MODELS_API_REGIONS = [
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-south-1', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'eu-central-1', 'eu-north-1', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'sa-east-1', 'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
]
export const BEDROCK_MODELS_API_STATUSES = new Set(['ACTIVE', 'LEGACY'])
export const BEDROCK_MODELS_API_NOT_ENABLED = 'UnrecognizedClientException'

const SOURCE = 'aws-bedrock models API'
const MODEL_ID = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-z0-9._:+-]*$/i
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/
const ACCESS_KEY_ID = /^[A-Z0-9]{16,128}$/
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const CONTEXT_VARIANT = /^(.+):\d+[km]$/
// Lifecycle times are a whole-hour midnight between UTC and UTC-8, so the UTC date is the calendar date.
const LIFECYCLE_TIME = /^(\d{4}-\d{2}-\d{2})T0[0-8]:00:00(?:\.0+)?Z$/
const MAX_ERROR_BODY_BYTES = 16 * 1024
const LIFECYCLE_FIELDS = [['legacy', 'legacyTime'], ['eol', 'endOfLifeTime'], ['extendedAccess', 'publicExtendedAccessTime']]
const set = value => typeof value === 'string' && value.trim() !== ''

/** Credentials from the environment; undefined when neither key is set, and an error when only one is or either is malformed. */
export function bedrockModelsApiCredentials(env = process.env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  const sessionToken = env.AWS_SESSION_TOKEN
  if (!set(accessKeyId) && !set(secretAccessKey)) {
    if (set(sessionToken)) throw new Error(`${SOURCE}: AWS_SESSION_TOKEN is set but AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not`)
    return undefined
  }
  if (!set(accessKeyId)) throw new Error(`${SOURCE}: AWS_SECRET_ACCESS_KEY is set but AWS_ACCESS_KEY_ID is not`)
  if (!set(secretAccessKey)) throw new Error(`${SOURCE}: AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is not`)
  if (!ACCESS_KEY_ID.test(accessKeyId.trim())) throw new Error(`${SOURCE}: AWS_ACCESS_KEY_ID is not an access key id`)
  if (/\s/.test(secretAccessKey.trim())) throw new Error(`${SOURCE}: AWS_SECRET_ACCESS_KEY contains whitespace`)
  if (set(sessionToken) && /\s/.test(sessionToken.trim())) throw new Error(`${SOURCE}: AWS_SESSION_TOKEN contains whitespace`)
  const credentials = { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() }
  if (set(sessionToken)) credentials.sessionToken = sessionToken.trim()
  return credentials
}

export const bedrockModelsApiUrl = region => `https://bedrock.${region}.amazonaws.com/foundation-models`

function lifecycleDate(value, label) {
  if (value === undefined || value === null) return undefined
  const match = typeof value === 'string' && value.match(LIFECYCLE_TIME)
  try {
    if (!match) throw new Error('not a lifecycle time')
    assertIsoDate(match[1], label)
  } catch {
    throw new Error(`${label} is not a midnight timestamp between UTC and UTC-8: ${JSON.stringify(value)}`)
  }
  return match[1]
}

function apiEntry(item, where, region) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${where} is not an object`)
  if (typeof item.modelId !== 'string' || !MODEL_ID.test(item.modelId)) throw new Error(`${where} has an invalid modelId: ${JSON.stringify(item.modelId ?? null)}`)
  const label = `${where} (${item.modelId})`
  const lifecycle = item.modelLifecycle
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) throw new Error(`${label} has no modelLifecycle object`)
  if (!BEDROCK_MODELS_API_STATUSES.has(lifecycle.status)) throw new Error(`${label} has an unknown modelLifecycle.status: ${JSON.stringify(lifecycle.status ?? null)}`)
  const entry = { region, id: item.modelId, status: lifecycle.status }
  for (const [field, name] of LIFECYCLE_FIELDS) {
    const date = lifecycleDate(lifecycle[name], `${label} modelLifecycle.${name}`)
    if (date !== undefined) entry[field] = date
  }
  return entry
}

/** One region's ListFoundationModels response as lifecycle entries. */
export function parseBedrockModelsApiResponse(text, region = 'unknown region') {
  const where = `${SOURCE} ${region}`
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`${where} returned a body that is not JSON`)
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.modelSummaries)) throw new Error(`${where} response has no modelSummaries array`)
  if (body.nextToken !== undefined && body.nextToken !== null) throw new Error(`${where} response has a nextToken, which ListFoundationModels does not document`)
  const seen = new Set()
  return body.modelSummaries.map((item, index) => {
    const entry = apiEntry(item, `${where} entry ${index}`, region)
    if (seen.has(entry.id)) throw new Error(`${where} lists ${entry.id} twice`)
    seen.add(entry.id)
    return entry
  })
}

/** A message with the key id, secret, session token, signatures, and anything that looks like an account id removed. */
export function redactBedrockModelsApiMessage(message, credentials = {}) {
  let text = String(message)
  for (const value of [credentials.secretAccessKey, credentials.sessionToken, credentials.accessKeyId]) {
    if (value) text = text.split(value).join('[redacted]')
  }
  return text
    .replace(/Signature=[0-9a-f]+/gi, 'Signature=[redacted]')
    .replace(/\b(?:AKIA|ASIA|AIDA|AROA)[A-Z0-9]{12,}\b/g, '[redacted]')
    .replace(/(?<!\d)\d{12}(?!\d)/g, '{account}')
}

async function errorCode(response) {
  const header = typeof response.headers?.get === 'function' ? response.headers.get('x-amzn-errortype') : null
  const fromHeader = header?.split(':')[0]
  if (fromHeader && ERROR_CODE.test(fromHeader)) return fromHeader
  const chunks = []
  let bytes = 0
  if (response.body) {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      chunks.push(buffer)
      bytes += buffer.byteLength
      if (bytes >= MAX_ERROR_BODY_BYTES) return undefined
    }
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
    const code = String(body?.__type ?? body?.code ?? '').split('#').pop().split(':')[0]
    return ERROR_CODE.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

// An AccessDenied body names the caller's ARN and account, so a failed request reports only its status and error type.
function statusOnlyFetch(fetchImpl, refused) {
  return async (url, init) => {
    const response = await fetchImpl(url, init)
    if (response.ok) return response
    let code
    try {
      code = await errorCode(response)
    } catch {}
    if (response.status === 403 && code === BEDROCK_MODELS_API_NOT_ENABLED) refused.add(url)
    throw new Error(`HTTP ${response.status}${code ? ` ${code}` : ''}`)
  }
}

/** Every entry in each region; a region that refuses the credentials as unrecognised is listed in notEnabled unless every region does. */
export async function fetchBedrockModelsApi(credentials, { fetchImpl = globalThis.fetch, regions = BEDROCK_MODELS_API_REGIONS, now } = {}) {
  try {
    const entries = []
    const read = []
    const notEnabled = []
    const refused = new Set()
    const guarded = statusOnlyFetch(fetchImpl, refused)
    for (const region of regions) {
      if (!REGION.test(region)) throw new Error(`${SOURCE}: invalid region ${JSON.stringify(region)}`)
      const url = bedrockModelsApiUrl(region)
      const where = `${SOURCE} ${region}`
      const { headers } = signAwsRequest({ url, region, service: 'bedrock', credentials, headers: { Accept: 'application/json' }, now: now ?? new Date() })
      let body
      try {
        body = await fetchBoundedBody(url, where, guarded, { headers, secretHeaders: ['Authorization', 'X-Amz-Security-Token'] })
      } catch (error) {
        if (!refused.has(url)) throw error
        notEnabled.push(region)
        continue
      }
      entries.push(...parseBedrockModelsApiResponse(body, region))
      read.push(region)
    }
    if (!read.length) throw new Error(`${SOURCE}: every region refused the credentials (HTTP 403 ${BEDROCK_MODELS_API_NOT_ENABLED})`)
    return { entries, regions: read, notEnabled }
  } catch (error) {
    throw new Error(redactBedrockModelsApiMessage(error.message, credentials))
  }
}

const today = now => (now === undefined ? new Date() : new Date(now)).toISOString().slice(0, 10)
const datesOf = item => Object.fromEntries(LIFECYCLE_FIELDS.flatMap(([field]) => item[field] === undefined ? [] : [[field, item[field]]]))
const hasDates = item => LIFECYCLE_FIELDS.some(([field]) => item[field] !== undefined)
const sameDates = (left, right) => LIFECYCLE_FIELDS.every(([field]) => left[field] === right[field])

/** Compare API entries with the lifecycle page by model id and Region, and with model cards by id; the records come back unchanged. */
export function reconcileBedrockModelsApi(records, entries, { rows = [], regions, now } = {}) {
  const read = new Set(regions ?? entries.map(entry => entry.region))
  const pageRows = rows.filter(row => row.endpoint !== 'bedrock-mantle')
  const pageIds = new Set(rows.map(row => row.bedrockId))
  const byRegion = new Map()
  for (const row of pageRows) {
    for (const region of row.regions) {
      const key = `${row.bedrockId}\0${region}`
      if (!byRegion.has(key)) byRegion.set(key, row)
    }
  }
  const cards = new Map(records.filter(record => !pageIds.has(record.bedrockId)).map(record => [record.bedrockId, record]))
  const bound = id => {
    const base = id.match(CONTEXT_VARIANT)?.[1]
    return base && !pageIds.has(id) && !cards.has(id) && (pageIds.has(base) || cards.has(base)) ? base : id
  }
  const returned = new Set()
  const groups = new Map()
  const rowIds = new Map()
  const observe = (reason, id, listed, api, region, apiId) => {
    if (listed && !rowIds.has(listed)) rowIds.set(listed, rowIds.size)
    const key = [reason, id, listed ? rowIds.get(listed) : '', api ? `${api.status}\0${JSON.stringify(datesOf(api))}` : ''].join('\0')
    const group = groups.get(key) ?? { reason, id, listed, api, regions: new Set(), apiIds: new Set() }
    group.regions.add(region)
    if (apiId) group.apiIds.add(apiId)
    groups.set(key, group)
  }
  for (const entry of entries) {
    const id = bound(entry.id)
    returned.add(`${id}\0${entry.region}`)
    const row = byRegion.get(`${id}\0${entry.region}`)
    if (row) {
      if (!hasDates(entry) && entry.status === 'ACTIVE') {
        if (row.eol !== undefined) observe('undated', id, row, entry, entry.region, entry.id)
      } else if (!sameDates(entry, row)) observe('date', id, row, entry, entry.region, entry.id)
      continue
    }
    const card = cards.get(id)
    if (card) {
      if (entry.eol !== undefined && entry.eol !== card.shutdown) observe('date', id, card, entry, entry.region, entry.id)
    } else if (entry.status === 'LEGACY' || hasDates(entry)) observe('unlisted', id, undefined, entry, entry.region, entry.id)
  }
  const date = today(now)
  for (const row of pageRows) {
    if (row.eol !== undefined && row.eol <= date) continue
    for (const region of row.regions) {
      if (read.has(region) && !returned.has(`${row.bedrockId}\0${region}`)) observe('absent', row.bedrockId, row, undefined, region)
    }
  }
  const order = ['date', 'undated', 'unlisted', 'absent']
  const conflicts = [...groups.values()]
    .sort((left, right) => left.id.localeCompare(right.id) || order.indexOf(left.reason) - order.indexOf(right.reason))
    .map(group => {
      const conflict = { via: 'aws-bedrock', source: 'models-api', reason: group.reason, id: group.id, regions: [...group.regions].sort() }
      if (group.api) {
        conflict.api = { status: group.api.status, ...datesOf(group.api) }
        const ids = [...group.apiIds].sort()
        if (ids.length !== 1 || ids[0] !== group.id) conflict.api.ids = ids
      }
      if (group.listed) {
        conflict.page = group.listed.regions
          ? datesOf(group.listed)
          : { card: group.listed.source, ...(group.listed.shutdown === undefined ? {} : { eol: group.listed.shutdown }) }
      }
      return conflict
    })
  return { records, conflicts }
}

const DATE_LABELS = { legacy: 'legacy', eol: 'EOL', extendedAccess: 'extended access' }
const dateList = item => LIFECYCLE_FIELDS.map(([field]) => `${DATE_LABELS[field]} ${item[field] ?? 'none'}`).join(', ')
const apiText = api => `${api.status}${hasDates(api) ? ` (${dateList(api)})` : ' with no lifecycle dates'}${api.ids ? ` as ${api.ids.join(', ')}` : ''}`

export function bedrockModelsApiConflictSummary(conflict) {
  const label = `${conflict.via} models API ${conflict.id ?? 'cross-check'}`
  if (conflict.reason === 'cross-check-failed') return `${label} failed: ${conflict.message}; the lifecycle page was read without the cross-check`
  const regions = conflict.regions.join(', ')
  const page = conflict.page?.card ? `model card ${conflict.page.card} EOL ${conflict.page.eol ?? 'none'}` : conflict.page && `page ${dateList(conflict.page)}`
  if (conflict.reason === 'unlisted') return `${label}: API ${apiText(conflict.api)} in ${regions}; the lifecycle page does not list it in these Regions`
  if (conflict.reason === 'absent') return `${label}: page ${dateList(conflict.page)} in ${regions}; the API does not return it in these Regions; lifecycle page kept`
  return `${label}: ${page}; API ${apiText(conflict.api)} in ${regions}; lifecycle page kept`
}

export function bedrockModelsApiSummary(api, conflicts) {
  const legacy = api.entries.filter(entry => entry.status === 'LEGACY').length
  return `bedrock models API: ${api.entries.length} entries in ${api.regions.length} regions; ${legacy} legacy; ${conflicts.length} conflicts with the lifecycle page`
}

export const bedrockModelsApiNotEnabledSummary = regions =>
  `bedrock models API: ${regions.length} ${regions.length === 1 ? 'region' : 'regions'} not enabled for these credentials (HTTP 403 ${BEDROCK_MODELS_API_NOT_ENABLED}), skipped: ${regions.join(', ')}`
