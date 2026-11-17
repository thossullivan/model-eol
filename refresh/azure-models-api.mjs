// Azure Resource Manager models API, read as a cross-check of the Azure AI Foundry retirement page.
import { fetchBoundedBody } from './fetch.mjs'
import { assertIsoDate, MODEL_ID_PATTERN } from './providers.mjs'

export const AZURE_MANAGEMENT_ORIGIN = 'https://management.azure.com'
export const AZURE_MODELS_API_VERSION = '2026-11-01'
export const AZURE_MODELS_API_LOCATIONS = ['eastus', 'eastus2', 'swedencentral', 'westus']
export const MAX_AZURE_MODELS_API_PAGES = 20
export const AZURE_MODELS_API_STATUSES = new Set(['GenerallyAvailable', 'Preview', 'Deprecating', 'Deprecated', 'Legacy'])
export const AZURE_MODELS_API_DEPRECATING = new Set(['Deprecating', 'Deprecated', 'Legacy'])
export const AZURE_MODELS_API_NO_DATE_YEAR = 2099
export const AZURE_MODELS_API_ONE_DAY = 'one-day'
export const AZURE_MODELS_API_PUBLISHER_BY_FORMAT = new Map([
  ['OpenAI', 'openai'],
  ['Anthropic', 'anthropic'],
  ['Mistral AI', 'mistral'],
  ['Cohere', 'cohere'],
])

const SOURCE = 'azure-ai-foundry models API'
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ANY_GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const MAX_ERROR_BODY_BYTES = 16 * 1024
const set = value => typeof value === 'string' && value.trim() !== ''

/** The token and subscription from the environment; undefined when neither is set, and an error when only one is or either is malformed. */
export function azureModelsApiCredentials(env = process.env) {
  const token = env.AZURE_MANAGEMENT_TOKEN
  const subscriptionId = env.AZURE_SUBSCRIPTION_ID
  if (!set(token) && !set(subscriptionId)) return undefined
  if (!set(token)) throw new Error(`${SOURCE}: AZURE_SUBSCRIPTION_ID is set but AZURE_MANAGEMENT_TOKEN is not`)
  if (!set(subscriptionId)) throw new Error(`${SOURCE}: AZURE_MANAGEMENT_TOKEN is set but AZURE_SUBSCRIPTION_ID is not`)
  if (!SUBSCRIPTION_ID.test(subscriptionId.trim())) throw new Error(`${SOURCE}: AZURE_SUBSCRIPTION_ID is not a subscription GUID`)
  if (/\s/.test(token.trim())) throw new Error(`${SOURCE}: AZURE_MANAGEMENT_TOKEN contains whitespace`)
  return { token: token.trim(), subscriptionId: subscriptionId.trim() }
}

export function azureModelsApiUrl(subscriptionId, location) {
  return `${AZURE_MANAGEMENT_ORIGIN}/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/locations/${location}/models?api-version=${AZURE_MODELS_API_VERSION}`
}

function apiDate(value, label) {
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z)?$/)
  try {
    if (!match) throw new Error('not a date')
    assertIsoDate(match[1], label)
  } catch {
    throw new Error(`${label} has an unparseable deprecation.inference date: ${JSON.stringify(value)}`)
  }
  // Azure writes far-future placeholders such as 2099-06-03 for models without a retirement date.
  return Number(match[1].slice(0, 4)) >= AZURE_MODELS_API_NO_DATE_YEAR ? undefined : match[1]
}

function apiEntry(item, where, location) {
  const model = item?.model
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error(`${where} has no model object`)
  for (const field of ['format', 'name', 'version']) {
    if (!set(model[field])) throw new Error(`${where} has no model ${field}`)
  }
  const label = `${where} (${model.format} ${model.name} version ${model.version})`
  const publisher = AZURE_MODELS_API_PUBLISHER_BY_FORMAT.get(model.format)
  if (publisher && !(MODEL_ID_PATTERN.test(model.name) && MODEL_ID_PATTERN.test(model.version))) {
    throw new Error(`${label} has an invalid model name or version`)
  }
  if (!AZURE_MODELS_API_STATUSES.has(model.lifecycleStatus)) {
    throw new Error(`${label} has an unknown lifecycleStatus: ${JSON.stringify(model.lifecycleStatus ?? null)}`)
  }
  const deprecation = model.deprecation ?? {}
  if (typeof deprecation !== 'object' || Array.isArray(deprecation)) throw new Error(`${label} has a deprecation that is not an object`)
  const entry = { location, format: model.format, name: model.name, version: model.version, status: model.lifecycleStatus }
  const shutdown = deprecation.inference === undefined || deprecation.inference === null ? undefined : apiDate(deprecation.inference, label)
  if (shutdown !== undefined) entry.shutdown = shutdown
  if (publisher) entry.publisher = publisher
  return entry
}

/** One page of the models API: its entries and the next page URL. */
export function parseAzureModelsApiPage(text, location = 'unknown location') {
  const where = `${SOURCE} ${location}`
  let page
  try {
    page = JSON.parse(text)
  } catch {
    throw new Error(`${where} returned a body that is not JSON`)
  }
  if (!page || typeof page !== 'object' || !Array.isArray(page.value)) throw new Error(`${where} response has no value array`)
  if (page.nextLink !== undefined && page.nextLink !== null && typeof page.nextLink !== 'string') {
    throw new Error(`${where} response has a nextLink that is not a string`)
  }
  return {
    entries: page.value.map((item, index) => apiEntry(item, `${where} entry ${index}`, location)),
    nextLink: page.nextLink || undefined,
  }
}

function nextPageUrl(link, first, where) {
  let next
  try {
    next = new URL(link)
  } catch {
    throw new Error(`${where} nextLink is not a URL`)
  }
  if (next.username || next.password) throw new Error(`${where} nextLink carries a username or password`)
  const expected = new URL(first)
  if (next.origin !== expected.origin || next.pathname.toLowerCase() !== expected.pathname.toLowerCase()) {
    throw new Error(`${where} nextLink leaves the models endpoint`)
  }
  return next.href
}

/** An error message with the subscription, every other GUID, and the token removed; GUIDs go first so no cut can leave part of one. */
export function redactAzureModelsApiMessage(message, { token, subscriptionId } = {}) {
  let text = String(message)
  if (subscriptionId) text = text.replace(new RegExp(subscriptionId.replace(/[^0-9a-z]/gi, '\\$&'), 'gi'), '{subscriptionId}')
  text = text.replace(ANY_GUID, '{guid}')
  if (token) text = text.split(token).join('[redacted]')
  return text
}

async function errorCode(response) {
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
    const code = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))?.error?.code
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

// The error body names the caller's client, object, and tenant ids, so a failed request reports only its status and error code.
function statusOnlyFetch(fetchImpl) {
  return async (url, init) => {
    const response = await fetchImpl(url, init)
    if (response.ok) return response
    let code
    try {
      code = await errorCode(response)
    } catch {}
    throw new Error(`HTTP ${response.status}${code ? ` ${code}` : ''}`)
  }
}

/** Every entry for each location, following nextLink up to MAX_AZURE_MODELS_API_PAGES pages per location. */
export async function fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl = globalThis.fetch, locations = AZURE_MODELS_API_LOCATIONS } = {}) {
  try {
    const entries = []
    const guarded = statusOnlyFetch(fetchImpl)
    for (const location of locations) {
      const where = `${SOURCE} ${location}`
      const first = azureModelsApiUrl(subscriptionId, location)
      const seen = new Set()
      for (let url = first, page = 0; url; page++) {
        if (page >= MAX_AZURE_MODELS_API_PAGES) throw new Error(`${where} still has more pages after ${MAX_AZURE_MODELS_API_PAGES}`)
        if (seen.has(url)) throw new Error(`${where} nextLink repeats an earlier page`)
        seen.add(url)
        const body = await fetchBoundedBody(url, where, guarded, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
        const parsed = parseAzureModelsApiPage(body, location)
        entries.push(...parsed.entries)
        url = parsed.nextLink && nextPageUrl(parsed.nextLink, first, where)
      }
    }
    return { entries, locations: [...locations] }
  } catch (error) {
    throw new Error(redactAzureModelsApiMessage(error.message, { token, subscriptionId }))
  }
}

const apiAzureId = (publisher, name, version) => (
  publisher === 'openai' && /^(?:\d{4}-\d{2}-\d{2}|\d{4})$/.test(version) ? `${name}-${version}` : name
)

const DAY_MS = 24 * 60 * 60 * 1000
const dayGap = (left, right) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / DAY_MS

/** Compare models API entries with the page, each against the page row for its version when rows lists one; the records come back unchanged. */
export function reconcileAzureModelsApi(records, entries, { rows = records } = {}) {
  const page = new Map()
  for (const record of records) if (record.publisher) page.set(`${record.publisher}\0${record.azureId}`, record)
  const byVersion = new Map()
  for (const row of rows) {
    if (!row.publisher) continue
    const key = `${row.publisher}\0${row.azureId}`
    const versions = byVersion.get(key) ?? new Map()
    if (!versions.has(row.version)) versions.set(row.version, row)
    byVersion.set(key, versions)
  }
  const rowIds = new Map()
  const groups = new Map()
  for (const entry of entries) {
    if (!entry.publisher) continue
    const id = apiAzureId(entry.publisher, entry.name, entry.version)
    const key = `${entry.publisher}\0${id}`
    const listed = byVersion.get(key)?.get(entry.version) ?? page.get(key)
    if (listed && !rowIds.has(listed)) rowIds.set(listed, rowIds.size)
    const group = groups.get(key) ?? { publisher: entry.publisher, id, observations: new Map() }
    const observationKey = `${listed ? rowIds.get(listed) : ''}\0${entry.status}\0${entry.shutdown ?? ''}`
    const observation = group.observations.get(observationKey) ?? { listed, status: entry.status, shutdown: entry.shutdown, locations: new Set(), versions: new Set() }
    observation.locations.add(entry.location)
    observation.versions.add(entry.version)
    group.observations.set(observationKey, observation)
    groups.set(key, group)
  }
  const conflicts = []
  for (const [, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    for (const observation of group.observations.values()) {
      const { listed } = observation
      let reason
      if (!listed) reason = AZURE_MODELS_API_DEPRECATING.has(observation.status) || observation.shutdown !== undefined ? 'unlisted' : undefined
      else if (observation.shutdown !== undefined) {
        if (observation.shutdown !== listed.shutdown) reason = listed.shutdown && dayGap(observation.shutdown, listed.shutdown) === 1 ? AZURE_MODELS_API_ONE_DAY : 'date'
      } else if (listed.shutdown !== undefined && !AZURE_MODELS_API_DEPRECATING.has(observation.status)) reason = 'undated'
      if (!reason) continue
      const api = { status: observation.status, locations: [...observation.locations].sort(), versions: [...observation.versions].sort() }
      if (observation.shutdown !== undefined) api.shutdown = observation.shutdown
      const conflict = { via: 'azure-ai-foundry', source: 'models-api', reason, publisher: group.publisher, id: group.id, api }
      if (listed) {
        conflict.section = listed.section
        conflict.page = { lifecycle: listed.lifecycle, version: listed.version }
        if (listed.shutdown !== undefined) conflict.page.shutdown = listed.shutdown
      }
      conflicts.push(conflict)
    }
  }
  return { records, conflicts }
}

const apiObservation = api => {
  const versions = `version${api.versions.length === 1 ? '' : 's'} ${api.versions.join(', ')}`
  return `${api.status}${api.shutdown ? ` ${api.shutdown}` : ''} (${versions}) in ${api.locations.join(', ')}`
}

export function azureModelsApiConflictSummary(conflict) {
  const label = `${conflict.via} models API ${conflict.publisher ? `${conflict.publisher}/${conflict.id}` : 'cross-check'}`
  if (conflict.reason === 'cross-check-failed') return `${label} failed: ${conflict.message}; the retirement page was read without the cross-check`
  const api = apiObservation(conflict.api)
  if (conflict.reason === 'unlisted') return `${label}: API ${api}; the retirement page does not list it`
  const page = `${conflict.page.shutdown ?? 'no date'} (${conflict.page.lifecycle}, version ${conflict.page.version})`
  if (conflict.reason === 'undated') return `${label}: page ${page}; API ${api} with no retirement date; retirement page kept`
  return `${label}: page ${page}; API ${api}; retirement page kept`
}

export const isAzureModelsApiOneDay = conflict => conflict.source === 'models-api' && conflict.reason === AZURE_MODELS_API_ONE_DAY

/** The one line that stands for every one-day difference. */
export function azureModelsApiOneDaySummary(conflicts) {
  const count = conflicts.filter(isAzureModelsApiOneDay).length
  return `azure-ai-foundry models API: ${count} ${count === 1 ? 'entry differs' : 'entries differ'} from the retirement page by exactly one day; retirement page kept`
}

const oneDayEntry = conflict => `${conflict.publisher}/${conflict.id}: page ${conflict.page.shutdown} (${conflict.page.lifecycle}, version ${conflict.page.version}); API ${apiObservation(conflict.api)}`

/** Source conflict bullets: one per conflict, except one-day differences, which share one bullet with a nested list. */
export function sourceConflictLines(conflicts, summary) {
  const oneDay = conflicts.filter(isAzureModelsApiOneDay)
  const lines = conflicts.filter(conflict => !isAzureModelsApiOneDay(conflict)).map(conflict => `- ${summary(conflict)}`)
  if (oneDay.length) lines.push(`- ${azureModelsApiOneDaySummary(oneDay)}:`, ...oneDay.map(conflict => `  - ${oneDayEntry(conflict)}`))
  return lines
}

export function azureModelsApiSummary(api, conflicts) {
  const deprecating = api.entries.filter(entry => AZURE_MODELS_API_DEPRECATING.has(entry.status)).length
  const oneDay = conflicts.filter(isAzureModelsApiOneDay).length
  return `azure models API: ${api.entries.length} entries in ${api.locations.length} locations; ${deprecating} deprecating/deprecated/legacy; ${conflicts.length - oneDay} conflicts with the retirement page; ${oneDay} entries differ by exactly one day`
}
