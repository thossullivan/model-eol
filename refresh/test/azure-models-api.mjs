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
  redactAzureModelsApiMessage,
} from '../azure-models-api.mjs'
import { AZURE_MODEL_RETIREMENT_SCHEDULE_URL, crossChecksStrict, loadDistributorSource, parseAzureModelRetirementScheduleMarkdown, sourceConflictSummary } from '../distributors.mjs'
import { compareFeeds, renderSemanticDiff } from '../diff.mjs'
import { providerSourceConflictSummary } from '../providers.mjs'

const fixtures = path.join(import.meta.dirname, 'fixture')
const apiPages = [0, 1, 2].map(index => fs.readFileSync(path.join(fixtures, 'azure-models-api', `eastus-page-${index}.json`), 'utf8'))
const subscriptionId = '00000000-0000-0000-0000-000000000000'
const token = 'test-token-value-1234'
const env = { AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: subscriptionId }
const strict = { MODEL_EOL_CROSS_CHECKS: 'strict' }
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
function fakeFetch({ markdown, api = {}, status, errorBody = '{"error":{"code":"AuthenticationFailed"}}' }) {
  const requests = []
  const served = new Map()
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url) === AZURE_MODEL_RETIREMENT_SCHEDULE_URL) return new Response(markdown)
    if (status) return new Response(errorBody, { status })
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

await test('the loader skips the API without credentials; one credential alone fails under strict cross-checks and warns otherwise', async () => {
  const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
  const skipped = await load({ fetchImpl: fakeFetch({ markdown }).fetchImpl, env: {} })
  strictAssert.deepEqual(skipped.notices, ['notice: azure models API skipped: AZURE_MANAGEMENT_TOKEN and AZURE_SUBSCRIPTION_ID are not set'])
  strictAssert.deepEqual(skipped.source.conflicts, [])
  for (const half of [{ AZURE_SUBSCRIPTION_ID: subscriptionId }, { AZURE_MANAGEMENT_TOKEN: token }]) {
    const { fetchImpl, requests } = fakeFetch({ markdown })
    const result = await load({ fetchImpl, env: { ...half, ...strict } })
    strictAssert.match(result.error.message, /is set but AZURE_(MANAGEMENT_TOKEN|SUBSCRIPTION_ID) is not/)
    strictAssert.ok(requests.every(request => request.url === AZURE_MODEL_RETIREMENT_SCHEDULE_URL))
    const warned = await load({ fetchImpl: fakeFetch({ markdown }).fetchImpl, env: half })
    strictAssert.ok(!warned.error, warned.error?.message)
    strictAssert.deepEqual(warned.source.records.map(record => [record.azureId, record.shutdown]), [['whisper', '2026-12-15']])
    strictAssert.match(warned.notices[0], /^warning: azure models API cross-check failed: azure-ai-foundry models API: AZURE_(MANAGEMENT_TOKEN|SUBSCRIPTION_ID) is set but/)
    strictAssert.deepEqual(warned.source.conflicts.map(conflict => [conflict.via, conflict.source, conflict.reason]), [['azure-ai-foundry', 'models-api', 'cross-check-failed']])
  }
})

await test('a 401 or 403 fails the source under strict cross-checks without printing the subscription or the token', async () => {
  const realLooking = '12345678-9abc-def0-1234-56789abcdef0'
  for (const status of [401, 403]) {
    const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
    const result = await load({ fetchImpl: fakeFetch({ markdown, status }).fetchImpl, env: { AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: realLooking, ...strict } })
    strictAssert.match(result.error.message, new RegExp(`azure-ai-foundry models API eastus fetch failed for .*: HTTP ${status} AuthenticationFailed$`))
    strictAssert.ok(result.error.message.includes('{subscriptionId}') && !result.error.message.includes(realLooking) && !result.error.message.includes(token))
  }
})

await test('an AuthorizationFailed 403 reports only its status and error code, with no subscription, client, or object id', async () => {
  const subscription = '7C1E2A90-5B3D-4E8F-9A61-0D2C4B6E8F13'
  const client = '3f9a1c27-8e4b-4d62-a0f5-b7c19e2d4a68'
  const object = '9e0d4b13-6a7c-4f28-8b51-2c3e7a9d0f46'
  const message = `The client '${client}' with object id '${object}' does not have authorization to perform action 'Microsoft.CognitiveServices/locations/models/read' over scope '/subscriptions/${subscription.toLowerCase()}' or the scope is invalid. If access was recently granted, please refresh your credentials.`
  const errorBody = JSON.stringify({ error: { code: 'AuthorizationFailed', message } })
  const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
  const credentials = { AZURE_MANAGEMENT_TOKEN: token, AZURE_SUBSCRIPTION_ID: subscription }
  const failed = await load({ fetchImpl: fakeFetch({ markdown, status: 403, errorBody }).fetchImpl, env: { ...credentials, ...strict } })
  strictAssert.equal(failed.error.message, `azure-ai-foundry models API eastus fetch failed for ${azureModelsApiUrl('{subscriptionId}', 'eastus')}: HTTP 403 AuthorizationFailed`)
  const warned = await load({ fetchImpl: fakeFetch({ markdown, status: 403, errorBody }).fetchImpl, env: credentials })
  const published = [...warned.notices, ...warned.source.conflicts.map(sourceConflictSummary)].join('\n')
  strictAssert.ok(published.includes('HTTP 403 AuthorizationFailed'), published)
  for (const secret of [subscription, client, object, token, client.slice(0, 8), object.slice(-12), subscription.slice(-12), 'does not have authorization']) {
    strictAssert.ok(!published.toLowerCase().includes(secret.toLowerCase()), secret)
  }
  const odd = await load({ fetchImpl: fakeFetch({ markdown, status: 500, errorBody: `{"error":{"code":"Bad code ${client}"}}` }).fetchImpl, env: { ...credentials, ...strict } })
  strictAssert.match(odd.error.message, /: HTTP 500$/)
})

await test('every GUID is redacted in any case', () => {
  const subscription = 'ABCDEF01-2345-6789-ABCD-EF0123456789'
  const other = 'fedcba98-7654-3210-FEDC-BA9876543210'
  const text = `x /subscriptions/${subscription.toLowerCase()}/y client ${other} token ${token}`
  strictAssert.equal(redactAzureModelsApiMessage(text, { token, subscriptionId: subscription }), 'x /subscriptions/{subscriptionId}/y client {guid} token [redacted]')
  strictAssert.equal(redactAzureModelsApiMessage(`id ${other.toUpperCase()}`), 'id {guid}')
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
  strictAssert.ok(result.notices.includes('notice: azure-ai-foundry models API openai/whisper: page 2026-12-15 (GA, version 001); API GenerallyAvailable 2027-02-26 (version 001) in eastus; retirement page kept'))
  const summary = result.notices.filter(line => line.startsWith('notice: azure models API:'))
  strictAssert.deepEqual(summary, [`notice: azure models API: 12 entries in 1 locations; 4 deprecating/deprecated/legacy; ${result.source.conflicts.length} conflicts with the retirement page; 0 entries differ by exactly one day`])
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
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.publisher, conflict.id]), [['unlisted', 'anthropic', 'claude-old'], ['unlisted', 'openai', 'gpt-new-2026-10-01'], ['unlisted', 'openai', 'o3-deep-research-2025-06-26']])
  strictAssert.equal(sourceConflictSummary(conflicts[2]), 'azure-ai-foundry models API openai/o3-deep-research-2025-06-26: API Deprecating 2026-11-19 (version 2025-06-26) in eastus; the retirement page does not list it')
  strictAssert.equal(sourceConflictSummary(conflicts[1]), 'azure-ai-foundry models API openai/gpt-new-2026-10-01: API GenerallyAvailable 2027-10-01 (version 2026-10-01) in eastus; the retirement page does not list it')
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
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'azure-ai-foundry models API openai/tts: page 2026-12-15 (Preview, version 001); API GenerallyAvailable (version 001) in eastus with no retirement date; retirement page kept')
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

await test('an API version is compared with the page row for the same version, not the earliest row the page keeps', async () => {
  const markdown = page({ Anthropic: [['claude-haiku-4-5', '1', 'GA', '2027-02-22'], ['claude-haiku-4-5', '2', 'GA', '2027-03-16']] })
  const agreeing = apiBody([apiItem('Anthropic', 'claude-haiku-4-5', '1', 'GenerallyAvailable', '2027-02-22'), apiItem('Anthropic', 'claude-haiku-4-5', '2', 'GenerallyAvailable', '2027-03-16')])
  const result = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: [agreeing] } }).fetchImpl, env })
  strictAssert.ok(!result.error, result.error?.message)
  strictAssert.deepEqual(result.source.records.map(record => [record.azureId, record.version, record.shutdown]), [['claude-haiku-4-5', '1', '2027-02-22']])
  strictAssert.deepEqual(result.source.conflicts.filter(conflict => conflict.source === 'models-api'), [])
  const differing = apiBody([apiItem('Anthropic', 'claude-haiku-4-5', '2', 'GenerallyAvailable', '2027-04-01'), apiItem('Anthropic', 'claude-haiku-4-5', '20251001', 'GenerallyAvailable', '2027-04-01')])
  const changed = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: [differing] } }).fetchImpl, env })
  const api = changed.source.conflicts.filter(conflict => conflict.source === 'models-api')
  strictAssert.deepEqual(api.map(conflict => [conflict.page.version, conflict.page.shutdown, conflict.api.versions.join()]), [['2', '2027-03-16', '2'], ['1', '2027-02-22', '20251001']])
  strictAssert.equal(sourceConflictSummary(api[0]), 'azure-ai-foundry models API anthropic/claude-haiku-4-5: page 2027-03-16 (GA, version 2); API GenerallyAvailable 2027-04-01 (version 2) in eastus; retirement page kept')
})

await test('a deprecation.inference in 2099 or later is no date, and a dated GA or Preview entry the page does not list is reported', () => {
  for (const placeholder of ['2099-06-03', '2100-01-01', '9999-12-31']) {
    strictAssert.equal(entries(apiItem('Mistral AI', 'Codestral-2501', '2', 'GenerallyAvailable', placeholder)).at(0).shutdown, undefined, placeholder)
  }
  strictAssert.equal(entries(apiItem('Mistral AI', 'Codestral-2501', '2', 'GenerallyAvailable', '2098-12-31')).at(0).shutdown, '2098-12-31')
  const listed = records({ 'Mistral AI': [['Codestral-2501', '2', 'GA', '2027-02-15']], Cohere: [['Cohere-embed-v3-english', '1', 'GA', '-']] })
  const api = entries(
    apiItem('Mistral AI', 'Codestral-2501', '2', 'GenerallyAvailable', '2099-06-03'),
    apiItem('Cohere', 'Cohere-embed-v3-english', '1', 'GenerallyAvailable', '2099-06-03'),
    apiItem('Cohere', 'Cohere-new', '1', 'GenerallyAvailable', '2026-12-01'),
    apiItem('Mistral AI', 'mistral-preview', '1', 'Preview', '2027-01-01'),
    apiItem('Mistral AI', 'mistral-undated', '1', 'Preview', '2099-06-03'),
  )
  const { conflicts } = reconcileAzureModelsApi(listed, api)
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id, conflict.api.shutdown]), [
    ['unlisted', 'Cohere-new', '2026-12-01'],
    ['undated', 'Codestral-2501', undefined],
    ['unlisted', 'mistral-preview', '2027-01-01'],
  ])
})

await test('one-day differences share one notice and one diff bullet, and other conflicts keep their own lines', async () => {
  const markdown = page({
    Anthropic: [['claude-sonnet-4-5', '1', 'GA', '2026-11-30']],
    Cohere: [['Cohere-embed-v3-english', '1', 'GA', '2027-02-15'], ['Cohere-embed-v3-multilingual', '1', 'GA', '2027-02-15']],
    'Mistral AI': [['mistral-small-2503', '1', 'Deprecated', '2027-02-15']],
  })
  const body = apiBody([
    apiItem('Anthropic', 'claude-sonnet-4-5', '1', 'Deprecating', '2026-12-01'),
    apiItem('Cohere', 'Cohere-embed-v3-english', '1', 'GenerallyAvailable', '2027-02-16'),
    apiItem('Cohere', 'Cohere-embed-v3-multilingual', '1', 'GenerallyAvailable', '2027-02-14'),
    apiItem('Mistral AI', 'mistral-small-2503', '1', 'GenerallyAvailable', '2026-12-09'),
  ])
  const result = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: [body] } }).fetchImpl, env })
  strictAssert.ok(!result.error, result.error?.message)
  const conflicts = result.source.conflicts
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id]), [
    ['one-day', 'claude-sonnet-4-5'],
    ['one-day', 'Cohere-embed-v3-english'],
    ['one-day', 'Cohere-embed-v3-multilingual'],
    ['date', 'mistral-small-2503'],
  ])
  strictAssert.deepEqual(result.notices, [
    'notice: azure-ai-foundry models API mistral/mistral-small-2503: page 2027-02-15 (Deprecated, version 1); API GenerallyAvailable 2026-12-09 (version 1) in eastus; retirement page kept',
    'notice: azure-ai-foundry models API: 3 entries differ from the retirement page by exactly one day; retirement page kept',
    'notice: azure models API: 4 entries in 1 locations; 1 deprecating/deprecated/legacy; 1 conflicts with the retirement page; 3 entries differ by exactly one day',
  ])
  const empty = { publisher: 'openai', models: [] }
  const diff = renderSemanticDiff(empty, empty, { sourceConflicts: conflicts })
  strictAssert.ok(diff.includes([
    '## Source conflicts',
    '',
    '- azure-ai-foundry models API mistral/mistral-small-2503: page 2027-02-15 (Deprecated, version 1); API GenerallyAvailable 2026-12-09 (version 1) in eastus; retirement page kept',
    '- azure-ai-foundry models API: 3 entries differ from the retirement page by exactly one day; retirement page kept:',
    '  - anthropic/claude-sonnet-4-5: page 2026-11-30 (GA, version 1); API Deprecating 2026-12-01 (version 1) in eastus',
    '  - cohere/Cohere-embed-v3-english: page 2027-02-15 (GA, version 1); API GenerallyAvailable 2027-02-16 (version 1) in eastus',
    '  - cohere/Cohere-embed-v3-multilingual: page 2027-02-15 (GA, version 1); API GenerallyAvailable 2027-02-14 (version 1) in eastus',
    '',
  ].join('\n')), diff)
  const twoDays = reconcileAzureModelsApi(records({ Cohere: [['Cohere-x', '1', 'GA', '2027-02-15']] }), entries(apiItem('Cohere', 'Cohere-x', '1', 'GenerallyAvailable', '2027-02-17'))).conflicts
  strictAssert.deepEqual(twoDays.map(conflict => conflict.reason), ['date'])
})

await test('a nextLink with a username or password is refused', async () => {
  for (const link of [firstUrl('eastus').replace('https://', 'https://user@'), firstUrl('eastus').replace('https://', 'https://:secret@'), firstUrl('eastus').replace('https://', 'https://user:secret@')]) {
    const userinfo = async () => new Response(apiBody([], `${link}&$skiptoken=2`))
    await strictAssert.rejects(fetchAzureModelsApi({ token, subscriptionId }, { fetchImpl: userinfo, locations: ['eastus'] }), /nextLink carries a username or password/, link)
  }
})

await test('a broken cross-check warns and keeps the page by default, fails under strict, and a broken page always fails', async () => {
  const markdown = page({ 'Azure OpenAI': [['whisper', '001', 'GA', '2026-12-15']] })
  const meta = apiBody([apiItem('Meta', 'Llama-4', '1', 'Retiring')])
  const warned = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: [meta] } }).fetchImpl, env })
  strictAssert.ok(!warned.error, warned.error?.message)
  strictAssert.deepEqual(warned.source.records.map(record => record.azureId), ['whisper'])
  strictAssert.deepEqual(warned.notices.filter(line => line.startsWith('warning:')), ['warning: azure models API cross-check failed: azure-ai-foundry models API eastus entry 0 (Meta Llama-4 version 1) has an unknown lifecycleStatus: "Retiring"'])
  const [failure] = warned.source.conflicts
  strictAssert.deepEqual(failure, { via: 'azure-ai-foundry', source: 'models-api', reason: 'cross-check-failed', message: 'azure-ai-foundry models API eastus entry 0 (Meta Llama-4 version 1) has an unknown lifecycleStatus: "Retiring"' })
  strictAssert.ok(warned.notices.includes(`notice: ${sourceConflictSummary(failure)}`))
  strictAssert.equal(sourceConflictSummary(failure), 'azure-ai-foundry models API cross-check failed: azure-ai-foundry models API eastus entry 0 (Meta Llama-4 version 1) has an unknown lifecycleStatus: "Retiring"; the retirement page was read without the cross-check')
  const empty = { publisher: 'openai', models: [] }
  strictAssert.ok(renderSemanticDiff(empty, empty, { sourceConflicts: warned.source.conflicts }).includes(`## Source conflicts\n\n- ${sourceConflictSummary(failure)}\n`))
  const failed = await load({ fetchImpl: fakeFetch({ markdown, api: { eastus: [meta] } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.match(failed.error.message, /unknown lifecycleStatus: "Retiring"/)
  for (const cross of [{}, strict]) {
    const broken = await load({ fetchImpl: fakeFetch({ markdown: '<!doctype html><html></html>', api: { eastus: apiPages } }).fetchImpl, env: { ...env, ...cross } })
    strictAssert.match(broken.error.message, /azure-ai-foundry lifecycle source is HTML, not Markdown/)
  }
  strictAssert.equal(crossChecksStrict({}), false)
  strictAssert.equal(crossChecksStrict({ MODEL_EOL_CROSS_CHECKS: '' }), false)
  strictAssert.equal(crossChecksStrict({ MODEL_EOL_CROSS_CHECKS: 'warn' }), false)
  strictAssert.equal(crossChecksStrict(strict), true)
  for (const typo of ['Strict', 'stirct', '1']) strictAssert.throws(() => crossChecksStrict({ MODEL_EOL_CROSS_CHECKS: typo }), /MODEL_EOL_CROSS_CHECKS must be strict, warn, or unset/)
  const typo = await load({ fetchImpl: fakeFetch({ markdown }).fetchImpl, env: { ...env, MODEL_EOL_CROSS_CHECKS: 'stirct' } })
  strictAssert.match(typo.error.message, /MODEL_EOL_CROSS_CHECKS must be/)
})

if (failures) {
  console.error(`${failures} Azure models API test(s) failed`)
  process.exit(1)
}
