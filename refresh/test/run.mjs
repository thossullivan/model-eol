#!/usr/bin/env node
// Offline refresh-tool tests. The fixture directory is deliberately used for
// every CLI invocation so this suite never needs provider credentials or a
// network connection.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BEDROCK_LIFECYCLE_URL,
  VERTEX_MODEL_VERSIONS_URL,
  mergeBedrockDistributions,
  mergeVertexDistributions,
  normalizeBedrockId,
  normalizeVertexId,
  parseBedrockLifecycleHtml,
  parseVertexModelVersionsHtml,
} from '../distributors.mjs'
import {
  PROVIDERS,
  assertIsoDate,
  extractReplacementFields,
  loadProviderSources,
  mergeFeed,
  parseAnthropicDeprecations,
  parseAnthropicModels,
  dateFromText,
  parseGoogleDeprecations,
  parseGoogleModels,
  parseOpenAIDeprecations,
  parseOpenAIModels,
} from '../providers.mjs'
import { compareFeeds, renderSemanticDiff } from '../diff.mjs'
import { validateGeneratedFeeds } from '../refresh.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const refresh = path.join(root, 'refresh', 'refresh.mjs')
const fixtures = path.join(root, 'refresh', 'test', 'fixture')

function run(args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [refresh, ...args], { encoding: 'utf8' }),
    }
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: error.stdout ?? '',
      err: error.stderr ?? '',
    }
  }
}

let failures = 0
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failures++
  } else {
    console.log(`ok: ${message}`)
  }
}

let invalidRefreshDate = false
try {
  assertIsoDate('2026-02-30')
} catch {
  invalidRefreshDate = true
}
assert(invalidRefreshDate, 'refresh date validation rejects impossible calendar dates')
let invalidParsedDate = false
try {
  dateFromText('2026-02-30')
} catch {
  invalidParsedDate = true
}
assert(invalidParsedDate, 'dateFromText rejects impossible calendar dates before use')
let validatorRejectedDate = false
try {
  validateGeneratedFeeds([{
    provider: { feedFile: 'invalid.json' },
    feed: {
      spec: 'model-eol/0.1',
      publisher: 'test',
      generated: '2026-08-01T00:00:00Z',
      models: [{ id: 'invalid-refresh-model', shutdown: '2026-02-30' }],
    },
  }])
} catch {
  validatorRejectedDate = true
}
assert(validatorRejectedDate, 'validate-feeds rejects impossible generated dates')
let validatorRejectedReplacement = false
try {
  validateGeneratedFeeds([{
    provider: { feedFile: 'invalid-replacement.json' },
    feed: {
      spec: 'model-eol/0.1',
      publisher: 'test',
      generated: '2026-08-01T00:00:00Z',
      models: [{ id: 'retired', replacement: 'not-carried-yet' }],
    },
  }])
} catch {
  validatorRejectedReplacement = true
}
let validatorRejectedOption = false
try {
  validateGeneratedFeeds([{
    provider: { feedFile: 'invalid-option.json' },
    feed: {
      spec: 'model-eol/0.1',
      publisher: 'test',
      generated: '2026-08-01T00:00:00Z',
      models: [{ id: 'retired', replacement_options: ['bad option'] }],
    },
  }])
} catch {
  validatorRejectedOption = true
}
assert(validatorRejectedReplacement && validatorRejectedOption, 'validate-feeds rejects unresolved replacements and invalid options')

const unknownFlag = run(['--dyas', '90'])
assert(unknownFlag.code === 2 && unknownFlag.err.includes('--dyas') && unknownFlag.err.includes('--help'), 'unknown refresh flags exit 2 with the bad flag and help hint')

const openaiHtml = fs.readFileSync(path.join(fixtures, 'openai-deprecations.html'), 'utf8')
const anthropicHtml = fs.readFileSync(path.join(fixtures, 'anthropic-deprecations.html'), 'utf8')
const bedrockHtml = fs.readFileSync(path.join(fixtures, 'bedrock-lifecycle.html'), 'utf8')
const googleHtml = fs.readFileSync(path.join(fixtures, 'google-deprecations.html'), 'utf8')
const vertexHtml = fs.readFileSync(path.join(fixtures, 'vertex-model-versions.html'), 'utf8')
const endpointLookalikeHtml = fs.readFileSync(path.join(fixtures, 'anthropic-endpoint-lookalike.html'), 'utf8')
const openaiEntries = parseOpenAIDeprecations(openaiHtml)
const anthropicEntries = parseAnthropicDeprecations(anthropicHtml)
const bedrockEntries = parseBedrockLifecycleHtml(bedrockHtml)
const googleEntries = parseGoogleDeprecations(googleHtml)
const vertexEntries = parseVertexModelVersionsHtml(vertexHtml)
const openaiIds = parseOpenAIModels(fs.readFileSync(path.join(fixtures, 'openai-models.json'), 'utf8'))
const anthropicIds = parseAnthropicModels(fs.readFileSync(path.join(fixtures, 'anthropic-models.json'), 'utf8'))
const googleIds = parseGoogleModels(fs.readFileSync(path.join(fixtures, 'google-models.json'), 'utf8'))
const openaiFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8'))
const anthropicFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8'))
const googleFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'google.json'), 'utf8'))
const amazonFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'amazon.json'), 'utf8'))
const openaiById = new Map(openaiEntries.map(entry => [entry.id, entry]))

let endpointLookalikeReason = ''
try {
  parseAnthropicDeprecations(endpointLookalikeHtml)
} catch (error) {
  endpointLookalikeReason = error.message
}
assert(endpointLookalikeReason.includes('no recognised model tables') && endpointLookalikeReason.includes('endpoint-or-product-deprecation-table') && !endpointLookalikeReason.includes('/v1/old'), 'generic deprecation parser refuses endpoint lookalike tables by named reason')

const mixedEndpointHtml = '<h2>2026-01-01: Endpoint notice</h2><table><tr><th>Retirement date</th><th>Deprecated endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table><h2>2025-01-01: Model notice</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-mixed</code></td><td><code>claude-next</code></td></tr></table>'
const mixedEndpointEntries = parseAnthropicDeprecations(mixedEndpointHtml)
assert(mixedEndpointEntries.length === 1 && mixedEndpointEntries[0].id === 'claude-mixed', 'generic deprecation parser skips endpoint tables while retaining model tables')

const googleEndpointOnlyHtml = '<table><tr><th>Retirement date</th><th>Deprecated endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table>'
const mixedGoogleEndpointHtml = `${googleEndpointOnlyHtml}<table><tr><th>Shutdown date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>google-mixed</code></td><td><code>google-next</code></td></tr></table>`
const mixedGoogleEndpointEntries = parseGoogleDeprecations(mixedGoogleEndpointHtml)
assert(mixedGoogleEndpointEntries.length === 1 && mixedGoogleEndpointEntries[0].id === 'google-mixed', 'Google deprecation parser skips endpoint tables while retaining model tables')
let googleEndpointLookalikeReason = ''
try {
  parseGoogleDeprecations(googleEndpointOnlyHtml)
} catch (error) {
  googleEndpointLookalikeReason = error.message
}
assert(googleEndpointLookalikeReason.includes('no recognised model tables') && googleEndpointLookalikeReason.includes('endpoint-or-product-deprecation-table'), 'Google deprecation parser reports skipped endpoint reasons')

const openaiEndpointHtml = '<h2>2026-01-01: Endpoint notice</h2><table><tr><th>Shutdown date</th><th>Deprecated endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>responses</code></td><td><code>chat</code></td></tr></table>'
let openaiEndpointReason = ''
try {
  parseOpenAIDeprecations(openaiEndpointHtml)
} catch (error) {
  openaiEndpointReason = error.message
}
assert(openaiEndpointReason.includes('endpoint-or-product-deprecation-table') && !openaiEndpointReason.includes('responses'), 'OpenAI endpoint tables reject grammar-valid endpoint names')

const googleCombinedEndpointHtml = '<table><tr><th>Shutdown date</th><th>Model / endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table>'
let googleCombinedEndpointReason = ''
try {
  parseGoogleDeprecations(googleCombinedEndpointHtml)
} catch (error) {
  googleCombinedEndpointReason = error.message
}
assert(googleCombinedEndpointReason.includes('endpoint-or-product-deprecation-table') && !googleCombinedEndpointReason.includes('/v1/old'), 'Google combined model and endpoint headers are refused without ingesting the row')

const googleInvalidRowHtml = '<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table>'
let googleInvalidRowReason = ''
try {
  parseGoogleDeprecations(googleInvalidRowHtml)
} catch (error) {
  googleInvalidRowReason = error.message
}
assert(googleInvalidRowReason.includes('refused row') && googleInvalidRowReason.includes('endpoint-or-product-row'), 'Google model rows enforce the model identifier grammar')

const anthropicApiModelHtml = '<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>API model name</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-api-model</code></td><td><code>claude-next</code></td></tr></table>'
const anthropicApiModel = parseAnthropicDeprecations(anthropicApiModelHtml)
assert(anthropicApiModel.length === 1 && anthropicApiModel[0].id === 'claude-api-model', 'Anthropic API model name headers remain model tables')

const ambiguousAnnouncementHtml = '<h1>Model deprecations</h1><h2>Announcement context</h2><p>Notified 2025-01-01; retirement 2026-01-01.</p><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-ambiguous</code></td><td><code>claude-next</code></td></tr></table>'
let ambiguousAnnouncementReason = ''
try {
  parseAnthropicDeprecations(ambiguousAnnouncementHtml)
} catch (error) {
  ambiguousAnnouncementReason = error.message
}
assert(ambiguousAnnouncementReason.includes('ambiguous-announcement-date'), 'generic deprecation parser rejects ambiguous announcement context')

assert(openaiEntries.every(entry => !/[\s/]/.test(entry.id)), 'OpenAI endpoint and product retirement rows are excluded from the model feed')
assert(normalizeBedrockId('anthropic.claude-3-haiku-20240307-v1:0') === 'claude-3-haiku-20240307', 'Bedrock normalization strips a known provider prefix and v1 suffix')
assert(normalizeBedrockId('meta.llama3-1-405b-instruct-v2:0') === 'llama3-1-405b-instruct', 'Bedrock normalization strips v2 suffixes')
assert(normalizeBedrockId('future-provider.example-model:0') === 'example-model', 'Bedrock normalization handles an unknown provider prefix generically')
assert(normalizeBedrockId('cohere.command-r:0') === 'command-r', 'Bedrock normalization strips a bare colon version suffix')
assert(normalizeVertexId('publishers/google/models/gemini-2.5-pro') === 'gemini-2.5-pro', 'Vertex normalization strips a publisher resource prefix')
assert(bedrockEntries.length === 17, 'Bedrock lifecycle fixture parses and deduplicates logical model rows')
assert(bedrockEntries.find(entry => entry.bedrockId === 'anthropic.claude-3-haiku-20240307-v1:0')?.eol === '2026-09-10', 'Bedrock parser handles rowspan model rows')
assert(bedrockEntries.find(entry => entry.bedrockId === 'amazon.nova-canvas-v1:0')?.legacy === '2026-03-30', 'Bedrock parser reads human legacy dates')
assert(bedrockEntries.every(entry => entry.legacy && entry.eol), 'Bedrock lifecycle records contain only parsed lifecycle dates')
assert(openaiEntries.length === 43, 'OpenAI real-structure fixture parses all selected model entries')
assert(openaiEntries.filter(entry => entry.announced === '2026-04-22').length >= 20, 'OpenAI announcement date is inherited across a section')
assert(openaiById.get('o3-deep-research-2025-06-26')?.announced === '2026-04-22', 'OpenAI July wave inherits its April announcement date')
assert(openaiById.get('o3-deep-research-2025-06-26')?.shutdown === '2026-07-23', 'OpenAI July wave parses its human shutdown date')
assert(openaiById.get('o4-mini-deep-research-2025-06-26')?.replacement === 'gpt-5.6-sol', 'OpenAI parses multiple models under one announcement')
assert(openaiById.get('gpt-4-turbo-2024-04-09')?.replacement === 'gpt-5.6-sol', 'OpenAI selects the dated snapshot from an alias cell')
assert(openaiById.get('sora-2')?.replacement === undefined, 'OpenAI preserves a missing replacement from ---')
const duplicateConflictHtml = '<h2>2026-01-01: Duplicate rows</h2><table><tr><th>Shutdown date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>duplicate-model</code></td><td><code>target-a</code></td></tr><tr><td>2027-01-01</td><td><code>duplicate-model</code></td><td><code>target-b</code></td></tr></table>'
const duplicateConflict = parseOpenAIDeprecations(duplicateConflictHtml)
assert(
  duplicateConflict.length === 1
    && duplicateConflict[0].replacement === undefined
    && duplicateConflict[0].replacement_options?.join(',') === 'target-a,target-b',
  'OpenAI duplicate lifecycle rows with different replacement payloads merge to the union as options, never first-wins',
)
const duplicateIdenticalHtml = '<h2>2026-01-01: Duplicate rows</h2><table><tr><th>Shutdown date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>duplicate-model</code><code>first-alias</code></td><td><code>target-a</code></td></tr><tr><td>2027-01-01</td><td><code>duplicate-model</code><code>second-alias</code></td><td><code>target-a</code></td></tr></table>'
const duplicateIdentical = parseOpenAIDeprecations(duplicateIdenticalHtml)
assert(duplicateIdentical.length === 1 && duplicateIdentical[0].aliases?.includes('first-alias') && duplicateIdentical[0].aliases?.includes('second-alias'), 'OpenAI identical replacement duplicates still merge aliases')
const parameterFields = extractReplacementFields('<code>target-model</code> (<code>reasoning.mode: pro</code>)')
const optionFields = extractReplacementFields('<code>first-model</code> or <code>second-model</code>')
const wildcardFields = extractReplacementFields('first-model or second-model*')
const proseFields = extractReplacementFields('Use API v1')
const wholeCellFields = extractReplacementFields('gemini-2.0-flash')
assert(parameterFields.replacement === 'target-model' && parameterFields.replacement_note === 'reasoning.mode: pro', 'replacement extraction keeps one ID and parameter guidance')
assert(JSON.stringify(optionFields.replacement_options) === JSON.stringify(['first-model', 'second-model']), 'replacement extraction preserves ordered options')
assert(!wildcardFields.replacement && JSON.stringify(wildcardFields.replacement_options) === JSON.stringify(['first-model']) && wildcardFields.replacement_note === 'second-model*', 'prose replacement tokens remain issue-only when wildcard text is present')
assert(!proseFields.replacement && JSON.stringify(proseFields.replacement_options) === JSON.stringify(['v1']), 'prose-derived replacement tokens never become patch targets')
assert(wholeCellFields.replacement === 'gemini-2.0-flash', 'whole-cell model IDs remain patchable replacements')
assert(dateFromText('2026‑08‑26') === '2026-08-26', 'OpenAI parses nonbreaking-hyphen dates')
assert(openaiEntries.every(entry => entry.source.startsWith('https://')), 'OpenAI dated entries carry a source URL')
const feedById = new Map(openaiFeed.models.map(model => [model.id, model]))
const overlapping = openaiEntries.filter(entry => feedById.has(entry.id))
assert(overlapping.length > 0 && overlapping.every(entry => {
  const model = feedById.get(entry.id)
  return entry.announced === model.announced && entry.shutdown === model.shutdown
}), 'OpenAI fixture and committed feed agree on covered IDs and lifecycle dates')
assert(anthropicEntries.length === 7, 'Anthropic deprecation fixture parses all entries')
assert(anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805')?.replacement === 'claude-opus-4-6', 'Anthropic replacement parses')
assert(openaiIds.length === 3 && openaiIds.includes('gpt-5.6-sol'), 'OpenAI models endpoint fixture parses')
assert(anthropicIds.includes('claude-sonnet-4-6'), 'Anthropic models endpoint fixture parses')
assert(googleEntries.length === 64, 'Google deprecations fixture parses all model rows')
assert(googleEntries.find(entry => entry.id === 'gemini-2.5-pro')?.date_precision === 'earliest', 'Google marks earliest possible shutdown dates')
assert(googleEntries.find(entry => entry.id === 'gemini-2.5-pro')?.shutdown === '2026-10-16', 'Google parses a human shutdown date')
assert(googleEntries.find(entry => entry.id === 'gemini-3.6-flash')?.shutdown === undefined, 'Google preserves models without a shutdown date')
assert(googleIds.length === 3 && googleIds.includes('gemini-2.5-pro'), 'Google models endpoint fixture strips the models/ prefix')
const genericStructuredHtml = '<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>generic-structured</code></td><td><code>first-model</code> or <code>second-model</code></td></tr></table>'
const googleStructuredHtml = '<table><tr><th>Model</th><th>Shutdown date</th><th>Recommended replacement</th></tr><tr><td><code>google-structured</code></td><td>2027-01-01</td><td>first-model or second-model*</td></tr></table>'
const genericStructured = parseAnthropicDeprecations(genericStructuredHtml)[0]
const googleStructured = parseGoogleDeprecations(googleStructuredHtml)[0]
assert(JSON.stringify(genericStructured.replacement_options) === JSON.stringify(['first-model', 'second-model']), 'generic parser uses structured replacement routing')
assert(!googleStructured.replacement && JSON.stringify(googleStructured.replacement_options) === JSON.stringify(['first-model']) && googleStructured.replacement_note === 'second-model*', 'Google parser keeps prose replacement tokens issue-only')
assert(vertexEntries.length === 41, 'Vertex model-versions fixture parses model rows')
assert(vertexEntries.find(entry => entry.vertexId === 'gemini-2.5-pro')?.date_precision === 'earliest', 'Vertex marks dates that cannot move earlier')
assert(vertexEntries.find(entry => entry.vertexId === 'claude-sonnet-4-20250514')?.shutdown === '2026-10-14', 'Vertex parses an Anthropic model row')
assert(VERTEX_MODEL_VERSIONS_URL.includes('/model-versions'), 'Vertex distributor cites its model versions source')

const minimalCommitted = {
  spec: 'model-eol/0.1',
  publisher: 'openai',
  generated: '2026-07-25T00:00:00Z',
  source: PROVIDERS.openai.deprecationsUrl,
  models: [{ id: 'old-current' }],
}
const currentMerge = mergeFeed(minimalCommitted, {
  currentIds: ['new-current'],
  deprecations: [],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
assert(currentMerge.feed.models.find(model => model.id === 'new-current' && !model.shutdown && !model.announced), 'current model entries have no lifecycle dates')
const structuredMerge = mergeFeed(minimalCommitted, {
  currentIds: ['resolved-target', 'second-target'],
  deprecations: [
    { id: 'single-resolvable', shutdown: '2026-12-01', replacement: 'resolved-target' },
    { id: 'multi-option', shutdown: '2026-12-01', replacement_options: ['resolved-target', 'second-target'] },
    { id: 'parameterized', shutdown: '2026-12-01', replacement: 'resolved-target', replacement_note: 'reasoning.mode: pro' },
    { id: 'single-unresolvable', shutdown: '2026-12-01', replacement: 'not-carried-yet' },
    { id: 'wildcard', shutdown: '2026-12-01', replacement: 'resolved-target', replacement_note: 'second-target*' },
  ],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
const structuredById = new Map(structuredMerge.feed.models.map(model => [model.id, model]))
assert(structuredById.get('single-resolvable')?.replacement === 'resolved-target', 'merge routes one resolvable token to replacement')
assert(JSON.stringify(structuredById.get('multi-option')?.replacement_options) === JSON.stringify(['resolved-target', 'second-target']), 'merge preserves multiple replacement options')
assert(structuredById.get('parameterized')?.replacement === 'resolved-target' && structuredById.get('parameterized')?.replacement_note === 'reasoning.mode: pro', 'merge preserves a parameterized replacement note')
assert(JSON.stringify(structuredById.get('single-unresolvable')?.replacement_options) === JSON.stringify(['not-carried-yet']) && !structuredById.get('single-unresolvable')?.replacement, 'merge routes an unresolved token to issue-only options')
assert(structuredById.get('wildcard')?.replacement === 'resolved-target' && structuredById.get('wildcard')?.replacement_note === 'second-target*' && !structuredById.get('wildcard')?.replacement_options, 'merge keeps wildcard guidance out of replacement IDs')
const provenanceMerge = mergeFeed(minimalCommitted, {
  currentIds: ['v1', 'gemini-2.0-flash'],
  deprecations: [
    { id: 'prose-replacement', shutdown: '2026-12-01', ...proseFields },
    { id: 'whole-cell-replacement', shutdown: '2026-12-01', ...wholeCellFields },
  ],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
const provenanceById = new Map(provenanceMerge.feed.models.map(model => [model.id, model]))
assert(!provenanceById.get('prose-replacement')?.replacement && JSON.stringify(provenanceById.get('prose-replacement')?.replacement_options) === JSON.stringify(['v1']), 'resolvable prose tokens remain issue-only after feed routing')
assert(provenanceById.get('whole-cell-replacement')?.replacement === 'gemini-2.0-flash', 'whole-cell exact IDs route to replacement after feed resolution')
const staleCurrent = mergeFeed({
  ...minimalCommitted,
  models: [{ id: 'stale-current', announced: '2026-01-01', shutdown: '2026-12-01', replacement: 'new-current' }],
}, {
  currentIds: ['stale-current'],
  deprecations: [],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
assert(staleCurrent.feed.models[0].shutdown === undefined && staleCurrent.feed.models[0].announced === undefined, 'endpoint presence clears stale lifecycle fields')

const unconfirmedMerge = mergeFeed({
  ...minimalCommitted,
  models: [
    { id: 'confirmed-model' },
    { id: 'kept-model', announced: '2026-01-01', shutdown: '2026-12-01' },
  ],
}, {
  currentIds: [],
  deprecations: [{
    id: 'confirmed-model',
    announced: '2026-01-01',
    shutdown: '2026-12-01',
    replacement: 'new-current',
    source: PROVIDERS.openai.deprecationsUrl,
  }],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
assert(unconfirmedMerge.feed.models.some(model => model.id === 'kept-model'), 'merge keeps an unconfirmed committed entry')
assert(unconfirmedMerge.unconfirmedIds.includes('kept-model'), 'merge reports the unconfirmed entry')

const aliasRewriteMerge = mergeFeed({
  ...minimalCommitted,
  models: [{ id: 'old-canonical', aliases: ['source-alias'] }],
}, {
  currentIds: null,
  deprecations: [
    { id: 'source-alias', announced: '2026-01-01', shutdown: '2026-12-01', source: PROVIDERS.openai.deprecationsUrl },
    { id: 'old-canonical', announced: '2026-01-01', shutdown: '2026-12-01', source: PROVIDERS.openai.deprecationsUrl },
  ],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
assert(aliasRewriteMerge.feed.models.length === 1 && aliasRewriteMerge.feed.models[0].id === 'old-canonical' && aliasRewriteMerge.feed.models[0].aliases?.includes('source-alias'), 'merge preserves canonical identity through alias rewrite and re-add')

const aliasCoverageMerge = mergeFeed({
  ...minimalCommitted,
  models: [{ id: 'old-current', aliases: ['committed-alias'] }],
}, {
  currentIds: null,
  deprecations: [{
    id: 'old-current',
    aliases: ['source-alias'],
    announced: '2026-01-01',
    shutdown: '2026-12-01',
    source: PROVIDERS.openai.deprecationsUrl,
  }],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.openai,
})
const aliasCoverageModel = aliasCoverageMerge.feed.models.find(model => model.id === 'old-current')
assert(aliasCoverageModel?.aliases?.includes('source-alias') && aliasCoverageModel.aliases.includes('committed-alias'), 'merge does not shrink aliases supplied by the source')

const distributorCommitted = {
  spec: 'model-eol/0.1',
  publisher: 'anthropic',
  generated: '2026-07-25T00:00:00Z',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [
    { id: 'publisher-model-20260101', aliases: ['publisher-alias'], notes: 'keep this note' },
    {
      id: 'existing-model-20250101',
      aliases: ['existing-model'],
      announced: '2025-01-01',
      shutdown: '2026-06-01',
      replacement: 'replacement-model',
      distributions: [
        { via: 'azure-ai-foundry', shutdown: '2026-12-01', source: 'https://example.test/azure' },
        { via: 'aws-bedrock', announced: '2026-01-01', shutdown: '2026-12-31', source: 'https://example.test/old-bedrock' },
      ],
    },
    {
      id: 'stale-model',
      distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01', source: 'https://example.test/stale' }],
    },
  ],
}
const existingBefore = distributorCommitted.models[1]
const existingBeforeFields = { ...existingBefore }
delete existingBeforeFields.distributions
const existingBeforeForeign = JSON.stringify(existingBefore.distributions[0])
const distributorMerge = mergeBedrockDistributions([distributorCommitted], {
  sourceUrl: BEDROCK_LIFECYCLE_URL,
  records: [
    { bedrockId: 'anthropic.publisher-alias-v1:0', legacy: '2026-08-01', eol: '2027-02-01' },
    { bedrockId: 'anthropic.existing-model-20250101-v2:0', legacy: '2026-02-01', eol: '2027-01-01' },
    { bedrockId: 'meta.llama3-1-405b-instruct-v1:0', legacy: '2026-08-01', eol: '2027-02-01' },
  ],
})
const distributorFeed = distributorMerge.feeds[0]
const publisherModel = distributorFeed.models.find(model => model.id === 'publisher-model-20260101')
assert(publisherModel.distributions?.[0]?.via === 'aws-bedrock' && publisherModel.distributions[0].shutdown === '2027-02-01', 'Bedrock merge upserts a distribution through a publisher alias')
const existingModel = distributorFeed.models.find(model => model.id === 'existing-model-20250101')
assert(existingModel.distributions[1].shutdown === '2027-01-01', 'Bedrock merge updates a changed EOL date in place')
assert(JSON.stringify(existingModel.distributions[0]) === existingBeforeForeign, 'Bedrock merge preserves foreign-via distributions')
const existingAfterFields = { ...existingModel }
delete existingAfterFields.distributions
assert(JSON.stringify(existingAfterFields) === JSON.stringify(existingBeforeFields), 'Bedrock merge preserves entry-level lifecycle and replacement fields')
assert(JSON.stringify(Object.keys(existingModel.distributions[1])) === JSON.stringify(['via', 'announced', 'shutdown', 'source']), 'Bedrock distribution fields retain canonical order')
assert(distributorMerge.unconfirmedDistributions.some(item => item.id === 'stale-model'), 'Bedrock merge reports an unconfirmed existing distribution')
assert(distributorMerge.noPublisherFeed.some(item => item.bedrockId === 'meta.llama3-1-405b-instruct-v1:0'), 'Bedrock merge reports unmatched models without inventing entries')
assert(!distributorFeed.models.some(model => model.id === 'llama3-1-405b-instruct'), 'Bedrock merge does not create an unmatched publisher entry')

let bedrockBindingReason = ''
try {
  mergeBedrockDistributions([{ publisher: 'openai', models: [{ id: 'shared-claude-model' }] }], {
    sourceUrl: BEDROCK_LIFECYCLE_URL,
    records: [{ bedrockId: 'anthropic.shared-claude-model-v1:0', legacy: '2026-08-01', eol: '2027-02-01' }],
  })
} catch (error) {
  bedrockBindingReason = error.message
}
assert(bedrockBindingReason.includes('binds to anthropic') && bedrockBindingReason.includes('openai feed'), 'Bedrock namespace binding refuses a cross-publisher match')

const unknownNamespaceMerge = mergeBedrockDistributions([{ publisher: 'openai', models: [{ id: 'unknown-model' }] }], {
  sourceUrl: BEDROCK_LIFECYCLE_URL,
  records: [{ bedrockId: 'future-provider.unknown-model:0', legacy: '2026-08-01', eol: '2027-02-01' }],
})
assert(unknownNamespaceMerge.noPublisherFeed.some(item => item.bedrockId === 'future-provider.unknown-model:0') && !unknownNamespaceMerge.feeds[0].models[0].distributions, 'unknown Bedrock namespaces remain skipped with a note')

const vertexMerge = mergeVertexDistributions([googleFeed, anthropicFeed], {
  records: vertexEntries,
  sourceUrl: VERTEX_MODEL_VERSIONS_URL,
})
const vertexGoogle = vertexMerge.feeds[0].models.find(model => model.id === 'gemini-2.5-pro')
const vertexAnthropic = vertexMerge.feeds[1].models.find(model => model.id === 'claude-sonnet-4-20250514')
assert(vertexGoogle?.distributions?.some(distribution => distribution.via === 'vertex-ai' && distribution.shutdown === '2026-10-20' && distribution.date_precision === 'earliest'), 'Vertex merge annotates a Google publisher entry')
assert(vertexAnthropic?.distributions?.some(distribution => distribution.via === 'vertex-ai' && distribution.shutdown === '2026-10-14'), 'Vertex merge annotates an Anthropic publisher entry')
assert(vertexMerge.noPublisherFeed.some(item => item.vertexId === 'vertex-unmatched-model'), 'Vertex merge reports an unmatched model')
assert(!vertexMerge.feeds.some(feed => feed.models.some(model => model.id === 'vertex-unmatched-model')), 'Vertex merge does not invent an unmatched publisher entry')

let vertexBindingReason = ''
try {
  mergeVertexDistributions([{ publisher: 'anthropic', models: [{ id: 'shared-vertex-model' }] }], {
    sourceUrl: VERTEX_MODEL_VERSIONS_URL,
    records: [{ vertexId: 'publishers/google/models/shared-vertex-model', shutdown: '2027-02-01' }],
  })
} catch (error) {
  vertexBindingReason = error.message
}
assert(vertexBindingReason.includes('binds to google') && vertexBindingReason.includes('anthropic feed'), 'Vertex namespace binding refuses a cross-publisher match')

const amazonBedrock = mergeBedrockDistributions([amazonFeed], {
  records: bedrockEntries,
  sourceUrl: BEDROCK_LIFECYCLE_URL,
})
assert(amazonBedrock.feeds[0].models.some(model => model.id === 'nova-canvas'), 'Amazon seed contains Nova publisher entries')
assert(!amazonBedrock.noPublisherFeed.some(item => item.normalizedId.startsWith('nova-')), 'Bedrock resolves Nova models to the Amazon feed')

const oldFeed = {
  spec: 'model-eol/0.1', publisher: 'openai', generated: '2026-07-25T00:00:00Z', models: [
    { id: 'stable', shutdown: '2026-10-01', replacement: 'old-target' },
    { id: 'fresh' },
    { id: 'kept' },
  ],
}
const newFeed = {
  ...oldFeed,
  generated: '2026-08-01T00:00:00Z',
  models: [
    { id: 'stable', shutdown: '2026-11-01', replacement: 'new-target' },
    { id: 'fresh', announced: '2026-08-01', shutdown: '2026-12-01', replacement: 'new-target' },
    { id: 'kept' },
    { id: 'added', announced: '2026-08-01', shutdown: '2027-01-01', replacement: 'new-target' },
  ],
}
const semantic = compareFeeds(oldFeed, newFeed, { unconfirmed: ['kept'] })
const semanticMarkdown = renderSemanticDiff(oldFeed, newFeed, { unconfirmed: ['kept'] })
assert(semantic.changed, 'semantic diff detects changes')
for (const heading of [
  '## Models added',
  '## Shutdown date changes',
  '## Replacement changes',
  '## Newly announced deprecations',
  '## Unconfirmed entries',
]) assert(semanticMarkdown.includes(heading), `semantic diff renders ${heading.slice(3).toLowerCase()}`)
assert(!semanticMarkdown.includes('## Distribution changes'), 'semantic diff omits empty sections instead of rendering None')
assert(semanticMarkdown.includes('2026-10-01') && semanticMarkdown.includes('2026-11-01'), 'semantic diff renders shutdown date movement')
assert(semanticMarkdown.includes('old-target') && semanticMarkdown.includes('new-target'), 'semantic diff renders replacement movement')
const optionsOld = { ...oldFeed, models: [{ id: 'options-model', replacement_options: ['first-target', 'second-target'], replacement_note: 'old guidance' }] }
const optionsNew = { ...oldFeed, models: [{ id: 'options-model', replacement_options: ['first-target', 'third-target'], replacement_note: 'new guidance' }] }
const optionsDiff = compareFeeds(optionsOld, optionsNew)
const optionsMarkdown = renderSemanticDiff(optionsOld, optionsNew)
assert(optionsDiff.changed && optionsDiff.replacementChanges.length === 1 && optionsMarkdown.includes('replacement_options') && optionsMarkdown.includes('new guidance'), 'semantic diff treats replacement options and notes as material')
assert(!compareFeeds(oldFeed, oldFeed).changed, 'semantic diff ignores generated metadata and reports no-change feeds')
const precisionFeed = { ...oldFeed, models: [{ id: 'precision', shutdown: '2026-10-01', date_precision: 'earliest' }] }
const precisionDiff = renderSemanticDiff({ ...oldFeed, models: [{ id: 'precision', shutdown: '2026-10-01' }] }, precisionFeed)
assert(precisionDiff.includes('2026-10-01') && precisionDiff.includes('(earliest)'), 'semantic diff renders earliest date precision')

const aliasDiffOld = { ...oldFeed, models: [{ id: 'alias-model', aliases: ['old-alias'], shutdown: '2026-10-01' }] }
const aliasDiffNew = { ...aliasDiffOld, models: [{ id: 'alias-model', aliases: ['new-alias'], shutdown: '2026-10-01' }] }
const aliasDiff = compareFeeds(aliasDiffOld, aliasDiffNew)
const aliasDiffMarkdown = renderSemanticDiff(aliasDiffOld, aliasDiffNew)
assert(aliasDiff.changed && aliasDiffMarkdown.includes('## Alias changes') && aliasDiffMarkdown.includes('new-alias') && aliasDiffMarkdown.includes('old-alias'), 'semantic diff marks and renders alias changes')

const announcementDiffOld = { ...oldFeed, models: [{ id: 'announcement-model', announced: '2026-01-01', shutdown: '2026-10-01' }] }
const announcementDiffNew = { ...announcementDiffOld, models: [{ id: 'announcement-model', announced: '2026-02-01', shutdown: '2026-10-01' }] }
const announcementDiff = compareFeeds(announcementDiffOld, announcementDiffNew)
const announcementDiffMarkdown = renderSemanticDiff(announcementDiffOld, announcementDiffNew)
assert(announcementDiff.changed && announcementDiffMarkdown.includes('Announcement date changes') && announcementDiffMarkdown.includes('2026-01-01') && announcementDiffMarkdown.includes('2026-02-01'), 'semantic diff marks and renders announced-date corrections')

const informationalOnlyDiff = compareFeeds(
  { ...oldFeed, models: [{ id: 'stable' }] },
  { ...oldFeed, models: [{ id: 'stable' }] },
  { unconfirmed: ['stable'], noPublisherFeed: [{ bedrockId: 'future.model', normalizedId: 'model' }] },
)
assert(!informationalOnlyDiff.changed, 'semantic diff keeps unconfirmed entries and no-publisher notes informational')
const currentAdditionDiff = compareFeeds(
  { ...oldFeed, models: [{ id: 'stable' }] },
  { ...oldFeed, models: [{ id: 'stable' }, { id: 'current-only' }] },
)
assert(currentAdditionDiff.changed, 'semantic diff treats a current-model addition as material')

const openaiCheck = run(['--provider', 'openai', '--check', '--fixtures', fixtures])
assert(openaiCheck.code === 0 || openaiCheck.code === 3, 'OpenAI --check exits 0 or 3 depending on committed feed state, never a failure')
assert(openaiCheck.out.includes('Unconfirmed entries') && openaiCheck.out.includes('retained because neither source confirmed it'), '--check retains and reports committed entries the fixture slice does not confirm')

const responseFor = body => ({ ok: true, status: 200, text: async () => body })
const openaiPageUrls = []
const paginatedOpenAI = await loadProviderSources(PROVIDERS.openai, {
  env: { OPENAI_API_KEY: 'fixture-key' },
  notice: () => {},
  fetchImpl: async url => {
    const parsedUrl = new URL(url)
    openaiPageUrls.push(parsedUrl)
    if (parsedUrl.pathname === '/v1/models') {
      return parsedUrl.searchParams.get('after')
        ? responseFor(JSON.stringify({ data: [{ id: 'page-two' }], has_more: false, last_id: 'page-two' }))
        : responseFor(JSON.stringify({ data: [{ id: 'page-one' }], has_more: true, last_id: 'page-one' }))
    }
    return responseFor(openaiHtml)
  },
})
assert(paginatedOpenAI.currentIds.length === 2 && paginatedOpenAI.currentIds.includes('page-two') && openaiPageUrls[1]?.searchParams.get('after') === 'page-one', 'OpenAI models pagination follows the last id into the next page')

const anthropicPageUrls = []
const paginatedAnthropic = await loadProviderSources(PROVIDERS.anthropic, {
  env: { ANTHROPIC_API_KEY: 'fixture-key' },
  notice: () => {},
  fetchImpl: async url => {
    const parsedUrl = new URL(url)
    anthropicPageUrls.push(parsedUrl)
    if (parsedUrl.pathname === '/v1/models') {
      return parsedUrl.searchParams.get('after_id')
        ? responseFor(JSON.stringify({ data: [{ id: 'anthropic-page-two' }], has_more: false, last_id: 'anthropic-page-two' }))
        : responseFor(JSON.stringify({ data: [{ id: 'anthropic-page-one' }], has_more: true, last_id: 'anthropic-page-one' }))
    }
    return responseFor(anthropicHtml)
  },
})
assert(paginatedAnthropic.currentIds.length === 2 && anthropicPageUrls[1]?.searchParams.get('after_id') === 'anthropic-page-one', 'Anthropic models pagination follows after_id from last_id')

let capCalls = 0
let paginationCapReason = ''
try {
  await loadProviderSources(PROVIDERS.openai, {
    env: { OPENAI_API_KEY: 'fixture-key' },
    notice: () => {},
    fetchImpl: async url => {
      const parsedUrl = new URL(url)
      if (parsedUrl.pathname === '/v1/models') {
        capCalls++
        return responseFor(JSON.stringify({ data: [{ id: `cap-page-${capCalls}` }], has_more: true, last_id: `cap-page-${capCalls}` }))
      }
      return responseFor(openaiHtml)
    },
  })
} catch (error) {
  paginationCapReason = error.message
}
assert(capCalls === 20 && paginationCapReason.includes('pagination cap of 20 pages'), 'models pagination fails loudly at the hard page cap')

const anthropicCheck = run(['--provider', 'anthropic', '--check', '--fixtures', fixtures])
assert(anthropicCheck.code === 0 || anthropicCheck.code === 3, 'Anthropic --check exits 0 or 3 depending on committed feed state, never a failure')

const googleCheck = run(['--provider', 'google', '--check', '--fixtures', fixtures])
assert(googleCheck.code === 0 || googleCheck.code === 3, 'Google --check exits 0 or 3 depending on committed feed state, never a failure')

const bedrockCheck = run(['--distributor', 'aws-bedrock', '--check', '--fixtures', fixtures])
assert(bedrockCheck.code === 0 || bedrockCheck.code === 3, 'Bedrock --check exits 0 or 3 depending on committed feed state, never a failure')
assert(bedrockCheck.out.includes('## Distribution changes'), 'Bedrock --check renders the Distribution changes section')
assert(bedrockCheck.out.includes('no publisher feed'), 'Bedrock --check reports unmatched models (moved-EOL rendering is covered by the merge unit tests)')
assert(!bedrockCheck.out.includes('normalized id `nova-'), 'Bedrock --check no longer reports Nova as feedless')

const vertexCheck = run(['--distributor', 'vertex-ai', '--check', '--fixtures', fixtures])
assert([0, 3].includes(vertexCheck.code), 'Vertex --check exits 0 or 3 depending on committed feed state, never a failure')
assert(vertexCheck.out.includes('no publisher feed'), 'Vertex --check reports unmatched models')

const bothDistributorsCheck = run(['--distributor', 'aws-bedrock,vertex-ai', '--check', '--fixtures', fixtures])
assert(bothDistributorsCheck.code === 3 && bothDistributorsCheck.out.includes('vertex-ai'), 'refresh accepts comma-separated distributors')

const refreshWorkflow = fs.readFileSync(path.join(root, '.github/workflows/feed-refresh.yml'), 'utf8')
assert(refreshWorkflow.includes('[ "$providers" -ne 0 ] && [ "$providers" -ne 3 ]') && refreshWorkflow.includes('exit code $providers'), 'workflow fails explicitly on unexpected provider refresh exit codes')
assert(refreshWorkflow.includes('[ "$bedrock" -ne 0 ] && [ "$bedrock" -ne 3 ]') && refreshWorkflow.includes('exit code $bedrock'), 'workflow fails explicitly on unexpected distributor refresh exit codes')

const composedBedrockCheck = run(['--provider', 'anthropic', '--distributor', 'aws-bedrock', '--check', '--fixtures', fixtures])
assert(composedBedrockCheck.code === 3 && composedBedrockCheck.out.includes('Distribution changes'), 'Bedrock distributor composes with a selected publisher refresh')

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-test-'))
const beforeOpenAI = fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8')
const beforeAnthropic = fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8')
const writeRun = run(['--provider', 'all', '--out', outputDir, '--fixtures', fixtures])
assert(writeRun.code === 0, 'non-check refresh writes valid fixture output')
assert(fs.existsSync(path.join(outputDir, 'openai.json')) && fs.existsSync(path.join(outputDir, 'anthropic.json')), 'non-check refresh writes both selected feeds')
const generatedAnthropic = JSON.parse(fs.readFileSync(path.join(outputDir, 'anthropic.json'), 'utf8'))
const generatedOpenAI = JSON.parse(fs.readFileSync(path.join(outputDir, 'openai.json'), 'utf8'))
assert(generatedAnthropic.models.some(model => model.id === 'claude-sonnet-4-6' && !model.shutdown && !model.announced), 'written output includes a current model without lifecycle dates')
assert(generatedOpenAI.models.some(model => model.id === 'sora-2' && !model.replacement), 'written OpenAI output preserves a missing replacement')
assert(generatedOpenAI.models.some(model => model.id === 'gpt-4-0613' && model.aliases?.includes('gpt-4')), 'written OpenAI output preserves every model-cell code token as an alias')
assert(fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8') === beforeOpenAI, 'refresh does not modify committed OpenAI feeds during tests')
assert(fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8') === beforeAnthropic, 'refresh does not modify committed Anthropic feeds during tests')

const corruptBedrockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-bedrock-corrupt-'))
fs.writeFileSync(path.join(corruptBedrockDir, 'bedrock-lifecycle.html'), '<html><body><table><tr><th>Model ID</th><th>Legacy date</th></tr></table></body></html>')
const corruptBedrockOut = path.join(corruptBedrockDir, 'out')
const corruptBedrockRun = run(['--distributor', 'aws-bedrock', '--out', corruptBedrockOut, '--fixtures', corruptBedrockDir])
assert(corruptBedrockRun.code === 1, 'corrupted Bedrock fixture exits nonzero')
assert(!fs.existsSync(corruptBedrockOut), 'corrupted Bedrock fixture produces no output directory')

const corruptOpenAIDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-openai-corrupt-'))
fs.copyFileSync(path.join(fixtures, 'openai-models.json'), path.join(corruptOpenAIDir, 'openai-models.json'))
fs.writeFileSync(path.join(corruptOpenAIDir, 'openai-deprecations.html'), '<html><body><h1>Deprecations</h1><p>corrupt</p></body></html>')
const corruptOpenAIOut = path.join(corruptOpenAIDir, 'out')
const corruptOpenAIRun = run(['--provider', 'openai', '--out', corruptOpenAIOut, '--fixtures', corruptOpenAIDir])
assert(corruptOpenAIRun.code === 1, 'corrupted OpenAI fixture exits nonzero')
assert(!fs.existsSync(corruptOpenAIOut), 'corrupted OpenAI fixture produces no output directory')

const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-corrupt-'))
for (const file of ['openai-models.json', 'anthropic-models.json', 'openai-deprecations.html']) {
  fs.copyFileSync(path.join(fixtures, file), path.join(corruptDir, file))
}
fs.writeFileSync(path.join(corruptDir, 'anthropic-deprecations.html'), '<html><body><table><tr><td>corrupt</td></tr></table></body></html>')
const corruptOut = path.join(corruptDir, 'out')
const corruptRun = run(['--provider', 'anthropic', '--out', corruptOut, '--fixtures', corruptDir])
assert(corruptRun.code === 1, 'corrupted fixture exits nonzero')
assert(!fs.existsSync(corruptOut), 'corrupted fixture produces no output directory')

fs.rmSync(outputDir, { recursive: true, force: true })
fs.rmSync(corruptBedrockDir, { recursive: true, force: true })
fs.rmSync(corruptOpenAIDir, { recursive: true, force: true })
fs.rmSync(corruptDir, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)` : '\nall refresh assertions passed')
process.exit(failures ? 1 : 0)
