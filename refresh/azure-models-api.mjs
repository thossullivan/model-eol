// Azure Resource Manager models API, read as a cross-check of the Azure AI Foundry retirement page.
import { fetchBoundedBody } from './fetch.mjs'
import { assertIsoDate, MODEL_ID_PATTERN } from './providers.mjs'

export const AZURE_MANAGEMENT_ORIGIN = 'https://management.azure.com'
export const AZURE_MODELS_API_VERSION = '2026-11-01'
export const AZURE_MODELS_API_LOCATIONS = ['eastus', 'eastus2', 'swedencentral', 'westus']
export const MAX_AZURE_MODELS_API_PAGES = 20
export const AZURE_MODELS_API_STATUSES = new Set(['GenerallyAvailable', 'Preview', 'Deprecating', 'Deprecated', 'Legacy'])
export const AZURE_MODELS_API_DEPRECATING = new Set(['Deprecating', 'Deprecated', 'Legacy'])
export const AZURE_MODELS_API_PUBLISHER_BY_FORMAT = new Map([
  ['OpenAI', 'openai'],
  ['Anthropic', 'anthropic'],
  ['Mistral AI', 'mistral'],
  ['Cohere', 'cohere'],
])

const SOURCE = 'azure-ai-foundry models API'
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
    return assertIsoDate(match[1], label)
  } catch {
    throw new Error(`${label} has an unparseable deprecation.inference date: ${JSON.stringify(value)}`)
  }
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
  if (deprecation.inference !== undefined && deprecation.inference !== null) entry.shutdown = apiDate(deprecation.inference, label)
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
  const expected = new URL(first)
  if (next.origin !== expected.origin || next.pathname.toLowerCase() !== expected.pathname.toLowerCase()) {
    throw new Error(`${where} nextLink leaves the models endpoint`)
  }
  return next.href
}

/** Every entry for each location, following nextLink up to MAX_AZURE_MODELS_API_PAGES pages per location. */
export async function fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl, locations = AZURE_MODELS_API_LOCATIONS } = {}) {
  const redact = message => message.split(subscriptionId).join('{subscriptionId}').split(token).join('[redacted]')
  const entries = []
  for (const location of locations) {
    const where = `${SOURCE} ${location}`
    const first = azureModelsApiUrl(subscriptionId, location)
    const seen = new Set()
    for (let url = first, page = 0; url; page++) {
      if (page >= MAX_AZURE_MODELS_API_PAGES) throw new Error(`${where} still has more pages after ${MAX_AZURE_MODELS_API_PAGES}`)
      if (seen.has(url)) throw new Error(`${where} nextLink repeats an earlier page`)
      seen.add(url)
      let body
      try {
        body = await fetchBoundedBody(url, where, fetchImpl, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
      } catch (error) {
        throw new Error(redact(error.message))
      }
      const parsed = parseAzureModelsApiPage(body, location)
      entries.push(...parsed.entries)
      url = parsed.nextLink && nextPageUrl(parsed.nextLink, first, where)
    }
  }
  return { entries, locations: [...locations] }
}

const apiAzureId = (publisher, name, version) => (
  publisher === 'openai' && /^(?:\d{4}-\d{2}-\d{2}|\d{4})$/.test(version) ? `${name}-${version}` : name
)

/** Compare models API entries with the retirement page records. The page is authoritative, so the records come back unchanged. */
export function reconcileAzureModelsApi(records, entries) {
  const page = new Map()
  for (const record of records) if (record.publisher) page.set(`${record.publisher}\0${record.azureId}`, record)
  const groups = new Map()
  for (const entry of entries) {
    if (!entry.publisher) continue
    const id = apiAzureId(entry.publisher, entry.name, entry.version)
    const key = `${entry.publisher}\0${id}`
    const group = groups.get(key) ?? { publisher: entry.publisher, id, observations: new Map() }
    const observationKey = `${entry.status}\0${entry.shutdown ?? ''}`
    const observation = group.observations.get(observationKey) ?? { status: entry.status, shutdown: entry.shutdown, locations: new Set(), versions: new Set() }
    observation.locations.add(entry.location)
    observation.versions.add(entry.version)
    group.observations.set(observationKey, observation)
    groups.set(key, group)
  }
  const conflicts = []
  for (const [key, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const listed = page.get(key)
    for (const observation of group.observations.values()) {
      let reason
      if (!listed) reason = AZURE_MODELS_API_DEPRECATING.has(observation.status) ? 'unlisted' : undefined
      else if (observation.shutdown !== undefined) reason = observation.shutdown === listed.shutdown ? undefined : 'date'
      else if (listed.shutdown !== undefined && !AZURE_MODELS_API_DEPRECATING.has(observation.status)) reason = 'undated'
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

export function azureModelsApiConflictSummary(conflict) {
  const api = `${conflict.api.status}${conflict.api.shutdown ? ` ${conflict.api.shutdown}` : ''} in ${conflict.api.locations.join(', ')}`
  const label = `${conflict.via} models API ${conflict.publisher}/${conflict.id}`
  if (conflict.reason === 'unlisted') return `${label}: API ${api}; the retirement page does not list it`
  const page = `${conflict.page.shutdown ?? 'no date'} (${conflict.page.lifecycle}, version ${conflict.page.version})`
  if (conflict.reason === 'undated') return `${label}: page ${page}; API ${api} with no retirement date; retirement page kept`
  return `${label}: page ${page}; API ${api}; retirement page kept`
}

export function azureModelsApiSummary(api, conflicts) {
  const deprecating = api.entries.filter(entry => AZURE_MODELS_API_DEPRECATING.has(entry.status)).length
  return `azure models API: ${api.entries.length} entries in ${api.locations.length} locations; ${deprecating} deprecating/deprecated/legacy; ${conflicts.length} conflicts with the retirement page`
}
