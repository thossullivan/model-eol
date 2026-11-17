#!/usr/bin/env node
// Offline tests for the Azure models API cross-check of the Azure AI Foundry retirement page.
import fs from 'node:fs'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import {
  AZURE_MODELS_API_LOCATIONS,
  MAX_AZURE_MODELS_API_PAGES,
  azureModelsApiCredentials,
  azureModelsApiUrl,
  fetchAzureModelsApi,
  parseAzureModelsApiPage,
  reconcileAzureModelsApi,
} from '../azure-models-api.mjs'
import { AZURE_MODEL_RETIREMENT_SCHEDULE_URL, loadDistributorSource, parseAzureModelRetirementScheduleMarkdown, sourceConflictSummary } from '../distributors.mjs'
import { compareFeeds, renderSemanticDiff } from '../diff.mjs'
import { providerSourceConflictSummary } from '../providers.mjs'

const fixtures = path.join(import.meta.dirname, 'fixture')
const apiPages = [0, 1, 2].map(index => fs.readFileSync(path.join(fixtures, 'azure-models-api', `eastus-page-${index}.json`), 'utf8'))
const subscriptionId = '00000000-0000-0000-0000-000000000000'
const token = 'test-token-value-1234'
const env = { AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: subscriptionId }
const now = '2026-11-16T00:00:00Z'
let failures = 0

const test = async (name, check) => {
  try {
    await check()
    console.log(`ok: ${name}`)
  } catch (error) {
    console.error(`FAIL: ${name}: ${error.message}`)
    failures++
  }
}

const header = '| Model | Version | Lifecycle | Retirement date | Replacement |\n| --- | --- | --- | --- | --- |'
const page = sections => Object.entries(sections).map(([section, rows]) => `### ${section}\n\n${header}\n${rows.map(row => `| ${row.join(' | ')} | - |`).join('\n')}\n\n`).join('')
const records = sections => parseAzureModelRetirementScheduleMarkdown(page(sections), { now }).records
const apiItem = (format, name, version, lifecycleStatus, inference) => ({
  kind: 'AIServices',
  skuName: 'S0',
  model: { format, name, version, lifecycleStatus, ...(inference === undefined ? {} : { deprecation: { inference: `${inference}T00:00:00Z` } }) },
})
const apiBody = (value, nextLink) => JSON.stringify(nextLink ? { nextLink, value } : { value })
const entries = (...items) => parseAzureModelsApiPage(apiBody(items), 'eastus').entries
const firstUrl = location => azureModelsApiUrl(subscriptionId, location)

/** A fetch that serves the retirement page and, per location, the given API pages in order. */
function fakeFetch({ markdown, api = {}, status }) {
  const requests = []
  const served = new Map()
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url) === AZURE_MODEL_RETIREMENT_SCHEDULE_URL) return new Response(markdown)
    if (status) return new Response('{"error":{"code":"AuthenticationFailed"}}', { status })
    const location = new URL(url).pathname.split('/')[6]
    const index = served.get(location) ?? 0
    served.set(location, index + 1)
    const body = api[location]?.[index]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body)
  }
  return { fetchImpl, requests }
}

const load = (options) => {
  const notices = []
  return loadDistributorSource('azure-ai-foundry', { now, notice: line => notices.push(line), azureLocations: ['eastus'], ...options })
    .then(source => ({ source, notices }), error => ({ error, notices }))
}

await test('the recorded pages parse with every field the comparison reads', () => {
  const first = parseAzureModelsApiPage(apiPages[0], 'eastus')
  strictAssert.equal(first.entries.length, 4)
  strictAssert.equal(first.nextLink, `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/locations/eastus/models?api-version=2026-11-01&$skiptoken=djE6NTA&$top=50`)
  strictAssert.deepEqual(first.entries[1], { location: 'eastus', format: 'OpenAI', name: 'gpt-4o', version: '2024-05-13', status: 'Deprecating', shutdown: '2027-01-14', publisher: 'openai' })
  const last = parseAzureModelsApiPage(apiPages[2], 'eastus')
  strictAssert.equal(last.nextLink, undefined)
  strictAssert.deepEqual(last.entries.map(entry => [entry.format, entry.publisher]), [['Meta', undefined], ['Mistral AI', 'mistral'], ['Anthropic', 'anthropic'], ['Anthropic', 'anthropic'], ['Anthropic', 'anthropic']])
})

await test('pagination follows nextLink with the bearer token and refuses redirects', async () => {
  const { fetchImpl, requests } = fakeFetch({ api: { eastus: apiPages } })
  const api = await fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl, locations: ['eastus'] })
  strictAssert.equal(api.entries.length, 12)
  strictAssert.deepEqual(api.locations, ['eastus'])
  strictAssert.equal(requests.length, 3)
  strictAssert.equal(requests[0].url, firstUrl('eastus'))
  strictAssert.ok(requests[1].url.includes('$skiptoken=djE6NTA'))
  strictAssert.ok(requests.every(request => request.init.headers.Authorization === `Bearer ${token}` && request.init.redirect === 'error'))
  strictAssert.deepEqual(AZURE_MODELS_API_LOCATIONS, ['eastus', 'eastus2', 'swedencentral', 'westus'])
})

await test('pagination stops at the page cap, on a repeated page, and on a nextLink that leaves the endpoint', async () => {
  let calls = 0
  const endless = async () => new Response(apiBody([], `${firstUrl('eastus')}&$skiptoken=${++calls}`))
  await strictAssert.rejects(fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl: endless, locations: ['eastus'] }), new RegExp(`still has more pages after ${MAX_AZURE_MODELS_API_PAGES}`))
  strictAssert.equal(calls, MAX_AZURE_MODELS_API_PAGES)
  const loop = async () => new Response(apiBody([], `${firstUrl('eastus')}&$skiptoken=same`))
  await strictAssert.rejects(fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl: loop, locations: ['eastus'] }), /nextLink repeats an earlier page/)
  for (const link of ['https://example.test/subscriptions/x/models', `${firstUrl('westus').split('?')[0]}?page=2`, 'not a url']) {
    const away = async () => new Response(apiBody([], link))
    await strictAssert.rejects(fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl: away, locations: ['eastus'] }), /nextLink (leaves the models endpoint|is not a URL)/, link)
  }
})

await test('an unknown lifecycle status, an unparseable date, or a missing value array fails closed', () => {
  strictAssert.throws(() => entries(apiItem('OpenAI', 'gpt-x', '2026-01-01', 'Retiring', '2027-01-01')), /gpt-x version 2026-01-01\) has an unknown lifecycleStatus: "Retiring"/)
  strictAssert.throws(() => entries({ model: { format: 'Meta', name: 'llama', version: '1' } }), /unknown lifecycleStatus: null/)
  for (const inference of ['2027-02-30T00:00:00Z', '2027-01-01T12:00:00Z', 'January 1, 2027', 20270101, '']) {
    const item = apiItem('OpenAI', 'gpt-x', '1', 'GenerallyAvailable')
    item.model.deprecation = { inference }
    strictAssert.throws(() => entries(item), /has an unparseable deprecation\.inference date/, String(inference))
  }
  strictAssert.throws(() => parseAzureModelsApiPage('{"values": []}', 'eastus'), /eastus response has no value array/)
  strictAssert.throws(() => parseAzureModelsApiPage('<html>', 'eastus'), /not JSON/)
  strictAssert.throws(() => parseAzureModelsApiPage('{"value": [], "nextLink": 5}', 'eastus'), /nextLink that is not a string/)
  strictAssert.throws(() => entries({ kind: 'OpenAI' }), /has no model object/)
  strictAssert.throws(() => entries(apiItem('OpenAI', 'gpt x', '1', 'Preview')), /invalid model name or version/)
  strictAssert.deepEqual(entries(apiItem('Meta', 'Llama 3 (preview)', '1', 'Preview')).map(entry => entry.name), ['Llama 3 (preview)'])
  strictAssert.equal(entries(apiItem('OpenAI', 'gpt-x', '1', 'GenerallyAvailable')).at(0).shutdown, undefined)
})

await test('half-configured or malformed credentials fail, and no credentials skip', () => {
  strictAssert.equal(azureModelsApiCredentials({}), undefined)
  strictAssert.equal(azureModelsApiCredentials({ AZURE_MANAGEMENT_TOKEN: '', AZURE_SUBSCRIPTION_ID: ' ' }), undefined)
  strictAssert.throws(() => azureModelsApiCredentials({ AZURE_SUBSCRIPTION_ID: subscriptionId }), /AZURE_SUBSCRIPTION_ID is set but AZURE_MANAGEMENT_TOKEN is not/)
  strictAssert.throws(() => azureModelsApiCredentials({ AZURE_MANAGEMENT_TOKEN: token }), /AZURE_MANAGEMENT_TOKEN is set but AZURE_SUBSCRIPTION_ID is not/)
  const malformed = (() => {
    try {
      azureModelsApiCredentials({ AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: 'my-subscription/../x' })
    } catch (error) {
      return error.message
    }
  })()
  strictAssert.match(malformed, /AZURE_SUBSCRIPTION_ID is not a subscription GUID/)
  strictAssert.ok(!malformed.includes('my-subscription'))
  strictAssert.throws(() => azureModelsApiCredentials({ AZURE_MANAGEMENT_TOKEN: 'two words', AZURE_SUBSCRIPTION_ID: subscriptionId }), /contains whitespace/)
})

await test('the loader skips the API without credentials and fails when only one is set', async () => {
  const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
  const skipped = await load({ fetchImpl: fakeFetch({ markdown }).fetchImpl, env: {} })
  strictAssert.deepEqual(skipped.notices, ['notice: azure models API skipped: AZURE_MANAGEMENT_TOKEN and AZURE_SUBSCRIPTION_ID are not set'])
  strictAssert.deepEqual(skipped.source.conflicts, [])
  for (const half of [{ AZURE_SUBSCRIPTION_ID: subscriptionId }, { AZURE_MANAGEMENT_TOKEN: token }]) {
    const { fetchImpl, requests } = fakeFetch({ markdown })
    const result = await load({ fetchImpl, env: half })
    strictAssert.match(result.error.message, /is set but AZURE_(MANAGEMENT_TOKEN|SUBSCRIPTION_ID) is not/)
    strictAssert.ok(requests.every(request => request.url === AZURE_MODEL_RETIREMENT_SCHEDULE_URL))
  }
})

await test('a 401 or 403 fails the source without printing the subscription or the token', async () => {
  const realLooking = '12345678-9abc-def0-1234-56789abcdef0'
  for (const status of [401, 403]) {
    const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
    const result = await load({ fetchImpl: fakeFetch({ markdown, status }).fetchImpl, env: { AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: realLooking } })
    strictAssert.match(result.error.message, new RegExp(`azure-ai-foundry models API eastus fetch failed for .*HTTP ${status}`))
    strictAssert.ok(result.error.message.includes('{subscriptionId}') && !result.error.message.includes(realLooking) && !result.error.message.includes(token))
  }
})

await test('a different date is a reported conflict, never a failure, and the page record is kept', async () => {
  const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15'], ['gpt-4o', '2024-05-13', 'Deprecated', '2027-01-14']] })
  const result = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: apiPages } }).fetchImpl, env })
  strictAssert.ok(!result.error, result.error?.message)
  const whisper = result.source.records.find(record => record.azureId === 'whisper')
  strictAssert.equal(whisper.shutdown, '2026-12-15')
  const conflict = result.source.conflicts.find(item => item.id === 'whisper')
  strictAssert.deepEqual(conflict, {
    via: 'azure-ai-foundry', source: 'models-api', reason: 'date', publisher: 'openai', id: 'whisper',
    api: { status: 'GenerallyAvailable', locations: ['eastus'], versions: ['001'], shutdown: '2027-02-26' },
    section: 'Azure OpenAI', page: { lifecycle: 'GA', version: '001', shutdown: '2026-12-15' },
  })
  strictAssert.ok(!result.source.conflicts.some(item => item.id === 'gpt-4o-2024-05-13'), 'matching dates are not conflicts')
  strictAssert.ok(result.notices.includes('notice: azure-ai-foundry models API openai/whisper: page 2026-12-15 (GA, version 001); API GenerallyAvailable 2027-02-26 in eastus; retirement page kept'))
  const summary = result.notices.filter(line => line.startsWith('notice: azure models API:'))
  strictAssert.deepEqual(summary, [`notice: azure models API: 12 entries in 1 locations; 4 deprecating/deprecated/legacy; ${result.source.conflicts.length} conflicts with the retirement page`])
  const empty = { publisher: 'openai', models: [] }
  const options = { sourceConflicts: result.source.conflicts }
  strictAssert.equal(compareFeeds(empty, empty, options).changed, false)
  const diff = renderSemanticDiff(empty, empty, options)
  strictAssert.ok(diff.includes('## Source conflicts\n') && diff.includes(`\n- ${sourceConflictSummary(conflict)}\n`))
})

await test('an API deprecating entry the page does not list is reported', () => {
  const page = records({ 'Azure OpenAI': [['gpt-5', '2025-08-07', 'GA', '2027-02-09']] })
  const api = entries(
    apiItem('OpenAI', 'o3-deep-research', '2025-06-26', 'Deprecating', '2026-11-19'),
    apiItem('OpenAI', 'gpt-new', '2026-10-01', 'GenerallyAvailable', '2027-10-01'),
    apiItem('Anthropic', 'claude-old', '1', 'Legacy'),
    apiItem('Meta', 'Llama-old', '1', 'Deprecated', '2026-12-01'),
  )
  const { records: kept, conflicts } = reconcileAzureModelsApi(page, api)
  strictAssert.equal(kept, page)
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.publisher, conflict.id]), [['unlisted', 'anthropic', 'claude-old'], ['unlisted', 'openai', 'o3-deep-research-2025-06-26']])
  strictAssert.equal(sourceConflictSummary(conflicts[1]), 'azure-ai-foundry models API openai/o3-deep-research-2025-06-26: API Deprecating 2026-11-19 in eastus; the retirement page does not list it')
})

await test('the diff renders Azure models API conflicts next to provider models API conflicts, each with its own summary', () => {
  const azure = reconcileAzureModelsApi([], entries(apiItem('OpenAI', 'o3-deep-research', '2025-06-26', 'Deprecating', '2026-11-19'))).conflicts
  const provider = { publisher: 'anthropic', via: 'models-api', id: 'claude-x', lifecycle: 'deprecated', field: 'uncovered' }
  const empty = { publisher: 'openai', models: [] }
  const diff = renderSemanticDiff(empty, empty, { sourceConflicts: [...azure, provider] })
  strictAssert.ok(diff.includes(`- ${sourceConflictSummary(azure[0])}\n`), diff)
  strictAssert.ok(diff.includes(`- ${providerSourceConflictSummary(provider)}\n`), diff)
})

await test('a dated page record the API calls generally available or preview with no date is reported', () => {
  const page = records({ 'Azure OpenAI': [['tts', '001', 'Preview', '2026-12-15'], ['gpt-5', '2025-08-07', 'GA', '-']], Cohere: [['Cohere-old', '1', 'Deprecated', '2026-12-01']] })
  const api = entries(
    apiItem('OpenAI', 'tts', '001', 'GenerallyAvailable'),
    apiItem('OpenAI', 'gpt-5', '2025-08-07', 'Preview'),
    apiItem('Cohere', 'Cohere-old', '1', 'Deprecating'),
  )
  const { conflicts } = reconcileAzureModelsApi(page, api)
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id]), [['undated', 'tts']])
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'azure-ai-foundry models API openai/tts: page 2026-12-15 (Preview, version 001); API GenerallyAvailable in eastus with no retirement date; retirement page kept')
})

await test('API entries bind like page rows: OpenAI snapshots by version, other publishers by name, across hosting versions and locations', () => {
  const page = records({
    'Azure OpenAI': [['gpt-4o', '2024-05-13', 'Deprecated', '2027-01-14'], ['text-embedding-ada-002', '2', 'GA', '2028-02-09']],
    Anthropic: [['claude-haiku-4-5', '1', 'GA', '2027-02-22'], ['claude-haiku-4-5', '2', 'GA', '2027-02-22']],
  })
  const api = [
    ...entries(apiItem('OpenAI', 'gpt-4o', '2024-05-13', 'Deprecating', '2027-01-14'), apiItem('OpenAI', 'text-embedding-ada-002', '1', 'GenerallyAvailable', '2028-02-09')),
    ...entries(apiItem('Anthropic', 'claude-haiku-4-5', '2', 'GenerallyAvailable', '2027-03-16'), apiItem('Anthropic', 'claude-haiku-4-5', '20251001', 'GenerallyAvailable', '2027-03-16')),
    ...parseAzureModelsApiPage(apiBody([apiItem('Anthropic', 'claude-haiku-4-5', '2', 'GenerallyAvailable', '2027-03-15')]), 'westus').entries,
  ]
  const { conflicts } = reconcileAzureModelsApi(page, api)
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.id, conflict.api.shutdown, conflict.api.locations.join(), conflict.api.versions.join()]), [
    ['claude-haiku-4-5', '2027-03-16', 'eastus', '2,20251001'],
    ['claude-haiku-4-5', '2027-03-15', 'westus', '2'],
  ])
})

if (failures) {
  console.error(`${failures} Azure models API test(s) failed`)
  process.exit(1)
}
