#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DOCUMENT_TYPES,
  loadDocumentSchemaCatalog,
  validateDocument,
} from '../lib/validate-document.mjs'
import { normalizeConfig } from '../lib/config.mjs'
import { loadFeeds } from '../lib/feeds.mjs'
import { JsonSchemaRegistry, validateJsonSchema } from '../lib/json-schema.mjs'
import { formatInventoryCycloneDX } from '../lib/reports.mjs'
import { validateFeed } from '../lib/validate-feed.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'check.mjs')
const fixture = path.join(root, 'test/fixture')
const canonicalBase = 'https://thossullivan.github.io/model-eol/schema/0.1/'
const schema052Directory = path.join(fixture, 'schemas-0.5.2')
const schema052 = new Map(['check', 'inventory', 'plan'].map(type => [
  type,
  JSON.parse(fs.readFileSync(path.join(schema052Directory, `model-eol.${type}.schema.json`), 'utf8')),
]))

const run = (args, { cwd = root } = {}) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const validFeed = () => ({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-18T00:00:00Z',
  source: 'https://example.test/deprecations',
  models: [{ id: 'test-model' }],
})

const referencesIn = value => {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(referencesIn)
  return [
    ...(typeof value.$ref === 'string' ? [value.$ref] : []),
    ...Object.values(value).flatMap(referencesIn),
  ]
}

const withoutWaiverFields = value => {
  if (Array.isArray(value)) return value.map(withoutWaiverFields)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'waiver')
    .map(([key, child]) => [key, withoutWaiverFields(child)]))
}

const catalog = loadDocumentSchemaCatalog()
assert.equal(catalog.byType.size, DOCUMENT_TYPES.length, 'every public document schema loads')
assert.deepEqual([...catalog.byType.keys()], DOCUMENT_TYPES, 'the schema catalog covers every public document type')
for (const [type, schema] of catalog.byType) {
  assert(schema.$id.startsWith(canonicalBase), `${type} has a canonical public schema ID`)
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#', `${type} uses the canonical Draft-07 dialect URI`)
  for (const reference of referencesIn(schema)) {
    assert(reference.startsWith('#/') || reference.startsWith(canonicalBase), `${type} uses only local or canonical cross-references`)
  }
}
assert.equal(catalog.registry.assertReferences(), true, 'all local and cross-document references resolve')

const conflictingReplacement = validFeed()
conflictingReplacement.models = [
  { id: 'old-model', replacement: 'new-model', replacement_options: ['other-model'] },
  { id: 'new-model' },
]
const conflictingReplacementErrors = validateJsonSchema(conflictingReplacement, catalog.byType.get('feed'))
assert(conflictingReplacementErrors.some(error => error.path === '$.models[0].replacement_options' && error.keyword === 'falseSchema'), 'the standalone Draft-07 feed schema rejects replacement plus replacement_options')
assert(validateFeed(conflictingReplacement).some(error => error.message.includes('mutually exclusive')), 'the runtime feed validator independently rejects conflicting replacement guidance')
const replacementChoice = validFeed()
replacementChoice.models[0].replacement_options = ['external-choice']
assert.equal(validateJsonSchema(replacementChoice, catalog.byType.get('feed')).length, 0, 'the standalone feed schema permits issue-only replacement options without a replacement')

const duplicateDistribution = validFeed()
duplicateDistribution.models[0].distributions = [
  { via: 'aws-bedrock', shutdown: '2026-09-01' },
  { via: 'aws-bedrock', shutdown: '2027-09-01' },
]
assert.equal(validateJsonSchema(duplicateDistribution, catalog.byType.get('feed')).length, 0, 'the portable Draft-07 schema leaves distributor-key uniqueness to semantic validation')
assert(validateFeed(duplicateDistribution).some(error => error.path === 'models[0].distributions[1].via' && error.message.includes('duplicate distributor via')), 'the runtime feed validator rejects ambiguous duplicate distributor clocks')

const unprovenDistributionAnnouncement = validFeed()
delete unprovenDistributionAnnouncement.source
unprovenDistributionAnnouncement.models[0].distributions = [
  { via: 'aws-bedrock', announced: '2026-08-01' },
]
assert(validateFeed(unprovenDistributionAnnouncement).some(error => error.path === 'models[0].distributions[0]' && error.message.includes('dated distribution needs a source')), 'the runtime feed validator requires provenance for announced-only distributor dates')

const tentativePrecisionFeed = validFeed()
tentativePrecisionFeed.models[0] = {
  id: 'tentative-model',
  shutdown: '2027-06-09',
  date_precision: 'tentative',
  distributions: [{ via: 'test-channel', shutdown: '2027-07-01', date_precision: 'tentative' }],
}
assert.equal(validateJsonSchema(tentativePrecisionFeed, catalog.byType.get('feed')).length, 0, 'the feed schema accepts tentative publisher and distributor dates')
assert.equal(validateFeed(tentativePrecisionFeed).length, 0, 'the runtime feed validator accepts tentative publisher and distributor dates')

const announcedTentativeModel = structuredClone(tentativePrecisionFeed)
announcedTentativeModel.models[0].announced = '2026-08-01'
assert(validateFeed(announcedTentativeModel).some(error => error.path === 'models[0].announced' && error.message.includes('tentative')), 'the runtime feed validator rejects announced tentative models')

const announcedTentativeDistribution = structuredClone(tentativePrecisionFeed)
announcedTentativeDistribution.models[0].distributions[0].announced = '2026-08-01'
assert(validateFeed(announcedTentativeDistribution).some(error => error.path === 'models[0].distributions[0].announced' && error.message.includes('tentative')), 'the runtime feed validator rejects announced tentative distributions')

const retiredTentativeDistribution = structuredClone(tentativePrecisionFeed)
retiredTentativeDistribution.models[0].distributions[0].status = 'retired'
assert(validateFeed(retiredTentativeDistribution).some(error => error.path === 'models[0].distributions[0].status' && error.message.includes('tentative')), 'the runtime feed validator rejects retired tentative distributions')

for (const via of ['publisher', 'publisher-fallback', 'Publisher', 'PUBLISHER-FALLBACK']) {
  const reservedDistribution = validFeed()
  reservedDistribution.models[0].distributions = [{ via }]
  assert(validateFeed(reservedDistribution).some(error => error.path === 'models[0].distributions[0].via' && error.message.includes('reserved publisher clock')), `the runtime feed validator rejects reserved clock ${via}`)
}

const credentialEnvironmentNames = [
  'GITHUB_TOKEN', 'gh_auth', 'Actions_Runtime_URL', 'ssh_auth_sock',
  'AWS_SECRET_ACCESS_KEY', 'MODEL_EOL_SECRET', 'database_password', 'credential_file',
]
for (const name of credentialEnvironmentNames) {
  const errors = validateJsonSchema({ eval: { pass_env: [name] } }, catalog.byType.get('config'))
  assert(errors.some(error => error.path === '$.eval.pass_env[0]' && error.keyword === 'pattern'), `the standalone config schema rejects credential-like pass_env name ${name}`)
  assert.throws(() => normalizeConfig({ eval: { pass_env: [name] } }), new RegExp(name, 'i'), `the runtime config validator rejects credential-like pass_env name ${name}`)
}
assert.equal(validateJsonSchema({ eval: { pass_env: ['OPENAI_API_KEY', 'MODEL_EOL_REPORT', 'AWS_REGION'] } }, catalog.byType.get('config')).length, 0, 'the standalone config schema permits explicit non-credential eval inputs')

const validWaiver = {
  model: 'test-model',
  paths: ['services/legacy/**'],
  via: 'aws-bedrock',
  reason: 'A migration is scheduled.',
  owner: '@platform-team',
  expires: '2026-12-31',
}
assert.equal(validateJsonSchema({ waivers: [validWaiver] }, catalog.byType.get('config')).length, 0, 'the standalone config schema accepts a bounded owned waiver')
assert.equal(normalizeConfig({ overrides: [{ paths: ['services/**'], waivers: [validWaiver] }] }).overrides[0].waivers.length, 1, 'runtime config normalization accepts waivers inside path overrides')
const aggregateWaiverConfig = {
  waivers: Array.from({ length: 500 }, () => validWaiver),
  overrides: [{ paths: ['services/**'], waivers: [validWaiver] }],
}
assert.equal(validateJsonSchema(aggregateWaiverConfig, catalog.byType.get('config')).length, 0, 'portable config structure leaves the aggregate waiver cap to semantic validation')
assert.throws(() => normalizeConfig(aggregateWaiverConfig), /at most 500 waivers/, 'runtime config normalization enforces the aggregate waiver cap across root and overrides')

const cycloneDxReference = ({
  file,
  line,
  usage,
  requestedVia,
  via,
  status,
  shutdown,
  distributionStatus = null,
  waiver = null,
}) => ({
  file,
  line,
  matched: 'shared-model',
  id: 'shared-model',
  publisher: 'test-publisher',
  usage,
  requested_via: requestedVia,
  via,
  status,
  shutdown,
  date_precision: null,
  distribution_status: distributionStatus,
  safe_until: shutdown,
  replacement: 'next-model',
  replacement_options: null,
  replacement_note: null,
  waiver,
})
const sharedActiveWaiver = { reason: 'Migration scheduled.', owner: '@platform-team', expires: '2026-12-31', active: true }
const mixedClockReferences = [
  cycloneDxReference({ file: 'z-direct.py', line: 9, usage: 'direct-api', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01', waiver: sharedActiveWaiver }),
  cycloneDxReference({ file: 'a-direct.py', line: 2, usage: 'model-reference', requestedVia: null, via: 'publisher', status: 'retiring', shutdown: '2026-08-01' }),
  cycloneDxReference({ file: 'a-direct.py', line: 2, usage: 'model-reference', requestedVia: null, via: 'publisher', status: 'retiring', shutdown: '2026-08-01' }),
  cycloneDxReference({ file: 'custom-publisher/service.ts', line: 3, usage: 'gateway', requestedVia: 'publisher', via: 'publisher', status: 'scheduled', shutdown: '2027-02-01' }),
  cycloneDxReference({ file: 'azure/service.ts', line: 4, usage: 'cloud-provider', requestedVia: 'azure-ai-foundry', via: 'azure-ai-foundry', status: 'scheduled', shutdown: '2027-01-01' }),
  cycloneDxReference({ file: 'bedrock/service.ts', line: 7, usage: 'cloud-provider', requestedVia: 'aws-bedrock', via: 'aws-bedrock', status: 'ok', shutdown: null, distributionStatus: 'extended-access' }),
]
const cycloneDxInventory = references => ({
  generated: '2026-08-18T00:00:00Z',
  model_references: references,
})
const mixedClockCycloneDx = formatInventoryCycloneDX(cycloneDxInventory(mixedClockReferences))
const cycloneDxProperty = (component, name) => component.properties.find(property => property.name === name)?.value
const componentForChannel = channel => mixedClockCycloneDx.components.find(component => cycloneDxProperty(component, 'model-eol:lifecycle_channel') === channel)
assert.equal(mixedClockCycloneDx.bomFormat, 'CycloneDX', 'channel-qualified inventory remains a CycloneDX BOM')
assert.equal(mixedClockCycloneDx.specVersion, '1.6', 'channel-qualified inventory preserves the official CycloneDX 1.6 contract')
assert.equal(mixedClockCycloneDx.components.length, 4, 'one canonical model used through four lifecycle channels emits four components')
assert.equal(new Set(mixedClockCycloneDx.components.map(component => component['bom-ref'])).size, 4, 'channel-qualified component bom-refs are unique')
assert(mixedClockCycloneDx.components.every(component => component['bom-ref'].includes(`:${encodeURIComponent(cycloneDxProperty(component, 'model-eol:lifecycle_channel'))}`)), 'each component bom-ref carries its lifecycle channel')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:status'), 'retired', 'direct publisher lifecycle does not inherit a distributor status')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:shutdown'), '2026-08-01', 'direct publisher lifecycle keeps its own shutdown clock')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:waiver_active'), 'partial', 'CycloneDX marks a component with mixed waived and unwaived occurrences as partially waived')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:waiver_owner'), undefined, 'partial CycloneDX waiver state omits ownership details')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:waiver_expires'), undefined, 'partial CycloneDX waiver state omits expiry details')
assert.equal(cycloneDxProperty(componentForChannel('publisher-direct'), 'model-eol:waiver_reason'), undefined, 'partial CycloneDX waiver state omits reason details')
assert.equal(cycloneDxProperty(componentForChannel('publisher'), 'model-eol:shutdown'), '2027-02-01', 'a custom distribution literally named publisher does not collide with the direct publisher clock')
assert.equal(cycloneDxProperty(componentForChannel('azure-ai-foundry'), 'model-eol:shutdown'), '2027-01-01', 'Azure lifecycle keeps its separate shutdown clock')
assert.equal(cycloneDxProperty(componentForChannel('aws-bedrock'), 'model-eol:distribution_status'), 'extended-access', 'Bedrock lifecycle keeps its channel-specific distribution status')
assert.deepEqual(componentForChannel('publisher-direct').evidence.occurrences, [
  { location: 'a-direct.py#2' },
  { location: 'z-direct.py#9' },
], 'component occurrences are sorted and deduplicated within their lifecycle channel')
assert.deepEqual(
  formatInventoryCycloneDX(cycloneDxInventory([...mixedClockReferences].reverse())),
  mixedClockCycloneDx,
  'CycloneDX component identities, lifecycle properties, and occurrences are independent of input order',
)

const fullyWaivedCycloneDx = formatInventoryCycloneDX(cycloneDxInventory([
  cycloneDxReference({ file: 'first.py', line: 1, usage: 'direct-api', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01', waiver: sharedActiveWaiver }),
  cycloneDxReference({ file: 'second.py', line: 2, usage: 'model-reference', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01', waiver: sharedActiveWaiver }),
]))
const fullyWaivedComponent = fullyWaivedCycloneDx.components[0]
assert.equal(cycloneDxProperty(fullyWaivedComponent, 'model-eol:waiver_active'), 'true', 'CycloneDX marks a component as waived when every occurrence has an active waiver')
assert.equal(cycloneDxProperty(fullyWaivedComponent, 'model-eol:waiver_owner'), '@platform-team', 'a shared active waiver exposes its owner in CycloneDX')
assert.equal(cycloneDxProperty(fullyWaivedComponent, 'model-eol:waiver_expires'), '2026-12-31', 'a shared active waiver exposes its expiry in CycloneDX')
assert.equal(cycloneDxProperty(fullyWaivedComponent, 'model-eol:waiver_reason'), 'Migration scheduled.', 'a shared active waiver exposes its reason in CycloneDX')

const distinctWaiversCycloneDx = formatInventoryCycloneDX(cycloneDxInventory([
  cycloneDxReference({ file: 'first.py', line: 1, usage: 'direct-api', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01', waiver: sharedActiveWaiver }),
  cycloneDxReference({ file: 'second.py', line: 2, usage: 'model-reference', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01', waiver: { reason: 'Second migration.', owner: '@second-team', expires: '2026-11-30', active: true } }),
]))
const distinctWaiversComponent = distinctWaiversCycloneDx.components[0]
assert.equal(cycloneDxProperty(distinctWaiversComponent, 'model-eol:waiver_active'), 'true', 'CycloneDX marks every-occurrence coverage as waived across distinct active waivers')
assert.equal(cycloneDxProperty(distinctWaiversComponent, 'model-eol:waiver_expires'), '2026-11-30', 'distinct active waivers expose their earliest expiry in CycloneDX')
assert.equal(cycloneDxProperty(distinctWaiversComponent, 'model-eol:waiver_owner'), undefined, 'distinct active waivers omit ambiguous ownership from CycloneDX')
assert.equal(cycloneDxProperty(distinctWaiversComponent, 'model-eol:waiver_reason'), undefined, 'distinct active waivers omit ambiguous reasons from CycloneDX')

const unwaivedCycloneDx = formatInventoryCycloneDX(cycloneDxInventory([
  cycloneDxReference({ file: 'first.py', line: 1, usage: 'direct-api', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01' }),
  cycloneDxReference({ file: 'second.py', line: 2, usage: 'model-reference', requestedVia: null, via: 'publisher', status: 'retired', shutdown: '2026-08-01' }),
]))
assert.equal(cycloneDxProperty(unwaivedCycloneDx.components[0], 'model-eol:waiver_active'), undefined, 'CycloneDX omits waiver properties when no occurrence is actively waived')

const oneOfSchema = {
  $id: 'https://example.test/one-of.schema.json',
  oneOf: [{ type: 'string' }, { const: 'matches-both' }],
}
assert.equal(validateJsonSchema('matches-one', oneOfSchema).length, 0, 'oneOf accepts exactly one matching branch')
const noOneOfMatch = validateJsonSchema(42, oneOfSchema)
assert(noOneOfMatch.some(error => error.keyword === 'oneOf' && error.message.includes('matched 0')), 'oneOf rejects a value matching no branches')
const twoOneOfMatches = validateJsonSchema('matches-both', oneOfSchema)
assert(twoOneOfMatches.some(error => error.keyword === 'oneOf' && error.message.includes('matched 2')), 'oneOf rejects a value matching multiple branches')

const schemaDependencySchema = {
  $id: 'https://example.test/schema-dependency.schema.json',
  type: 'object',
  dependencies: {
    trigger: {
      required: ['peer'],
      properties: { peer: { const: 'expected' } },
    },
  },
}
const missingSchemaDependency = validateJsonSchema({ trigger: true }, schemaDependencySchema)
assert(missingSchemaDependency.some(error => error.path === '$.peer' && error.keyword === 'required'), 'schema-valued dependencies validate the whole containing object')
const invalidSchemaDependency = validateJsonSchema({ trigger: true, peer: 'wrong' }, schemaDependencySchema)
assert(invalidSchemaDependency.some(error => error.path === '$.peer' && error.keyword === 'const'), 'schema-valued dependencies enforce their nested assertions')
assert.equal(validateJsonSchema({ trigger: true, peer: 'expected' }, schemaDependencySchema).length, 0, 'schema-valued dependencies accept a conforming object')

const schemaDependencyDocument = structuredClone(catalog.byType.get('config'))
schemaDependencyDocument.definitions.referenceRoute.dependencies.match = { required: ['model'] }
assert.equal(validateDocument(schemaDependencyDocument).errors.length, 0, 'the public schema linter accepts dependency schemas enforced by the runtime')
const unsupportedAssertionDocument = structuredClone(catalog.byType.get('inventory'))
unsupportedAssertionDocument.anyOf = [{ required: ['schema'] }]
const unsupportedAssertion = validateDocument(unsupportedAssertionDocument)
assert(unsupportedAssertion.errors.some(error => error.path === '$.anyOf' && error.keyword === 'anyOf'), 'the public schema linter rejects assertion keywords the runtime cannot enforce')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-validation-'))
try {
  const schemaPaths = [...catalog.byType.values()].map(schema => {
    const name = new URL(schema.$id).pathname.split('/').at(-1)
    return path.join(root, 'schema', name)
  })
  for (const schemaPath of schemaPaths) {
    const result = run(['validate', schemaPath])
    assert.equal(result.code, 0, `${path.basename(schemaPath)} passes public schema-definition validation: ${result.err}`)
    assert.match(result.out, /valid schema document/, 'schema definition auto-selection is reported')
  }

  const feedPaths = []
  for (const feedName of fs.readdirSync(path.join(root, 'feeds')).filter(file => file.endsWith('.json'))) {
    const feedPath = path.join(root, 'feeds', feedName)
    feedPaths.push(feedPath)
    const result = run(['validate', feedPath])
    assert.equal(result.code, 0, `${feedName} validates through automatic feed selection: ${result.err}`)
    assert.match(result.out, /valid feed document/, `${feedName} reports its selected type`)
  }
  const batch = run(['validate', ...schemaPaths, ...feedPaths])
  assert.equal(batch.code, 0, `one validate invocation accepts all schema and feed documents: ${batch.err}`)
  assert.equal(batch.out.trim().split('\n').length, schemaPaths.length + feedPaths.length, 'batch validation reports every valid document')

  const mixedSpecFeeds = path.join(tempRoot, 'mixed-spec-feeds')
  fs.mkdirSync(mixedSpecFeeds)
  writeJson(path.join(mixedSpecFeeds, 'current.json'), validFeed())
  writeJson(path.join(mixedSpecFeeds, 'future.json'), {
    ...validFeed(),
    spec: 'model-eol/0.2',
    publisher: 'future',
    models: [{ id: 'future-model' }],
  })
  assert.throws(
    () => loadFeeds(mixedSpecFeeds),
    error => error.message.includes('future.json') && error.message.includes('unsupported feed spec "model-eol/0.2"'),
    'feed loading fails closed when one file in a mixed directory uses an unsupported spec',
  )
  const mixedSpecCheck = run([fixture, '--feeds', mixedSpecFeeds])
  assert.equal(mixedSpecCheck.code, 2, 'check exits 2 instead of scanning with a partially loaded mixed-spec feed directory')
  assert.match(mixedSpecCheck.err, /failed to load feeds.*unsupported feed spec "model-eol\/0\.2"/s, 'check names the unsupported feed spec instead of silently skipping it')

  const configPath = path.join(tempRoot, '.model-eol.json')
  writeJson(configPath, {
    days: 90,
    scope: 'direct',
    routes: [{ paths: ['services/**'], via: 'aws-bedrock' }],
  })
  const autoConfig = run(['validate', configPath])
  assert.equal(autoConfig.code, 0, `the canonical config filename selects the config schema: ${autoConfig.err}`)
  assert.match(autoConfig.out, /valid config document/, 'config validation identifies the document type')

  const namedConfigPath = path.join(tempRoot, 'policy.json')
  writeJson(namedConfigPath, {})
  const explicitConfig = run(['validate', namedConfigPath, '--type', 'config'])
  assert.equal(explicitConfig.code, 0, `explicit schema selection validates an empty config: ${explicitConfig.err}`)

  const generated = new Map()
  for (const [type, args, expectedCode] of [
    ['check', ['check', fixture, '--json'], 1],
    ['inventory', ['inventory', fixture, '--json'], 0],
    ['schedule', ['schedule', fixture, '--json'], 0],
    ['alert', ['alert', fixture, '--json'], 1],
    ['plan', ['plan', fixture], 0],
  ]) {
    const report = run(args)
    assert.equal(report.code, expectedCode, `${type} fixture report is emitted with its established exit code: ${report.err}`)
    const file = path.join(tempRoot, `${type}.json`)
    fs.writeFileSync(file, report.out)
    generated.set(type, JSON.parse(report.out))
    const validation = run(['validate', file])
    assert.equal(validation.code, 0, `emitted ${type} report conforms to its public schema: ${validation.err}`)
    assert.match(validation.out, new RegExp(`valid ${type} document`), `${type} is automatically selected by discriminator`)
  }

  for (const type of ['check', 'inventory', 'schedule', 'alert', 'plan']) {
    assert.deepEqual(generated.get(type), withoutWaiverFields(generated.get(type)), `default-config ${type} output omits unmatched waiver fields`)
  }

  for (const [type, schema, registered] of [
    ['check', schema052.get('check'), [schema052.get('check'), schema052.get('inventory')]],
    ['inventory', schema052.get('inventory'), [schema052.get('inventory')]],
    ['schedule', catalog.byType.get('schedule'), [catalog.byType.get('schedule'), schema052.get('inventory')]],
    ['alert', catalog.byType.get('alert'), [catalog.byType.get('alert'), schema052.get('inventory')]],
    ['plan', schema052.get('plan'), [schema052.get('plan')]],
  ]) {
    const registry = new JsonSchemaRegistry(registered)
    registry.assertReferences()
    assert.equal(validateJsonSchema(generated.get(type), schema, { registry }).length, 0, `default-config ${type} output validates against the pinned 0.5.2 schema contract`)
  }

  for (const type of ['check', 'inventory', 'plan']) {
    const preWaiverDocument = withoutWaiverFields(generated.get(type))
    assert.equal(validateDocument(preWaiverDocument, { type }).errors.length, 0, `pre-waiver 0.1 ${type} documents remain schema-compatible`)
    const preWaiverPath = path.join(tempRoot, `pre-waiver-${type}.json`)
    writeJson(preWaiverPath, preWaiverDocument)
    const preWaiverValidation = run(['validate', preWaiverPath, '--type', type])
    assert.equal(preWaiverValidation.code, 0, `model-eol validate accepts a pre-waiver 0.1 ${type} document: ${preWaiverValidation.err}`)
  }

  assert.equal(generated.get('check').schema, 'model-eol/check@0.1', 'check --json emits its stable public discriminator')
  const strictCheckFinding = structuredClone(generated.get('check'))
  strictCheckFinding.findings[0].unexpected = true
  assert(validateDocument(strictCheckFinding, { type: 'check' }).errors.some(error => error.path === '$.findings[0].unexpected' && error.keyword === 'additionalProperties'), 'check findings reject unknown nested fields')
  const tentativeRoot = path.join(tempRoot, 'tentative-documents')
  const tentativeFeeds = path.join(tentativeRoot, 'feeds')
  fs.mkdirSync(tentativeFeeds, { recursive: true })
  fs.writeFileSync(path.join(tentativeRoot, 'app.py'), 'MODEL = "tentative-document-model"\n')
  writeJson(path.join(tentativeFeeds, 'anthropic.json'), {
    spec: 'model-eol/0.1',
    publisher: 'anthropic',
    generated: '2026-09-03T00:00:00Z',
    source: 'https://example.invalid/anthropic',
    policy: { min_notice_days: 60, source: 'https://example.invalid/anthropic' },
    models: [{ id: 'tentative-document-model', shutdown: '2026-09-29', date_precision: 'tentative' }],
  })
  const tentativeDocuments = new Map()
  for (const [type, args] of [
    ['check', ['check', tentativeRoot, '--feeds', tentativeFeeds, '--days', '30', '--json']],
    ['inventory', ['inventory', tentativeRoot, '--feeds', tentativeFeeds, '--days', '30', '--json']],
    ['schedule', ['schedule', tentativeRoot, '--feeds', tentativeFeeds, '--days', '30', '--json']],
    ['alert', ['alert', tentativeRoot, '--feeds', tentativeFeeds, '--days', '30', '--json']],
    ['plan', ['plan', tentativeRoot, '--feeds', tentativeFeeds, '--days', '30']],
  ]) {
    const report = run(args)
    assert.equal(report.code, 0, `${type} emits a tentative-floor document without failing: ${report.err}`)
    const document = JSON.parse(report.out)
    tentativeDocuments.set(type, document)
    const file = path.join(tempRoot, `tentative-${type}.json`)
    writeJson(file, document)
    const validation = run(['validate', file])
    assert.equal(validation.code, 0, `a ${type} document derived from a tentative finding validates: ${validation.err}`)
  }
  assert.equal(tentativeDocuments.get('check').findings[0].date_precision, 'tentative', 'check preserves tentative precision')
  assert.equal(tentativeDocuments.get('inventory').model_references[0].date_precision, 'tentative', 'inventory preserves tentative precision')
  assert.equal(tentativeDocuments.get('schedule').items[0].date_precision, 'tentative', 'schedule preserves tentative precision')
  assert.equal(tentativeDocuments.get('alert').warnings[0].date_precision, 'tentative', 'alert preserves tentative precision')
  assert.equal(tentativeDocuments.get('plan').items.length, 0, 'plan creates no migration item for a tentative finding')
  const artifactInventory = JSON.parse(run(['inventory', tempRoot, '--json']).out)
  assert(!artifactInventory.model_references.some(reference => reference.file.endsWith('/check.json')), 'a generated check report is not re-ingested as repository model usage')
  assert(artifactInventory.scan_notes.some(note => note.reason === 'model-eol-document-skipped' && note.file.endsWith('/check.json')), 'scanner records the generated check report as an intentional product artifact skip')

  const nestedExtraCases = [
    ['model reference', 'model_references', generated.get('inventory').model_references, 0],
    ['candidate reference', 'candidate_model_references', generated.get('inventory').candidate_model_references, 0],
    ['integration hint', 'integration_hints', generated.get('inventory').integration_hints, 0],
  ]
  for (const [label, property, values, index] of nestedExtraCases) {
    assert(values.length > index, `fixture emits a ${label} for strictness testing`)
    const report = structuredClone(generated.get('inventory'))
    report[property][index].unexpected = true
    const result = validateDocument(report, { type: 'inventory' })
    assert(result.errors.some(error => error.path === `$.${property}[${index}].unexpected` && error.keyword === 'additionalProperties'), `${label} rejects unknown nested fields`)
  }
  const nestedScanNote = structuredClone(generated.get('inventory'))
  nestedScanNote.scan_notes = [{ reason: 'test-note', unexpected: true }]
  const nestedScanNoteResult = validateDocument(nestedScanNote, { type: 'inventory' })
  assert(nestedScanNoteResult.errors.some(error => error.path === '$.scan_notes[0].unexpected' && error.keyword === 'additionalProperties'), 'scan notes reject unknown nested fields')

  const emptyModelIdentifier = structuredClone(generated.get('inventory'))
  emptyModelIdentifier.model_references[0].id = ''
  assert(validateDocument(emptyModelIdentifier, { type: 'inventory' }).errors.some(error => error.path === '$.model_references[0].id' && error.keyword === 'minLength'), 'emitted model identifiers must be non-empty')
  const emptyIntegrationPath = structuredClone(generated.get('inventory'))
  emptyIntegrationPath.integration_hints[0].file = ''
  assert(validateDocument(emptyIntegrationPath, { type: 'inventory' }).errors.some(error => error.path === '$.integration_hints[0].file' && error.keyword === 'minLength'), 'emitted integration paths must be non-empty')

  const strictScheduleItem = structuredClone(generated.get('schedule'))
  strictScheduleItem.items[0].unexpected = true
  assert(validateDocument(strictScheduleItem, { type: 'schedule' }).errors.some(error => error.path === '$.items[0].unexpected' && error.keyword === 'additionalProperties'), 'schedule cross-references retain strict model-reference validation')
  const strictScheduleCandidate = structuredClone(generated.get('schedule'))
  strictScheduleCandidate.candidate_model_references[0].unexpected = true
  assert(validateDocument(strictScheduleCandidate, { type: 'schedule' }).errors.some(error => error.path === '$.candidate_model_references[0].unexpected' && error.keyword === 'additionalProperties'), 'schedule cross-references retain strict candidate validation')

  for (const kind of ['candidate-model-reference', 'integration-hint']) {
    const strictAlertWarning = structuredClone(generated.get('alert'))
    const index = strictAlertWarning.warnings.findIndex(item => item.kind === kind)
    assert(index >= 0, `fixture alert emits a ${kind} warning for strictness testing`)
    strictAlertWarning.warnings[index].unexpected = true
    const result = validateDocument(strictAlertWarning, { type: 'alert' })
    assert(result.errors.some(error => error.path === `$.warnings[${index}]` && error.keyword === 'oneOf'), `alert ${kind} warnings reject unknown nested fields`)
  }

  const malformedPath = path.join(tempRoot, 'malformed.json')
  fs.writeFileSync(malformedPath, '{"spec":')
  const malformed = run(['validate', malformedPath])
  assert.equal(malformed.code, 2, 'malformed JSON exits 2')
  assert.match(malformed.err, /invalid JSON/, 'malformed JSON has a precise parse diagnostic')

  const invalidUtf8Path = path.join(tempRoot, 'invalid-utf8.json')
  fs.writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))
  const invalidUtf8 = run(['validate', invalidUtf8Path])
  assert.equal(invalidUtf8.code, 2, 'invalid UTF-8 exits 2')
  assert.match(invalidUtf8.err, /invalid UTF-8/, 'invalid UTF-8 is refused without replacement decoding')

  const unknownPath = path.join(tempRoot, 'unknown.json')
  writeJson(unknownPath, { hello: 'world' })
  const unknown = run(['validate', unknownPath])
  assert.equal(unknown.code, 2, 'an unknown automatic document type exits 2')
  assert.match(unknown.err, /could not determine the document type/, 'unknown automatic type recommends explicit selection')
  const explicitUnknown = run(['validate', unknownPath, '--type', 'mystery'])
  assert.equal(explicitUnknown.code, 2, 'an unknown explicit type exits 2')
  assert.match(explicitUnknown.err, /unknown document type/, 'unknown explicit type is named')

  const extraFieldPath = path.join(tempRoot, 'extra-field.json')
  writeJson(extraFieldPath, { ...validFeed(), unexpected: true })
  const extraField = run(['validate', extraFieldPath])
  assert.equal(extraField.code, 2, 'additional properties are rejected with exit 2')
  assert.match(extraField.err, /\$\.unexpected: is not allowed/, 'additionalProperties reports the exact field path')

  const invalidDatePath = path.join(tempRoot, 'invalid-date.json')
  const invalidDate = validFeed()
  invalidDate.models[0].shutdown = '2026-02-30'
  writeJson(invalidDatePath, invalidDate)
  const invalidDateResult = run(['validate', invalidDatePath])
  assert.equal(invalidDateResult.code, 2, 'an impossible date exits 2')
  assert.match(invalidDateResult.err, /\$\.models\[0\]\.shutdown: must match format date/, 'date validation reports the exact model field')

  const invalidDateTimePath = path.join(tempRoot, 'invalid-date-time.json')
  writeJson(invalidDateTimePath, { ...validFeed(), generated: '2026-02-30T00:00:00Z' })
  const invalidDateTime = run(['validate', invalidDateTimePath])
  assert.equal(invalidDateTime.code, 2, 'an impossible date-time exits 2')
  assert.match(invalidDateTime.err, /\$\.generated: must match format date-time/, 'date-time validation reports the exact metadata field')

  const aggregated = run(['validate', feedPaths[0], malformedPath, invalidDateTimePath])
  assert.equal(aggregated.code, 2, 'batch validation exits 2 when any document fails')
  assert.match(aggregated.out, /valid feed document/, 'batch validation still reports valid peers')
  assert(aggregated.err.includes(malformedPath) && aggregated.err.includes(invalidDateTimePath), 'batch validation aggregates every document failure')

  const unresolvedReplacementPath = path.join(tempRoot, 'unresolved-replacement.json')
  const unresolvedReplacement = validFeed()
  unresolvedReplacement.models[0].replacement = 'missing-model'
  writeJson(unresolvedReplacementPath, unresolvedReplacement)
  const unresolved = run(['validate', unresolvedReplacementPath])
  assert.equal(unresolved.code, 2, 'feed semantic errors exit 2 after schema conformance')
  assert.match(unresolved.err, /does not resolve to an id or alias in this feed/, 'the public command invokes the strict runtime feed validator')

  const duplicateDistributionPath = path.join(tempRoot, 'duplicate-distribution.json')
  writeJson(duplicateDistributionPath, duplicateDistribution)
  const duplicateDistributionResult = run(['validate', duplicateDistributionPath])
  assert.equal(duplicateDistributionResult.code, 2, 'duplicate distributor clocks fail public CLI validation')
  assert.match(duplicateDistributionResult.err, /duplicate distributor via "aws-bedrock"/, 'CLI validation names the ambiguous distributor clock')

  const unprovenDistributionPath = path.join(tempRoot, 'unproven-distribution-announcement.json')
  writeJson(unprovenDistributionPath, unprovenDistributionAnnouncement)
  const unprovenDistributionResult = run(['validate', unprovenDistributionPath])
  assert.equal(unprovenDistributionResult.code, 2, 'announced-only distributor dates without provenance fail public CLI validation')
  assert.match(unprovenDistributionResult.err, /dated distribution needs a source/, 'CLI validation explains missing distributor date provenance')

  const unsafeConfigPath = path.join(tempRoot, 'unsafe-config.json')
  writeJson(unsafeConfigPath, { eval: { pass_env: ['GITHUB_TOKEN'] } })
  const unsafeConfig = run(['validate', unsafeConfigPath, '--type', 'config'])
  assert.equal(unsafeConfig.code, 2, 'runtime config restrictions are part of public validation')
  assert.match(unsafeConfig.err, /\$\.eval\.pass_env\[0\]: must match pattern/, 'public validation enforces credential-name refusal in the portable schema')

  const missingRouteModelPath = path.join(tempRoot, 'missing-route-model.json')
  writeJson(missingRouteModelPath, { routes: [{ paths: ['**'], via: 'aws-bedrock', match: 'chat-prod' }] })
  const missingRouteModel = run(['validate', missingRouteModelPath, '--type', 'config'])
  assert.equal(missingRouteModel.code, 2, 'Draft-07 property dependencies are enforced')
  assert.match(missingRouteModel.err, /\.model: is required when match is present/, 'dependency errors identify the missing peer')

  const aggregateWaiverPath = path.join(tempRoot, 'aggregate-waivers.json')
  writeJson(aggregateWaiverPath, aggregateWaiverConfig)
  const aggregateWaivers = run(['validate', aggregateWaiverPath, '--type', 'config'])
  assert.equal(aggregateWaivers.code, 2, 'public config validation enforces the aggregate waiver cap')
  assert.match(aggregateWaivers.err, /at most 500 waivers/, 'aggregate waiver cap errors name the semantic resource bound')

  const crossedSchedule = structuredClone(generated.get('schedule'))
  crossedSchedule.scan_notes = [{ reason: 'test', unexpected: true }]
  const crossed = validateDocument(crossedSchedule, { type: 'schedule' })
  assert.equal(crossed.errors.length, 1, 'external inventory references validate nested schedule values')
  assert.equal(crossed.errors[0].path, '$.scan_notes[0].unexpected', 'cross-reference errors preserve the nested instance path')

  const invalidAlert = structuredClone(generated.get('alert'))
  invalidAlert.warnings = [{}]
  const alertOneOf = validateDocument(invalidAlert, { type: 'alert' })
  assert(alertOneOf.errors.some(error => error.path === '$.warnings[0]' && error.keyword === 'oneOf'), 'alert warning unions enforce oneOf through public cross-references')

  const wrongPlanType = structuredClone(generated.get('plan'))
  wrongPlanType.threshold_days = '90'
  const wrongPlan = validateDocument(wrongPlanType, { type: 'plan' })
  assert(wrongPlan.errors.some(error => error.path === '$.threshold_days' && error.keyword === 'type'), 'strict plan validation rejects the wrong root field type')

  const noOpPlan = structuredClone(generated.get('plan'))
  assert(noOpPlan.items.length > 0, 'fixture emits a migration item for semantic plan validation')
  noOpPlan.items[0].replacement = noOpPlan.items[0].matched
  const noOpPlanResult = validateDocument(noOpPlan, { type: 'plan' })
  assert(noOpPlanResult.errors.some(error => error.keyword === 'model-eol-plan' && error.message.includes('must differ')), 'public plan validation rejects semantic no-op replacements')

  const missing = run(['validate', path.join(tempRoot, 'missing.json')])
  assert.equal(missing.code, 2, 'an unreadable document exits 2')
  assert.match(missing.err, /could not read/, 'an unreadable document names the read failure')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('document validation assertions passed')
