#!/usr/bin/env node
// Offline tests for SigV4 signing and the Bedrock ListFoundationModels cross-check of the Bedrock lifecycle page.
import fs from 'node:fs'
import path from 'node:path'
import strictAssert from 'node:assert/strict'
import { awsCanonicalQuery, signAwsRequest } from '../aws-sigv4.mjs'
import {
  BEDROCK_MODELS_API_REGIONS,
  bedrockModelsApiCredentials,
  bedrockModelsApiUrl,
  fetchBedrockModelsApi,
  parseBedrockModelsApiResponse,
  reconcileBedrockModelsApi,
  redactBedrockModelsApiMessage,
} from '../bedrock-models-api.mjs'
import {
  BEDROCK_LIFECYCLE_MARKDOWN_URL,
  BEDROCK_MODEL_CARDS_MARKDOWN_URL,
  loadDistributorSource,
  parseBedrockLifecycleMarkdownRows,
  sourceConflictSummary,
} from '../distributors.mjs'
import { compareFeeds, renderSemanticDiff } from '../diff.mjs'

const fixtures = path.join(import.meta.dirname, 'fixture')
const recorded = Object.fromEntries(['us-east-1', 'us-west-2'].map(region => [region, fs.readFileSync(path.join(fixtures, 'bedrock-models-api', `${region}.json`), 'utf8')]))
const lifecycleFixture = fs.readFileSync(path.join(fixtures, 'bedrock-lifecycle.md'), 'utf8')
const cardIndexFixture = fs.readFileSync(path.join(fixtures, 'bedrock-model-cards.md'), 'utf8')
const accessKeyId = 'AKIAZZZZEXAMPLE12345'
const secretAccessKey = 'zzzzSECRETzzzzEXAMPLEzzzzKEYzzzz/zzzz+zz'
const sessionToken = 'IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKENzzzz'
const env = { AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey }
const strict = { MODEL_EOL_CROSS_CHECKS: 'strict' }
const now = '2026-11-17T00:00:00Z'
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

const lifecycle = (status, legacy, eol, extendedAccess) => ({
  status,
  startOfLifeTime: '2024-01-01T17:00:00Z',
  legacyTime: legacy ? `${legacy}T08:00:00Z` : null,
  endOfLifeTime: eol ? `${eol}T08:00:00Z` : null,
  publicExtendedAccessTime: extendedAccess ? `${extendedAccess}T08:00:00Z` : null,
})
const model = (modelId, status = 'ACTIVE', legacy, eol, extendedAccess) => ({
  modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}`,
  modelId,
  providerName: 'Example',
  modelLifecycle: lifecycle(status, legacy, eol, extendedAccess),
})
const apiBody = (...models) => JSON.stringify({ modelSummaries: models })
const entries = (region, ...models) => parseBedrockModelsApiResponse(apiBody(...models), region)
const regionalEntry = (id, ...lines) => [
  '- **Example**',
  '  - **Model name:** Example',
  `  - **Model ID:** ${id}`,
  ...lines.map(([regions, legacy, eol, extendedAccess]) => `  - **Regions:** ${regions} / **Legacy date:** ${legacy} / **EOL date:** ${eol} / **Public extended access start date:** ${extendedAccess}`),
  '',
  '',
].join('\n')
const pageEntry = (id, regions, legacy, eol, extendedAccess = 'N/A') => [
  '- **Example**',
  '  - **Model name:** Example',
  `  - **Model ID:** ${id}`,
  `  - **Regions:** ${regions}`,
  `  - **Legacy date:** ${legacy}`,
  `  - **EOL date:** ${eol}`,
  `  - **Public extended access start date:** ${extendedAccess}`,
  '',
  '',
].join('\n')
const page = (...items) => `# Model lifecycle (Legacy)\n\n${items.join('')}`
const pageRows = markdown => parseBedrockLifecycleMarkdownRows(markdown)

/** A fetch that serves the lifecycle page, the card fixtures, and, per Region, the given API body or error. */
function fakeFetch({ markdown = lifecycleFixture, api = {}, errors = {} } = {}) {
  const requests = []
  const fetchImpl = async (url, init) => {
    url = String(url)
    requests.push({ url, init })
    if (url === BEDROCK_LIFECYCLE_MARKDOWN_URL) return new Response(markdown)
    if (url === BEDROCK_MODEL_CARDS_MARKDOWN_URL) return new Response(cardIndexFixture)
    if (url.includes('/userguide/model-card-')) return new Response(fs.readFileSync(path.join(fixtures, 'bedrock-model-cards', path.basename(new URL(url).pathname)), 'utf8'))
    const region = new URL(url).hostname.split('.')[1]
    if (errors[region]) return errors[region]()
    if (api[region] === undefined) return new Response('not found', { status: 404 })
    return new Response(api[region])
  }
  return { fetchImpl, requests }
}

const load = options => {
  const notices = []
  return loadDistributorSource('aws-bedrock', { now, notice: line => notices.push(line), bedrockRegions: ['us-east-1', 'us-west-2'], ...options })
    .then(source => ({ source, notices }), error => ({ error, notices }))
}
const apiConflicts = source => source.conflicts.filter(conflict => conflict.source === 'models-api')

// Vectors from the AWS SigV4 test suite as published in awslabs/aws-c-auth tests/aws-signing-test-suite/v4.
const vector = { region: 'us-east-1', service: 'service', now: '2015-08-30T12:36:00Z', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' } }

await test('SigV4 matches the AWS test suite vectors, including GET with a query and with a session token', () => {
  const sign = (pathAndQuery, credentials = {}) => signAwsRequest({ ...vector, url: `https://example.amazonaws.com${pathAndQuery}`, credentials: { ...vector.credentials, ...credentials } })
  strictAssert.equal(sign('/').signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', 'get-vanilla')
  const keyCase = sign('/?Param2=value2&Param1=value1')
  strictAssert.equal(keyCase.canonicalRequest, 'GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  strictAssert.equal(keyCase.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0')
  strictAssert.equal(keyCase.headers.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500', 'get-vanilla-query-order-key-case')
  strictAssert.equal(keyCase.headers['X-Amz-Date'], '20150830T123600Z')
  strictAssert.equal(sign('/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1').signature, '371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac', 'get-vanilla-query-order-encoded')
  const unreserved = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  strictAssert.equal(sign(`/?${unreserved}=${unreserved}`).signature, '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197', 'get-vanilla-query-unreserved')
  const token = sign('/', { sessionToken: '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267' })
  strictAssert.equal(token.headers.Authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8', 'get-vanilla-with-session-token')
  strictAssert.equal(token.headers['X-Amz-Security-Token'], '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267')
  strictAssert.equal(awsCanonicalQuery('?b=2&a=2&a=1&c'), 'a=1&a=2&b=2&c=')
  strictAssert.throws(() => signAwsRequest({ ...vector, url: 'https://example.amazonaws.com/', headers: { Authorization: 'x' } }), /sets the authorization header itself/)
  strictAssert.throws(() => signAwsRequest({ ...vector, url: 'https://example.amazonaws.com/', credentials: { accessKeyId: 'AKIDEXAMPLE' } }), /needs an access key id and a secret access key/)
})

await test('the recorded responses parse with every lifecycle field, each timestamp read as its calendar date', () => {
  const east = parseBedrockModelsApiResponse(recorded['us-east-1'], 'us-east-1')
  strictAssert.equal(east.length, 9)
  strictAssert.deepEqual(east.find(entry => entry.id === 'anthropic.claude-opus-4-1-20250805-v1:0'), { region: 'us-east-1', id: 'anthropic.claude-opus-4-1-20250805-v1:0', status: 'LEGACY', legacy: '2026-07-08', eol: '2027-01-08', extendedAccess: '2026-10-08' })
  strictAssert.deepEqual(east.find(entry => entry.id === 'amazon.nova-pro-v1:0'), { region: 'us-east-1', id: 'amazon.nova-pro-v1:0', status: 'ACTIVE' })
  strictAssert.deepEqual(east.find(entry => entry.id === 'writer.palmyra-x4-v1:0'), { region: 'us-east-1', id: 'writer.palmyra-x4-v1:0', status: 'LEGACY', legacy: '2026-09-09', eol: '2027-03-09' })
  for (const time of ['T08:00:00Z', 'T07:00:00Z', 'T00:00:00Z', 'T08:00:00.000Z']) {
    const item = model('a.m-v1:0', 'LEGACY')
    item.modelLifecycle.endOfLifeTime = `2027-03-30${time}`
    strictAssert.equal(entries('us-east-1', item)[0].eol, '2027-03-30', time)
  }
})

await test('an unknown status, a timestamp that is not a western-hemisphere midnight, or a malformed response fails closed', () => {
  for (const value of ['2027-03-30T09:00:00Z', '2027-03-30T08:30:00Z', '2027-03-29T16:00:00Z', '2027-03-30T08:00:00+01:00', '2027-02-30T08:00:00Z', '2027-03-30', 1806393600, 'March 30, 2027']) {
    const item = model('a.m-v1:0', 'LEGACY')
    item.modelLifecycle.endOfLifeTime = value
    strictAssert.throws(() => entries('us-east-1', item), /us-east-1 entry 0 \(a\.m-v1:0\) modelLifecycle\.endOfLifeTime is not a midnight timestamp between UTC and UTC-8/, String(value))
  }
  strictAssert.throws(() => entries('us-east-1', model('a.m-v1:0', 'DEPRECATED')), /has an unknown modelLifecycle\.status: "DEPRECATED"/)
  strictAssert.throws(() => entries('us-east-1', { modelId: 'a.m-v1:0' }), /has no modelLifecycle object/)
  strictAssert.throws(() => entries('us-east-1', { ...model('a.m-v1:0'), modelId: 'no dot' }), /has an invalid modelId/)
  strictAssert.throws(() => entries('us-east-1', model('a.m-v1:0'), model('a.m-v1:0')), /us-east-1 lists a\.m-v1:0 twice/)
  strictAssert.throws(() => parseBedrockModelsApiResponse('{"models": []}', 'us-east-1'), /us-east-1 response has no modelSummaries array/)
  strictAssert.throws(() => parseBedrockModelsApiResponse('{"modelSummaries": [], "nextToken": "x"}', 'us-east-1'), /has a nextToken/)
  strictAssert.throws(() => parseBedrockModelsApiResponse('<html>', 'us-east-1'), /not JSON/)
})

await test('half-configured or malformed credentials fail without printing any value, and no credentials skip', () => {
  strictAssert.equal(bedrockModelsApiCredentials({}), undefined)
  strictAssert.equal(bedrockModelsApiCredentials({ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: ' ' }), undefined)
  strictAssert.deepEqual(bedrockModelsApiCredentials(env), { accessKeyId, secretAccessKey })
  strictAssert.deepEqual(bedrockModelsApiCredentials({ ...env, AWS_SESSION_TOKEN: sessionToken }), { accessKeyId, secretAccessKey, sessionToken })
  const message = candidate => {
    try {
      bedrockModelsApiCredentials(candidate)
    } catch (error) {
      return error.message
    }
    return ''
  }
  const cases = [
    [{ AWS_ACCESS_KEY_ID: accessKeyId }, /AWS_ACCESS_KEY_ID is set but AWS_SECRET_ACCESS_KEY is not/],
    [{ AWS_SECRET_ACCESS_KEY: secretAccessKey }, /AWS_SECRET_ACCESS_KEY is set but AWS_ACCESS_KEY_ID is not/],
    [{ AWS_SESSION_TOKEN: sessionToken }, /AWS_SESSION_TOKEN is set but AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not/],
    [{ ...env, AWS_ACCESS_KEY_ID: 'my key/../x' }, /AWS_ACCESS_KEY_ID is not an access key id/],
    [{ ...env, AWS_SECRET_ACCESS_KEY: 'two words' }, /AWS_SECRET_ACCESS_KEY contains whitespace/],
    [{ ...env, AWS_SESSION_TOKEN: 'two words' }, /AWS_SESSION_TOKEN contains whitespace/],
  ]
  for (const [candidate, pattern] of cases) {
    const text = message(candidate)
    strictAssert.match(text, pattern)
    for (const value of Object.values(candidate)) strictAssert.ok(!text.includes(value), value)
  }
})

await test('each Region is one signed GET that refuses redirects and marks the signing headers as credentials', async () => {
  const { fetchImpl, requests } = fakeFetch({ api: recorded })
  const signedAt = new Date('2026-11-17T05:00:00Z')
  const api = await fetchBedrockModelsApi({ accessKeyId, secretAccessKey, sessionToken }, { fetchImpl, regions: ['us-east-1', 'us-west-2'], now: signedAt })
  strictAssert.equal(api.entries.length, 18)
  strictAssert.deepEqual(api.regions, ['us-east-1', 'us-west-2'])
  strictAssert.deepEqual(api.notEnabled, [])
  strictAssert.deepEqual(requests.map(request => request.url), [bedrockModelsApiUrl('us-east-1'), bedrockModelsApiUrl('us-west-2')])
  for (const [index, region] of ['us-east-1', 'us-west-2'].entries()) {
    const { init } = requests[index]
    const expected = signAwsRequest({ url: bedrockModelsApiUrl(region), region, service: 'bedrock', credentials: { accessKeyId, secretAccessKey, sessionToken }, headers: { Accept: 'application/json' }, now: signedAt })
    strictAssert.equal(init.redirect, 'error')
    strictAssert.equal(init.headers.Authorization, expected.headers.Authorization)
    strictAssert.ok(init.headers.Authorization.includes(`/20261117/${region}/bedrock/aws4_request, SignedHeaders=accept;host;x-amz-date;x-amz-security-token, Signature=`))
    strictAssert.equal(init.headers['X-Amz-Security-Token'], sessionToken)
    strictAssert.equal(init.headers['X-Amz-Date'], '20261117T050000Z')
  }
  strictAssert.equal(BEDROCK_MODELS_API_REGIONS.length, 17)
  strictAssert.ok(!BEDROCK_MODELS_API_REGIONS.some(region => /gov|ca-west|eu-central-2|eu-south|ap-south-2|ap-southeast-[3-7]|ap-east|af-|il-|me-|mx-/.test(region)), 'no opt-in or GovCloud Region')
})

await test('an AccessDenied 403 reports only its status and error type, never the account, ARN, key, or signature', async () => {
  const account = '123456789012'
  const body = JSON.stringify({ message: `User: arn:aws:iam::${account}:user/model-eol-bedrock-read is not authorized to perform: bedrock:ListFoundationModels with key ${accessKeyId}` })
  const denied = () => new Response(body, { status: 403, headers: { 'x-amzn-ErrorType': 'AccessDeniedException:http://internal.amazon.com/coral/com.amazon.coral.service/' } })
  const failed = await load({ fetchImpl: fakeFetch({ errors: { 'us-east-1': denied } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.equal(failed.error.message, `aws-bedrock models API us-east-1 fetch failed for ${bedrockModelsApiUrl('us-east-1')}: HTTP 403 AccessDeniedException`)
  const warned = await load({ fetchImpl: fakeFetch({ errors: { 'us-east-1': denied } }).fetchImpl, env: { ...env, AWS_SESSION_TOKEN: sessionToken } })
  strictAssert.ok(!warned.error, warned.error?.message)
  const published = [...warned.notices, ...warned.source.conflicts.map(sourceConflictSummary)].join('\n')
  strictAssert.ok(published.includes('HTTP 403 AccessDeniedException'), published)
  for (const secret of [account, accessKeyId, secretAccessKey, sessionToken, 'arn:aws:iam', 'model-eol-bedrock-read', 'Signature=']) strictAssert.ok(!published.includes(secret), secret)
  const bodyOnly = () => new Response(JSON.stringify({ __type: 'com.amazon.coral.service#ThrottlingException', message: `account ${account}` }), { status: 429 })
  const throttled = await load({ fetchImpl: fakeFetch({ errors: { 'us-east-1': bodyOnly } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.match(throttled.error.message, /: HTTP 429 ThrottlingException$/)
  const odd = await load({ fetchImpl: fakeFetch({ errors: { 'us-east-1': () => new Response(`{"__type":"Bad type ${account}"}`, { status: 500 }) } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.match(odd.error.message, /: HTTP 500$/)
})

await test('a Region that does not recognise the credentials is one notice, not a failure, unless every Region refuses them', async () => {
  const unrecognised = () => new Response('{"message":"The security token included in the request is invalid."}', { status: 403, headers: { 'x-amzn-ErrorType': 'UnrecognizedClientException:http://internal.amazon.com/coral/com.amazon.coral.service/' } })
  const partly = await load({ fetchImpl: fakeFetch({ api: recorded, errors: { 'ca-west-1': unrecognised, 'il-central-1': unrecognised } }).fetchImpl, env: { ...env, ...strict }, bedrockRegions: ['us-east-1', 'ca-west-1', 'il-central-1'] })
  strictAssert.ok(!partly.error, partly.error?.message)
  strictAssert.deepEqual(partly.notices.filter(line => line.includes('not enabled')), ['notice: bedrock models API: 2 regions not enabled for these credentials (HTTP 403 UnrecognizedClientException), skipped: ca-west-1, il-central-1'])
  strictAssert.ok(partly.notices.includes('notice: bedrock models API: 9 entries in 1 regions; 8 legacy; 2 conflicts with the lifecycle page'), partly.notices.join('\n'))
  const all = await load({ fetchImpl: fakeFetch({ errors: { 'us-east-1': unrecognised, 'us-west-2': unrecognised } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.equal(all.error.message, 'aws-bedrock models API: every region refused the credentials (HTTP 403 UnrecognizedClientException)')
  const signature = () => new Response('{}', { status: 403, headers: { 'x-amzn-ErrorType': 'InvalidSignatureException' } })
  const bad = await load({ fetchImpl: fakeFetch({ api: recorded, errors: { 'us-west-2': signature } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.match(bad.error.message, /us-west-2 fetch failed for .*: HTTP 403 InvalidSignatureException$/)
})

await test('the loader skips the API without credentials; one credential alone fails under strict cross-checks and warns otherwise', async () => {
  const skipped = await load({ fetchImpl: fakeFetch().fetchImpl, env: {} })
  strictAssert.ok(skipped.notices.includes('notice: bedrock models API skipped: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set'))
  strictAssert.deepEqual(apiConflicts(skipped.source), [])
  const fixtureRun = await loadDistributorSource('aws-bedrock', { fixtures, env, notice: () => {} })
  strictAssert.deepEqual(apiConflicts(fixtureRun), [])
  for (const half of [{ AWS_ACCESS_KEY_ID: accessKeyId }, { AWS_SECRET_ACCESS_KEY: secretAccessKey }]) {
    const { fetchImpl, requests } = fakeFetch()
    const result = await load({ fetchImpl, env: { ...half, ...strict } })
    strictAssert.match(result.error.message, /is set but AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY) is not/)
    strictAssert.ok(requests.every(request => !request.url.includes('/foundation-models')))
    const warned = await load({ fetchImpl: fakeFetch().fetchImpl, env: half })
    strictAssert.ok(!warned.error, warned.error?.message)
    strictAssert.ok(warned.source.records.some(record => record.bedrockId === 'deepseek.r1-v1:0' && record.eol === '2027-03-30'))
    strictAssert.match(warned.notices[0], /^warning: bedrock models API cross-check failed: aws-bedrock models API: AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY) is set but/)
    strictAssert.deepEqual(apiConflicts(warned.source).map(conflict => [conflict.via, conflict.source, conflict.reason]), [['aws-bedrock', 'models-api', 'cross-check-failed']])
  }
})

await test('the recorded responses against the recorded page report the expected conflicts, render in the diff, and keep the page records', async () => {
  const plain = await load({ fetchImpl: fakeFetch().fetchImpl, env: {} })
  const result = await load({ fetchImpl: fakeFetch({ api: recorded }).fetchImpl, env })
  strictAssert.ok(!result.error, result.error?.message)
  strictAssert.deepEqual(result.source.records, plain.source.records)
  const conflicts = apiConflicts(result.source)
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id, conflict.regions.join()]), [
    ['unlisted', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'us-east-1,us-west-2'],
    ['undated', 'deepseek.v3-v1:0', 'us-west-2'],
    ['unlisted', 'meta.llama3-1-8b-instruct-v1:0', 'us-east-1,us-west-2'],
    ['unlisted', 'meta.llama3-1-8b-instruct-v1:0:128k', 'us-west-2'],
  ])
  strictAssert.deepEqual(conflicts[1], {
    via: 'aws-bedrock', source: 'models-api', reason: 'undated', id: 'deepseek.v3-v1:0', regions: ['us-west-2'],
    api: { status: 'ACTIVE' }, page: { legacy: '2026-09-30', eol: '2027-03-30' },
  })
  strictAssert.ok(result.notices.includes('notice: aws-bedrock models API deepseek.v3-v1:0: page legacy 2026-09-30, EOL 2027-03-30, extended access none; API ACTIVE with no lifecycle dates in us-west-2; lifecycle page kept'), result.notices.join('\n'))
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'aws-bedrock models API anthropic.claude-sonnet-4-5-20250929-v1:0: API LEGACY (legacy 2026-10-08, EOL 2027-04-08, extended access 2027-01-08) in us-east-1, us-west-2; the lifecycle page does not list it in these Regions')
  strictAssert.deepEqual(result.notices.filter(line => line.startsWith('notice: bedrock models API:')), ['notice: bedrock models API: 18 entries in 2 regions; 15 legacy; 4 conflicts with the lifecycle page'])
  const empty = { publisher: 'anthropic', models: [] }
  const options = { sourceConflicts: result.source.conflicts }
  strictAssert.equal(compareFeeds(empty, empty, options).changed, false)
  const diff = renderSemanticDiff(empty, empty, options)
  strictAssert.ok(diff.includes('## Source conflicts\n') && conflicts.every(conflict => diff.includes(`\n- ${sourceConflictSummary(conflict)}\n`)), diff)
})

await test('a different legacy, EOL, or extended access date in a Region is a date conflict grouped across Regions', () => {
  const { records, rows } = pageRows(page(pageEntry('a.m-v1:0', 'us-east-1, us-west-2, eu-west-1', 'September 30, 2026', 'March 30, 2027', 'December 30, 2026')))
  const api = [
    ...entries('us-east-1', model('a.m-v1:0', 'LEGACY', '2026-09-30', '2027-04-30', '2026-12-30')),
    ...entries('us-west-2', model('a.m-v1:0', 'LEGACY', '2026-09-30', '2027-04-30', '2026-12-30')),
    ...entries('eu-west-1', model('a.m-v1:0', 'LEGACY', '2026-09-30', '2027-03-30', '2026-12-30')),
  ]
  const { records: kept, conflicts } = reconcileBedrockModelsApi(records, api, { rows, now })
  strictAssert.equal(kept, records)
  strictAssert.deepEqual(conflicts, [{
    via: 'aws-bedrock', source: 'models-api', reason: 'date', id: 'a.m-v1:0', regions: ['us-east-1', 'us-west-2'],
    api: { status: 'LEGACY', legacy: '2026-09-30', eol: '2027-04-30', extendedAccess: '2026-12-30' },
    page: { legacy: '2026-09-30', eol: '2027-03-30', extendedAccess: '2026-12-30' },
  }])
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'aws-bedrock models API a.m-v1:0: page legacy 2026-09-30, EOL 2027-03-30, extended access 2026-12-30; API LEGACY (legacy 2026-09-30, EOL 2027-04-30, extended access 2026-12-30) in us-east-1, us-west-2; lifecycle page kept')
  for (const [field, value] of [['legacy', ['2026-10-01', '2027-03-30', '2026-12-30']], ['extendedAccess', ['2026-09-30', '2027-03-30', undefined]]]) {
    const changed = reconcileBedrockModelsApi(records, entries('eu-west-1', model('a.m-v1:0', 'LEGACY', ...value)), { rows, now }).conflicts
    strictAssert.deepEqual(changed.map(conflict => [conflict.reason, conflict.regions.join()]), [['date', 'eu-west-1']], field)
  }
  const regional = pageRows(page(regionalEntry('b.m-v1:0', ['us-east-1', 'October 10, 2026', 'December 13, 2026', 'October 10, 2026'], ['us-west-2', 'October 15, 2026', 'December 27, 2026', 'October 15, 2026'])))
  strictAssert.deepEqual(regional.records.map(record => [record.legacy, record.eol]), [['2026-10-10', '2026-12-13']])
  const agreeing = [...entries('us-east-1', model('b.m-v1:0', 'LEGACY', '2026-10-10', '2026-12-13', '2026-10-10')), ...entries('us-west-2', model('b.m-v1:0', 'LEGACY', '2026-10-15', '2026-12-27', '2026-10-15'))]
  strictAssert.deepEqual(reconcileBedrockModelsApi(regional.records, agreeing, { rows: regional.rows, now }).conflicts, [], 'each Region is compared with its own regional line, not the merged earliest dates')
})

await test('a page record with an EOL date that the API calls ACTIVE with no dates is reported once per observation', () => {
  const { records, rows } = pageRows(page(pageEntry('a.m-v1:0', 'us-east-1, us-west-2', 'September 30, 2026', 'March 30, 2027', 'To be announced')))
  const api = [...entries('us-east-1', model('a.m-v1:0')), ...entries('us-west-2', model('a.m-v1:0'))]
  const { conflicts } = reconcileBedrockModelsApi(records, api, { rows, now })
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.regions.join()]), [['undated', 'us-east-1,us-west-2']])
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'aws-bedrock models API a.m-v1:0: page legacy 2026-09-30, EOL 2027-03-30, extended access none; API ACTIVE with no lifecycle dates in us-east-1, us-west-2; lifecycle page kept')
})

await test('an API LEGACY or dated entry the page does not list in that Region is reported; an undated ACTIVE one is not', () => {
  const { records, rows } = pageRows(page(pageEntry('a.m-v1:0', 'us-east-1', 'September 30, 2026', 'March 30, 2027')))
  const api = [
    ...entries('us-east-1', model('a.m-v1:0', 'LEGACY', '2026-09-30', '2027-03-30'), model('c.new-v1:0'), model('d.dated-v1:0', 'ACTIVE', undefined, '2027-06-01')),
    ...entries('us-west-2', model('a.m-v1:0', 'LEGACY', '2026-09-30', '2027-03-30')),
  ]
  const { conflicts } = reconcileBedrockModelsApi(records, api, { rows, now })
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id, conflict.regions.join()]), [['unlisted', 'a.m-v1:0', 'us-west-2'], ['unlisted', 'd.dated-v1:0', 'us-east-1']])
  strictAssert.equal(sourceConflictSummary(conflicts[1]), 'aws-bedrock models API d.dated-v1:0: API ACTIVE (legacy none, EOL 2027-06-01, extended access none) in us-east-1; the lifecycle page does not list it in these Regions')
})

await test('a page model the API does not return in a Region it read is reported, except past EOL, unread Regions, and bedrock-mantle ids', () => {
  const markdown = page(
    pageEntry('a.m-v1:0', 'us-east-1, us-west-2, eu-west-3', 'September 30, 2026', 'March 30, 2027'),
    pageEntry('e.gone-v1:0', 'us-east-1', 'March 30, 2026', 'September 30, 2026'),
    pageEntry('f.today-v1:0', 'us-east-1', 'May 17, 2026', 'November 17, 2026'),
    pageEntry('g.run-v1:0 (bedrock-runtime), g.mantle (bedrock-mantle)', 'us-east-1', 'September 30, 2026', 'March 30, 2027'),
  )
  const { records, rows } = pageRows(markdown)
  strictAssert.deepEqual(rows.filter(row => row.endpoint).map(row => [row.bedrockId, row.endpoint]), [['g.mantle', 'bedrock-mantle']])
  const api = [...entries('us-east-1', model('g.run-v1:0', 'LEGACY', '2026-09-30', '2027-03-30')), ...entries('us-west-2')]
  const { conflicts } = reconcileBedrockModelsApi(records, api, { rows, regions: ['us-east-1', 'us-west-2'], now })
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id, conflict.regions.join()]), [['absent', 'a.m-v1:0', 'us-east-1,us-west-2']])
  strictAssert.equal(sourceConflictSummary(conflicts[0]), 'aws-bedrock models API a.m-v1:0: page legacy 2026-09-30, EOL 2027-03-30, extended access none in us-east-1, us-west-2; the API does not return it in these Regions; lifecycle page kept')
})

await test('a context-length variant binds to its base model on the page, and a model card is compared by its EOL date', () => {
  const { records, rows } = pageRows(page(pageEntry('meta.llama3-1-8b-instruct-v1:0', 'us-west-2', 'September 30, 2026', 'March 30, 2027')))
  const api = entries('us-west-2', model('meta.llama3-1-8b-instruct-v1:0', 'LEGACY', '2026-09-30', '2027-03-30'), model('meta.llama3-1-8b-instruct-v1:0:128k', 'LEGACY', '2026-09-30', '2027-03-30'), model('meta.llama3-1-8b-instruct-v1:0:1m', 'LEGACY', '2026-09-30', '2027-04-30'))
  const { conflicts } = reconcileBedrockModelsApi(records, api, { rows, now })
  strictAssert.deepEqual(conflicts.map(conflict => [conflict.reason, conflict.id, conflict.api.ids]), [['date', 'meta.llama3-1-8b-instruct-v1:0', ['meta.llama3-1-8b-instruct-v1:0:1m']]])
  strictAssert.match(sourceConflictSummary(conflicts[0]), /API LEGACY \(legacy 2026-09-30, EOL 2027-04-30, extended access none\) as meta\.llama3-1-8b-instruct-v1:0:1m in us-west-2; lifecycle page kept$/)
  const card = { bedrockId: 'h.card-v1:0', shutdown: '2027-05-01', status: 'legacy', source: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-h.html' }
  const withCard = [...records, card]
  strictAssert.deepEqual(reconcileBedrockModelsApi(withCard, entries('us-east-1', model('h.card-v1:0', 'LEGACY', '2026-11-01', '2027-05-01')), { rows, now }).conflicts, [])
  const differs = reconcileBedrockModelsApi(withCard, entries('us-east-1', model('h.card-v1:0', 'LEGACY', '2026-11-01', '2027-06-01')), { rows, now }).conflicts
  strictAssert.deepEqual(differs.map(conflict => [conflict.reason, conflict.page]), [['date', { card: card.source, eol: '2027-05-01' }]])
  strictAssert.equal(sourceConflictSummary(differs[0]), `aws-bedrock models API h.card-v1:0: model card ${card.source} EOL 2027-05-01; API LEGACY (legacy 2026-11-01, EOL 2027-06-01, extended access none) in us-east-1; lifecycle page kept`)
})

await test('a broken cross-check warns and keeps the page by default, fails under strict, and a broken page always fails', async () => {
  const broken = apiBody(model('a.m-v1:0', 'RETIRED'))
  const warned = await load({ fetchImpl: fakeFetch({ api: { 'us-east-1': broken, 'us-west-2': recorded['us-west-2'] } }).fetchImpl, env })
  strictAssert.ok(!warned.error, warned.error?.message)
  const message = 'aws-bedrock models API us-east-1 entry 0 (a.m-v1:0) has an unknown modelLifecycle.status: "RETIRED"'
  strictAssert.deepEqual(warned.notices.filter(line => line.startsWith('warning:')), [`warning: bedrock models API cross-check failed: ${message}`])
  const [failure] = apiConflicts(warned.source)
  strictAssert.deepEqual(failure, { via: 'aws-bedrock', source: 'models-api', reason: 'cross-check-failed', message })
  strictAssert.equal(sourceConflictSummary(failure), `aws-bedrock models API cross-check failed: ${message}; the lifecycle page was read without the cross-check`)
  strictAssert.ok(warned.notices.includes(`notice: ${sourceConflictSummary(failure)}`))
  const empty = { publisher: 'amazon', models: [] }
  strictAssert.ok(renderSemanticDiff(empty, empty, { sourceConflicts: warned.source.conflicts }).includes(`## Source conflicts\n\n- ${sourceConflictSummary(failure)}\n`))
  const failed = await load({ fetchImpl: fakeFetch({ api: { 'us-east-1': broken } }).fetchImpl, env: { ...env, ...strict } })
  strictAssert.equal(failed.error.message, message)
  for (const cross of [{}, strict]) {
    const html = await load({ fetchImpl: fakeFetch({ markdown: '<!doctype html><html></html>', api: recorded }).fetchImpl, env: { ...env, ...cross } })
    strictAssert.match(html.error.message, /aws-bedrock lifecycle page is HTML, not Markdown/)
  }
  const typo = await load({ fetchImpl: fakeFetch({ api: recorded }).fetchImpl, env: { ...env, MODEL_EOL_CROSS_CHECKS: 'stirct' } })
  strictAssert.match(typo.error.message, /MODEL_EOL_CROSS_CHECKS must be/)
})

await test('messages are redacted of keys, tokens, signatures, and account ids', () => {
  const text = `key ${accessKeyId} secret ${secretAccessKey} token ${sessionToken} Signature=abc123def arn:aws:iam::123456789012:user/x other ASIAZZZZEXAMPLE67890 version 20250805`
  const redacted = redactBedrockModelsApiMessage(text, { accessKeyId, secretAccessKey, sessionToken })
  strictAssert.equal(redacted, 'key [redacted] secret [redacted] token [redacted] Signature=[redacted] arn:aws:iam::{account}:user/x other [redacted] version 20250805')
})

if (failures) {
  console.error(`${failures} Bedrock models API test(s) failed`)
  process.exit(1)
}
