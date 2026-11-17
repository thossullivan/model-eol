#!/usr/bin/env node
// Offline refresh-tool tests. The fixture directory is deliberately used for
// every CLI invocation so this suite never needs provider credentials or a
// network connection.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import strictAssert from 'node:assert/strict'
import {
  BEDROCK_LIFECYCLE_MARKDOWN_URL,
  BEDROCK_LIFECYCLE_URL,
  BEDROCK_MODEL_CARDS_MARKDOWN_URL,
  BEDROCK_MODEL_CARDS_URL,
  MAX_BEDROCK_MODEL_CARDS,
  MAX_DISTRIBUTOR_BODY_BYTES,
  AZURE_MODEL_RETIREMENT_SCHEDULE_URL,
  AZURE_PUBLISHER_BY_SECTION,
  VERTEX_MODEL_VERSIONS_URL,
  loadDistributorSource,
  mergeBedrockDistributions,
  mergeBedrockSources,
  mergeDistributions,
  mergeVertexDistributions,
  normalizeBedrockId,
  normalizeVertexId,
  bedrockMarkdownUrl,
  parseBedrockLifecycleMarkdown,
  parseBedrockModelCardMarkdown,
  parseBedrockModelCardsIndexMarkdown,
  parseAzureModelRetirementScheduleHtml,
  parseVertexModelVersionsHtml,
} from '../distributors.mjs'
import {
  PROVIDERS,
  MAX_ANTHROPIC_MODEL_PAGES,
  parseAnthropicModelsIndex,
  parseAnthropicModelPage,
  assertIsoDate,
  extractReplacementFields,
  loadProviderSources,
  mergeFeed,
  parseAnthropicDeprecations,
  parseAnthropicDeprecationsHtml,
  anthropicMarkdownToHtml,
  anthropicModelsListUrl,
  compareAnthropicLifecycle,
  parseAnthropicModelsLifecyclePage,
  providerSourceConflictSummary,
  parseAnthropicModels,
  dateFromText,
  parseGoogleDeprecations,
  parseGoogleDeprecationsHtml,
  googleMarkdownToHtml,
  findFixture,
  parseGoogleModels,
  parseMistralDeprecationsMarkdown,
  cohereMarkdownToHtml,
  parseCohereDeprecations,
  parseCohereDeprecationsMarkdown,
  parseCohereModelsResponse,
  parseModelsResponse,
  parseOpenAIDeprecations,
  parseOpenAIDeprecationsMarkdown,
  parseOpenAIModels,
  stripComments,
} from '../providers.mjs'
import { compareFeeds, renderSemanticDiff } from '../diff.mjs'
import { SOURCE_FETCH_DEADLINE_MS, credentialHeaderNames, fetchBoundedBody } from '../fetch.mjs'
import { parseRefreshArgs, sourceFailureError, usage, validateGeneratedFeeds } from '../refresh.mjs'
import { validateFeed } from '../../lib/validate-feed.mjs'
import { lifecycleFor } from '../../lib/feeds.mjs'
import { classifyFeedReleasePaths } from '../../scripts/feed-release-guard.mjs'
import { validateReleaseVersion } from '../../scripts/validate-release-version.mjs'
import { resolveReleaseState, targetReleaseVersion } from '../../scripts/release-state.mjs'
import { createReleaseReceipt, validateReleaseReceipt } from '../../scripts/release-receipt.mjs'
import { assertSha512Integrity, sha512Integrity } from '../../scripts/package-integrity.mjs'
import { stableGithubReleaseExists } from '../../scripts/github-release-state.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const refresh = path.join(root, 'refresh', 'refresh.mjs')
const fixtures = path.join(root, 'refresh', 'test', 'fixture')

function run(args, { env = process.env } = {}) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [refresh, ...args], { encoding: 'utf8', env }),
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
let schemaOnlyRefreshMessage = ''
try {
  validateGeneratedFeeds([{
    provider: { feedFile: 'schema-only.json' },
    feed: {
      spec: 'model-eol/0.1',
      publisher: 'test',
      generated: '2026-08-01T00:00:00Z',
      models: [{ id: 'schema-only-refresh-model', notes: 5 }],
    },
  }])
} catch (error) {
  schemaOnlyRefreshMessage = error.message
}
assert(schemaOnlyRefreshMessage.includes('schema-only.json model schema-only-refresh-model: models[0].notes: '), 'refresh runs the feed schema on generated feeds')
let tentativeWithoutAnnouncementValid = true
try {
  validateGeneratedFeeds([{
    provider: { feedFile: 'tentative.json' },
    feed: {
      spec: 'model-eol/0.1',
      publisher: 'anthropic',
      generated: '2026-08-01T00:00:00Z',
      source: PROVIDERS.anthropic.deprecationsUrl,
      models: [{ id: 'tentative-model', shutdown: '2027-06-09', date_precision: 'tentative' }],
    },
  }])
} catch {
  tentativeWithoutAnnouncementValid = false
}
assert(tentativeWithoutAnnouncementValid, 'feed validation permits tentative shutdown dates without announced dates')

for (const via of ['publisher', 'publisher-fallback']) {
  let reservedClockReason = ''
  try {
    mergeDistributions([], { records: [], sourceUrl: 'https://example.invalid/distributor', via })
  } catch (error) {
    reservedClockReason = error.message
  }
  assert(reservedClockReason.includes('reserved distributor clock') && reservedClockReason.includes(via), `refresh rejects reserved distributor clock ${via}`)
}

const unknownFlag = run(['--dyas', '90'])
assert(unknownFlag.code === 2 && unknownFlag.err.includes('--dyas') && unknownFlag.err.includes('--help'), 'unknown refresh flags exit 2 with the bad flag and help hint')

const openaiHtml = fs.readFileSync(path.join(fixtures, 'openai-deprecations-headings.html'), 'utf8')
const anthropicMarkdown = fs.readFileSync(path.join(fixtures, 'anthropic-deprecations.md'), 'utf8')
const bedrockMarkdown = fs.readFileSync(path.join(fixtures, 'bedrock-lifecycle.md'), 'utf8')
const googleMarkdown = fs.readFileSync(path.join(fixtures, 'google-deprecations.md'), 'utf8')
const vertexHtml = fs.readFileSync(path.join(fixtures, 'vertex-model-versions.html'), 'utf8')
const endpointLookalikeMarkdown = fs.readFileSync(path.join(fixtures, 'anthropic-endpoint-lookalike.md'), 'utf8')
const mdTable = (header, rows) => `\n${[header, header.map(() => '---'), ...rows].map(cells => `| ${cells.join(' | ')} |`).join('\n')}\n\n`
const statusExtraColumnMarkdown = mdTable(['Recommended replacement', 'Current state', 'API model name', 'Tentative retirement date', 'Deprecated'], [['`claude-next`', 'Active', 'claude-extra-column', 'Not sooner than September 1, 2027', 'N/A']])
const statusRenamedColumnMarkdown = mdTable(['API model name', 'Lifecycle state', 'Deprecated', 'Tentative retirement date'], [['claude-renamed-column', 'Active', 'N/A', 'Not sooner than September 1, 2027']])
const openaiEntries = parseOpenAIDeprecations(openaiHtml)
const anthropicEntries = parseAnthropicDeprecations(anthropicMarkdown)
const bedrockEntries = parseBedrockLifecycleMarkdown(bedrockMarkdown)
const bedrockById = new Map(bedrockEntries.map(entry => [entry.bedrockId, entry]))
const googleEntries = parseGoogleDeprecations(googleMarkdown)
const vertexEntries = parseVertexModelVersionsHtml(vertexHtml)
const openaiIds = parseOpenAIModels(fs.readFileSync(path.join(fixtures, 'openai-models.json'), 'utf8'))
const anthropicIds = parseAnthropicModels(fs.readFileSync(path.join(fixtures, 'anthropic-models.json'), 'utf8'))
const googleIds = parseGoogleModels(fs.readFileSync(path.join(fixtures, 'google-models.json'), 'utf8'))
const openaiFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8'))
const anthropicFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8'))
const googleFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'google.json'), 'utf8'))
const amazonFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds', 'amazon.json'), 'utf8'))
const anthropicIndex = fs.readFileSync(path.join(fixtures, 'anthropic-llms.txt'), 'utf8')
const anthropicModelUrls = parseAnthropicModelsIndex(anthropicIndex)
const anthropicModelMarkdown = url => fs.readFileSync(path.join(fixtures, 'anthropic-model-pages', `${new URL(url).pathname.split('/').at(-2)}.md`), 'utf8')
const anthropicPageModels = anthropicModelUrls.map(url => parseAnthropicModelPage(anthropicModelMarkdown(url), url))
const anthropicExpectedAliases = [
  { id: 'claude-haiku-4-5-20251001', aliases: ['claude-haiku-4-5'] },
  { id: 'claude-opus-4-5-20251101', aliases: ['claude-opus-4-5'] },
  { id: 'claude-sonnet-4-5-20250929', aliases: ['claude-sonnet-4-5'] },
]
assert(anthropicModelUrls.length === 13 && JSON.stringify(anthropicPageModels.filter(model => model.aliases.length)) === JSON.stringify(anthropicExpectedAliases), '13 Anthropic model fixtures produce exactly the three published aliases')
assert(anthropicPageModels.filter(model => !model.aliases.length).length === 10 && anthropicPageModels.find(model => model.id === 'claude-opus-4-6')?.aliases.length === 0, 'all ten dateless Anthropic model pages yield no aliases')
assert(anthropicPageModels.every(model => Object.keys(model).join() === 'id,aliases'), 'Anthropic model pages ingest only model IDs and aliases')
const anthropicTestUrl = 'https://platform.claude.com/docs/en/models/test/overview.md'
const anthropicTestRow = '| Claude API | `claude-test` |'
const anthropicTestTable = rows => `| Platform | Model ID |\n| --- | --- |\n${rows}`
for (const [label, markdown] of [
  ['missing Claude API row', '| Status | Active |'],
  ['duplicate Claude API rows', `${anthropicTestRow}\n${anthropicTestRow}`],
  ['two code spans', '| Claude API | `claude-test` `claude-other` |'],
  ['uncoded value', '| Claude API | claude-test |'],
  ['pipe in ID', '| Claude API | `claude|bad` |'],
  ['extra alias cell', `${anthropicTestRow}\n| Claude API alias | \`claude-alias\` | extra |`],
  ['malformed ID', '| Claude API | `claude/bad` |'],
  ['surrounding prose', '| Claude API | use `claude-test` |'],
  ['duplicate aliases', `${anthropicTestRow}\n| Claude API alias | \`claude-alias\` |\n| Claude API alias | \`claude-alias\` |`],
  ['malformed alias', `${anthropicTestRow}\n| Claude API alias | \`bad alias\` |`],
  ['two alias spans', `${anthropicTestRow}\n| Claude API alias | \`claude-a\` \`claude-b\` |`],
]) {
  strictAssert.throws(() => parseAnthropicModelPage(anthropicTestTable(markdown), anthropicTestUrl), error => error.message.includes(anthropicTestUrl))
  assert(true, `Anthropic model pages reject ${label} and name the URL`)
}
assert(parseAnthropicModelPage(anthropicTestTable(`${anthropicTestRow}\n| Claude API alias | \`claude-test\` |`), anthropicTestUrl).aliases.length === 0, 'Anthropic ignores a self alias')
strictAssert.throws(() => parseAnthropicModelPage(`<!--\n${anthropicTestTable(`${anthropicTestRow}\n| Claude API alias | \`claude-other\` |`)}`, anthropicTestUrl), /unbalanced comment marker/)
assert(true, 'Anthropic model pages fail closed on an unterminated comment instead of reading the hidden table')
const anthropicIgnoredRows = anthropicTestTable(`${anthropicTestRow}\n| Status | Retired |\n| Released | invalid date |\n| Retirement | 2000-01-01 |\n| Amazon Bedrock (InvokeModel) | \`anthropic.claude-test-v1:0\` |\n| Google Cloud | \`claude-test@20260101\` |\n| Microsoft Foundry | \`other-model\` |\n| Claude Platform on AWS | \`other-model\` |`)
assert(JSON.stringify(parseAnthropicModelPage(anthropicIgnoredRows, anthropicTestUrl)) === JSON.stringify({ id: 'claude-test', aliases: [] }), 'Anthropic ignores platform, status, release, and retirement rows')
const anthropicCapUrls = Array.from({ length: MAX_ANTHROPIC_MODEL_PAGES }, (_, index) => `https://platform.claude.com/docs/en/models/test-${index}/overview.md`)
assert(parseAnthropicModelsIndex([...anthropicCapUrls, ...anthropicCapUrls].join('\n')).length === 100, 'Anthropic index deduplicates URLs before applying its 100-page cap')
strictAssert.throws(() => parseAnthropicModelsIndex([...anthropicCapUrls, anthropicTestUrl].join('\n')), /cap of 100 pages/)
strictAssert.throws(() => parseAnthropicModelsIndex('no model pages'), /has no model pages/)
const anthropicIndexLookalikes = [
  anthropicTestUrl.replace('https:', 'http:'), anthropicTestUrl.replace('platform.claude.com', 'platform.claude.com.evil'),
  `${anthropicTestUrl}?query=1`, `${anthropicTestUrl}#fragment`, `${anthropicTestUrl}.extra`,
  anthropicTestUrl.replace('/test/', '/Test/'), anthropicTestUrl.replace('/test/', '/../'),
]
assert(parseAnthropicModelsIndex([anthropicTestUrl, ...anthropicIndexLookalikes].map(url => `[Page](${url})`).join('\n')).join() === anthropicTestUrl, 'Anthropic index accepts only exact model overview URLs')
const anthropicSources = await loadProviderSources(PROVIDERS.anthropic, { fixtures, notice: () => {} })
assert(JSON.stringify(anthropicSources.currentModels) === JSON.stringify(anthropicPageModels) && JSON.stringify(anthropicSources.deprecations) === JSON.stringify(anthropicEntries), 'Anthropic loading routes page identities through currentModels without modifying deprecations')
const anthropicAliasBase = { ...anthropicFeed, models: anthropicPageModels.map(model => ({ id: model.id })) }
const anthropicAliasNotices = []
const anthropicAliasesMerged = mergeFeed(anthropicAliasBase, { currentModels: anthropicSources.currentModels, provider: PROVIDERS.anthropic, notice: message => anthropicAliasNotices.push(message) }).feed
assert(anthropicAliasNotices.length === 3 && anthropicExpectedAliases.every(model => anthropicAliasNotices.includes(`notice: anthropic alias ${model.aliases[0]} attached to ${model.id}`)), 'Anthropic merge emits one notice per attached alias')
const anthropicAliasDiff = renderSemanticDiff(anthropicAliasBase, anthropicAliasesMerged)
assert(compareFeeds(anthropicAliasBase, anthropicAliasesMerged).changed && anthropicAliasDiff.includes('## Alias changes') && anthropicExpectedAliases.every(model => anthropicAliasDiff.includes(model.aliases[0])), 'semantic diff renders all three Anthropic alias additions')
const anthropicMovedBase = { ...anthropicFeed, models: [{ id: 'claude-old', aliases: ['claude-moving'] }, { id: 'claude-new' }] }
const anthropicMoveNotices = []
const anthropicMoved = mergeFeed(anthropicMovedBase, { currentModels: [{ id: 'claude-new', aliases: ['claude-moving'] }], provider: PROVIDERS.anthropic, notice: message => anthropicMoveNotices.push(message) }).feed
assert(!anthropicMoved.models[0].aliases && anthropicMoved.models[1].aliases.join() === 'claude-moving' && anthropicMoveNotices.join() === 'notice: anthropic alias claude-moving moved from claude-old to claude-new', 'Anthropic moves an alias between canonical models with exactly one notice')
assert(compareFeeds(anthropicMovedBase, anthropicMoved).aliasChanges.length === 2 && renderSemanticDiff(anthropicMovedBase, anthropicMoved).includes('claude-moving'), 'semantic diff renders both sides of an alias move')
const anthropicRepeatNotices = []
mergeFeed(anthropicAliasesMerged, { currentModels: anthropicPageModels, provider: PROVIDERS.anthropic, notice: message => anthropicRepeatNotices.push(message) })
assert(!anthropicRepeatNotices.length, 'unchanged aliases produce no attachment notices')
strictAssert.throws(() => mergeFeed({ ...anthropicFeed, models: [{ id: 'claude-sonnet-4-5' }] }, { currentModels: anthropicExpectedAliases, provider: PROVIDERS.anthropic, notice: () => {} }), /claude-sonnet-4-5.*canonical model id/)
strictAssert.throws(() => mergeFeed({ ...anthropicFeed, models: [{ id: 'claude-sonnet-4-5', aliases: ['claude-sonnet-4-5-20250929'] }] }, { currentModels: anthropicExpectedAliases, provider: PROVIDERS.anthropic, notice: () => {} }), /claude-sonnet-4-5.*canonical model id/)
const anthropicPageOnly = mergeFeed({ ...anthropicFeed, models: [] }, { currentModels: anthropicExpectedAliases, currentIds: [], provider: PROVIDERS.anthropic, notice: () => {} }).feed
assert(JSON.stringify(anthropicPageOnly.models) === JSON.stringify(anthropicExpectedAliases) && anthropicPageOnly.models.every(model => lifecycleFor(model, { days: 30 }).status === 'ok'), 'page-only Anthropic models become active entries with aliases and no dates')
const anthropicPageDates = mergeFeed({ ...anthropicFeed, models: [] }, { deprecations: [{ id: 'claude-test', announced: '2025-01-01', shutdown: '2026-01-01' }], currentIds: ['claude-test'], currentModels: [parseAnthropicModelPage(anthropicIgnoredRows, anthropicTestUrl)], provider: PROVIDERS.anthropic }).feed.models[0]
assert(anthropicPageDates.announced === '2025-01-01' && anthropicPageDates.shutdown === '2026-01-01', 'Anthropic model-page lifecycle rows cannot override deprecation dates')
const missingAnthropicPageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-missing-anthropic-page-'))
try {
  for (const name of ['anthropic-models.json', 'anthropic-deprecations.md', 'anthropic-llms.txt']) fs.copyFileSync(path.join(fixtures, name), path.join(missingAnthropicPageDir, name))
  await strictAssert.rejects(loadProviderSources(PROVIDERS.anthropic, { fixtures: missingAnthropicPageDir, notice: () => {} }), error => error.message.includes(anthropicModelUrls[0]) && error.message.includes('missing or unreadable fixture'))
  const missingPageOut = path.join(missingAnthropicPageDir, 'out')
  const missingPageRun = run(['--provider', 'anthropic', '--fixtures', missingAnthropicPageDir, '--out', missingPageOut])
  assert(missingPageRun.code === 1 && missingPageRun.err.includes(anthropicModelUrls[0]) && !fs.existsSync(missingPageOut), 'a missing Anthropic model-page fixture stops refresh before writing feeds')
} finally {
  fs.rmSync(missingAnthropicPageDir, { recursive: true, force: true })
}

const cohereHtml = fs.readFileSync(path.join(fixtures, 'cohere-deprecations-page.html'), 'utf8')
const cohereMarkdown = fs.readFileSync(path.join(fixtures, 'cohere-deprecations.md'), 'utf8')
const cohereModels = fs.readFileSync(path.join(fixtures, 'cohere-models.json'), 'utf8')
const cohereParsed = parseCohereDeprecations(cohereHtml)
const cohereByDate = date => cohereParsed.filter(record => record.announced === date)
const cohereById = id => cohereParsed.find(record => record.id === id)
const cohereSections = [...cohereHtml.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h[123]\b|$)/gi)]
const coherePage = section => `<h2>Deprecation History</h2>${section}<h2>Other content</h2>`
const cohereRefusal = (html, source) => {
  try {
    parseCohereDeprecations(html, source)
    return ''
  } catch (error) {
    return error.message
  }
}
const cohereReplacementOptions = ['command-r-08-2024', 'command-r-plus-08-2024', 'command-a-03-2025']
const cohereTaskNote = 'Embedding tasks alternatives: embed-english-v3.0, embed-multilingual-v3.0, embed-v4.0; Chat tasks alternatives: command-r7b-12-2024, command-a-03-2025, command-a-reasoning-08-2025'
assert(cohereSections.length === 5 && cohereParsed.length === 12 && ['2026-04-04', '2025-09-15', '2024-12-02'].map(date => cohereByDate(date).length).join() === '5,5,2', 'Cohere parses exactly 12 records across its three model announcement sections')
assert(cohereByDate('2026-04-04').map(record => record.id).join() === 'embed-english-v2.0,embed-english-light-v2.0,embed-multilingual-v2.0,c4ai-aya-expanse-8b,c4ai-aya-vision-8b', 'Cohere retirement ids come only from the immediately following model list')
assert(cohereByDate('2026-04-04').every(record => record.shutdown === '2026-04-04' && record.replacement_note === cohereTaskNote && !record.replacement && !record.replacement_options), 'Cohere preserves task-grouped alternatives as notes with the explicit effective shutdown date')
assert(cohereParsed.every(record => record.source === PROVIDERS.cohere.deprecationsUrl && !record.date_precision), 'Cohere records retain their exact source and never infer date precision')
assert(cohereById('command-r-03-2024')?.aliases?.join() === 'command-r' && cohereById('command-r-plus-04-2024')?.aliases?.join() === 'command-r-plus', 'Cohere attaches both documented command aliases to canonical models')
assert(cohereByDate('2025-09-15').every(record => !Object.hasOwn(record, 'shutdown')), 'Cohere deprecated models have an announcement without an invented shutdown')
assert(cohereByDate('2025-09-15').filter(record => record.id.startsWith('command')).every(record => JSON.stringify(record.replacement_options) === JSON.stringify(cohereReplacementOptions) && !record.replacement), 'Cohere command replacement options preserve the page order')
assert(cohereById('summarize') && !['replacement', 'replacement_options', 'replacement_note'].some(field => Object.hasOwn(cohereById('summarize'), field)), 'Cohere summarize is a model without command replacement guidance')
assert(['/v1/generate', '/v1/summarize', '/v1/classify', '/v1/chat', '/v1/connectors', 'classify', 'rerank', 'connectors', 'search_queries_only', 'Slack App'].every(id => !cohereById(id)), 'Cohere excludes endpoints, fine-tuning capabilities, parameters, and features')
assert(cohereByDate('2024-12-02').map(record => record.id).join() === 'rerank-english-v2.0,rerank-multilingual-v2.0' && cohereByDate('2024-12-02').every(record => record.shutdown === '2025-04-30' && record.replacement === 'rerank-v3.5'), 'Cohere table rows use the heading announcement, shutdown cell, and exact replacement id')
for (const section of cohereSections.filter(section => /2025-03-08|2025-01-31/.test(section[1]))) {
  assert(parseCohereDeprecations(coherePage(section[0])).length === 0, `Cohere skips the non-model section without error: ${section[1]}`)
}
assert(parseCohereDeprecations(`${cohereHtml}<h3>2099-01-01: Outside history</h3><code>ignored-model</code>`).length === 12, 'Cohere scopes parsing to Deprecation History')
assert(cohereRefusal('').includes('page is empty') && cohereRefusal(cohereHtml, 'not-a-url').includes('source is not a URL') && cohereRefusal('<h3>2026-01-01: Unknown</h3>').includes('no Deprecation History'), 'Cohere refuses missing source structure and invalid source URLs')
for (const date of ['2026-4-04', '2026-02-30', '2026–04–04', 'April 4, 2026']) {
  const reason = cohereRefusal(cohereHtml.replace(cohereSections[0][0], cohereSections[0][0].replace('2026-04-04: Embed', `${date}: Embed`)))
  assert(reason.includes(`${date}: Embed`) && /date|YYYY-MM-DD/.test(reason), `Cohere requires a strict real ISO heading date: ${date}`)
}
for (const date of ['February 30, 2026', 'April 2026', 'April 4, 2026 or April 5, 2026', 'April 3, 2026']) {
  const reason = cohereRefusal(cohereHtml.replace('Effective April 4th, 2026,', `Effective ${date},`))
  assert(reason.includes('2026-04-04: Embed') && /date|before announcement/.test(reason), `Cohere refuses invalid or ambiguous retirement dates: ${date}`)
}
const cohereUnknown = cohereHtml.replace('the following models will be retired:', 'these models have changed status:')
assert(cohereRefusal(cohereUnknown).includes('2026-04-04: Embed v2.0, Aya Expanse 8B') && cohereRefusal(cohereUnknown).includes('unrecognised section shape'), 'Cohere refuses a mutated unknown shape and names its heading')
assert(cohereRefusal(cohereHtml.replace('Deprecated Models:', 'Affected Models:')).includes('2025-09-15: Various older command'), 'Cohere refuses an unknown model-list label instead of dropping records')
assert(cohereRefusal(cohereHtml.replace('the following models will be retired:</p>', 'the following models will be retired:</p><p>Unexpected paragraph</p>')).includes('immediately following'), 'Cohere refuses a displaced retirement list')
assert(cohereRefusal(cohereHtml.replace('Deprecated Models:</p>', 'Deprecated Models:</p><p>Unexpected paragraph</p>')).includes('immediately following'), 'Cohere refuses a displaced deprecated-model list')
for (const id of ['/v1/generate', 'invalid/model', 'invalid id', '_invalid']) {
  const reason = cohereRefusal(cohereHtml.replace('<code>embed-english-v2.0</code>', `<code>${id}</code>`))
  assert(reason.includes('2026-04-04: Embed') && reason.includes(id) && /endpoint-or-product-row|invalid-model-id/.test(reason), `Cohere refuses invalid model ids within model lists: ${id}`)
}
assert(cohereRefusal(cohereHtml.replace('<code>command-r</code>', '<code>/v1/summarize</code>')).includes('endpoint-or-product-row'), 'Cohere refuses endpoint-like aliases')
assert(cohereRefusal(cohereHtml.replace('<code>rerank-english-v2.0</code>', '<code>/v1/generate</code>')).includes('row /v1/generate'), 'Cohere refuses endpoint-like table ids and names the row')
assert(cohereRefusal(cohereHtml.replace('<td>2025-04-30</td>', '<td>2025-02-30</td>')).includes('row rerank-english-v2.0'), 'Cohere refuses malformed table dates and names the row')
assert(cohereRefusal(cohereHtml.replace('Shutdown Date</th>', 'Service Shutdown Date</th>')).includes('header: Service Shutdown Date'), 'Cohere refuses an unknown shutdown header by its exact label')
assert(cohereRefusal(cohereHtml.replace('<code>command-r7b-12-2024</code>', '<code>bad/id</code>')).includes('endpoint-or-product-row'), 'Cohere validates task alternative ids')
assert(cohereRefusal(cohereHtml.replace('Chat tasks alternatives:', 'Chat alternatives:')).includes('2026-04-04: Embed'), 'Cohere refuses renamed task groups instead of silently dropping their alternatives')
assert(cohereRefusal(cohereHtml.replace('<code>command-r-plus-08-2024</code>', '<code>bad/id</code>')).includes('endpoint-or-product-row'), 'Cohere validates paragraph replacement ids')
assert(cohereRefusal(cohereHtml.replace('<code>embed-english-v2.0</code>', '<code>embed-english-v2.0</code><code>extra-model</code>')).includes('one exact model id'), 'Cohere refuses ambiguous retirement list items')
const coherePlainModels = cohereHtml.replace('<code>command-light</code>', 'command-light').replace('<code>command</code>', 'command').replace('<code>summarize</code>', 'summarize')
assert(JSON.stringify(parseCohereDeprecations(coherePlainModels)) === JSON.stringify(cohereParsed), 'Cohere accepts plain exact ids under Deprecated Models')
const cohereDuplicateRow = '<tr><td>2025-04-30</td><td><code>rerank-english-v2.0</code></td><td>$1.00 / 1K searches</td><td><code>rerank-v3.5</code></td></tr>'
assert(parseCohereDeprecations(cohereHtml.replace(cohereDuplicateRow, cohereDuplicateRow.repeat(2))).length === 12, 'Cohere collapses identical duplicate rows')
assert(cohereRefusal(cohereHtml.replace(cohereDuplicateRow, cohereDuplicateRow + cohereDuplicateRow.replace('2025-04-30', '2025-05-01'))).includes('conflicting rows for rerank-english-v2.0'), 'Cohere refuses conflicting duplicate lifecycle rows')
const cohereMdParsed = parseCohereDeprecationsMarkdown(cohereMarkdown)
const cohereMdRefusal = (markdown, source) => {
  try {
    parseCohereDeprecationsMarkdown(markdown, source)
    return ''
  } catch (error) {
    return error.message
  }
}
const cohereMdSections = cohereMarkdown.split(/^(?=#{1,3} )/m)
const cohereMdSection = date => cohereMdSections.find(section => section.startsWith(`### ${date}:`))
const cohereMdPage = section => `## Deprecation History\n\n${section}\n## Other content\n`
assert(JSON.stringify(cohereMdParsed) === JSON.stringify(cohereParsed), 'Cohere Markdown yields exactly the records of the recorded HTML page')
assert(cohereMdParsed.every(record => record.source === PROVIDERS.cohere.deprecationsUrl), 'Cohere Markdown records cite the human page')
for (const date of ['2025-03-08', '2025-01-31']) {
  assert(cohereMdSection(date) && parseCohereDeprecationsMarkdown(cohereMdPage(cohereMdSection(date))).length === 0, `Cohere Markdown skips the prose-only section without error: ${date}`)
}
assert(parseCohereDeprecationsMarkdown(`${cohereMarkdown}\n\n### 2099-01-01: Outside history\n\n* \`ignored-model\`\n`).length === 12, 'Cohere Markdown scopes parsing to Deprecation History')
assert(cohereMdRefusal('').includes('page is empty') && cohereMdRefusal(cohereMarkdown, 'not-a-url').includes('source is not a URL') && cohereMdRefusal('### 2026-01-01: Unknown\n\n* `m`\n').includes('no Deprecation History'), 'Cohere Markdown refuses missing source structure and invalid source URLs')
for (const date of ['2026-02-30', '2026-4-04', 'April 4, 2026']) {
  const reason = cohereMdRefusal(cohereMarkdown.replace('### 2026-04-04: Embed', `### ${date}: Embed`))
  assert(reason.includes(`${date}: Embed`) && /date|YYYY-MM-DD/.test(reason), `Cohere Markdown requires a strict real ISO heading date: ${date}`)
}
for (const date of ['April 31st, 2026', 'April 4th, 2026 or May 1st, 2026', 'March 1st, 2026']) {
  const reason = cohereMdRefusal(cohereMarkdown.replace('Effective April 4th, 2026,', `Effective ${date},`))
  assert(reason.includes('2026-04-04: Embed') && /date|before announcement/.test(reason), `Cohere Markdown refuses invalid or ambiguous retirement dates: ${date}`)
}
const cohereMdUnknown = cohereMarkdown.replace('the following models will be retired:', 'these models have changed status:')
assert(cohereMdRefusal(cohereMdUnknown).includes('2026-04-04: Embed v2.0, Aya Expanse 8B') && cohereMdRefusal(cohereMdUnknown).includes('unrecognised section shape'), 'Cohere Markdown refuses a mutated unknown shape and names its heading')
assert(cohereMdRefusal(cohereMarkdown.replace('Deprecated Models:', 'Affected Models:')).includes('2025-09-15: Various older command'), 'Cohere Markdown refuses an unknown model-list label instead of dropping records')
assert(cohereMdRefusal(cohereMarkdown.replace('the following models will be retired:\n', 'the following models will be retired:\n\nUnexpected paragraph\n')).includes('immediately following'), 'Cohere Markdown refuses a displaced retirement list')
assert(cohereMdRefusal(cohereMarkdown.replace('* `embed-english-light-v2.0`', '  * `embed-english-light-v2.0`')).includes('flat model list'), 'Cohere Markdown refuses a nested retirement list')
assert(cohereMdRefusal(cohereMarkdown.replace('* `embed-english-v2.0`', '* `embed-english-v2.0` `extra-model`')).includes('one exact model id'), 'Cohere Markdown refuses ambiguous retirement list items')
for (const id of ['bad/id', 'bad id']) {
  const reason = cohereMdRefusal(cohereMarkdown.replace('`embed-english-v2.0`', `\`${id}\``))
  assert(reason.includes('2026-04-04: Embed') && reason.includes(id) && /endpoint-or-product-row|invalid-model-id/.test(reason), `Cohere Markdown refuses invalid model ids within model lists: ${id}`)
}
assert(cohereMdRefusal(cohereMarkdown.replace('`command-r7b-12-2024`', '`bad/id`')).includes('endpoint-or-product-row'), 'Cohere Markdown validates task alternative ids')
assert(cohereMdRefusal(cohereMarkdown.replace('Chat tasks alternatives:', 'Chat alternatives:')).includes('2026-04-04: Embed'), 'Cohere Markdown refuses renamed task groups instead of silently dropping their alternatives')
assert(cohereMdRefusal(cohereMarkdown.replace('  * `command-r7b-12-2024`', ' * `command-r7b-12-2024`')).includes('ambiguous list item indentation'), 'Cohere Markdown refuses a list item indented between two list levels')
const cohereMdPlainModels = cohereMarkdown.replace('* `command-light`', '* command-light').replace('* `command`\n', '* command\n').replace('* `summarize`', '* summarize')
assert(JSON.stringify(parseCohereDeprecationsMarkdown(cohereMdPlainModels)) === JSON.stringify(cohereParsed), 'Cohere Markdown accepts plain exact ids under Deprecated Models')
const cohereMdTableRow = cohereMarkdown.split('\n').find(line => line.includes('`rerank-english-v2.0`'))
assert(parseCohereDeprecationsMarkdown(cohereMarkdown.replace(cohereMdTableRow, `${cohereMdTableRow}\n${cohereMdTableRow}`)).length === 12, 'Cohere Markdown collapses identical duplicate table rows')
assert(cohereMdRefusal(cohereMarkdown.replace(cohereMdTableRow, `${cohereMdTableRow}\n${cohereMdTableRow.replace('2025-04-30', '2025-05-01')}`)).includes('conflicting rows for rerank-english-v2.0'), 'Cohere Markdown refuses conflicting duplicate table rows')
assert(cohereMdRefusal(cohereMarkdown.replace(cohereMdTableRow, `${cohereMdTableRow} extra |`)).includes('table row has 5 cells; the header has 4'), 'Cohere Markdown refuses a misaligned table row with its line number')
assert(cohereMdRefusal(cohereMarkdown.replace('| Shutdown Date |', '| Service Shutdown Date |')).includes('header: Service Shutdown Date'), 'Cohere Markdown refuses an unknown table header by its exact label')
for (const [label, markdown, pattern] of [
  ['an HTML body', cohereHtml, /^cohere deprecations page is HTML, not Markdown$/],
  ['an HTML table', `${cohereMarkdown}\n<table><tr><td>x</td></tr></table>\n`, /line \d+: HTML table in the Markdown source$/],
  ['a raw HTML block', cohereMarkdown.replace('Deprecated Models:\n', 'Deprecated Models:\n\n<div>\n'), /line \d+: raw HTML block/],
  ['a setext heading', cohereMarkdown.replace('### 2024-12-02: Rerank v2.0\n', '2024-12-02: Rerank v2.0\n---\n'), /line \d+: setext heading/],
  ['an indented code block', cohereMarkdown.replace('Deprecated Models:\n', 'Deprecated Models:\n\n    * `hidden-model`\n'), /line \d+: indented code block/],
  ['tab indentation', cohereMarkdown.replace('  * `embed-v4.0`', '\t* `embed-v4.0`'), /line \d+: tab indentation/],
  ['a heading inside a list item', cohereMarkdown.replace('  * `embed-v4.0`', '  * `embed-v4.0`\n    ### 2026-05-01: Hidden'), /line \d+: unsupported block inside a list item/],
  ['a table inside a list item', cohereMarkdown.replace('* `command`\n', `* \`command\`\n  ${cohereMdTableRow.replace(/[^|]+/g, ' x ')}\n  | --- | --- | --- | --- |\n`), /line \d+: table inside a list item/],
]) {
  assert(pattern.test(cohereMdRefusal(markdown)), `Cohere Markdown refuses ${label}: ${cohereMdRefusal(markdown)}`)
}
assert(/^<p>Effective April 4th, 2026, the following models will be retired:<\/p>\n<ul><li>\n<code>embed-english-v2\.0<\/code>/m.test(cohereMarkdownToHtml(cohereMarkdown)), 'Cohere Markdown renders a paragraph followed directly by its flat list')
assert(cohereMarkdownToHtml(cohereMarkdown).includes('<li>\nEmbedding tasks alternatives:\n<ul><li>\n<code>embed-english-v3.0</code>'), 'Cohere Markdown nests task alternative lists inside their group item')
assert(findFixture(fixtures, 'cohere', 'deprecations').endsWith('cohere-deprecations.md'), 'the Cohere deprecations fixture is the Markdown page')
{
  const requested = []
  const sources = await loadProviderSources(PROVIDERS.cohere, { env: {}, notice: () => {}, fetchImpl: async url => { requested.push(url); return new Response(cohereMarkdown) } })
  assert(
    PROVIDERS.cohere.deprecationsFetchUrl === `${PROVIDERS.cohere.deprecationsUrl}.md`
      && JSON.stringify(requested) === JSON.stringify([PROVIDERS.cohere.deprecationsFetchUrl])
      && JSON.stringify(sources.deprecations) === JSON.stringify(cohereParsed),
    'Cohere deprecations are fetched from the Markdown copy and cite the human page',
  )
}
assert(parseRefreshArgs(['--provider', 'cohere']).providers.join() === 'cohere' && parseRefreshArgs([]).providers.includes('cohere') && usage().includes('mistral|cohere|all'), 'refresh selects Cohere explicitly and through all, and documents its usage')
const cohereNotices = []
const cohereSources = await loadProviderSources(PROVIDERS.cohere, { fixtures, notice: message => cohereNotices.push(message) })
const cohereSeed = { spec: 'model-eol/0.1', publisher: 'cohere', generated: '2026-09-08T00:00:00Z', source: PROVIDERS.cohere.deprecationsUrl, models: [] }
const cohereMerged = mergeFeed(cohereSeed, { ...cohereSources, provider: PROVIDERS.cohere })
assert(cohereSeed.models.length === 0 && cohereMerged.feed.models.length === 15 && cohereMerged.unconfirmedIds.length === 0 && validateFeed(cohereMerged.feed).length === 0, 'Cohere generates a valid feed with 12 dated records and three endpoint-only ids')
assert(cohereMerged.feed.models.find(model => model.id === 'rerank-english-v2.0')?.replacement === 'rerank-v3.5', 'Cohere promotes the exact table replacement when it resolves in the feed')
const cohereWithoutCurrent = mergeFeed(cohereSeed, { deprecations: cohereParsed, provider: PROVIDERS.cohere }).feed
assert(cohereWithoutCurrent.models.filter(model => model.id.startsWith('rerank-')).every(model => !model.replacement && model.replacement_options?.join() === 'rerank-v3.5'), 'Cohere routes unresolved table replacements to options')
const cohereUndated = cohereMerged.feed.models.find(model => model.id === 'cohere-fixture-undated')
assert(cohereUndated && !cohereUndated.announced && !cohereUndated.shutdown && !cohereUndated.is_deprecated && !cohereUndated.endpoints, 'Cohere endpoint-only deprecation flags never invent lifecycle fields or import endpoint metadata')
const cohereNoticeDiff = compareFeeds(cohereMerged.feed, cohereMerged.feed, { undatedDeprecatedIds: cohereSources.undatedDeprecatedIds })
const cohereNoticeLine = 'models endpoint flags `cohere-fixture-undated` as deprecated without a dated announcement'
assert(!cohereNoticeDiff.changed && renderSemanticDiff(cohereNoticeDiff).includes(cohereNoticeLine) && cohereSources.undatedDeprecatedIds.join() === 'cohere-fixture-undated' && cohereNotices.some(message => message.includes('models endpoint flags cohere-fixture-undated as deprecated without a dated announcement')), 'Cohere reports undated endpoint deprecations in notices and diff markdown without causing semantic changes')
const cohereEndpointParsed = parseCohereModelsResponse(cohereModels)
assert(cohereEndpointParsed.ids.length === 4 && cohereEndpointParsed.deprecatedIds.join() === 'command-r-03-2024,cohere-fixture-undated', 'Cohere parses models[].name and is_deprecated with its own endpoint parser')
for (const body of ['{', {}, { data: [] }, { models: [null] }, { models: [{ name: '/v1/generate' }] }, { models: [{ name: 'model-one', is_deprecated: 'true' }] }, { models: [], next_page_token: 42 }, { models: [], next_page_token: '' }, { models: [{ name: 'same' }, { name: 'same' }] }]) {
  let reason = ''
  try { parseCohereModelsResponse(body) } catch (error) { reason = error.message }
  assert(reason.includes('cohere models response'), `Cohere refuses malformed endpoint data: ${JSON.stringify(body)}`)
}

const mistralMarkdown = fs.readFileSync(path.join(fixtures, 'mistral-deprecations.md'), 'utf8')
const mistralModels = fs.readFileSync(path.join(fixtures, 'mistral-models.json'), 'utf8')
const mistralNow = new Date('2026-11-17T12:00:00Z')
const mistralParse = (markdown, source, now = mistralNow) => parseMistralDeprecationsMarkdown(markdown, source, { now })
const mistralParsed = mistralParse(mistralMarkdown)
const mistralLines = mistralMarkdown.split('\n')
const mistralLifecycleHeader = mistralLines.find(line => line.startsWith('| Model | API name | Status | Context | Summary | Deprecation |'))
const mistralOverviewHeader = mistralLines.find(line => line === '| Model | API name | Status | Context | Summary |')
const mistralRows = mistralLines.slice(mistralLines.indexOf(mistralLifecycleHeader) + 2).filter(line => line.startsWith('| ['))
const mistralMediumRow = mistralRows.find(row => row.includes('| `mistral-medium-2508` |'))
const mistralMedium = mistralParsed.records.find(record => record.id === 'mistral-medium-2508')
const mistralExpectedSkipped = [
  { model: 'Mathstral 7B', version: '' },
  { model: 'Mistral Next', version: '' },
  { model: 'Mistral 7B', version: '' },
]
const mistralMutatedRow = (cellIndex, value, row = mistralMediumRow) => row.split('|').map((cell, index) => index === cellIndex + 1 ? ` ${value} ` : cell).join('|')
const mistralWithRow = (cellIndex, value) => mistralMarkdown.replace(mistralMediumRow, mistralMutatedRow(cellIndex, value))
const mistralRefusal = (markdown, source, now) => {
  try {
    mistralParse(markdown, source, now)
    return ''
  } catch (error) {
    return error.message
  }
}
assert(mistralRows.length === 16 && mistralParsed.records.length === 11, 'Mistral Markdown parses 16 lifecycle rows into 11 unique API records')
assert(JSON.stringify(mistralParsed.skipped) === JSON.stringify(mistralExpectedSkipped), 'Mistral Markdown reports exactly the three rows without API ids by model name')
assert(mistralMedium?.announced === '2026-05-22' && mistralMedium?.shutdown === '2026-08-31' && mistralMedium?.replacement_note === 'Mistral lists Mistral Medium 3.5 as the alternative', 'Mistral Markdown takes dates and the replacement link text from their exact cells')
const mistralWritten = mistralParsed.records.find(record => record.id === 'magistral-small-2509')
assert(mistralWritten?.announced === '2026-04-30' && mistralWritten?.shutdown === '2026-07-31', 'Mistral Markdown reads written dates such as April 30, 2026')
assert(!Object.hasOwn(mistralParsed.records.find(record => record.id === 'labs-leanstral-1-5') ?? { replacement_note: 1 }, 'replacement_note'), 'Mistral Markdown adds no note for an empty Replacement cell')
assert(mistralParsed.records.every(record => record.source === PROVIDERS.mistral.deprecationsUrl && !Object.hasOwn(record, 'date_precision') && !Object.hasOwn(record, 'replacement') && !Object.hasOwn(record, 'replacement_options')), 'Mistral emits exact dates and product alternatives only as notes, citing the human page')
assert(!mistralParsed.records.some(record => ['mistral-large-4', 'mistral-ocr-4-1'].includes(record.id)), 'Mistral overview rows never become lifecycle records')
assert(mistralRefusal('').includes('page is empty') && mistralRefusal(mistralMarkdown, 'not-a-url').includes('source is not a URL'), 'Mistral validates the page and source URL')
assert(mistralRefusal(mistralMarkdown, undefined, new Date('invalid')).includes('refresh clock is not a valid date'), 'Mistral refuses an invalid refresh clock')
assert(mistralRefusal(`<!doctype html><html><body>${mistralMarkdown}</body></html>`) === 'mistral deprecations page is HTML, not Markdown', 'Mistral refuses an HTML body served in place of the Markdown copy')
assert(mistralRefusal(`${mistralMarkdown}\n\n<table><tr><th>Model</th></tr></table>\n`).includes('HTML table'), 'Mistral refuses an HTML table inside the Markdown')
const mistralOverviewOnly = mistralLines.slice(0, mistralLines.indexOf('## Deprecated and retired models')).join('\n')
assert(mistralRefusal(mistralOverviewOnly).includes('no recognised model tables with data rows'), 'Mistral refuses a page with no lifecycle table')
assert(mistralRefusal(`${mistralOverviewOnly}\n${mistralLifecycleHeader}\n${'| --- '.repeat(8)}|\n`).includes('no recognised model tables with data rows'), 'Mistral refuses a lifecycle table without rows')
assert(mistralRefusal(mistralMarkdown.replace(/\n(\| Model \| API name \| Status \| Context \| Summary \| Deprecation)/, '\n```\n$1').replace(/\n(\| \[Mistral 7B\]\(\/models\/mistral-7b-0-1\)[^\n]*)/, '\n$1\n```')).includes('no recognised model tables'), 'Mistral ignores a lifecycle table inside fenced code')
for (const header of [
  mistralLifecycleHeader.replace('| Replacement |', '| Alternative |'),
  mistralLifecycleHeader.replace('| Deprecation | Retirement |', '| Retirement | Deprecation |'),
  mistralLifecycleHeader.replace('| API name |', '| API |'),
  '| Model | Version | API | Deprecation Retirement | Alternative | Notes | Extra | More |',
]) {
  assert(mistralRefusal(mistralMarkdown.replace(mistralLifecycleHeader, header)).includes('unrecognised or ambiguous header'), `Mistral refuses an unknown lifecycle header: ${header}`)
}
assert(mistralRefusal(mistralMarkdown.replace(mistralLifecycleHeader, mistralLifecycleHeader.replace('| Replacement |', '| Replacement | Notes |'))).includes('the header has 9'), 'Mistral refuses an added lifecycle column whose rows do not match it')
assert(mistralRefusal(mistralMarkdown.replace(mistralOverviewHeader, '| Model | API name | Status | Context | Retirement |')).includes('unrecognised or ambiguous header'), 'Mistral refuses an overview table that gains a lifecycle label')
assert(mistralRefusal(mistralMarkdown.replace(mistralMediumRow, mistralMediumRow.replace('| Deprecated |', '|'))).includes('the header has 8'), 'Mistral refuses a row with a missing cell instead of shifting its dates')
for (const status of ['Legacy', 'Active', 'GA', '']) {
  const reason = mistralRefusal(mistralWithRow(2, status))
  assert(reason.includes('mistral-medium-2508') && reason.includes('unrecognised status'), `Mistral refuses lifecycle status ${status || '(empty)'} and names the row`)
}
assert(mistralParse(mistralWithRow(2, 'Retired')).records.find(record => record.id === 'mistral-medium-2508')?.shutdown === '2026-08-31', 'Mistral accepts a Retired row whose retirement date has passed')
assert(mistralRefusal(mistralWithRow(2, 'Retired'), undefined, new Date('2026-08-30T23:00:00Z')).includes('is Retired but its retirement date 2026-08-31 is after 2026-08-30'), 'Mistral refuses a Retired row whose retirement date is still ahead')
const mistralOverviewRow = mistralLines.find(line => line.includes('| `mistral-large-4` |'))
for (const status of ['Deprecated', 'Retired']) {
  assert(mistralRefusal(mistralMarkdown.replace(mistralOverviewRow, mistralOverviewRow.replace('| GA |', `| ${status} |`))).includes(`overview lists mistral-large-4 as ${status}`), `Mistral refuses an overview row marked ${status}, which has no dates`)
}
for (const [cell, value] of [
  [5, ''], [6, ''], [5, '-'], [5, '5/22/2026'], [5, '2026-5-22'], [5, '2026-02-30'], [6, '2026-08-31 2026-09-01'],
  [5, 'May 22, 2026 (tentative)'], [6, 'Smarch 31, 2026'], [6, 'September 31, 2026'], [5, '22 May 2026'], [6, '2026-05-21'],
]) {
  const reason = mistralRefusal(mistralWithRow(cell, value))
  assert(reason.includes('mistral-medium-2508') && /date|announcement/.test(reason), `Mistral refuses ${cell === 5 ? 'deprecation' : 'retirement'} cell ${value || '(empty)'} and names the row`)
}
const mistralLeap = mistralMarkdown.replace(mistralMediumRow, mistralMutatedRow(6, 'February 29, 2024', mistralMutatedRow(5, '2024-02-29')))
assert(mistralParse(mistralLeap).records.find(record => record.id === 'mistral-medium-2508')?.shutdown === '2024-02-29', 'Mistral accepts real leap days, mixed date styles, and same-day retirement')
const mistralInvalidId = mistralRefusal(mistralWithRow(1, '`invalid/api id`'))
assert(mistralInvalidId.includes('invalid-model-id') && mistralInvalidId.includes('invalid/api id'), 'Mistral refuses an invalid API id and names the row')
for (const id of ['voxtral-mini-2507', 'open-mistral-7b']) {
  assert(mistralRows.filter(row => row.includes(`| \`${id}\` |`)).length === 2 && mistralParsed.records.filter(record => record.id === id).length === 1, `Mistral collapses identical source rows for ${id}`)
}
for (const [cell, value] of [[5, '2026-05-21'], [6, '2026-09-01'], [7, '[Another alternative](/models/another)']]) {
  const duplicate = mistralMarkdown.replace(mistralMediumRow, `${mistralMediumRow}\n${mistralMutatedRow(cell, value)}`)
  assert(mistralRefusal(duplicate).includes('conflicting rows for mistral-medium-2508'), `Mistral refuses duplicate ids with conflicting dates or alternatives: ${value}`)
}
assert(parseRefreshArgs(['--provider', 'mistral']).providers.join() === 'mistral' && parseRefreshArgs([]).providers.includes('mistral') && usage().includes('google|mistral|cohere|all'), 'refresh selects Mistral explicitly and through all, and documents it in usage')
assert(findFixture(fixtures, 'mistral', 'deprecations').endsWith('mistral-deprecations.md'), 'the Mistral deprecations fixture is the Markdown page')
const mistralNotices = []
const mistralSources = await loadProviderSources(PROVIDERS.mistral, { fixtures, notice: message => mistralNotices.push(message) })
assert(mistralNotices.filter(message => message.startsWith('notice: mistral skipped ')).length === 3 && mistralExpectedSkipped.every(row => mistralNotices.some(message => message.includes(row.model) && message.includes('version not listed'))), 'Mistral emits one named notice for each skipped row')
{
  const requested = []
  const sources = await loadProviderSources(PROVIDERS.mistral, { env: {}, notice: () => {}, now: mistralNow, fetchImpl: async url => { requested.push(url); return new Response(mistralMarkdown) } })
  assert(
    PROVIDERS.mistral.deprecationsFetchUrl === `${PROVIDERS.mistral.deprecationsUrl}.md`
      && JSON.stringify(requested) === JSON.stringify([PROVIDERS.mistral.deprecationsFetchUrl])
      && JSON.stringify(sources.deprecations) === JSON.stringify(mistralParsed.records)
      && sources.deprecations.every(record => record.source === PROVIDERS.mistral.deprecationsUrl),
    'Mistral deprecations are fetched from the Markdown copy and cite the human page',
  )
}
assert(parseModelsResponse(mistralModels, 'mistral').length === 3 && !parseModelsResponse(mistralModels, 'mistral').includes('mistral-medium-latest'), 'the generic models parser returns canonical ids without flattening endpoint aliases')
const mistralSeed = { spec: 'model-eol/0.1', publisher: 'mistral', generated: '2026-09-08T00:00:00Z', source: PROVIDERS.mistral.deprecationsUrl, models: [] }
const mistralMerged = mergeFeed(mistralSeed, { ...mistralSources, provider: PROVIDERS.mistral })
assert(mistralSeed.models.length === 0 && mistralMerged.feed.models.length === 11 && mistralMerged.unconfirmedIds.length === 0 && validateFeed(mistralMerged.feed).length === 0, 'Mistral generates a valid feed from an empty committed seed')
assert(mistralMerged.feed.models.find(model => model.id === 'mistral-medium-2508')?.aliases?.includes('mistral-medium-latest') && !mistralMerged.feed.models.some(model => model.id === 'mistral-medium-latest'), 'Mistral attaches endpoint aliases to the dated canonical record')
const mistralAliasSeed = { ...mistralSeed, models: [{ id: 'mistral-medium-latest' }, { id: 'mistral-medium-2508' }] }
let mistralCanonicalAliasReason = ''
try { mergeFeed(mistralAliasSeed, { ...mistralSources, provider: PROVIDERS.mistral }) } catch (error) { mistralCanonicalAliasReason = error.message }
assert(mistralCanonicalAliasReason.includes('endpoint alias mistral-medium-latest') && mistralCanonicalAliasReason.includes('canonical model id') && mistralAliasSeed.models.length === 2, 'Mistral refuses endpoint aliases that would absorb a committed canonical entry')
const mistralSkippedDiff = compareFeeds(mistralMerged.feed, mistralMerged.feed, { skipped: mistralSources.skipped })
const mistralSkippedMarkdown = renderSemanticDiff(mistralSkippedDiff)
assert(!mistralSkippedDiff.changed && mistralSkippedMarkdown.includes('## Rows without an API id') && mistralExpectedSkipped.every(row => mistralSkippedMarkdown.includes(`\`${row.model}\` - version: \`${row.version || 'not set'}\``)), 'skipped Mistral rows appear in the semantic diff without becoming material changes')

const reviewTest = (name, check) => {
  try {
    check()
    assert(true, name)
  } catch (error) {
    assert(false, `${name}: ${error.message}`)
  }
}
const cohereReviewTable = (headers, cells) => `<table><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr><tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr></table>`
const cohereReviewHeaders = ['Shutdown Date', 'Deprecated Model', 'Recommended Replacement']
const cohereReviewSection = (table, date = '2026-09-01') => `<h3>${date}: Review retirement</h3>${table}`
const cohereReviewRow = replacement => cohereReviewTable(cohereReviewHeaders, ['2026-10-01', '<code>command-r-03-2024</code>', replacement])
for (const [headers, cells] of [
  [['Fine-tuning Shutdown Date', ...cohereReviewHeaders], ['2026-09-15', '2026-10-01', '<code>command-r-03-2024</code>', '<code>command-a-03-2025</code>']],
  [['Shutdown Date', 'Deprecated Model Price', 'Deprecated Model', 'Recommended Replacement'], ['2026-10-01', '1.00', '<code>command-r-03-2024</code>', '<code>command-a-03-2025</code>']],
]) {
  reviewTest(`Review F3: Cohere refuses adversarial header ${headers.join(' | ')}`, () => {
    const reason = cohereRefusal(coherePage(cohereReviewSection(cohereReviewTable(headers, cells))))
    strictAssert.match(reason, /header/i)
    strictAssert.ok(headers.every(header => reason.includes(header)))
  })
}
for (const label of [...cohereReviewHeaders, 'Deprecated Model Price', 'Unexpected Column']) {
  reviewTest(`Review F3: Cohere refuses duplicate or unknown column ${label}`, () => {
    const headers = ['Shutdown Date', 'Deprecated Model', 'Deprecated Model Price', 'Recommended Replacement', label]
    strictAssert.match(cohereRefusal(coherePage(cohereReviewSection(cohereReviewTable(headers, ['2026-10-01', '<code>command-r-03-2024</code>', '1.00', '<code>command-a-03-2025</code>', 'extra'])))), /header/i)
  })
}
reviewTest('Review F3: Cohere accepts trimmed case-insensitive labels and an optional price column', () => {
  const table = cohereReviewTable([' shutdown date ', 'DEPRECATED MODEL', ' deprecated model PRICE ', 'Recommended Replacement'], ['2026-10-01', '<code>command-r-03-2024</code>', '1.00', '<code>command-a-03-2025</code>'])
  strictAssert.equal(parseCohereDeprecations(coherePage(cohereReviewSection(table)))[0].id, 'command-r-03-2024')
})
for (const [cell, note, options] of [
  ['<code>rerank-new</code> only after changing the request format', 'rerank-new only after changing the request format', ['rerank-new']],
  ['Do not use <code>rerank-new</code>; contact support', 'Do not use rerank-new ; contact support', ['rerank-new']],
  ['Contact support for rerank-new', 'Contact support for rerank-new', undefined],
  ['rerank-new', 'rerank-new', undefined],
  ['<code>rerank-new</code> or <code>rerank-other</code> after migration', 'rerank-new or rerank-other after migration', ['rerank-new', 'rerank-other']],
]) {
  reviewTest(`Review F4: Cohere keeps conditional or plain replacement text advisory: ${cell}`, () => {
    const records = parseCohereDeprecations(coherePage(cohereReviewSection(cohereReviewRow(cell))))
    const feed = mergeFeed({ ...cohereSeed, models: [{ id: 'rerank-new' }, { id: 'rerank-other' }] }, { deprecations: records, provider: PROVIDERS.cohere }).feed
    const model = feed.models.find(model => model.id === 'command-r-03-2024')
    strictAssert.equal(model.replacement, undefined)
    strictAssert.deepEqual(model.replacement_options, options)
    strictAssert.equal(model.replacement_note, note)
    strictAssert.deepEqual(validateFeed(feed), [])
  })
}
reviewTest('Review F4: Cohere promotes only a standalone code id that resolves in the feed', () => {
  const records = parseCohereDeprecations(coherePage(cohereReviewSection(cohereReviewRow('<code>rerank-new</code>'))))
  for (const models of [[], [{ id: 'rerank-new' }]]) {
    const model = mergeFeed({ ...cohereSeed, models }, { deprecations: records, provider: PROVIDERS.cohere }).feed.models.find(model => model.id === 'command-r-03-2024')
    strictAssert.equal(model.replacement, models.length ? 'rerank-new' : undefined)
    strictAssert.deepEqual(model.replacement_options, models.length ? undefined : ['rerank-new'])
    strictAssert.equal(model.replacement_note, undefined)
  }
})
reviewTest('Review F7a: Cohere parses a recognised table without code markup', () => {
  const table = cohereReviewTable(cohereReviewHeaders, ['2026-10-01', 'command-r-03-2024', 'command-a-03-2025'])
  strictAssert.deepEqual(parseCohereDeprecations(coherePage(cohereReviewSection(table))), [{
    id: 'command-r-03-2024', announced: '2026-09-01', shutdown: '2026-10-01', source: PROVIDERS.cohere.deprecationsUrl, replacement_note: 'command-a-03-2025',
  }])
})
const cohereEarlierDeprecation = cohereSections.find(section => section[1].includes('2025-09-15'))[0]
reviewTest('Review F7b: Cohere refuses an unaccounted shutdown paragraph, even for a listed id', () => {
  const page = coherePage(`${cohereEarlierDeprecation}<p>We will shut down <code>command-r-plus-04-2024</code> on October 1, 2026.</p>`)
  strictAssert.match(cohereRefusal(page), /2025-09-15: Various older command.*unrecognised code ids/)
})
const cohereLaterShutdown = cohereReviewSection(cohereReviewRow('<code>command-a-03-2025</code>'))
const cohereAliasShutdown = cohereLaterShutdown.replace('command-r-03-2024', 'command-r')
reviewTest('Second pass F9: Cohere merges a later command-r shutdown into its documented canonical ID', () => {
  const records = parseCohereDeprecations(coherePage(cohereEarlierDeprecation + cohereAliasShutdown))
  strictAssert.deepEqual(records.find(record => record.id === 'command-r-03-2024'), {
    id: 'command-r-03-2024', announced: '2025-09-15', shutdown: '2026-10-01',
    source: PROVIDERS.cohere.deprecationsUrl, aliases: ['command-r'], replacement: 'command-a-03-2025',
  })
  strictAssert.ok(!records.some(record => record.id === 'command-r'))
})
reviewTest('Third pass F3: Cohere resolves command-r with newest sections first and produces identical records in reverse order', () => {
  const newestFirst = parseCohereDeprecations(coherePage(cohereAliasShutdown + cohereEarlierDeprecation))
  const oldestFirst = parseCohereDeprecations(coherePage(cohereEarlierDeprecation + cohereAliasShutdown))
  strictAssert.deepEqual(newestFirst, oldestFirst)
  strictAssert.deepEqual(newestFirst.find(record => record.id === 'command-r-03-2024'), {
    id: 'command-r-03-2024', announced: '2025-09-15', shutdown: '2026-10-01',
    source: PROVIDERS.cohere.deprecationsUrl, aliases: ['command-r'], replacement: 'command-a-03-2025',
  })
  strictAssert.ok(!newestFirst.some(record => record.id === 'command-r'))
})
reviewTest('Third pass F3: Cohere builds identities before merging even when the alias definition has a later heading date', () => {
  const definition = cohereEarlierDeprecation.replace('2025-09-15:', '2026-09-02:')
  const records = parseCohereDeprecations(coherePage(cohereAliasShutdown + definition))
  strictAssert.deepEqual(records, parseCohereDeprecations(coherePage(definition + cohereAliasShutdown)))
  strictAssert.deepEqual(records.find(record => record.id === 'command-r-03-2024'), {
    id: 'command-r-03-2024', announced: '2026-09-01', shutdown: '2026-10-01',
    source: PROVIDERS.cohere.deprecationsUrl, replacement: 'command-a-03-2025', aliases: ['command-r'],
  })
  strictAssert.ok(!records.some(record => record.id === 'command-r'))
})
reviewTest('Second pass F9: Cohere refuses conflicting shutdown dates through a documented alias', () => {
  const conflict = cohereAliasShutdown.replace('2026-09-01:', '2026-09-02:').replace('2026-10-01', '2026-11-01')
  strictAssert.match(cohereRefusal(coherePage(cohereEarlierDeprecation + cohereLaterShutdown + conflict)), /conflicting rows for command-r-03-2024/)
})
reviewTest('Second pass F9: Cohere refuses an alias claimed by two canonical records', () => {
  const ambiguous = '<h3>2025-09-15: Shared alias</h3><p>Deprecated Models:</p><ul><li><code>command-r-03-2024</code> (and the alias <code>command-r</code>)</li><li><code>command-r-08-2024</code> (and the alias <code>command-r</code>)</li></ul>'
  strictAssert.match(cohereRefusal(coherePage(ambiguous + cohereAliasShutdown)), /ambiguous id or alias: command-r/)
})
for (const sections of [[cohereLaterShutdown, cohereEarlierDeprecation], [cohereEarlierDeprecation, cohereLaterShutdown]]) {
  reviewTest(`Review F10: Cohere combines deprecation and later shutdown in ${sections[0] === cohereLaterShutdown ? 'reverse' : 'chronological'} order`, () => {
    const model = parseCohereDeprecations(coherePage(sections.join(''))).find(record => record.id === 'command-r-03-2024')
    strictAssert.deepEqual(model, { id: 'command-r-03-2024', announced: '2025-09-15', shutdown: '2026-10-01', source: PROVIDERS.cohere.deprecationsUrl, aliases: ['command-r'], replacement: 'command-a-03-2025' })
  })
}
reviewTest('Review F10: Cohere still refuses conflicting shutdown dates across sections', () => {
  const conflicting = cohereLaterShutdown.replace('2026-09-01:', '2026-09-02:').replace('2026-10-01', '2026-11-01')
  strictAssert.match(cohereRefusal(coherePage(cohereLaterShutdown + cohereEarlierDeprecation + conflicting)), /2026-09-02: Review retirement.*conflicting rows for command-r-03-2024/)
})
const cohereReplacementUpdate = '<h3>2026-08-01: Replacement update</h3><p>Deprecated Models:</p><ul><li><code>command-r-03-2024</code></li></ul><p>For command model replacements, we recommend <code>command-new</code>.</p>'
for (const sections of [[cohereEarlierDeprecation, cohereReplacementUpdate], [cohereReplacementUpdate, cohereEarlierDeprecation]]) {
  reviewTest('Review F10: Cohere uses the latest undated replacement independently of announcement order', () => {
    const model = parseCohereDeprecations(coherePage(sections.join(''))).find(record => record.id === 'command-r-03-2024')
    strictAssert.equal(model.announced, '2025-09-15')
    strictAssert.equal(model.shutdown, undefined)
    strictAssert.deepEqual(model.replacement_options, ['command-new'])
    strictAssert.deepEqual(model.aliases, ['command-r'])
  })
}
reviewTest('Review F10: A shutdown section without replacement guidance clears earlier options', () => {
  const shutdown = cohereReviewSection(cohereReviewRow(''))
  const model = parseCohereDeprecations(coherePage(cohereEarlierDeprecation + shutdown + cohereReplacementUpdate)).find(record => record.id === 'command-r-03-2024')
  strictAssert.equal(model.shutdown, '2026-10-01')
  strictAssert.ok(!['replacement', 'replacement_options', 'replacement_note'].some(field => Object.hasOwn(model, field)))
})
const mistralTable = (rows, header = mistralLifecycleHeader) => `${header}\n${'| --- '.repeat(header.split('|').length - 2)}|\n${rows.join('\n')}\n`
const mistralSampleRow = '| [Sample](/models/sample) | `sample-model` | Deprecated | 32k | A sample model. | 2026-05-22 | 2026-08-31 | [Sample 2](/models/sample-2) |'
const mistralConfirmingRow = '| [Mistral Medium 3.1](/models/mistral-medium-3-1-25-08) | `mistral-medium-2508` | Deprecated | 128k | A sample model. | 2026-05-22 | 2026-08-31 | [Mistral Medium 3.5](/models/mistral-medium-3-5-26-04) |'
reviewTest('Markdown source: Mistral refuses a lifecycle row cut off from its table by a blank line', () => {
  strictAssert.match(mistralRefusal(mistralMarkdown.replace(`\n${mistralMediumRow}`, `\n\n${mistralMediumRow}`)), /table row outside a table/)
})
reviewTest('Markdown source: Mistral reads a second lifecycle table and merges identical rows across tables', () => {
  strictAssert.deepEqual(mistralParse(`${mistralMarkdown}\n\n## More\n\n${mistralTable([mistralSampleRow, mistralMediumRow])}`).records, [...mistralParsed.records, { id: 'sample-model', announced: '2026-05-22', shutdown: '2026-08-31', source: PROVIDERS.mistral.deprecationsUrl, replacement_note: 'Mistral lists Sample 2 as the alternative' }])
})
const mistralRetirementGuide = '| Mistral X | `mistral-x` | Deprecated | 32k | A sample model. | 2026-01-01 | 2026-12-01 | See retirement guide |'
reviewTest('Third pass F4: Mistral preserves plain retirement guidance as a note', () => {
  strictAssert.deepEqual(mistralParse(mistralTable([mistralRetirementGuide])), {
    records: [{ id: 'mistral-x', announced: '2026-01-01', shutdown: '2026-12-01', source: PROVIDERS.mistral.deprecationsUrl, replacement_note: 'Mistral lists See retirement guide as the alternative' }],
    skipped: [],
  })
})
reviewTest('Third pass F4: Mistral ignores lifecycle words in the rows of an unrelated table', () => {
  const unrelated = mistralTable(['| Mistral X | See retirement guide |'], '| Feature | Supported |')
  strictAssert.deepEqual(mistralParse(`${mistralMarkdown}\n\n${unrelated}`), mistralParsed)
})
reviewTest('Review F9: Mistral refuses a drifted lifecycle header alongside valid tables and names it', () => {
  const drifted = mistralLifecycleHeader.replace('| Deprecation | Retirement |', '| Deprecation date | Retirement date |')
  const reason = mistralRefusal(`${mistralMarkdown}\n\n${mistralTable([mistralSampleRow], drifted)}`)
  strictAssert.match(reason, /unrecognised or ambiguous header/)
  strictAssert.ok(reason.includes('Deprecation date | Retirement date'))
})
reviewTest('Review F9: Mistral requires the exact lifecycle header set', () => {
  for (const labels of [
    ['Model', 'API name'],
    ['Retirement date'],
    ['Model', 'Version', 'API', 'Deprecation Retirement', 'Alternative'],
    ['Model', 'API name', 'Status', 'Context', 'Summary', 'Deprecation', 'Retirement', 'Replacement', 'Feature'],
    ['Model', 'API name', 'Status', 'Context', 'Summary', 'Deprecation', 'Retirement', 'Replacement', 'Model'],
  ]) {
    const header = `| ${labels.join(' | ')} |`
    strictAssert.match(mistralRefusal(`${mistralMarkdown}\n\n${mistralTable([`|${' x |'.repeat(labels.length)}`], header)}`), /header/i, header)
  }
})
reviewTest('Review F9: Mistral skips unrelated headers', () => {
  strictAssert.deepEqual(mistralParse(`${mistralMarkdown}\n\n${mistralTable(['| A | Yes |'], '| Feature | Supported |')}`), mistralParsed)
})
for (const canonical of ['mistral-medium-2608', 'mistral-medium-2508']) {
  const sources = await loadProviderSources(PROVIDERS.mistral, {
    env: { MISTRAL_API_KEY: 'fixture-key' }, notice: () => {},
    fetchImpl: async url => ({ ok: true, text: async () => url === PROVIDERS.mistral.modelsUrl
      ? JSON.stringify({ object: 'list', data: [{ id: canonical, aliases: ['mistral-medium-latest'] }] })
      : mistralTable(canonical === 'mistral-medium-2508' ? [mistralSampleRow, mistralConfirmingRow] : [mistralSampleRow]) }),
  })
  for (const fields of [
    {},
    { announced: '2026-05-22', replacement: 'mistral-next', replacement_note: 'Preserve guidance' },
    { announced: '2026-05-22', replacement_options: ['mistral-next'], replacement_note: 'Preserve guidance' },
  ]) {
    reviewTest(`Review F1: Mistral preserves committed lifecycle when endpoint alias is ${canonical === 'mistral-medium-2608' ? 'moved' : 'unchanged'} (${fields.replacement ? 'replacement' : fields.replacement_options ? 'options' : 'exact review'} record)`, () => {
      const old = { id: 'mistral-medium-2508', aliases: ['mistral-medium-latest'], shutdown: '2026-08-31', ...fields }
      const seed = { ...mistralSeed, models: [old, { id: 'mistral-next' }] }
      const original = structuredClone(seed)
      const merged = mergeFeed(seed, { ...sources, provider: PROVIDERS.mistral })
      const kept = merged.feed.models.find(model => model.id === old.id)
      if (canonical === old.id) {
        strictAssert.equal(kept.shutdown, '2026-08-31')
        strictAssert.equal(kept.announced, '2026-05-22')
      } else {
        const expected = { ...old }
        delete expected.aliases
        strictAssert.deepEqual(kept, expected)
      }
      strictAssert.deepEqual(merged.feed.models.find(model => model.id === canonical).aliases, ['mistral-medium-latest'])
      strictAssert.ok(!merged.feed.models.some(model => model.aliases?.includes(old.id)))
      strictAssert.deepEqual(validateFeed(merged.feed), [])
      strictAssert.deepEqual(seed, original)
      const diff = compareFeeds(seed, merged.feed)
      strictAssert.deepEqual(diff.shutdownChanges, [])
      if (canonical !== old.id) strictAssert.deepEqual(diff.replacementChanges, [])
      strictAssert.equal(diff.added.some(model => model.id === 'mistral-medium-2608'), canonical !== old.id)
    })
  }
  reviewTest('Review F1: Mistral endpoint alias records remain separate from deprecations', () => {
    strictAssert.deepEqual(sources.currentModels, [{ id: canonical, aliases: ['mistral-medium-latest'] }])
    strictAssert.deepEqual(sources.deprecations.map(record => record.id), canonical === 'mistral-medium-2508' ? ['sample-model', 'mistral-medium-2508'] : ['sample-model'])
  })
}
const openaiById = new Map(openaiEntries.map(entry => [entry.id, entry]))
const anthropicStatusColumns = ['API model name', 'Current state', 'Deprecated', 'Tentative retirement date']
const anthropicAnnouncementColumns = ['Retirement date', 'Deprecated model', 'Recommended replacement']
const anthropicStatusHeader = '<tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr>'
const anthropicStatusTable = (id, state, deprecated, retirement) => mdTable(anthropicStatusColumns, [[id, state, deprecated, retirement]])
const anthropicAnnouncementTable = (id, announced, shutdown, aliases = []) => `\n### ${announced}: Model retirement\n${mdTable(anthropicAnnouncementColumns, [[shutdown, [id, ...aliases].map(token => `\`${token}\``).join(' / '), '`claude-next`']])}`

let endpointLookalikeReason = ''
try {
  parseAnthropicDeprecations(endpointLookalikeMarkdown)
} catch (error) {
  endpointLookalikeReason = error.message
}
assert(endpointLookalikeReason.includes('missing required columns') && endpointLookalikeReason.includes('api model name'), 'Anthropic rejects an endpoint lookalike carrying the status retirement header')

const mixedEndpointMarkdown = `### 2026-01-01: Endpoint notice\n${mdTable(['Retirement date', 'Deprecated endpoint', 'Recommended replacement'], [['2027-01-01', '`/v1/old`', '`/v1/new`']])}### 2025-01-01: Model notice\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-mixed`', '`claude-next`']])}${anthropicStatusTable('claude-mixed', 'Retired', '2025-01-01', '2027-01-01')}`
const mixedEndpointEntries = parseAnthropicDeprecations(mixedEndpointMarkdown)
assert(mixedEndpointEntries.length === 1 && mixedEndpointEntries[0].id === 'claude-mixed', 'generic deprecation parser skips endpoint tables while retaining model tables')

const googleEndpointOnlyHtml = '<table><tr><th>Retirement date</th><th>Deprecated endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table>'
const mixedGoogleEndpointHtml = `${googleEndpointOnlyHtml}<table><tr><th>Shutdown date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>google-mixed</code></td><td><code>google-next</code></td></tr></table>`
const mixedGoogleEndpointEntries = parseGoogleDeprecationsHtml(mixedGoogleEndpointHtml)
assert(mixedGoogleEndpointEntries.length === 1 && mixedGoogleEndpointEntries[0].id === 'google-mixed', 'Google deprecation parser skips endpoint tables while retaining model tables')
let googleEndpointLookalikeReason = ''
try {
  parseGoogleDeprecationsHtml(googleEndpointOnlyHtml)
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
  parseGoogleDeprecationsHtml(googleCombinedEndpointHtml)
} catch (error) {
  googleCombinedEndpointReason = error.message
}
assert(googleCombinedEndpointReason.includes('endpoint-or-product-deprecation-table') && !googleCombinedEndpointReason.includes('/v1/old'), 'Google combined model and endpoint headers are refused without ingesting the row')

const googleInvalidRowHtml = '<table><tr><th>Shutdown date</th><th>Model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table>'
let googleInvalidRowReason = ''
try {
  parseGoogleDeprecationsHtml(googleInvalidRowHtml)
} catch (error) {
  googleInvalidRowReason = error.message
}
assert(googleInvalidRowReason.includes('refused row') && googleInvalidRowReason.includes('endpoint-or-product-row'), 'Google model rows enforce the model identifier grammar')

const anthropicApiModelMarkdown = `## 2026-01-01\n${mdTable(['Retirement date', 'API model name', 'Recommended replacement'], [['2027-01-01', '`claude-api-model`', '`claude-next`']])}${anthropicStatusTable('claude-api-model', 'Retired', '2026-01-01', '2027-01-01')}`
const anthropicApiModel = parseAnthropicDeprecations(anthropicApiModelMarkdown)
assert(anthropicApiModel.length === 1 && anthropicApiModel[0].id === 'claude-api-model' && anthropicApiModel[0].replacement === 'claude-next', 'Anthropic announcement tables keep their recommended replacement column')

const ambiguousAnnouncementMarkdown = `# Model deprecations\n\n## Announcement context\n\nNotified 2025-01-01; retirement 2026-01-01.\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-ambiguous`', '`claude-next`']])}`
let ambiguousAnnouncementReason = ''
try {
  parseAnthropicDeprecations(ambiguousAnnouncementMarkdown)
} catch (error) {
  ambiguousAnnouncementReason = error.message
}
assert(ambiguousAnnouncementReason.includes('ambiguous-announcement-date'), 'generic deprecation parser rejects ambiguous announcement context')

const anthropicStatusEdgeMarkdown = mdTable(anthropicStatusColumns, [
  ['claude-no-tentative-date', 'Active', 'N/A', 'N/A'],
  ['claude-empty-tentative-date', 'Active', 'N/A', ''],
  ['claude-retired-without-announcement', 'Retired', 'June 1, 2026', 'August 1, 2026'],
  ['claude-deprecated-without-retirement', 'Deprecated', 'July 1, 2026', 'N/A'],
])
const anthropicStatusEdges = parseAnthropicDeprecations(anthropicStatusEdgeMarkdown)
const anthropicNoDates = anthropicStatusEdges.filter(entry => entry.id === 'claude-no-tentative-date' || entry.id === 'claude-empty-tentative-date')
assert(anthropicNoDates.length === 2 && anthropicNoDates.every(entry => entry.shutdown === undefined && entry.date_precision === undefined), 'Anthropic treats active N/A and empty retirement dates as no date')
const anthropicRetiredStatus = anthropicStatusEdges.find(entry => entry.id === 'claude-retired-without-announcement')
assert(anthropicRetiredStatus?.announced === '2026-06-01' && anthropicRetiredStatus.shutdown === '2026-08-01' && anthropicRetiredStatus.date_precision === undefined, 'Anthropic converts an unmatched retired status row into an exact lifecycle record')
const anthropicDeprecatedStatus = anthropicStatusEdges.find(entry => entry.id === 'claude-deprecated-without-retirement')
assert(anthropicDeprecatedStatus?.announced === '2026-07-01' && anthropicDeprecatedStatus.shutdown === undefined, 'Anthropic converts a deprecated N/A status row into an announced-only record')

const anthropicStatusError = (markdown, parse = parseAnthropicDeprecations) => {
  try {
    parse(markdown)
    return ''
  } catch (error) {
    return error.message
  }
}
const anthropicHtmlStatusError = html => anthropicStatusError(html, parseAnthropicDeprecationsHtml)
const activeAnnouncementConflictId = 'claude-active-announcement-conflict'
const activeAnnouncementConflictReason = anthropicStatusError(`${anthropicAnnouncementTable(activeAnnouncementConflictId, '2026-01-01', '2027-01-01')}${anthropicStatusTable(activeAnnouncementConflictId, 'Active', 'N/A', 'Not sooner than September 1, 2028')}`)
assert(activeAnnouncementConflictReason.includes(activeAnnouncementConflictId) && activeAnnouncementConflictReason.includes('Active') && activeAnnouncementConflictReason.includes('2027-01-01'), 'Anthropic rejects an active status row that conflicts with an announcement')
const shutdownConflictId = 'claude-shutdown-announcement-conflict'
const shutdownConflictReason = anthropicStatusError(`${anthropicAnnouncementTable(shutdownConflictId, '2026-01-01', '2027-01-01')}${anthropicStatusTable(shutdownConflictId, 'Deprecated', '2026-01-01', '2027-02-01')}`)
assert(shutdownConflictReason.includes(shutdownConflictId) && shutdownConflictReason.includes('2027-01-01') && shutdownConflictReason.includes('2027-02-01'), 'Anthropic rejects a status shutdown that differs from its announcement')
const matchingAnnouncementId = 'claude-matching-announcement-status'
const matchingAnnouncement = parseAnthropicDeprecations(`${anthropicAnnouncementTable(matchingAnnouncementId, '2026-01-01', '2027-01-01')}${anthropicStatusTable(matchingAnnouncementId, 'Deprecated', '2026-01-01', '2027-01-01')}`)
assert(matchingAnnouncement.length === 1 && matchingAnnouncement[0].id === matchingAnnouncementId && matchingAnnouncement[0].replacement === 'claude-next', 'Anthropic skips a matching deprecated status row and keeps its announcement')
const aliasAnnouncementId = 'claude-canonical-announcement'
const aliasStatusId = 'claude-alias-announcement'
const aliasActiveConflictReason = anthropicStatusError(`${anthropicAnnouncementTable(aliasAnnouncementId, '2026-01-01', '2027-01-01', [aliasStatusId])}${anthropicStatusTable(aliasStatusId, 'Active', 'N/A', 'Not sooner than January 1, 2028')}`)
assert(aliasActiveConflictReason.includes(aliasStatusId) && aliasActiveConflictReason.includes('Active') && aliasActiveConflictReason.includes('2027-01-01'), 'Anthropic announcement aliases participate in active status conflict detection')
const matchingAliasAnnouncement = parseAnthropicDeprecations(`${anthropicAnnouncementTable(aliasAnnouncementId, '2026-01-01', '2027-01-01', [aliasStatusId, aliasStatusId])}${anthropicStatusTable(aliasStatusId, 'Deprecated', '2026-01-01', '2027-01-01')}`)
assert(matchingAliasAnnouncement.length === 1 && JSON.stringify(matchingAliasAnnouncement[0].aliases) === JSON.stringify([aliasStatusId]), 'Anthropic deduplicates a matching status row reached through an announcement alias')
const missingStatusShutdownId = 'claude-missing-status-shutdown'
const missingStatusShutdownReason = anthropicStatusError(`${anthropicAnnouncementTable(missingStatusShutdownId, '2026-01-01', '2027-01-01')}${anthropicStatusTable(missingStatusShutdownId, 'Deprecated', '2026-01-01', 'N/A')}`)
assert(missingStatusShutdownReason.includes(missingStatusShutdownId) && missingStatusShutdownReason.includes('N/A') && missingStatusShutdownReason.includes('2027-01-01'), 'Anthropic rejects N/A status retirement against a dated announcement')
const announcedOnlyId = 'claude-announced-only-match'
const announcedOnlyMatch = parseAnthropicDeprecations(`${anthropicAnnouncementTable(announcedOnlyId, '2026-01-01', 'N/A')}${anthropicStatusTable(announcedOnlyId, 'Deprecated', '2026-01-01', 'N/A')}`)
assert(announcedOnlyMatch.length === 1 && announcedOnlyMatch[0].announced === '2026-01-01' && announcedOnlyMatch[0].shutdown === undefined, 'Anthropic deduplicates matching announced-only lifecycle rows')
const extraColumnStatus = parseAnthropicDeprecations(statusExtraColumnMarkdown)
assert(extraColumnStatus.length === 1 && extraColumnStatus[0].id === 'claude-extra-column' && extraColumnStatus[0].date_precision === 'tentative' && extraColumnStatus[0].replacement === undefined, 'Anthropic status parsing owns a table with an extra recommended replacement column')
const footnotedStatusMarkdown = `## 2026-01-01\n${mdTable(['API model name', 'Current state', 'Deprecated', 'Tentative retirement date¹', 'Recommended replacement'], [['claude-footnoted-status', 'Active', 'N/A', 'Not sooner than September 1, 2027', '`claude-next`']])}`
const footnotedStatus = parseAnthropicDeprecations(footnotedStatusMarkdown)
assert(footnotedStatus.length === 1 && footnotedStatus[0].date_precision === 'tentative' && footnotedStatus[0].announced === undefined && footnotedStatus[0].replacement === undefined, 'Anthropic parses a footnoted tentative header only as status data')
const tdHeaderStatusHtml = '<h2>2026-01-01</h2><table><tr><td>API model name</td><td>Current state</td><td>Deprecated</td><td>Tentative retirement *</td><td>Recommended replacement</td></tr><tr><td><code>claude-td-header-status</code></td><td>Active</td><td>N/A</td><td>Not sooner than October 1, 2027</td><td><code>claude-next</code></td></tr></table>'
const tdHeaderStatus = parseAnthropicDeprecationsHtml(tdHeaderStatusHtml)
assert(tdHeaderStatus.length === 1 && tdHeaderStatus[0].date_precision === 'tentative' && tdHeaderStatus[0].announced === undefined && tdHeaderStatus[0].replacement === undefined, 'Anthropic HTML core treats a td-only first row with the status signature as the header (a pipe table always has a header row)')
const leadingTitleStatusHtml = '<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-leading-title-announcement</code></td><td><code>claude-next</code></td></tr></table><table><tr><th colspan="4">Model status</th></tr><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr><tr><td><code>claude-leading-title-status</code></td><td>Active</td><td>N/A</td><td>Not sooner than November 1, 2027</td></tr></table>'
const leadingTitleStatus = parseAnthropicDeprecationsHtml(leadingTitleStatusHtml)
const leadingTitleAnnouncement = leadingTitleStatus.find(entry => entry.id === 'claude-leading-title-announcement')
const leadingTitleTentative = leadingTitleStatus.find(entry => entry.id === 'claude-leading-title-status')
assert(leadingTitleStatus.length === 2 && leadingTitleAnnouncement?.replacement === 'claude-next', 'Anthropic HTML core keeps announcements beside a status table with a leading title row (a pipe table has no colspan)')
assert(leadingTitleTentative?.date_precision === 'tentative' && leadingTitleTentative.announced === undefined && leadingTitleTentative.replacement === undefined, 'Anthropic HTML core owns a status table across its leading header block')
const renamedColumnReason = anthropicStatusError(statusRenamedColumnMarkdown)
assert(renamedColumnReason.includes('missing required columns') && renamedColumnReason.includes('current state'), 'Anthropic status parsing fails loudly on a renamed required column')
const multipleStatusDriftReason = anthropicStatusError(`${anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'Not sooner than September 1, 2027')}## 2026-01-01\n${mdTable(['API model name', 'Lifecycle state', 'Deprecated', 'Tentative retirement [1]', 'Recommended replacement'], [['claude-drifted-status', 'Active', 'N/A', 'September 1, 2027', '`claude-next`']])}`)
assert(multipleStatusDriftReason.includes('missing required columns') && multipleStatusDriftReason.includes('current state'), 'Anthropic never classifies a drifted second status table as an announcement')
const ambiguousStatusSignatureReason = anthropicHtmlStatusError(`<table><tr><th colspan="4">Tentative retirement overview</th></tr>${anthropicStatusHeader}<tr><td><code>claude-ambiguous-status-header</code></td><td>Active</td><td>N/A</td><td>Not sooner than September 1, 2027</td></tr></table>`)
assert(ambiguousStatusSignatureReason.includes('ambiguous signature rows'), 'Anthropic HTML core rejects two status signature rows in one leading header block (a pipe table has one header row)')
const missingStatusReason = anthropicStatusError(`## 2026-01-01\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-no-status-table`', '`claude-next`']])}`)
assert(missingStatusReason === 'anthropic deprecations page has no model status table', 'Anthropic parsing requires a recognised model status table')
const missingStatusHtmlReason = anthropicHtmlStatusError('<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th></tr><tr><td>2027-01-01</td><td><code>claude-no-status-table</code></td></tr></table>')
assert(missingStatusHtmlReason === 'anthropic deprecations page has no model status table', 'Anthropic HTML core skips a two-column history table and still requires a status table')
const twoColumnHistoryReason = anthropicStatusError(`${anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'N/A')}## 2026-01-01\n${mdTable(['Retirement date', 'Deprecated model'], [['2027-01-01', '`claude-no-replacement-column`']])}`)
assert(twoColumnHistoryReason.includes('unrecognised layout: Retirement date | Deprecated model') && twoColumnHistoryReason.includes('under "2026-01-01"'), 'Anthropic Markdown refuses a model table it cannot classify instead of skipping it')
const headerOnlyStatusReason = anthropicStatusError(`## 2026-01-01\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-header-only-status`', '`claude-next`']])}${mdTable(anthropicStatusColumns, [])}`)
assert(headerOnlyStatusReason === 'anthropic model status table has no rows', 'Anthropic rejects a header-only status table even when announcements parsed')
const duplicateStatusHeaderReason = anthropicStatusError(mdTable(['API model name', 'Current state', 'Deprecated', 'Deprecated', 'Tentative retirement date'], [['claude-duplicate-header', 'Active', 'N/A', 'N/A', 'Not sooner than September 1, 2027']]))
assert(duplicateStatusHeaderReason.includes('duplicate required column') && duplicateStatusHeaderReason.includes('deprecated'), 'Anthropic rejects duplicate required status headers')
const anthropicDeprecatedExact = parseAnthropicDeprecations(anthropicStatusTable('claude-deprecated-exact', 'Deprecated', 'July 1, 2026', 'October 1, 2026'))[0]
assert(anthropicDeprecatedExact.announced === '2026-07-01' && anthropicDeprecatedExact.shutdown === '2026-10-01', 'Anthropic parses a deprecated status row with exact lifecycle dates')
const unparseableTentativeReason = anthropicStatusError(anthropicStatusTable('claude-unparseable-tentative-date', 'Active', 'N/A', 'Not sooner than Q4 2027'))
assert(unparseableTentativeReason.includes('claude-unparseable-tentative-date') && unparseableTentativeReason.includes('Not sooner than Q4 2027'), 'Anthropic rejects an unparseable active tentative retirement date')
const plainActiveDateReason = anthropicStatusError(anthropicStatusTable('claude-plain-active-date', 'Active', 'N/A', 'September 1, 2027'))
assert(plainActiveDateReason.includes('claude-plain-active-date') && plainActiveDateReason.includes('September 1, 2027'), 'Anthropic rejects an active retirement date without the not-sooner-than prefix')
const retiredWithoutShutdownReason = anthropicStatusError(anthropicStatusTable('claude-retired-without-shutdown', 'Retired', 'June 1, 2026', 'N/A'))
assert(retiredWithoutShutdownReason.includes('claude-retired-without-shutdown') && retiredWithoutShutdownReason.includes('N/A'), 'Anthropic rejects a retired status row without a shutdown date')
const matchedRetiredWithoutShutdownReason = anthropicStatusError(`${anthropicAnnouncementTable('claude-matched-retired', 'June 1, 2026', 'N/A')}${anthropicStatusTable('claude-matched-retired', 'Retired', 'June 1, 2026', 'N/A')}`)
assert(matchedRetiredWithoutShutdownReason.includes('retired without a shutdown date'), 'a matched Retired row without a shutdown date still fails closed')
const tbaDeprecated = parseAnthropicDeprecations(anthropicStatusTable('claude-tba-deprecated', 'Deprecated', 'June 9, 2026', 'To be announced'))[0]
assert(tbaDeprecated.announced === '2026-06-09' && tbaDeprecated.shutdown === undefined && tbaDeprecated.date_precision === undefined, 'Anthropic converts a deprecated To-be-announced status row into an announced-only record')
const tbaRetiredReason = anthropicStatusError(anthropicStatusTable('claude-tba-retired', 'Retired', 'June 9, 2026', 'To be announced'))
assert(tbaRetiredReason.includes('retired without a shutdown date'), 'Anthropic rejects a retired To-be-announced status row without a shutdown date')
const tbaActive = parseAnthropicDeprecations(anthropicStatusTable('claude-tba-active', 'Active', 'N/A', 'To be announced'))[0]
assert(tbaActive.announced === undefined && tbaActive.shutdown === undefined && tbaActive.date_precision === undefined, 'Anthropic treats an active To-be-announced tentative retirement as no date')
const tbaSoonReason = anthropicStatusError(anthropicStatusTable('claude-tba-soon', 'Deprecated', 'June 9, 2026', 'To be announced soon'))
assert(tbaSoonReason.includes('unrecognised retirement date'), 'Anthropic only accepts the exact To-be-announced retirement cell')
const tbaUpper = parseAnthropicDeprecations(anthropicStatusTable('claude-tba-upper', 'Deprecated', 'June 9, 2026', 'TO BE ANNOUNCED'))[0]
assert(tbaUpper.announced === '2026-06-09' && tbaUpper.shutdown === undefined, 'Anthropic matches the To-be-announced retirement cell case-insensitively')
const tbaConflictId = 'claude-tba-announcement-conflict'
const tbaConflictReason = anthropicStatusError(`${anthropicAnnouncementTable(tbaConflictId, '2026-01-01', '2027-01-01')}${anthropicStatusTable(tbaConflictId, 'Deprecated', '2026-01-01', 'To be announced')}`)
assert(tbaConflictReason.includes(tbaConflictId) && tbaConflictReason.includes('2027-01-01'), 'Anthropic rejects a To-be-announced status retirement against a dated announcement')
const tbaAnnouncementId = 'claude-tba-announcement'
const tbaAnnouncement = parseAnthropicDeprecations(`${anthropicAnnouncementTable(tbaAnnouncementId, '2026-01-01', 'To be announced')}${anthropicStatusTable(tbaAnnouncementId, 'Deprecated', '2026-01-01', 'To be announced')}`)
assert(tbaAnnouncement.length === 1 && tbaAnnouncement[0].announced === '2026-01-01' && tbaAnnouncement[0].shutdown === undefined, 'Anthropic converts a To-be-announced announcement row into an announced-only record')
const populatedRowWithoutIdReason = anthropicStatusError(mdTable(anthropicStatusColumns, [['claude-kept-row', 'Active', 'N/A', 'Not sooner than June 9, 2027'], ['', 'Active', 'N/A', 'Not sooner than July 1, 2027']]))
assert(populatedRowWithoutIdReason.includes('populated row without a model id'), 'a populated status row with an empty model cell fails closed')
const spacerRowRecords = parseAnthropicDeprecations(mdTable(anthropicStatusColumns, [['claude-kept-row', 'Active', 'N/A', 'Not sooner than June 9, 2027'], ['', '', '', '']]))
assert(spacerRowRecords.length === 1 && spacerRowRecords[0].id === 'claude-kept-row', 'a wholly empty spacer row is still skipped')
const renamedSignatureReason = anthropicStatusError(`${anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'Not sooner than June 9, 2027')}${mdTable(['API model name', 'Current state', 'Deprecated', 'Retirement date'], [['claude-drifted-status', 'Active', 'N/A', 'September 1, 2027']])}`)
assert(renamedSignatureReason.includes('missing required columns: tentative retirement'), 'a status-shaped table with a renamed tentative column fails closed instead of parsing as an announcement')
const twoDateCellReason = anthropicStatusError(anthropicStatusTable('claude-two-dates', 'Retired', 'June 1, 2026', '2026-08-01 August 5, 2026'))
assert(twoDateCellReason.includes('unrecognised retirement date'), 'a status date cell with two date candidates fails closed')
const missingDeprecatedReason = anthropicStatusError(anthropicStatusTable('claude-missing-deprecated-date', 'Deprecated', 'N/A', 'September 1, 2027'))
assert(missingDeprecatedReason.includes('claude-missing-deprecated-date') && missingDeprecatedReason.includes('N/A'), 'Anthropic rejects a non-active status row without a deprecated date')
const unknownStateReason = anthropicStatusError(anthropicStatusTable('claude-preview-state', 'Preview', 'N/A', 'N/A'))
assert(unknownStateReason.includes('claude-preview-state') && unknownStateReason.includes('Preview'), 'Anthropic rejects an undocumented model state')
const activeDeprecatedReason = anthropicStatusError(anthropicStatusTable('claude-active-deprecated', 'Active', 'June 1, 2026', 'Not sooner than September 1, 2027'))
assert(activeDeprecatedReason.includes('claude-active-deprecated') && activeDeprecatedReason.includes('June 1, 2026'), 'Anthropic rejects an active row with a deprecated date')
const reversedLifecycleReason = anthropicStatusError(anthropicStatusTable('claude-reversed-lifecycle', 'Retired', 'August 1, 2026', 'June 1, 2026'))
assert(reversedLifecycleReason.includes('claude-reversed-lifecycle') && reversedLifecycleReason.includes('before'), 'Anthropic rejects retirement before deprecation')

const anthropicStatusOnly = anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'N/A')
reviewTest('Anthropic Markdown: front matter, Note and Warning components, lists, links, and the parameter table are read as prose or skipped', () => {
  const html = anthropicMarkdownToHtml(anthropicMarkdown)
  strictAssert.ok(!/title: Model deprecations|&lt;Note|&lt;Warning|<Note|<Warning/.test(html))
  strictAssert.ok(html.includes('<h3>2026-06-05: Claude Opus 4.1 model</h3>') && html.includes('<p>This model was retired August 5, 2026.</p>'))
  strictAssert.equal((html.match(/<table>/g) ?? []).length, 8)
  strictAssert.deepEqual(parseAnthropicDeprecations(anthropicMarkdown.replace(/\n/g, '\r\n')), anthropicEntries)
})
reviewTest('Anthropic Markdown: the heading date wins over the dates in a Note callout and the prose below it', () => {
  strictAssert.equal(anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805').announced, '2026-06-05')
  const undated = `### Claude X model\n\n<Note>\n  This model was retired August 5, 2026.\n</Note>\n\nOn June 5, 2026, Anthropic notified developers.\n${mdTable(anthropicAnnouncementColumns, [['August 5, 2026', '`claude-x`', '`claude-next`']])}${anthropicStatusOnly}`
  strictAssert.throws(() => parseAnthropicDeprecations(undated), /ambiguous-announcement-date/)
})
reviewTest('Anthropic Markdown: undocumented components, raw HTML blocks, and HTML tables or headings fail closed', () => {
  for (const markup of ['<Accordion title="Retired models">', '<div class="history">', '<table><tr><td>x</td></tr></table>', '<h3>2026-01-01: Claude X</h3>', '<Tabs>']) {
    strictAssert.throws(() => parseAnthropicDeprecations(`## History\n\n${markup}\n${anthropicStatusOnly}`), /unsupported markup under "History"/, markup)
  }
  strictAssert.throws(() => parseAnthropicDeprecations(`## History\n\nSee <table> below.\n${anthropicStatusOnly}`), /HTML table or heading under "History"/)
  strictAssert.throws(() => parseAnthropicDeprecations(`<Note>This was <h3>moved</h3> here</Note>\n${anthropicStatusOnly}`), /HTML table or heading/)
  strictAssert.deepEqual(parseAnthropicDeprecations(`<Tip title="x">See <https://example.com/a>.</Tip>\n${anthropicStatusOnly}`).map(entry => entry.id), ['claude-valid-status'])
})
reviewTest('Anthropic Markdown: a setext heading cannot stand in for a dated section heading', () => {
  const setext = `2026-01-01: Claude X model\n---\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-x`', '`claude-next`']])}${anthropicStatusOnly}`
  strictAssert.throws(() => parseAnthropicDeprecations(setext), /setext heading before the first heading: 2026-01-01: Claude X model/)
  strictAssert.throws(() => parseAnthropicDeprecations(setext.replace('---', '===')), /setext heading/)
  strictAssert.deepEqual(parseAnthropicDeprecations(`Intro.\n\n---\n${anthropicStatusOnly}`).map(entry => entry.id), ['claude-valid-status'])
})
reviewTest('Anthropic Markdown: malformed pipe tables, comments, and fenced code follow the strict reader', () => {
  strictAssert.throws(() => parseAnthropicDeprecations(`| API model name | Current state | Deprecated | Tentative retirement date |\n| --- | --- | --- | --- |\n| claude-short | Active | N/A |\n`), /line 3: table row has 3 cells; the header has 4/)
  strictAssert.throws(() => parseAnthropicDeprecations(`${anthropicStatusOnly}\n| claude-orphan | Active | N/A | N/A |\n`), /table row outside a table/)
  strictAssert.throws(() => parseAnthropicDeprecations(`${anthropicStatusOnly}<!-- unclosed\n`), /unbalanced comment marker/)
  const hidden = mdTable(anthropicStatusColumns, [['claude-hidden', 'Retired', 'June 1, 2026', 'August 1, 2026']])
  strictAssert.deepEqual(parseAnthropicDeprecations(`<!--\n${hidden}-->\n\`\`\`\n${hidden}\`\`\`\n${anthropicStatusOnly}`).map(entry => entry.id), ['claude-valid-status'])
})
reviewTest('Anthropic Markdown: the API parameter table is skipped, but a renamed table that names models or retirement fails closed', () => {
  const parameters = columns => `## API parameter deprecations\n${mdTable(columns, [['`temperature`, `top_p`', 'Removed', 'Returns a 400 error.', 'Omit']])}`
  strictAssert.deepEqual(parseAnthropicDeprecations(`${anthropicStatusOnly}${parameters(['Parameter', 'Status', 'Behavior', 'Recommended replacement'])}`).map(entry => entry.id), ['claude-valid-status'])
  strictAssert.throws(() => parseAnthropicDeprecations(`${anthropicStatusOnly}${parameters(['Parameter', 'Status', 'Affected models', 'Recommended replacement'])}`), /table under "API parameter deprecations" has an unrecognised layout: Parameter \| Status \| Affected models/)
  strictAssert.throws(() => parseAnthropicDeprecations(`${anthropicStatusOnly}${parameters(['Parameter', 'Retirement', 'Behavior', 'Recommended replacement'])}`), /unrecognised layout/)
})

const anthropicApiRow = (id, lifecycle, deprecated_at = null, retires_at = null) => ({ type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z', lifecycle, deprecated_at, retires_at })
const anthropicApiPage = (rows, extra = {}) => JSON.stringify({ data: rows, first_id: rows[0]?.id ?? null, has_more: false, last_id: rows.at(-1)?.id ?? null, ...extra })
const anthropicApiAgreeing = [
  anthropicApiRow('claude-fable-5-1', 'active'),
  anthropicApiRow('claude-opus-4-6', 'active'),
  anthropicApiRow('claude-opus-4-1-20250805', 'retired', '2026-06-05T00:00:00Z', '2026-08-05T00:00:00Z'),
  anthropicApiRow('claude-3-haiku-20240307', 'retired', '2026-02-19T00:00:00Z', '2026-04-20T00:00:00Z'),
]
const anthropicApiConflicting = [
  anthropicApiRow('claude-fable-5-1', 'active'),
  anthropicApiRow('claude-opus-4-6', 'deprecated', '2026-11-01T00:00:00Z', null),
  anthropicApiRow('claude-opus-4-1-20250805', 'deprecated', '2026-06-04T20:00:00-04:00', '2026-08-05T00:00:00Z'),
  anthropicApiRow('claude-sonnet-4-20250514', 'retired', '2026-04-14T00:00:00Z', '2026-06-16T00:00:00Z'),
  anthropicApiRow('claude-mystery-1', 'deprecated', '2026-10-01T00:00:00Z', null),
  anthropicApiRow('claude-mystery-0', 'retired', '2025-01-01T00:00:00.123Z', '2025-06-01T00:00:00Z'),
  anthropicApiRow('claude-new-active', 'active'),
]
const anthropicApiLoad = async (pages, { notices = [], requests = [], env = {} } = {}) => loadProviderSources(PROVIDERS.anthropic, {
  env: { ANTHROPIC_API_KEY: 'fixture-key', ...env },
  notice: message => notices.push(message),
  fetchImpl: async (url, options) => {
    const parsed = new URL(url)
    requests.push({ url: parsed, options })
    const text = body => ({ ok: true, status: 200, text: async () => body })
    if (parsed.hostname === 'api.anthropic.com') return typeof pages === 'function' ? pages() : text(pages[parsed.searchParams.get('after_id') ?? ''])
    if (url === PROVIDERS.anthropic.deprecationsFetchUrl) return text(anthropicMarkdown)
    if (url === PROVIDERS.anthropic.aliasesUrl) return text(anthropicIndex)
    return text(anthropicModelMarkdown(url))
  },
})
const agreeingNotices = []
const agreeingRequests = []
const agreeingSources = await anthropicApiLoad({ '': anthropicApiPage(anthropicApiAgreeing) }, { notices: agreeingNotices, requests: agreeingRequests })
assert(agreeingNotices.at(-1) === 'notice: anthropic models API lifecycle: 2 active, 0 deprecated, 2 retired; 0 conflicts with the deprecations page' && !agreeingSources.sourceConflicts.length, 'Anthropic models API counts each lifecycle stage and finds no conflict when the API agrees with the page')
assert(JSON.stringify(agreeingSources.deprecations) === JSON.stringify(anthropicEntries) && agreeingSources.currentIds.join() === 'claude-fable-5-1,claude-opus-4-6', 'Anthropic models API leaves page records untouched and keeps retired models out of the current ids')
const agreeingModelsRequest = agreeingRequests.find(request => request.url.hostname === 'api.anthropic.com')
assert(agreeingModelsRequest.options.headers['x-api-key'] === 'fixture-key' && agreeingModelsRequest.options.headers['anthropic-version'] === '2023-06-01' && agreeingModelsRequest.options.redirect === 'error', 'Anthropic models API request carries the key and version and refuses redirects')

const conflictNotices = []
const conflictSources = await anthropicApiLoad({ '': anthropicApiPage(anthropicApiConflicting) }, { notices: conflictNotices })
const conflictLines = conflictSources.sourceConflicts.map(providerSourceConflictSummary)
const expectedConflictLines = [
  'anthropic models API claude-opus-4-6: lifecycle deprecated on the API, active on the deprecations page; page kept',
  'anthropic models API claude-opus-4-6: deprecated_at 2026-11-01T00:00:00Z on the API, deprecated not set on the deprecations page; page kept',
  'anthropic models API claude-opus-4-1-20250805: lifecycle deprecated on the API, retired on the deprecations page; page kept',
  'anthropic models API claude-sonnet-4-20250514: retires_at 2026-06-16T00:00:00Z on the API, retirement 2026-06-15 on the deprecations page; page kept',
  'anthropic models API claude-mystery-1: deprecated (deprecated_at 2026-10-01T00:00:00Z, retires_at null) but not on the deprecations page; API dates not applied',
  'anthropic models API claude-mystery-0: retired (deprecated_at 2025-01-01T00:00:00.123Z, retires_at 2025-06-01T00:00:00Z) but not on the deprecations page; API dates not applied',
]
reviewTest('Anthropic models API: a state or date disagreement and an API-only deprecated or retired model are reported, not fatal', () => {
  strictAssert.deepEqual(conflictLines, expectedConflictLines)
  strictAssert.deepEqual(conflictNotices.slice(-7), [...expectedConflictLines.map(line => `notice: ${line}`), 'notice: anthropic models API lifecycle: 2 active, 3 deprecated, 2 retired; 6 conflicts with the deprecations page'].slice(-7))
  strictAssert.deepEqual(conflictSources.deprecations, anthropicEntries)
  strictAssert.deepEqual(conflictSources.currentIds, ['claude-fable-5-1', 'claude-opus-4-6', 'claude-opus-4-1-20250805', 'claude-mystery-1', 'claude-new-active'])
})
reviewTest('Anthropic models API: an offset timestamp compares by its UTC calendar date, and a tentative page date never conflicts with a null retires_at', () => {
  strictAssert.ok(!conflictLines.some(line => line.includes('claude-opus-4-1-20250805: deprecated_at')))
  strictAssert.ok(!conflictLines.some(line => line.includes('claude-fable-5-1') || line.includes('claude-new-active')))
  const tentative = compareAnthropicLifecycle(anthropicEntries, [{ id: 'claude-opus-4-6', lifecycle: 'deprecated', deprecated: { date: '2026-11-01', raw: '2026-11-01T00:00:00Z' }, retires: { date: '2027-02-05', raw: '2027-02-05T00:00:00Z' } }])
  strictAssert.deepEqual(tentative.conflicts.filter(conflict => conflict.field === 'retirement').map(providerSourceConflictSummary), ['anthropic models API claude-opus-4-6: retires_at 2027-02-05T00:00:00Z on the API, retirement 2027-02-05 (tentative) on the deprecations page; page kept'])
})
reviewTest('Anthropic models API conflicts render in the semantic diff Source conflicts section without counting as a change', () => {
  const committed = { ...anthropicFeed, models: [{ id: 'claude-opus-4-6' }] }
  const options = { sourceConflicts: conflictSources.sourceConflicts }
  const markdown = renderSemanticDiff(committed, committed, options)
  strictAssert.ok(!compareFeeds(committed, committed, options).changed)
  strictAssert.ok(markdown.includes(`## Source conflicts\n\n${expectedConflictLines.map(line => `- ${line}`).join('\n')}\n`))
  strictAssert.ok(markdown.includes('No semantic changes.'))
})
reviewTest('Anthropic models API: an undocumented lifecycle value, date, or missing field stops the run', () => {
  const row = { ...anthropicApiRow('claude-x', 'deprecated', '2026-06-05T00:00:00Z', '2026-08-05T00:00:00Z') }
  const page = changes => anthropicApiPage([{ ...row, ...changes }])
  const without = field => anthropicApiPage([Object.fromEntries(Object.entries(row).filter(([key]) => key !== field))])
  for (const [body, pattern] of [
    [page({ lifecycle: 'legacy' }), /entry claude-x has an unrecognised lifecycle: "legacy"/],
    [page({ lifecycle: 'Deprecated' }), /unrecognised lifecycle: "Deprecated"/],
    [page({ lifecycle: null }), /unrecognised lifecycle: null/],
    [without('lifecycle'), /entry claude-x has no lifecycle field/],
    [without('deprecated_at'), /entry claude-x has no deprecated_at field/],
    [without('retires_at'), /entry claude-x has no retires_at field/],
    [page({ retires_at: 'August 5, 2026' }), /unparseable retires_at: "August 5, 2026"/],
    [page({ deprecated_at: '2026-06-05' }), /unparseable deprecated_at: "2026-06-05"/],
    [page({ deprecated_at: '2026-02-30T00:00:00Z' }), /unparseable deprecated_at/],
    [page({ deprecated_at: '2026-06-05T24:00:00Z' }), /unparseable deprecated_at/],
    [page({ deprecated_at: '2026-06-05T00:00:00' }), /unparseable deprecated_at/],
    [page({ deprecated_at: 1780617600 }), /unparseable deprecated_at: 1780617600/],
    [page({ lifecycle: 'active' }), /entry claude-x is active but has deprecated_at/],
    [page({ lifecycle: 'active', retires_at: null }), /entry claude-x is active but has deprecated_at 2026-06-05T00:00:00Z$/],
    [page({ deprecated_at: null }), /entry claude-x is deprecated without deprecated_at/],
    [page({ lifecycle: 'retired', deprecated_at: null, retires_at: null }), /entry claude-x is retired without deprecated_at/],
    [page({ retires_at: '2026-06-04T00:00:00Z' }), /entry claude-x retires before it was deprecated/],
    [page({ id: 'claude x' }), /invalid model id: claude x/],
    [anthropicApiPage([row], { has_more: undefined }), /boolean has_more/],
    [JSON.stringify([row]), /boolean has_more/],
  ]) {
    strictAssert.throws(() => parseAnthropicModelsLifecyclePage(body), pattern, body)
  }
  strictAssert.deepEqual(parseAnthropicModelsLifecyclePage(anthropicApiPage([row])).models, [{ id: 'claude-x', lifecycle: 'deprecated', deprecated: { date: '2026-06-05', raw: '2026-06-05T00:00:00Z' }, retires: { date: '2026-08-05', raw: '2026-08-05T00:00:00Z' } }])
})
let anthropicApiUnknownReason = ''
try {
  await anthropicApiLoad({ '': anthropicApiPage([{ ...anthropicApiRow('claude-x', 'sunset'), deprecated_at: null }]) }, { env: { MODEL_EOL_CROSS_CHECKS: 'strict' } })
} catch (error) { anthropicApiUnknownReason = error.message }
assert(anthropicApiUnknownReason.includes('unrecognised lifecycle: "sunset"'), 'with MODEL_EOL_CROSS_CHECKS=strict an unknown models API lifecycle value fails the Anthropic source load')
const anthropicApiPagedRequests = []
const anthropicApiPaged = await anthropicApiLoad({
  '': anthropicApiPage([anthropicApiRow('claude-fable-5-1', 'active')], { has_more: true }),
  'claude-fable-5-1': anthropicApiPage([anthropicApiRow('claude-opus-4-1-20250805', 'retired', '2026-06-05T00:00:00Z', '2026-08-05T00:00:00Z')]),
}, { requests: anthropicApiPagedRequests })
const pagedModelsUrls = anthropicApiPagedRequests.filter(request => request.url.hostname === 'api.anthropic.com').map(request => request.url)
assert(pagedModelsUrls.length === 2 && pagedModelsUrls[1].searchParams.get('after_id') === 'claude-fable-5-1' && pagedModelsUrls.every(url => url.searchParams.getAll('lifecycle[]').join() === 'active,deprecated,retired') && anthropicApiPaged.currentIds.join() === 'claude-fable-5-1' && JSON.stringify(anthropicApiPaged.sourceConflicts.map(providerSourceConflictSummary)) === JSON.stringify(['anthropic models API claude-opus-4-6: active on the deprecations page but not returned by the API; page kept']), 'Anthropic models API pages through every lifecycle stage and compares the retired model on page two')
let anthropicApiDuplicateReason = ''
try {
  await anthropicApiLoad({
    '': anthropicApiPage([anthropicApiRow('claude-fable-5-1', 'active')], { has_more: true }),
    'claude-fable-5-1': anthropicApiPage([anthropicApiRow('claude-fable-5-1', 'active')], { has_more: true }),
  }, { env: { MODEL_EOL_CROSS_CHECKS: 'strict' } })
} catch (error) { anthropicApiDuplicateReason = error.message }
assert(anthropicApiDuplicateReason.includes('duplicate model id across pages: claude-fable-5-1'), 'Anthropic models API pagination stops on a model repeated across pages')
assert(anthropicModelsListUrl(`${PROVIDERS.anthropic.modelsUrl}?lifecycle=active&limit=5&after_id=x`) === 'https://api.anthropic.com/v1/models?lifecycle%5B%5D=active&lifecycle%5B%5D=deprecated&lifecycle%5B%5D=retired&limit=1000', 'Anthropic models list URL replaces any lifecycle, limit, or cursor with all three stages and the maximum page size')

reviewTest('Anthropic models API: a page model in Active or Deprecated state that the API omits is reported, and a retired one is not', () => {
  const deprecated = { id: 'claude-page-deprecated', announced: '2026-06-01', shutdown: '2026-09-01', source: PROVIDERS.anthropic.deprecationsUrl }
  const markdown = `## Model status\n\n| API model name | Current state | Deprecated | Tentative retirement date |\n| :-- | :-- | :-- | :-- |\n| claude-page-active | Active | N/A | N/A |\n| claude-page-deprecated | Deprecated | June 1, 2026 | September 1, 2026 |\n| claude-page-retired | Retired | January 1, 2026 | March 1, 2026 |\n`
  const records = parseAnthropicDeprecations(markdown)
  strictAssert.deepEqual(records.find(record => record.id === deprecated.id), deprecated)
  const { conflicts } = compareAnthropicLifecycle(records, [{ id: 'claude-other', lifecycle: 'active', deprecated: undefined, retires: undefined }])
  strictAssert.deepEqual(conflicts.map(providerSourceConflictSummary), [
    'anthropic models API claude-page-active: active on the deprecations page but not returned by the API; page kept',
    'anthropic models API claude-page-deprecated: deprecated on the deprecations page but not returned by the API; page kept',
  ])
  strictAssert.deepEqual(compareAnthropicLifecycle(records, ['claude-page-active', 'claude-page-deprecated'].map(id => ({ id, lifecycle: id.endsWith('active') ? 'active' : 'deprecated', deprecated: id.endsWith('active') ? undefined : { date: '2026-06-01', raw: '2026-06-01T00:00:00Z' }, retires: id.endsWith('active') ? undefined : { date: '2026-09-01', raw: '2026-09-01T00:00:00Z' } }))).conflicts, [])
})
reviewTest('Anthropic models API: an active model with a tentative retires_at is accepted and compared with the page\'s tentative date', () => {
  const row = anthropicApiRow('claude-x', 'active', null, '2027-11-30T00:00:00-08:00')
  const [model] = parseAnthropicModelsLifecyclePage(anthropicApiPage([row])).models
  strictAssert.deepEqual(model, { id: 'claude-x', lifecycle: 'active', deprecated: undefined, retires: { date: '2027-11-30', raw: '2027-11-30T00:00:00-08:00' } })
  const status = date => parseAnthropicDeprecations(`## Model status\n\n| API model name | Current state | Deprecated | Tentative retirement date |\n| :-- | :-- | :-- | :-- |\n| claude-x | Active | N/A | Not sooner than ${date} |\n`)
  strictAssert.deepEqual(compareAnthropicLifecycle(status('November 30, 2027'), [model]).conflicts, [])
  strictAssert.deepEqual(compareAnthropicLifecycle(status('November 29, 2027'), [model]).conflicts.map(providerSourceConflictSummary), ['anthropic models API claude-x: retires_at 2027-11-30T00:00:00-08:00 on the API, retirement 2027-11-29 (tentative) on the deprecations page; page kept'])
  const lateOffset = parseAnthropicModelsLifecyclePage(anthropicApiPage([anthropicApiRow('claude-x', 'active', null, '2027-11-29T20:00:00-08:00')])).models
  strictAssert.deepEqual(compareAnthropicLifecycle(status('November 30, 2027'), lateOffset).conflicts, [])
  strictAssert.deepEqual(compareAnthropicLifecycle(status('November 29, 2027'), lateOffset).conflicts.map(providerSourceConflictSummary), ['anthropic models API claude-x: retires_at 2027-11-29T20:00:00-08:00 on the API, retirement 2027-11-29 (tentative) on the deprecations page; page kept'])
})
for (const [label, pages] of [
  ['an unknown lifecycle value', { '': anthropicApiPage([{ ...anthropicApiRow('claude-x', 'sunset'), deprecated_at: null }]) }],
  ['a malformed response', { '': '{"data": "nope"}' }],
  ['an HTTP error', () => new Response('upstream rejected key fixture-key', { status: 503 })],
]) {
  const notices = []
  const sources = await anthropicApiLoad(pages, { notices })
  reviewTest(`Anthropic models API: ${label} is a reported cross-check failure that keeps the page and treats the endpoint as unavailable`, () => {
    const [conflict] = sources.sourceConflicts
    strictAssert.equal(sources.sourceConflicts.length, 1)
    strictAssert.deepEqual(Object.keys(conflict).sort(), ['message', 'publisher', 'reason', 'via'])
    strictAssert.deepEqual([conflict.via, conflict.publisher, conflict.reason], ['models-api', 'anthropic', 'cross-check-failed'])
    strictAssert.ok(!conflict.message.includes('fixture-key'), conflict.message)
    strictAssert.ok(notices.includes(`warning: anthropic models API cross-check failed: ${conflict.message}`), notices.join('\n'))
    strictAssert.deepEqual(sources.deprecations, anthropicEntries)
    strictAssert.equal(sources.currentIds, null)
    strictAssert.equal(sources.endpointAvailable, false)
    const line = `- ${providerSourceConflictSummary(conflict)}`
    strictAssert.ok(line.startsWith('- anthropic models API cross-check failed: ') && line.endsWith('; the deprecations page was used without it'), line)
    const committed = { ...anthropicFeed, models: [{ id: 'claude-opus-4-6' }] }
    strictAssert.ok(renderSemanticDiff(committed, committed, { sourceConflicts: sources.sourceConflicts }).includes(`## Source conflicts\n\n${line}\n`))
    strictAssert.ok(!compareFeeds(committed, committed, { sourceConflicts: sources.sourceConflicts }).changed)
  })
}
let strictMalformedReason = ''
try { await anthropicApiLoad({ '': '{"data": "nope"}' }, { env: { MODEL_EOL_CROSS_CHECKS: 'strict' } }) } catch (error) { strictMalformedReason = error.message }
const unknownPolicyReasons = []
for (const value of ['Strict', 'stirct']) {
  try { await anthropicApiLoad({ '': anthropicApiPage(anthropicApiAgreeing) }, { env: { MODEL_EOL_CROSS_CHECKS: value } }) } catch (error) { unknownPolicyReasons.push(error.message) }
}
const warnPolicySources = await anthropicApiLoad({ '': '{"data": "nope"}' }, { env: { MODEL_EOL_CROSS_CHECKS: 'warn' } })
const emptyPolicySources = await anthropicApiLoad({ '': '{"data": "nope"}' }, { env: { MODEL_EOL_CROSS_CHECKS: '' } })
reviewTest('Anthropic models API: MODEL_EOL_CROSS_CHECKS=strict turns a cross-check failure back into a failed run, warn or empty keeps it a warning, and any other value is refused', () => {
  strictAssert.match(strictMalformedReason, /anthropic models response/)
  strictAssert.deepEqual(unknownPolicyReasons, ['MODEL_EOL_CROSS_CHECKS must be unset, "warn", or "strict", not "Strict"', 'MODEL_EOL_CROSS_CHECKS must be unset, "warn", or "strict", not "stirct"'])
  strictAssert.deepEqual([warnPolicySources, emptyPolicySources].map(sources => sources.sourceConflicts.map(conflict => conflict.reason)), [['cross-check-failed'], ['cross-check-failed']])
})
const anthropicBadModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-anthropic-bad-models-'))
try {
  for (const name of ['anthropic-deprecations.md', 'anthropic-llms.txt']) fs.copyFileSync(path.join(fixtures, name), path.join(anthropicBadModelsDir, name))
  fs.cpSync(path.join(fixtures, 'anthropic-model-pages'), path.join(anthropicBadModelsDir, 'anthropic-model-pages'), { recursive: true })
  fs.writeFileSync(path.join(anthropicBadModelsDir, 'anthropic-models.json'), anthropicApiPage([{ ...anthropicApiRow('claude-x', 'sunset'), deprecated_at: null }]))
  const notices = []
  const lenient = await loadProviderSources(PROVIDERS.anthropic, { fixtures: anthropicBadModelsDir, env: {}, notice: message => notices.push(message) })
  let strictReason = ''
  try { await loadProviderSources(PROVIDERS.anthropic, { fixtures: anthropicBadModelsDir, env: { MODEL_EOL_CROSS_CHECKS: 'strict' }, notice: () => {} }) } catch (error) { strictReason = error.message }
  reviewTest('Anthropic models API: a bad fixture models response follows the same cross-check policy as a live one', () => {
    strictAssert.deepEqual(lenient.sourceConflicts.map(conflict => [conflict.reason, conflict.message]), [['cross-check-failed', 'anthropic models response entry claude-x has an unrecognised lifecycle: "sunset"']])
    strictAssert.ok(notices.includes('warning: anthropic models API cross-check failed: anthropic models response entry claude-x has an unrecognised lifecycle: "sunset"'))
    strictAssert.equal(lenient.endpointAvailable, false)
    strictAssert.equal(lenient.currentIds, null)
    strictAssert.match(strictReason, /unrecognised lifecycle: "sunset"/)
  })
} finally {
  fs.rmSync(anthropicBadModelsDir, { recursive: true, force: true })
}
const anthropicApiCliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-anthropic-api-cli-'))
try {
  for (const name of ['anthropic-deprecations.md', 'anthropic-llms.txt']) fs.copyFileSync(path.join(fixtures, name), path.join(anthropicApiCliDir, name))
  fs.cpSync(path.join(fixtures, 'anthropic-model-pages'), path.join(anthropicApiCliDir, 'anthropic-model-pages'), { recursive: true })
  fs.writeFileSync(path.join(anthropicApiCliDir, 'anthropic-models.json'), anthropicApiPage(anthropicApiConflicting))
  const cli = spawnSync(process.execPath, [refresh, '--provider', 'anthropic', '--check', '--fixtures', anthropicApiCliDir], { encoding: 'utf8' })
  assert([0, 3].includes(cli.status) && cli.stdout.includes(`## Source conflicts\n\n- ${expectedConflictLines[0]}`) && cli.stderr.includes('notice: anthropic models API lifecycle: 2 active, 3 deprecated, 2 retired; 6 conflicts with the deprecations page') && cli.stderr.includes(`notice: ${expectedConflictLines[4]}`), 'refresh --check prints Anthropic models API conflicts in the diff and on stderr without failing')
} finally {
  fs.rmSync(anthropicApiCliDir, { recursive: true, force: true })
}

assert(openaiEntries.every(entry => !/[\s/]/.test(entry.id)), 'OpenAI endpoint and product retirement rows are excluded from the model feed')
assert(normalizeBedrockId('anthropic.claude-3-haiku-20240307-v1:0') === 'claude-3-haiku-20240307', 'Bedrock normalization strips a known provider prefix and v1 suffix')
assert(normalizeBedrockId('meta.llama3-1-405b-instruct-v2:0') === 'llama3-1-405b-instruct', 'Bedrock normalization strips v2 suffixes')
assert(normalizeBedrockId('future-provider.example-model:0') === 'example-model', 'Bedrock normalization handles an unknown provider prefix generically')
assert(normalizeBedrockId('cohere.command-r:0') === 'command-r', 'Bedrock normalization strips a bare colon version suffix')
assert(normalizeVertexId('publishers/google/models/gemini-2.5-pro') === 'gemini-2.5-pro', 'Vertex normalization strips a publisher resource prefix')
assert(bedrockEntries.length === 19, 'Bedrock lifecycle fixture parses and deduplicates logical model entries')
assert(bedrockEntries.find(entry => entry.bedrockId === 'anthropic.claude-3-haiku-20240307-v1:0')?.eol === '2026-09-10', 'Bedrock parser merges regional lines and repeated entries for one model')
assert(bedrockEntries.find(entry => entry.bedrockId === 'amazon.nova-canvas-v1:0')?.legacy === '2026-03-30', 'Bedrock parser reads human legacy dates')
assert(bedrockEntries.every(entry => entry.legacy && entry.eol), 'Bedrock lifecycle records preserve parsed Legacy and EOL dates')
assert(bedrockById.get('amazon.nova-canvas-v1:0')?.status === 'legacy', 'Bedrock parser marks entries without a public Extended Access date as Legacy')
assert(bedrockById.get('anthropic.claude-3-haiku-20240307-v1:0')?.status === 'extended-access', 'Bedrock parser ingests the public Extended Access lifecycle phase')
assert(bedrockById.get('anthropic.claude-3-sonnet-20240229-v1:0')?.status === 'extended-access', 'Bedrock parser keeps Extended Access across regional lines')
assert(bedrockById.get('cohere.command-r-plus-v1:0')?.eol === '2026-08-19', 'Bedrock parser reads an entry whose model name carries a Markdown escape')
const bedrockFields = (id, legacy = 'March 1, 2026', eol = 'September 1, 2026', extended = '\u2014') => [['Model name', 'Example'], ['Model ID', id], ['Regions', 'us-east-1'], ['Legacy date', legacy], ['EOL date', eol], ['Public extended access start date', extended]]
const bedrockEntry = (fields, provider = 'Example') => `- **${provider}**\n${fields.map(field => `  - ${Array.isArray(field[0]) ? field.map(([label, value]) => `**${label}:** ${value}`).join(' / ') : `**${field[0]}:** ${field[1]}`}`).join('\n')}\n`
const bedrockPage = (...entries) => `# Model lifecycle (Legacy)\n\n**Models with a scheduled EOL date**\n\n${entries.join('\n')}\nThe public extended access date indicates when a Legacy model enters the public extended access portion of the Legacy period.\n`
const bedrockError = markdown => {
  try {
    parseBedrockLifecycleMarkdown(markdown)
  } catch (error) {
    return error.message
  }
  return ''
}
const reorderedBedrock = parseBedrockLifecycleMarkdown(bedrockPage(bedrockEntry([...bedrockFields('cohere.command-r-v1:0', 'February 19, 2026', 'August 19, 2026', 'May 19, 2026')].reverse(), 'Cohere')))
assert(reorderedBedrock[0]?.bedrockId === 'cohere.command-r-v1:0' && reorderedBedrock[0]?.eol === '2026-08-19' && reorderedBedrock[0]?.status === 'extended-access', 'Bedrock parser reads an entry by its labels, so field order cannot misalign a date')
const explicitBedrockStatuses = parseBedrockLifecycleMarkdown(bedrockPage(
  bedrockEntry([...bedrockFields('amazon.legacy-model-v1:0'), ['Lifecycle status', 'Legacy']]),
  bedrockEntry([...bedrockFields('amazon.extended-model-v1:0', 'March 1, 2026', 'September 1, 2026', 'June 1, 2026'), ['Lifecycle status', 'Public Extended Access']]),
  bedrockEntry([...bedrockFields('amazon.eol-model-v1:0', 'March 1, 2026', 'September 1, 2026', 'June 1, 2026'), ['Lifecycle status', 'End-of-Life (EOL)']]),
))
assert(JSON.stringify(explicitBedrockStatuses.map(entry => entry.status)) === JSON.stringify(['legacy', 'extended-access', 'retired']), 'Bedrock parser normalizes explicit official lifecycle statuses')
for (const [label, value] of [['unknown', 'Deprecated'], ['empty', '']]) {
  const reason = bedrockError(bedrockPage(bedrockEntry([...bedrockFields('amazon.bad-status-v1:0'), ['Status', value]])))
  assert(reason.includes('unsupported lifecycle status'), `Bedrock parser fails closed on ${label} lifecycle status values`)
}
assert(bedrockError(bedrockPage(bedrockEntry(bedrockFields('amazon.bad-extended-date-v1:0', 'March 1, 2026', 'September 1, 2026', 'Eventually')))).includes('unrecognised public extended access date'), 'Bedrock parser fails closed on malformed public Extended Access dates')
assert(bedrockError(bedrockPage(bedrockEntry(bedrockFields('amazon.schema-drift-v1:0').slice(0, 5)))).includes('amazon.schema-drift-v1:0 is missing its Public extended access start date'), 'Bedrock parser fails closed when an entry drops the Extended Access label')
reviewTest('Markdown lifecycle: Bedrock refuses an HTML body, an empty body, and a page without model entries', () => {
  strictAssert.throws(() => parseBedrockLifecycleMarkdown('<!DOCTYPE html><html><body><table></table></body></html>'), /aws-bedrock lifecycle page is HTML, not Markdown/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown('<!-- note -->\n<html><body>x</body></html>'), /is HTML, not Markdown/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(' \n'), /aws-bedrock lifecycle page is empty/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown('# Model lifecycle (Legacy)\n\nNo models are scheduled.\n'), /no model entries/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(`\`\`\`\n${bedrockEntry(bedrockFields('amazon.fenced-v1:0'))}\`\`\`\n`)), /no model entries/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(`<!--\n${bedrockEntry(bedrockFields('amazon.hidden-v1:0'))}-->\n`)), /no model entries/)
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(`${bedrockPage(bedrockEntry(bedrockFields('amazon.open-comment-v1:0')))}<!-- unterminated`), /unbalanced comment marker/)
})
reviewTest('Markdown lifecycle: Bedrock ignores fenced and commented entries next to live ones', () => {
  const live = bedrockEntry(bedrockFields('amazon.live-v1:0'))
  const expected = parseBedrockLifecycleMarkdown(bedrockPage(live))
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(live, `<!-- ${bedrockEntry(bedrockFields('amazon.live-v1:0', 'January 1, 2026', 'February 1, 2026'))} -->`)), expected)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(live, `\`\`\`\n${bedrockEntry(bedrockFields('amazon.live-v1:0', 'January 1, 2026', 'February 1, 2026'))}\`\`\`\n`)), expected)
})
for (const [name, markdown, pattern] of [
  ['an unknown label', bedrockEntry([...bedrockFields('amazon.unknown-label-v1:0'), ['Retirement date', 'September 1, 2026']]), /line \d+: unrecognised label: Retirement date/],
  ['a renamed label', bedrockEntry(bedrockFields('amazon.renamed-label-v1:0').map(([label, value]) => [label === 'EOL date' ? 'EOL Date' : label, value])), /unrecognised label: EOL Date/],
  ['a missing Model ID', bedrockEntry(bedrockFields('amazon.no-id-v1:0').filter(([label]) => label !== 'Model ID')), /the Example entry has no Model ID/],
  ['a missing Legacy date', bedrockEntry(bedrockFields('amazon.no-legacy-v1:0').filter(([label]) => label !== 'Legacy date')), /amazon\.no-legacy-v1:0 is missing its Legacy date/],
  ['a missing EOL date', bedrockEntry(bedrockFields('amazon.no-eol-v1:0').filter(([label]) => label !== 'EOL date')), /amazon\.no-eol-v1:0 is missing its EOL date/],
  ['a duplicated label', bedrockEntry([...bedrockFields('amazon.twice-v1:0'), ['EOL date', 'October 1, 2026']]), /line \d+: duplicate EOL date/],
  ['a duplicated Model ID', bedrockEntry([...bedrockFields('amazon.first-v1:0'), ['Model ID', 'amazon.second-v1:0']]), /duplicate Model ID/],
  ['a label set both for the entry and on a regional line', bedrockEntry([...bedrockFields('amazon.both-v1:0').slice(0, 2), ['Legacy date', 'March 1, 2026'], [['Regions', 'us-east-1'], ['Legacy date', 'April 1, 2026'], ['EOL date', 'September 1, 2026'], ['Public extended access start date', '\u2014']]]), /duplicate Legacy date/],
  ['a Model ID on a regional line', bedrockEntry([['Model name', 'Example'], [['Model ID', 'amazon.regional-id-v1:0'], ['Regions', 'us-east-1'], ['Legacy date', 'March 1, 2026'], ['EOL date', 'September 1, 2026'], ['Public extended access start date', '\u2014']]]), /Model ID inside a regional line/],
  ['a duplicated label on a regional line', bedrockEntry([...bedrockFields('amazon.regional-twice-v1:0').slice(0, 2), [['Regions', 'us-east-1'], ['EOL date', 'September 1, 2026'], ['Legacy date', 'March 1, 2026'], ['EOL date', 'October 1, 2026'], ['Public extended access start date', '\u2014']]]), /duplicate EOL date/],
  ['a regional line missing a date', bedrockEntry([...bedrockFields('amazon.regional-short-v1:0').slice(0, 2), [['Regions', 'us-east-1'], ['Legacy date', 'March 1, 2026'], ['Public extended access start date', '\u2014']]]), /amazon\.regional-short-v1:0 is missing its EOL date/],
  ['a malformed regional segment', bedrockEntry([...bedrockFields('amazon.regional-bad-v1:0').slice(0, 2), ['Regions', 'us-east-1 / **Legacy date** March 1, 2026']]), /unrecognised segment: \*\*Legacy date\*\* March 1, 2026/],
  ['an entry without labelled fields', '- **Example**\n', /the Example entry has no labelled fields/],
  ['an unlabelled item inside an entry', bedrockEntry([...bedrockFields('amazon.unlabelled-v1:0'), ['Note', 'x']]).replace('**Note:** x', 'See the note below'), /unrecognised line in the Example entry: - See the note below/],
  ['a continuation line inside an entry', bedrockEntry(bedrockFields('amazon.wrapped-v1:0')).replace('**Regions:** us-east-1\n', '**Regions:** us-east-1,\n    us-west-2\n'), /unrecognised line in the Example entry: us-west-2/],
  ['a labelled item outside an entry', `Some prose.\n  - **Model ID:** amazon.loose-v1:0\n\n${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}`, /labelled item outside a model entry/],
  ['a labelled item after a blank line', bedrockEntry(bedrockFields('amazon.split-entry-v1:0')).replace('  - **EOL date:**', '\n  - **EOL date:**'), /labelled item outside a model entry/],
  ['a Model ID label in prose', `${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}\n**Model ID:** amazon.prose-v1:0\n`, /has the label Model ID outside a model entry/],
  ['a top-level labelled item', `${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}\n- **EOL date:** September 1, 2026\n`, /has the label EOL date outside a model entry/],
  ['a lifecycle pipe table', `| Model ID | Legacy date | EOL date |\n| --- | --- | --- |\n| amazon.table-v1:0 | March 1, 2026 | September 1, 2026 |\n\n${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}`, /line \d+: lifecycle table where labelled lists are expected/],
  ['a raw HTML table', `<table><tr><th>Model ID</th></tr></table>\n\n${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}`, /raw HTML table/],
  ['a misaligned pipe table', `| Region | Note |\n| --- | --- |\n| us-east-1 |\n\n${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}`, /line \d+: table row has 1 cells; the header has 2/],
  ['an EOL date with no sooner than', bedrockEntry(bedrockFields('amazon.floor-v1:0', 'March 1, 2026', 'No sooner than January 8, 2027')), /amazon\.floor-v1:0 has an unrecognised EOL date: No sooner than January 8, 2027/],
  ['an EOL date with or later', bedrockEntry(bedrockFields('amazon.later-v1:0', 'March 1, 2026', 'January 8, 2027 or later')), /amazon\.later-v1:0 has an unrecognised EOL date: January 8, 2027 or later/],
  ['a tentative EOL date', bedrockEntry(bedrockFields('amazon.tentative-v1:0', 'March 1, 2026', 'January 8, 2027 (tentative)')), /unrecognised EOL date: January 8, 2027 \(tentative\)/],
  ['an EOL value with two dates', bedrockEntry(bedrockFields('amazon.two-dates-v1:0', 'March 1, 2026', 'March 8, 2027 (us-gov-west-1); January 8, 2027 elsewhere')), /unrecognised EOL date: March 8, 2027 \(us-gov-west-1\); January 8, 2027 elsewhere/],
  ['a struck-through EOL date', bedrockEntry(bedrockFields('amazon.struck-v1:0', 'March 1, 2026', '~~January 8, 2027~~ March 8, 2027')), /struck-through text in Markdown is refused: ~~January 8, 2027~~ March 8, 2027/],
  ['a Legacy date with a qualifier', bedrockEntry(bedrockFields('amazon.legacy-floor-v1:0', 'No earlier than March 1, 2026')), /unrecognised legacy date: No earlier than March 1, 2026/],
  ['an extended access date with a qualifier', bedrockEntry(bedrockFields('amazon.extended-floor-v1:0', 'March 1, 2026', 'September 1, 2026', 'June 1, 2026 or later')), /unrecognised public extended access date: June 1, 2026 or later/],
  ['a labelled sub-bullet one level deeper', bedrockEntry(bedrockFields('amazon.deeper-v1:0')).replace('  - **Regions:** us-east-1\n', '').replace(/(\*\*Public extended access start date:\*\* .*\n)/, '$1    - **Regions:** us-gov-west-1\n'), /labelled item at a different list depth in the Example entry: - \*\*Regions:\*\* us-gov-west-1/],
  ['a labelled sub-bullet at the content column of a deeper list', bedrockEntry(bedrockFields('amazon.deep-start-v1:0')).replace('  - **Model name:**', '        - **Model name:**'), /labelled item at a different list depth/],
  ['an HTML bold label outside an entry', `${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}\n<b>EOL date:</b> June 1, 2026 for amazon.listed-v1:0 in all Regions\n`, /line \d+: the label EOL date outside a model entry/],
  ['an underscore bold label outside an entry', `${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}\n__EOL date:__ June 1, 2026\n`, /the label EOL date outside a model entry/],
  ['a strong label outside an entry', `<strong>Model ID:</strong> amazon.prose-v1:0\n\n${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}`, /the label Model ID outside a model entry/],
  ['a plain label outside an entry', `${bedrockEntry(bedrockFields('amazon.listed-v1:0'))}\nPublic extended access start date: June 1, 2026\n`, /the label Public extended access start date outside a model entry/],
  ['a second label inside a value', bedrockEntry(bedrockFields('amazon.listed-v1:0')).replace('**Regions:** us-east-1', '**Regions:** us-east-1 <b>EOL date:</b> June 1, 2026'), /the Regions value holds another label: EOL date/],
  ['a display name as Model ID', bedrockEntry(bedrockFields('DeepSeek V3')), /invalid model id: DeepSeek V3/],
  ['an empty Model ID', bedrockEntry(bedrockFields('')), /invalid model id: \(empty\)/],
]) {
  reviewTest(`Markdown lifecycle: Bedrock fails closed on ${name}`, () => {
    strictAssert.match(bedrockError(bedrockPage(markdown)), pattern)
  })
}
reviewTest('Markdown lifecycle: Bedrock ignores unrelated lists and tables', () => {
  const live = bedrockEntry(bedrockFields('amazon.live-v1:0'))
  const expected = parseBedrockLifecycleMarkdown(bedrockPage(live))
  const extras = '+ Create a new custom model deployment for on-demand inference.\n+ Continue using any existing on-demand deployments.\n  - nested detail\n\n| Region | Note |\n| --- | --- |\n| us-east-1 | ok |\n'
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(live, extras)), expected)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(live, '**Regions** column notes and **EOL** prose do not count as labels.\n')), expected)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage('**For models with EOL dates after February 1, 2026: ** After a minimum of 3 months in the Legacy state, a model enters public extended access.\n\n', live)), expected)
})
reviewTest('Markdown lifecycle: Bedrock reads entry fields at any one consistent list depth', () => {
  const expected = parseBedrockLifecycleMarkdown(bedrockPage(bedrockEntry(bedrockFields('amazon.live-v1:0'))))
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(bedrockEntry(bedrockFields('amazon.live-v1:0')).replace(/^ {2}-/gm, '    -'))), expected)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(bedrockEntry(bedrockFields('amazon.live-v1:0')).replace(/^ {2}-/gm, '\t-'))), expected)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(bedrockEntry(bedrockFields('amazon.live-v1:0', 'March 1, 2026 ', 'Sept 1, 2026')))), expected)
})

const cardIndexMarkdown = fs.readFileSync(path.join(fixtures, 'bedrock-model-cards.md'), 'utf8')
const cardUrls = parseBedrockModelCardsIndexMarkdown(cardIndexMarkdown)
const cardMarkdown = new Map(cardUrls.map(url => [url, fs.readFileSync(path.join(fixtures, 'bedrock-model-cards', path.basename(new URL(bedrockMarkdownUrl(url)).pathname)), 'utf8')]))
const cards = new Map([...cardMarkdown].map(([url, markdown]) => [path.basename(new URL(url).pathname), parseBedrockModelCardMarkdown(markdown, url)]))
const card = slug => cards.get(`model-card-${slug}.html`)
const cardRecords = [...cards.values()].flatMap(result => result.records)
const skippedCards = [...cards.values()].flatMap(result => result.skipped)
assert(cardUrls.length === 12 && cardRecords.length === 10 && skippedCards.length === 2, 'twelve Bedrock cards yield ten records and two reported skips')
assert(cardUrls.every(url => url.startsWith(new URL('.', BEDROCK_MODEL_CARDS_URL).href) && url.endsWith('.html')), 'Bedrock index links resolve to the human card pages')
const llamaCard = card('meta-llama-3-1-405b-instruct').records[0]
assert(card('meta-llama-3-1-405b-instruct').records.length === 1 && llamaCard.bedrockId === 'meta.llama3-1-405b-instruct-v1:0' && llamaCard.shutdown === '2026-07-07' && llamaCard.status === 'legacy' && !Object.hasOwn(llamaCard, 'date_precision'), 'an exact Model EOL date with a matching EOL lifecycle line is an exact legacy shutdown')
const fableCard = card('anthropic-claude-fable-5-1').records[0]
assert(card('anthropic-claude-fable-5-1').records.length === 1 && fableCard.shutdown === '2027-09-01' && fableCard.date_precision === 'tentative' && fableCard.status === 'active' && !Object.hasOwn(fableCard, 'announced'), 'Fable deduplicates endpoint IDs and keeps its unannounced N/A EOL floor')
const canvasCard = card('amazon-nova-canvas').records[0]
assert(canvasCard.shutdown === '2026-09-30' && canvasCard.status === 'legacy' && !Object.hasOwn(canvasCard, 'date_precision'), 'Nova Canvas uses its exact EOL and regional Legacy status')
const liteCard = card('amazon-nova-lite').records[0]
assert(liteCard.shutdown === '2025-12-05' && liteCard.date_precision === 'tentative', 'Nova Lite selects the later human floor over the US floor')
const haikuCard = card('anthropic-claude-haiku-4-5').records[0]
assert(card('anthropic-claude-haiku-4-5').records.length === 1 && haikuCard.bedrockId === 'anthropic.claude-haiku-4-5' && haikuCard.shutdown === '2026-10-16' && haikuCard.date_precision === 'tentative', 'Haiku skips its N/A runtime Model ID and keeps the bare mantle ID')
const haikuCards = [haikuCard, { ...haikuCard, bedrockId: 'anthropic.claude-haiku-4-5-20251001-v1:0' }]
assert(card('amazon-titan-text-embeddings-v2-2').skipped[0]?.reason === 'no lifecycle fields' && card('amazon-titan-text-embeddings-v2-2').skipped[0]?.ids[0] === 'amazon.titan-embed-g1-text-02', 'Titan reports its URL and ID despite having only Model EOL date N/A')
assert(card('mistral-ai-magistral-small-2509').skipped[0]?.reason === 'no day-precision date', 'Magistral reports a card with a Legacy period and no date without inventing a day')
const mistralCard = card('mistral-ai-mistral-7b-instruct').records[0]
assert(mistralCard.shutdown === '2027-03-30' && mistralCard.status === 'legacy' && !Object.hasOwn(mistralCard, 'date_precision'), 'Mistral 7B reads an exact EOL with Legacy status')
const jambaCard = card('ai21-labs-jamba-1-5-large').records[0]
assert(jambaCard.shutdown === '2026-11-26' && jambaCard.status === 'legacy' && !Object.hasOwn(jambaCard, 'date_precision'), 'Jamba parses an exact EOL and takes Legacy status from its Model lifecycle line without regional cells')
const cardOnlyJamba = mergeBedrockSources(bedrockEntries.filter(record => record.bedrockId !== jambaCard.bedrockId), [jambaCard])
assert(JSON.stringify(cardOnlyJamba.records.find(record => record.bedrockId === jambaCard.bedrockId)) === JSON.stringify(jambaCard), 'Jamba contributes a card-only exact record when the legacy table lacks its ID')
const commandCard = card('cohere-command-r').records[0]
assert(commandCard.shutdown === '2026-08-19' && !Object.hasOwn(commandCard, 'date_precision'), 'Command R retains its exact EOL despite its month-only floor')
const embedCard = card('cohere-embed-v4').records[0]
assert(embedCard.shutdown === '2026-04-15' && embedCard.date_precision === 'tentative', 'Embed v4 parses a floor without a publisher feed entry')
const marengoFixtureCard = card('twelvelabs-marengo-embed-3-0').records[0]
assert(marengoFixtureCard.shutdown === '2027-03-22' && marengoFixtureCard.status === 'legacy' && !Object.hasOwn(marengoFixtureCard, 'date_precision'), 'Marengo Embed 3.0 reads its regional Legacy lifecycle at its regional EOL date')
assert(cardRecords.every(record => cardUrls.includes(record.source) && !Object.hasOwn(record, 'announced') && !Object.hasOwn(record, 'legacy')), 'all card records retain their own source and omit announcements')

const bedrockSourceNotices = []
const loadedBedrock = await loadDistributorSource('aws-bedrock', { fixtures, notice: value => bedrockSourceNotices.push(value) })
assert(loadedBedrock.records.length === 24 && loadedBedrock.conflicts.length === 0 && loadedBedrock.skipped.length === 2, 'Bedrock combines legacy and card sources without reporting floor disagreements')
assert(bedrockSourceNotices.filter(value => value.startsWith('notice:') && value.includes(': skipped ')).length === 2, 'Bedrock prints one notice per skipped card')
for (const record of [canvasCard, commandCard]) {
  const kept = loadedBedrock.records.find(item => item.bedrockId === record.bedrockId)
  assert(JSON.stringify(kept) === JSON.stringify({ ...bedrockById.get(record.bedrockId), source: BEDROCK_LIFECYCLE_URL }), `legacy table wins over card for ${record.bedrockId}`)
}
const conflictingCards = [canvasCard, commandCard].map(record => ({ ...record, shutdown: '2028-01-01' }))
const bedrockConflicts = mergeBedrockSources(bedrockEntries, conflictingCards)
assert(bedrockConflicts.conflicts.length === 2 && bedrockConflicts.conflicts.every(conflict => conflict.kept.eol === bedrockById.get(conflict.id).eol), 'exact EOL conflicts preserve both sources and keep the legacy table')
const emptyBedrockFeed = { publisher: 'amazon', models: [] }
const bedrockInfoOptions = { sourceConflicts: bedrockConflicts.conflicts, skippedModelCards: skippedCards }
const bedrockInfoDiff = renderSemanticDiff(emptyBedrockFeed, emptyBedrockFeed, bedrockInfoOptions)
assert(!compareFeeds(emptyBedrockFeed, emptyBedrockFeed, bedrockInfoOptions).changed && bedrockInfoDiff.includes('## Source conflicts') && bedrockInfoDiff.includes('legacy table wins') && bedrockInfoDiff.includes('## Model cards without lifecycle fields') && bedrockInfoDiff.includes('no day-precision date'), 'Bedrock conflicts and skips render informational sections without semantic changes')
assert(bedrockInfoDiff.includes(BEDROCK_LIFECYCLE_URL) && skippedCards.every(item => bedrockInfoDiff.includes(item.source)) && !bedrockInfoDiff.includes('.md'), 'Bedrock conflicts and skips cite the human pages, not the Markdown copies')

const realBedrockFeeds = ['amazon', 'anthropic', 'cohere', 'mistral'].map(publisher => JSON.parse(fs.readFileSync(path.join(root, 'feeds', `${publisher}.json`), 'utf8')))
const realBedrockMerge = mergeBedrockDistributions(realBedrockFeeds, { records: loadedBedrock.records })
const bedrockDistribution = (publisher, id) => realBedrockMerge.feeds.find(feed => feed.publisher === publisher).models.find(model => model.id === id)?.distributions?.find(distribution => distribution.via === 'aws-bedrock')
assert(normalizeBedrockId(commandCard.bedrockId) === 'command-r' && bedrockDistribution('cohere', 'command-r-03-2024')?.shutdown === '2026-08-19', 'Cohere namespace binds Command R through its committed alias')
assert(normalizeBedrockId(mistralCard.bedrockId) === 'mistral-7b-instruct' && realBedrockMerge.noPublisherFeed.some(item => item.bedrockId === mistralCard.bedrockId), 'Mistral namespace leaves the absent 7B publisher ID unmatched')
for (const record of [embedCard, jambaCard, liteCard]) {
  assert(realBedrockMerge.noPublisherFeed.some(item => item.bedrockId === record.bedrockId), `absent publisher ID remains unmatched: ${record.bedrockId}`)
}
assert(!realBedrockMerge.noPublisherFeed.some(item => item.bedrockId === haikuCard.bedrockId) && bedrockDistribution('anthropic', 'claude-haiku-4-5-20251001')?.date_precision === 'tentative', 'the bare Haiku 4.5 Bedrock ID binds through the committed publisher alias')
assert(bedrockDistribution('anthropic', 'claude-fable-5-1')?.source === fableCard.source && bedrockDistribution('anthropic', 'claude-haiku-4-5-20251001')?.source === haikuCard.source, 'Fable and dated Haiku bind tentative distributions with card sources')
assert(bedrockDistribution('amazon', 'nova-canvas')?.source === BEDROCK_LIFECYCLE_URL && bedrockDistribution('cohere', 'command-r-03-2024')?.source === BEDROCK_LIFECYCLE_URL, 'legacy-bound distributions use the legacy page source')
assert(realBedrockMerge.feeds.every(feed => validateFeed(feed).length === 0), 'combined Bedrock fixture feeds pass semantic validation')

const haikuFeed = { publisher: 'anthropic', models: [{ id: 'claude-haiku-4-5-20251001', aliases: ['claude-haiku-4-5'] }] }
for (const records of [haikuCards, [haikuCards[0], { ...haikuCards[1], source: fableCard.source }]]) {
  const merged = mergeBedrockDistributions([haikuFeed], { records })
  assert(merged.feeds[0].models[0].distributions.length === 1 && merged.feeds[0].models[0].distributions[0].source === haikuCards[0].source, 'identical card lifecycle payloads collapse across IDs and retain the first source')
}
let cardCollisionReason = ''
try {
  mergeBedrockDistributions([haikuFeed], { records: [haikuCards[0], { ...haikuCards[1], shutdown: '2028-01-01' }] })
} catch (error) { cardCollisionReason = error.message }
assert(haikuCards.every(record => cardCollisionReason.includes(record.bedrockId)), 'different card payloads bound to one model throw naming both IDs')

const fableMarkdown = cardMarkdown.get(fableCard.source)
const canvasMarkdown = cardMarkdown.get(canvasCard.source)
const commandMarkdown = cardMarkdown.get(commandCard.source)
const cardField = (label, value) => `+ **${label}:** ${value}\n`
const eolField = value => fableMarkdown.replace(cardField('Model EOL date', 'N/A'), cardField('Model EOL date', value))
const reviewCardSource = new URL('model-card-example.html', BEDROCK_MODEL_CARDS_URL).href
const cardRow = cells => `| ${cells.join(' | ')} |`
const cardTable = (header, rows) => `\n${[cardRow(header), cardRow(header.map(() => '---')), ...rows.map(cardRow)].join('\n')}\n\n`
const cellTable = (...cells) => cardTable(cells.map((_, index) => `Region ${index + 1}`), [cells])
const reviewIdTable = cardTable(['**Model ID**'], [['anthropic.example-v1:0']])
const reviewFloor = cardField('EOL no sooner than', 'September 1, 2027')
const reviewCard = reviewIdTable + reviewFloor
const parseReviewCard = markdown => parseBedrockModelCardMarkdown(markdown, reviewCardSource)
reviewTest('Markdown card: Bedrock refuses an HTML body, an empty body, a raw HTML table, and a misaligned pipe table', () => {
  for (const [markdown, pattern] of [
    ['<!DOCTYPE html><html><body><table><tr><th>Model ID</th></tr></table></body></html>', /page is HTML, not Markdown/],
    ['', /empty/],
    [`${reviewCard}<table><tr><td>Legacy (EOL: 2028-01-01)</td></tr></table>\n`, /raw HTML table/],
    [`${reviewCard}\n| Region | In-Region |\n| --- | --- |\n| us-east-1 |\n`, /page: line \d+: table row has 1 cells; the header has 2/],
  ]) {
    strictAssert.throws(() => parseReviewCard(markdown), error => error.message.includes(reviewCardSource) && pattern.test(error.message))
  }
})
reviewTest('Third pass F1: Bedrock counts a Model ID header in a related-models table too', () => {
  const markdown = `${reviewIdTable}${cardField('Model EOL date', 'December 1, 2026')}\n## Related models\n${cardTable(['Model ID'], [['anthropic.other-v1:0']])}`
  strictAssert.throws(() => parseReviewCard(markdown), error =>
    error.message.includes(reviewCardSource) && error.message.includes('more than one Model ID table'))
})
reviewTest('Third pass F1: Bedrock recognises Model ID in any header cell, with or without emphasis', () => {
  strictAssert.deepEqual(parseReviewCard(cardTable(['Model', 'Model ID'], [['Example', 'anthropic.example-v1:0']]) + reviewFloor), parseReviewCard(reviewCard))
  strictAssert.deepEqual(parseReviewCard(cardTable(['Model ID'], [['`anthropic.example-v1:0`']]) + reviewFloor), parseReviewCard(reviewCard))
})
reviewTest('Third pass F1: Bedrock refuses a Model ID header outside the header row', () => {
  strictAssert.throws(() => parseReviewCard(cardTable(['Unrecognised heading'], [['**Model ID**'], ['anthropic.example-v1:0']]) + reviewFloor), /no Model ID table/)
})
for (const [shape, markdown] of [
  ['zero', reviewFloor],
  ['related models', reviewCard + `\n## Related models\n${cardTable(['**Model ID**'], [['anthropic.other-v1:0']])}`],
  ['duplicate', reviewCard + reviewIdTable],
]) {
  reviewTest(`Second pass F1: Bedrock rejects ${shape} Model ID tables`, () => {
    strictAssert.throws(() => parseReviewCard(markdown), error =>
      error.message.includes(reviewCardSource) && error.message.includes('Model ID table'))
  })
}
reviewTest('Second pass F1: Bedrock rejects a Model ID table with two Model ID columns or no rows', () => {
  strictAssert.throws(() => parseReviewCard(cardTable(['Model ID', 'Model ID'], [['anthropic.example-v1:0', 'anthropic.example-v1:0']]) + reviewFloor), /ambiguous Model ID columns/)
  strictAssert.throws(() => parseReviewCard(cardTable(['Model ID'], []) + reviewFloor), /Model ID table has no entries/)
})
const reviewEndpointTable = ids => cardTable(['**Endpoint**', '**Model ID**', '**Geo inference ID**', '**Global inference ID**'], ids.map((id, index) =>
  [`endpoint-${index}`, id, '`us.anthropic.example-v1:0`<br />`eu.anthropic.example-v1:0`', 'global.anthropic.example-v1:0']))
reviewTest('Endpoint table: Bedrock skips an N/A Model ID cell and records only the base id', () => {
  strictAssert.deepEqual(parseReviewCard(reviewEndpointTable(['N/A', 'anthropic.example-v1:0']) + reviewFloor), parseReviewCard(reviewCard))
})
reviewTest('Endpoint table: Bedrock skips a Model ID table whose every id is N/A with a notice', () => {
  strictAssert.deepEqual(parseReviewCard(reviewEndpointTable(['N/A', 'n/a']) + reviewFloor), {
    records: [], skipped: [{ source: reviewCardSource, ids: [], reason: 'no model ids' }],
  })
})
reviewTest('Endpoint table: Bedrock matches the N/A Model ID marker case-insensitively', () => {
  strictAssert.deepEqual(parseReviewCard(reviewEndpointTable(['n/a', 'anthropic.example-v1:0']) + reviewFloor), parseReviewCard(reviewCard))
})
for (const id of ['N/A (see profiles)', 'not available', '']) {
  reviewTest(`Endpoint table: Bedrock still rejects a non-N/A invalid Model ID: ${JSON.stringify(id)}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewEndpointTable([id, 'anthropic.example-v1:0']) + reviewFloor), error =>
      error.message.includes(reviewCardSource) && error.message.includes('invalid Model ID in row 2'))
  })
}
const reviewKimiFields = cardField('Model launch date', '18th Sept 2026') + cardField('EOL no sooner than', 'Not Applicable, at least 45 day EOL Notice will be provided') + cardField('Legacy period', 'at least 45 days')
reviewTest('Free-text lifecycle: Bedrock skips a Kimi-style card without a day-precision date', () => {
  strictAssert.deepEqual(parseReviewCard(reviewIdTable + reviewKimiFields), {
    records: [], skipped: [{ source: reviewCardSource, ids: ['anthropic.example-v1:0'], reason: 'no day-precision date' }],
  })
})
reviewTest('Free-text lifecycle: Bedrock treats a bare Not Applicable floor as no floor', () => {
  for (const floor of ['Not Applicable', 'not applicable', 'N/A']) {
    strictAssert.equal(parseReviewCard(reviewIdTable + cardField('EOL no sooner than', floor)).skipped[0]?.reason, 'no day-precision date')
  }
})
reviewTest('Free-text lifecycle: Bedrock accepts a Legacy period without "at least" (Claude 5.5 cards)', () => {
  const expected = parseReviewCard(reviewCard + cardField('Legacy period', 'at least 6 months'))
  for (const period of ['6 months', '1 month', '45 days']) {
    strictAssert.deepEqual(parseReviewCard(reviewCard + cardField('Legacy period', period)), expected)
  }
})
for (const period of ['TBD', 'six months', '6 weeks', 'at least', 'up to 6 months', '6 months minimum']) {
  reviewTest(`Free-text lifecycle: Bedrock still rejects an unrecognised Legacy period: ${period}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewCard + cardField('Legacy period', period)), /unrecognised Legacy period/)
  })
}
for (const floor of ['TBD', 'Currently Not Applicable', 'Not Applicabled', 'NA']) {
  reviewTest(`Free-text lifecycle: Bedrock still rejects an unrecognised floor: ${floor}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewIdTable + cardField('EOL no sooner than', floor)), /unrecognised EOL no sooner than date/)
  })
}
reviewTest('Free-text lifecycle: Bedrock accepts an ordinal launch date alongside a valid floor', () => {
  const expected = parseReviewCard(reviewCard + cardField('Model launch date', 'September 18, 2026'))
  strictAssert.deepEqual(expected, parseReviewCard(reviewCard))
  for (const launch of ['18th Sept 2026', '18 September 2026', '1st Sep 2026', '2nd Jan 2026', '3rd March 2026', '4TH SEPT 2026']) {
    strictAssert.deepEqual(parseReviewCard(reviewCard + cardField('Model launch date', launch)), expected)
  }
})
for (const launch of ['Sometime 2026', '18th Smarch 2026', '18th Sept 26', '18th of Sept 2026', 'Sept 2026 18th']) {
  reviewTest(`Free-text lifecycle: Bedrock still rejects an unrecognised launch date: ${launch}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewCard + cardField('Model launch date', launch)), /unrecognised Model launch date/)
  })
}
reviewTest('Free-text lifecycle: Bedrock rejects an ordinal launch date that is not a calendar date', () => {
  strictAssert.throws(() => parseReviewCard(reviewCard + cardField('Model launch date', '30th Feb 2026')), /invalid date/)
})
reviewTest('Markdown card: Bedrock reads a field from a plain line, a list item, or bold markup alike', () => {
  const expected = parseReviewCard(reviewIdTable + cardField('Model EOL date', 'December 1, 2027'))
  for (const line of ['Model EOL date: December 1, 2027\n', '- Model EOL date: December 1, 2027\n', '* **Model EOL date:** December 1, 2027\n', '+  **Model EOL date:** December 1, 2027\n', '**Model EOL date**: December 1, 2027\n']) {
    strictAssert.deepEqual(parseReviewCard(reviewIdTable + line), expected, line)
  }
})
for (const [shape, comment] of [
  ['EOL line', cardField('Model EOL date', 'December 1, 2026')],
  ['ID table', reviewIdTable.replace('anthropic.example-v1:0', 'anthropic.other-v1:0')],
  ['regional status', cellTable('Legacy (EOL: 2026-12-01)')],
]) {
  reviewTest(`Second pass F2: Bedrock ignores a commented ${shape} before extraction`, () => {
    const visible = reviewCard + cardField('Model EOL date', 'December 1, 2027')
    strictAssert.deepEqual(parseReviewCard(`${visible}<!-- ${comment} -->\n`), parseReviewCard(visible))
  })
}
reviewTest('Second pass F2: A commented exact EOL cannot replace a visible floor', () => {
  strictAssert.deepEqual(parseReviewCard(`${reviewCard}<!-- ${cardField('Model EOL date', 'December 1, 2026')} -->\n`), parseReviewCard(reviewCard))
})
reviewTest('Markdown card: Bedrock does not read fields or regional cells out of fenced code, but counts their labels', () => {
  strictAssert.deepEqual(parseReviewCard(`${reviewCard}\`\`\`\n| Region |\n| --- |\n| Legacy (EOL: 2026-12-01) |\n\`\`\`\n`), parseReviewCard(reviewCard))
  strictAssert.throws(() => parseReviewCard(`${reviewCard}\`\`\`\n${cardField('Model EOL date', 'December 1, 2026')}\`\`\`\n`), /unaccounted Model EOL date field/)
})
for (const [eol, payload] of [
  ['December 1, 2026', { shutdown: '2026-12-01', status: 'active' }],
  ['Legacy: December 1, 2026', { shutdown: '2026-12-01', status: 'legacy' }],
  ['No sooner than 12/1/2026', { shutdown: '2026-12-01', date_precision: 'tentative', status: 'active' }],
]) {
  reviewTest(`Second pass F3: Bedrock parses a standalone Model EOL date: ${eol}`, () => {
    strictAssert.deepEqual(parseReviewCard(reviewIdTable + cardField('Model EOL date', eol)), {
      records: [{ bedrockId: 'anthropic.example-v1:0', ...payload, source: reviewCardSource }], skipped: [],
    })
  })
}
reviewTest('Free-text lifecycle: Bedrock treats "Not announced." like N/A (GPT-6.1 Sol card)', () => {
  for (const eol of ['Not announced.', 'Not announced']) {
    strictAssert.equal(parseReviewCard(reviewIdTable + cardField('Model EOL date', eol)).skipped[0]?.reason, 'no lifecycle fields')
    strictAssert.deepEqual(
      parseReviewCard(reviewIdTable + cardField('Model launch date', 'September 29, 2026') + cardField('Model EOL date', eol)),
      parseReviewCard(reviewIdTable + cardField('Model launch date', 'September 29, 2026') + cardField('Model EOL date', 'N/A')))
    strictAssert.deepEqual(parseReviewCard(reviewCard + cardField('Model EOL date', eol)), parseReviewCard(reviewCard))
  }
})
const reviewRegionEol = cellTable('Legacy (EOL: 2028-01-01)')
for (const eol of ['N/A', 'Not announced.', 'No sooner than 9/1/2027']) {
  for (const [shape, extra] of [['alone', ''], ['with a launch date', cardField('Model launch date', 'September 29, 2026')], ['with a floor', reviewFloor]]) {
    reviewTest(`PR 107 review: Bedrock fails closed on a regional EOL without an exact Model EOL date (${eol}, ${shape})`, () => {
      strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${extra}${cardField('Model EOL date', eol)}${reviewRegionEol}`),
        error => error.message.includes(reviewCardSource) && error.message.includes('region EOL 2028-01-01 without an exact Model EOL date'))
    })
  }
}
reviewTest('PR 107 review: Bedrock fails closed on a regional EOL with no Model EOL date field', () => {
  strictAssert.throws(() => parseReviewCard(reviewIdTable + reviewRegionEol), /region EOL 2028-01-01 without an exact Model EOL date/)
})
const reviewNoIdTable = cardTable(['**Model ID**'], [['N/A']])
reviewTest('PR 107 review: Bedrock validates regional EOL cells on a card with no recordable Model ID', () => {
  strictAssert.throws(() => parseReviewCard(`${reviewNoIdTable}${cellTable('Legacy (EOL: someday)')}`), /unrecognised region EOL: Legacy \(EOL: someday\)/)
  strictAssert.equal(parseReviewCard(reviewNoIdTable + reviewRegionEol).skipped[0]?.reason, 'no model ids')
})
reviewTest('PR 107 review: Bedrock reports a malformed regional EOL before an invalid Model EOL date', () => {
  strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'February 30, 2028')}${cellTable('Legacy (EOL: someday)')}`),
    /unrecognised region EOL: Legacy \(EOL: someday\)/)
})
reviewTest('PR 107 review: Bedrock records a Legacy-prefixed Model EOL date with matching regional cells', () => {
  strictAssert.deepEqual(parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'Legacy: January 1, 2028')}${reviewRegionEol}${reviewRegionEol}`), {
    records: [{ bedrockId: 'anthropic.example-v1:0', shutdown: '2028-01-01', status: 'legacy', source: reviewCardSource }], skipped: [],
  })
})
for (const eol of ['August 31, 2027', 'Legacy: August 31, 2027']) {
  reviewTest(`PR 107 review: Bedrock rejects a Model EOL date before the EOL no sooner than floor: ${eol}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewCard + cardField('Model EOL date', eol)),
      error => error.message.includes(reviewCardSource) && error.message.includes('Model EOL date 2027-08-31 precedes EOL no sooner than 2027-09-01'))
  })
}
reviewTest('PR 107 review: Bedrock accepts a Model EOL date on or after the floor, and ignores a month-only floor', () => {
  for (const [eol, shutdown] of [['September 1, 2027', '2027-09-01'], ['September 2, 2027', '2027-09-02']]) {
    strictAssert.equal(parseReviewCard(reviewCard + cardField('Model EOL date', eol)).records[0]?.shutdown, shutdown)
  }
  strictAssert.equal(parseReviewCard(reviewIdTable + cardField('EOL no sooner than', 'Sep 2027') + cardField('Model EOL date', 'August 31, 2027')).records[0]?.shutdown, '2027-08-31')
})
for (const cell of ['legacy (EOL: 2028-01-01)', 'Legacy (EOL : 2028-01-01)', 'Legacy ( EOL: 2028-01-01)', 'LEGACY (eol: 2028-01-01)', 'Legacy(EOL: 2028-01-01)', 'Legacy (EOL: 2028-1-1)',
  'US East (N. Virginia): Legacy (EOL: 2028-01-01)', 'Legacy - EOL: 2028-01-01', 'Legacy (End of life: 2028-01-01)', 'End-of-life 2028-01-01',
  'Legacy', 'Legacy model', 'Legacy (EOL)', 'Legacy (EOL policy)',
  'E.O.L.: 2028-01-01', 'End of lifecycle: 2028-01-01', 'End of support: 2028-01-01', 'Retired (2028-01-01)', 'Retired']) {
  reviewTest(`PR 107 review: Bedrock fails closed on any table cell that mentions legacy or EOL in another shape: ${cell}`, () => {
    const regional = cellTable(cell)
    for (const markdown of [`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${regional}`, reviewNoIdTable + regional]) {
      strictAssert.throws(() => parseReviewCard(markdown), /unrecognised region EOL/)
    }
  })
}
for (const [shape, cell] of [
  ['image alt text', '![Legacy (EOL: 2028-01-02)](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-legacy.png)'],
  ['a link title', '[Retiring](model-lifecycle.html "End of life: 2028-01-02")'],
  ['a raw abbr title', '<abbr title="End of life: 2028-01-02">Retiring</abbr>'],
  ['a raw aria-label', '<span aria-label="Legacy (EOL: 2028-01-02)"></span>'],
  ['split emphasis', 'Leg**acy** (E*OL*: 2028-01-02)'],
  ['split raw markup', 'Leg<span>acy</span> (E<em>OL</em>: 2028-01-02)'],
]) {
  reviewTest(`PR 107 review: Bedrock does not let a regional EOL hide in ${shape}`, () => {
    strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable(cell)}`),
      /unrecognised region EOL|region EOL 2028-01-02 differs/)
  })
}
reviewTest('PR 107 review: Bedrock records a matching regional EOL from a header cell as legacy', () => {
  strictAssert.equal(parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 2, 2028')}${cardTable(['Legacy (EOL: 2028-01-02)'], [['us-east-1']])}`).records[0]?.status, 'legacy')
})
reviewTest('PR 107 review: Bedrock does not read lifecycle words inside Model ID and inference ID cells', () => {
  for (const id of ['vendor.eol-model-v1:0', 'vendor.legacy-model-v1:0', 'vendor.retired-v1:0']) {
    const table = cardTable(['**Model ID**', '**Geo inference ID**'], [[id, `\`us.${id}\`<br />\`eu.${id}\``]])
    strictAssert.equal(parseReviewCard(table).skipped[0]?.reason, 'no lifecycle fields')
    strictAssert.equal(parseReviewCard(table + cardField('Model EOL date', 'January 1, 2028')).records[0]?.status, 'active')
  }
})
reviewTest('PR 107 review pass 6: Bedrock does not read lifecycle words out of ids, URLs, link and image targets, digits, underscores, or double-decoded entities', () => {
  for (const cells of [
    ['us.vendor.eol2-v1:0 N/A'], ['us.vendor.eol-v1:0 N/A'], ['us.vendor.legacy_model-v1:0 Not supported'],
    ['https://bedrock-mantle.{region}.api.aws/vendor/eol'], ['https://bedrock-mantle.{region}.api.aws/vendor/eol2'],
    ['[Supported](https://icons.example/legacy.html)'], ['![supported](https://icons.example/icon-legacy.png) Supported'], ['l&amp;#101;gacy'],
    ['![Green circle with check mark](icon-yes.png)'], ['![Red circle with X](icon-no.png)'],
  ]) {
    strictAssert.equal(parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable(...cells)}`).records[0]?.status, 'active', cells[0])
  }
  strictAssert.equal(parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cardTable(['EOL2 availability'], [['Supported']])}`).records[0]?.status, 'active')
})
for (const cell of ['<img alt=Legacy>', '<span title=retired></span>', '<span aria-label=EOL></span>', "<img alt='Legacy (EOL: 2028-01-02)'>", '<span TITLE="Legacy">Supported</span>', 'E.O.L.: 2028-01-01', 'e.o.l.: 2028-01-01',
  '<img alt="Legacy > Active">', "<img title='Supported > EOL'>", '![legacy](icon.png)', '[Supported](icon.html "Retired")']) {
  reviewTest(`PR 107 review pass 6: Bedrock detects a lifecycle word in raw markup, alt text, a title, or any case: ${cell}`, () => {
    strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable(cell)}`), /unrecognised region EOL/)
  })
}
reviewTest('PR 107 review: Bedrock leaves the live regional status shapes that carry no EOL alone', () => {
  for (const cell of ['', 'Supported', 'Not supported', 'Active', 'us-east-1 (N. Virginia)', '![supported](https://docs.aws.amazon.com/bedrock/latest/userguide/images/icons/icon-yes.png)', '+ ![supported](icon-yes.png) [Guardrails](guardrails.html)<br />+ ![supported](icon-yes.png) [Flows](flows.html)']) {
    strictAssert.deepEqual(parseReviewCard(`${reviewCard}${cellTable(cell)}`), parseReviewCard(reviewCard))
  }
})
reviewTest('PR 107 review: Bedrock accepts Legacy periods whose number and unit agree', () => {
  const expected = parseReviewCard(reviewCard + cardField('Legacy period', 'at least 6 months'))
  for (const period of ['1 month', '1 day', 'at least 1 month', '2 days', '10 days', '12 months', 'at least 45 days', '999 days']) {
    strictAssert.deepEqual(parseReviewCard(reviewCard + cardField('Legacy period', period)), expected)
  }
})
for (const period of ['1 days', '1 months', 'at least 1 days', '2 month', '6 day', '0 days', '0 months', 'at least 0 days', '01 months', '00 days', '1000 days', 'at least 9999 months']) {
  reviewTest(`PR 107 review: Bedrock rejects a Legacy period whose number and unit disagree or are zero: ${period}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewCard + cardField('Legacy period', period)), /unrecognised Legacy period/)
  })
}
for (const eol of ['Not yet announced', 'Not announced until 2027', 'TBA', 'Announced.']) {
  reviewTest(`Free-text lifecycle: Bedrock still rejects an unrecognised Model EOL date: ${eol}`, () => {
    strictAssert.throws(() => parseReviewCard(reviewIdTable + cardField('Model EOL date', eol)), /unrecognised Model EOL date/)
  })
}
reviewTest('Second pass F3: Bedrock validates a standalone EOL and skips only absent or N/A lifecycle fields', () => {
  strictAssert.throws(() => parseReviewCard(reviewIdTable + cardField('Model EOL date', 'February 30, 2026')), /invalid date.*February 30, 2026/)
  for (const field of ['', cardField('Model EOL date', 'N/A'), cardField('Model lifecycle policy', 'Standard')]) {
    strictAssert.equal(parseReviewCard(reviewIdTable + field).skipped[0]?.reason, 'no lifecycle fields')
  }
})
for (const [label, value] of [
  ['Model launch date', 'December 1, 2025'], ['EOL no sooner than', 'December 1, 2027'],
  ['Legacy period', 'at least 6 months'], ['Model lifecycle policy', 'Standard'], ['Model EOL date', 'December 1, 2027'],
]) {
  for (const fragment of [`> ${label}: ${value}\n`, `### ${label}: ${value}\n`, `Details: ${label}: ${value}\n`, `+ **Model launch date:** December 1, 2025; ${label}: ${value}\n`, cellTable(`${label}: ${value}`)]) {
    reviewTest(`Second pass F5: Bedrock accounts for ${label} outside its field line: ${JSON.stringify(fragment)}`, () => {
      strictAssert.throws(() => parseReviewCard(reviewCard + fragment), error =>
        error.message.includes(reviewCardSource) && error.message.includes(label))
    })
  }
  for (const fragment of [`${label}\n: ${value}\n`, `${label.toUpperCase()}: ${value}\n`, `Details: ${label.toLowerCase()} ${value}\n`]) {
    reviewTest(`Third pass F2: Bedrock counts whole-word lifecycle labels regardless of case or colon: ${JSON.stringify(fragment)}`, () => {
      strictAssert.throws(() => parseReviewCard(reviewCard + fragment), error =>
        error.message.includes(reviewCardSource) && error.message.includes(`unaccounted ${label} field`))
    })
  }
}
reviewTest('Third pass F2: Bedrock refuses the reported definition-list and title-case EOL fields', () => {
  for (const fragment of ['Model EOL date\n: December 1, 2026\n', 'Model EOL Date: December 1, 2026\n', '+ **Model EOL Date:** December 1, 2026\n']) {
    strictAssert.throws(() => parseReviewCard(reviewCard + fragment), /unaccounted Model EOL date field/)
  }
})
reviewTest('Third pass F2: Bedrock matches whole labels without matching longer words', () => {
  const markdown = `${reviewCard}Premodel EOL date; Model EOL dates; Model launch dates; Legacy periods; Model lifecycle policymaker; EOL no sooner thanks\n`
  strictAssert.deepEqual(parseReviewCard(markdown), parseReviewCard(reviewCard))
})
const lifecycleLine = value => cardField('Model lifecycle', value)
const lifecycleCard = (value, eol = 'N/A') => fableMarkdown.replace(lifecycleLine('Active'), lifecycleLine(value)).replace(cardField('Model EOL date', 'N/A'), cardField('Model EOL date', eol))
const lifecyclePolicy = text => cardField('Model lifecycle policy', `[${text}](model-lifecycle-legacy.md)`)
const lifecycleBanner = '\nThis model version has reached the end of its life. For how model lifecycle stages work, see [Model lifecycle](model-lifecycle-legacy.md).\n\n'
reviewTest('Model lifecycle line: Bedrock keeps an Active card and a card without the line on current behaviour', () => {
  strictAssert.ok(fableMarkdown.includes(lifecycleLine('Active')))
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(lifecycleCard('Active'), fableCard.source), card('anthropic-claude-fable-5-1'))
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(fableMarkdown.replace(lifecycleLine('Active'), ''), fableCard.source), card('anthropic-claude-fable-5-1'))
})
reviewTest('Model lifecycle line: Bedrock marks a Legacy card legacy without changing its tentative floor', () => {
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(lifecycleCard('Legacy'), fableCard.source).records, [{ ...fableCard, status: 'legacy' }])
})
for (const value of ['EOL: 2027-09-01', 'EOL: 2027-09-01 (certain regions)']) {
  reviewTest(`Model lifecycle line: Bedrock marks a matching ${value} card legacy at its exact Model EOL date`, () => {
    const { date_precision: _, ...exact } = fableCard
    strictAssert.deepEqual(parseBedrockModelCardMarkdown(lifecycleCard(value, 'September 1, 2027'), fableCard.source).records, [{ ...exact, shutdown: '2027-09-01', status: 'legacy' }])
  })
}
reviewTest('Model lifecycle line: Bedrock rejects an EOL line on a card without an exact Model EOL date', () => {
  for (const [markdown, source] of [
    [lifecycleCard('EOL: 2026-12-01'), fableCard.source],
    [lifecycleCard('EOL: 2026-10-14', 'No sooner than 12/1/2026'), fableCard.source],
    [lifecycleCard('EOL: 2026-10-14 (certain regions)', 'No sooner than 12/1/2026'), fableCard.source],
    [`${reviewIdTable}${lifecycleLine('EOL: 2026-10-14')}`, reviewCardSource],
    [`${reviewIdTable}${cardField('Model EOL date', 'N/A')}${lifecycleLine('EOL: 2026-10-14')}`, reviewCardSource],
  ]) {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(markdown, source), /Model lifecycle EOL 2026-10-14 without an exact Model EOL date|Model lifecycle EOL 2026-12-01 without an exact Model EOL date/)
  }
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(lifecycleCard('Legacy', 'No sooner than 12/1/2026'), fableCard.source).records, [{ ...fableCard, status: 'legacy' }])
})
reviewTest('Model lifecycle line: Bedrock parses the live EOL card shape with its end-of-life banner', () => {
  strictAssert.ok(commandMarkdown.includes('reached end of life on August 19, 2026') && commandMarkdown.includes(lifecycleLine('EOL: 2026-08-19')))
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(commandMarkdown, commandCard.source).records, [{ ...commandCard, status: 'legacy' }])
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(commandMarkdown.replace('+ **Model launch date:**', `${lifecycleBanner}+ **Model launch date:**`), commandCard.source), card('cohere-command-r'))
})
reviewTest('Model lifecycle line: Bedrock reads Legacy (certain regions) as legacy', () => {
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(lifecycleCard('Legacy (certain regions)', 'No sooner than 12/1/2026'), fableCard.source).records, [{ ...fableCard, status: 'legacy' }])
})
const marengoSource = new URL('model-card-twelvelabs-marengo-embed-3-0.html', BEDROCK_MODEL_CARDS_URL).href
const marengoCard = (lifecycle, eol) => cardTable(['**Endpoint**', '**Model ID**'], [['bedrock-runtime', 'twelvelabs.marengo-embed-3-0-v1:0']]) +
  cardField('Model launch date', 'Oct 29, 2025') + cardField('EOL no sooner than', 'Oct 29, 2026') + cardField('Legacy period', 'at least 6 months') +
  lifecyclePolicy('Model lifecycle (For Models Launched Prior to Sept 7 2026)') +
  (eol === undefined ? '' : cardField('Model EOL date', eol)) + (lifecycle === undefined ? '' : lifecycleLine(lifecycle))
const marengoRecord = { bedrockId: 'twelvelabs.marengo-embed-3-0-v1:0', shutdown: '2027-03-22', status: 'legacy', source: marengoSource }
const marengoLive = ['Legacy in ap-northeast-2; Active in other Regions', 'March 22, 2027 (ap-northeast-2 only)']
reviewTest('Regional lifecycle: Bedrock reads the live Marengo Embed 3.0 card as legacy at its regional EOL date', () => {
  strictAssert.deepEqual(parseBedrockModelCardMarkdown(marengoCard(...marengoLive), marengoSource), { records: [marengoRecord], skipped: [] })
  const fixture = cardMarkdown.get(marengoSource)
  strictAssert.ok(fixture.includes(lifecycleLine(marengoLive[0])) && fixture.includes(cardField('Model EOL date', marengoLive[1])))
  strictAssert.deepEqual(card('twelvelabs-marengo-embed-3-0'), { records: [marengoRecord], skipped: [] })
})
for (const [lifecycle, eol, expected] of [
  ['Legacy in ap-northeast-2; Active in other Regions', 'March 22, 2027', marengoRecord],
  ['Legacy in ap-northeast-2; Active in other Regions', 'N/A', { ...marengoRecord, shutdown: '2026-10-29', date_precision: 'tentative' }],
  ['Legacy in ap-northeast-2; Active in other Regions', undefined, { ...marengoRecord, shutdown: '2026-10-29', date_precision: 'tentative' }],
  ['Legacy in ap-northeast-2, us-gov-west-1; Active in other Regions', 'March 22, 2027 (us-gov-west-1, ap-northeast-2 only)', marengoRecord],
]) {
  reviewTest(`Regional lifecycle: Bedrock marks ${lifecycle} with Model EOL date ${eol ?? '(absent)'} legacy`, () => {
    strictAssert.deepEqual(parseBedrockModelCardMarkdown(marengoCard(lifecycle, eol), marengoSource).records, [expected])
  })
}
for (const value of [
  'Legacy in ap-northeast-2', 'Legacy in ap-northeast-2; Active in other regions', 'Legacy in ap-northeast-2;Active in other Regions', 'legacy in ap-northeast-2; Active in other Regions',
  'Active in ap-northeast-2; Legacy in other Regions', 'Active in ap-northeast-2; Active in other Regions', 'Legacy in ap-northeast-2; Retired in other Regions', 'Legacy in ap-northeast-2; Legacy in other Regions',
  'Deprecated in ap-northeast-2; Active in other Regions', 'Retired in ap-northeast-2; Active in other Regions', 'Legacy in Seoul; Active in other Regions', 'Legacy in AP-NORTHEAST-2; Active in other Regions',
  'Legacy in ap-northeast-2 and us-east-1; Active in other Regions', 'Legacy in ap-northeast-2,us-east-1; Active in other Regions', 'Legacy in ap-northeast-2, ; Active in other Regions', 'Legacy in ; Active in other Regions',
  'Legacy in ap-northeast-2; EOL: 2027-03-22 in us-east-1; Active in other Regions', 'Legacy in ap-northeast-2; Active in other Regions; EOL: 2027-03-22', 'Legacy (certain regions) in ap-northeast-2; Active in other Regions',
  'Legacy in ap-northeast-2 (certain regions); Active in other Regions', 'EOL: 2027-3-22 in ap-northeast-2; Active in other Regions', 'EOL: March 22, 2027 in ap-northeast-2; Active in other Regions', 'Legacy in ap-northeast-2; Active in other Regions.',
  'EOL: 2027-03-22 in ap-northeast-2; Active in other Regions', 'EOL: 2027-03-22 in ap-northeast-2, eu-west-1; Active in other Regions', 'EOL: 2027-03-23 in ap-northeast-2; Active in other Regions', 'EOL: 2027-02-30 in ap-northeast-2; Active in other Regions',
  'EOL: 2027-03-22 (certain regions) in ap-northeast-2; Active in other Regions',
]) {
  reviewTest(`Regional lifecycle: Bedrock rejects an unrecognised regional value: ${value}`, () => {
    for (const eol of ['March 22, 2027', 'March 22, 2027 (ap-northeast-2 only)', 'N/A', undefined]) {
      strictAssert.throws(() => parseBedrockModelCardMarkdown(marengoCard(value, eol), marengoSource), error =>
        error.message.includes(marengoSource) && error.message.includes(`unrecognised Model lifecycle: ${value}`), String(eol))
    }
  })
}
for (const lifecycle of [undefined, 'Active', 'Legacy', 'Legacy (certain regions)', 'EOL: 2027-03-22', 'EOL: 2027-03-22 (certain regions)', 'Legacy in us-east-1; Active in other Regions', 'Legacy in ap-northeast-2, us-east-1; Active in other Regions']) {
  reviewTest(`Regional lifecycle: Bedrock rejects a regional Model EOL date whose Regions differ from Model lifecycle: ${lifecycle ?? '(absent)'}`, () => {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(marengoCard(lifecycle, 'March 22, 2027 (ap-northeast-2 only)'), marengoSource), error =>
      error.message.includes(marengoSource) && error.message.includes('Model EOL date March 22, 2027 (ap-northeast-2 only) does not match the Regions in Model lifecycle'))
  })
}
for (const eol of ['March 22, 2027 (ap-northeast-2)', 'March 22, 2027 (Seoul only)', 'March 22, 2027 (ap-northeast-2 only).', 'March 22, 2027 (ap-northeast-2 only) (ap-northeast-2 only)', 'March 22, 2027 (ap-northeast-2 Only)',
  'Legacy: March 22, 2027 (ap-northeast-2 only)', 'No sooner than 3/22/2027 (ap-northeast-2 only)', 'March 2027 (ap-northeast-2 only)', 'N/A (ap-northeast-2 only)', '(ap-northeast-2 only)', 'March 22, 2027(ap-northeast-2 only)']) {
  reviewTest(`Regional lifecycle: Bedrock rejects a malformed regional Model EOL date: ${eol}`, () => {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(marengoCard(marengoLive[0], eol), marengoSource), error =>
      error.message.includes(marengoSource) && /unrecognised Model EOL date date|does not match the Regions/.test(error.message))
  })
}
reviewTest('Regional lifecycle: Bedrock keeps the floor, calendar-date, and duplicate checks on regional values', () => {
  const cases = [
    [['Legacy in ap-northeast-2; Active in other Regions', 'March 22, 2026 (ap-northeast-2 only)'], /Model EOL date 2026-03-22 precedes EOL no sooner than 2026-10-29/],
    [['Legacy in ap-northeast-2; Active in other Regions', 'February 30, 2027 (ap-northeast-2 only)'], /invalid date.*February 30, 2027/],
    [['Legacy in ap-northeast-2, ap-northeast-2; Active in other Regions', 'March 22, 2027'], /duplicate Region in ap-northeast-2, ap-northeast-2/],
    [['Legacy in ap-northeast-2; Active in other Regions', 'March 22, 2027 (ap-northeast-2, ap-northeast-2 only)'], /duplicate Region in ap-northeast-2, ap-northeast-2/],
  ]
  for (const [[lifecycle, eol], pattern] of cases) {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(marengoCard(lifecycle, eol), marengoSource), pattern, `${lifecycle} / ${eol}`)
  }
  strictAssert.throws(() => parseBedrockModelCardMarkdown(marengoCard(marengoLive[0], marengoLive[1]) + lifecycleLine('Active'), marengoSource), /duplicate Model lifecycle field/)
})
reviewTest('Regional lifecycle: the live legacy table still wins over the regional Marengo card record', () => {
  const table = { bedrockId: marengoRecord.bedrockId, status: 'legacy', legacy: '2026-09-22', eol: '2027-03-22' }
  strictAssert.deepEqual(mergeBedrockSources([table], [marengoRecord]), { records: [{ ...table, source: BEDROCK_LIFECYCLE_URL }], conflicts: [] })
  strictAssert.deepEqual(loadedBedrock.records.find(record => record.bedrockId === marengoRecord.bedrockId), { ...bedrockById.get(marengoRecord.bedrockId), source: BEDROCK_LIFECYCLE_URL })
})
for (const line of ['Model lifecycle stages are described in the user guide.\n', '[Model lifecycle](model-lifecycle.md) explains the stages.\n', '**Model lifecycle policies:** see the user guide\n']) {
  reviewTest(`Model lifecycle line: Bedrock ignores prose that opens with the words: ${JSON.stringify(line)}`, () => {
    strictAssert.deepEqual(parseBedrockModelCardMarkdown(fableMarkdown.replace('+ **Model launch date:**', `${line}+ **Model launch date:**`), fableCard.source).records, [fableCard])
  })
}
for (const value of ['active', 'LEGACY', 'Deprecated', 'Retired', 'EOL', 'EOL: 2027-9-1', 'EOL 2027-09-01', 'EOL: September 1, 2027', 'EOL: 2027-09-01 (some regions)', 'EOL: 2027-09-01 (certain regions', 'Legacy (some regions)', 'Active; EOL: 2027-09-01']) {
  reviewTest(`Model lifecycle line: Bedrock rejects an unrecognised value: ${value}`, () => {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(lifecycleCard(value), fableCard.source), error =>
      error.message.includes(fableCard.source) && error.message.includes(`unrecognised Model lifecycle: ${value}`))
  })
}
reviewTest('Model lifecycle line: Bedrock rejects an EOL line with an impossible calendar date', () => {
  strictAssert.throws(() => parseBedrockModelCardMarkdown(lifecycleCard('EOL: 2027-02-30'), fableCard.source), /Model lifecycle EOL must be a real calendar date/)
})
for (const value of ['EOL: 2027-09-02', 'EOL: 2027-09-02 (certain regions)']) {
  reviewTest(`Model lifecycle line: Bedrock rejects ${value} that differs from the exact Model EOL date`, () => {
    for (const eol of ['September 1, 2027', 'Legacy: September 1, 2027']) {
      strictAssert.throws(() => parseBedrockModelCardMarkdown(lifecycleCard(value, eol), fableCard.source), /Model lifecycle EOL 2027-09-02 differs from Model EOL date 2027-09-01/)
    }
  })
}
reviewTest('Model lifecycle line: Bedrock rejects a duplicate Model lifecycle line', () => {
  for (const second of ['Active', 'Legacy']) {
    strictAssert.throws(() => parseBedrockModelCardMarkdown(fableMarkdown.replace(lifecycleLine('Active'), lifecycleLine('Active') + lifecycleLine(second)), fableCard.source), /duplicate Model lifecycle field/)
  }
})
for (const fragment of ['> Model lifecycle: Legacy\n', '### MODEL LIFECYCLE : Legacy\n', 'Details: Model lifecycle: Legacy\n', 'Context window: 8K tokens; Model lifecycle: Legacy\n', cellTable('Model lifecycle: EOL: 2027-09-01')]) {
  reviewTest(`Model lifecycle line: Bedrock accounts for Model lifecycle outside its field line: ${JSON.stringify(fragment)}`, () => {
    for (const markdown of [reviewCard + fragment, `${fableMarkdown}\n${fragment}`]) {
      strictAssert.throws(() => parseReviewCard(markdown), /unaccounted Model lifecycle field outside its field line/)
    }
  })
}
for (const line of ['**Model lifecycle** Legacy', '**Model lifecycle -** Legacy', 'MODEL LIFECYCLE Legacy', '**Model lifecycle status:** Legacy', '**Model lifecycle**', 'Model lifecycle status: Legacy', '<span class="x"><b>Model lifecycle status:</b></span> Legacy', '<strong>Model lifecycle stage</strong> retired', '__Model lifecycle stage__ retired', '+ **Model lifecycle stage** retired']) {
  reviewTest(`Model lifecycle line: Bedrock rejects a line that opens with Model lifecycle in another shape: ${line}`, () => {
    for (const markdown of [`${reviewCard}${line}\n`, fableMarkdown.replace(lifecycleLine('Active'), `${line}\n`)]) {
      strictAssert.throws(() => parseReviewCard(markdown), /unrecognised Model lifecycle field: Model lifecycle/i)
    }
  })
}
reviewTest('Model lifecycle line: the policy line, its link texts, and the EOL banner are not Model lifecycle fields', () => {
  for (const text of ['Model lifecycle (For Models Launched Prior to Sept 7 2026)', 'Model lifecycle', 'Bedrock Model Lifecycle']) {
    const markdown = reviewCard + lifecycleBanner + lifecyclePolicy(text)
    strictAssert.deepEqual(parseReviewCard(markdown), parseReviewCard(reviewCard))
    strictAssert.equal(parseReviewCard(markdown + lifecycleLine('Legacy')).records[0]?.status, 'legacy')
  }
})
for (const [url, markdown] of cardMarkdown) {
  reviewTest(`Third pass F2: Fixture lifecycle labels appear only in their field lines: ${path.basename(new URL(url).pathname)}`, () => {
    const outsideFields = stripComments(markdown).split('\n')
      .filter(line => !/^\s*[-*+]\s+\*\*(?:Model launch date|EOL no sooner than|Legacy period|Model lifecycle policy|Model EOL date):\*\*/.test(line))
      .join(' ').replace(/\s+/g, ' ')
    strictAssert.doesNotMatch(outsideFields, /\b(?:Model launch date|EOL no sooner than|Legacy period|Model lifecycle policy|Model EOL date)\b/i)
  })
}
const reviewLegacy = { bedrockId: 'anthropic.example-20260101-v1:0', legacy: '2026-08-01', eol: '2026-12-01', status: 'legacy', source: BEDROCK_LIFECYCLE_URL }
const reviewAliasFeed = { publisher: 'anthropic', models: [{ id: 'example-20260101', aliases: ['example'], distributions: [{ via: 'vertex-ai', shutdown: '2028-01-01' }] }] }
for (const [kind, dates, conflictCount] of [
  ['different exact dates', { shutdown: '2027-12-01' }, 1],
  ['explicit exact precision', { shutdown: '2027-12-01', date_precision: 'exact' }, 1],
  ['same exact dates', { shutdown: '2026-12-01' }, 0],
  ['tentative date', { shutdown: '2027-12-01', date_precision: 'tentative' }, 0],
  ['earliest date', { shutdown: '2027-12-01', date_precision: 'earliest' }, 0],
  ['no date', {}, 0],
]) {
  const cardRecord = { bedrockId: 'anthropic.example-v1:0', status: 'active', source: reviewCardSource, ...dates }
  for (const records of [[reviewLegacy, cardRecord], [cardRecord, reviewLegacy]]) {
    reviewTest(`Second pass F8: Bedrock legacy wins alias binding with ${kind}, ${records[0] === reviewLegacy ? 'legacy' : 'card'} first`, () => {
      const merged = mergeDistributions([reviewAliasFeed], { via: 'aws-bedrock', records })
      strictAssert.deepEqual(merged.feeds[0].models[0].distributions, [reviewAliasFeed.models[0].distributions[0], {
        via: 'aws-bedrock', announced: '2026-08-01', shutdown: '2026-12-01', status: 'legacy', source: BEDROCK_LIFECYCLE_URL,
      }])
      strictAssert.equal(merged.conflicts.length, conflictCount)
      if (conflictCount) {
        strictAssert.deepEqual(merged.conflicts[0], { via: 'aws-bedrock', id: reviewLegacy.bedrockId, kept: reviewLegacy, discarded: cardRecord })
        const options = { sourceConflicts: merged.conflicts }
        strictAssert.ok(renderSemanticDiff(merged.feeds[0], merged.feeds[0], options).includes('legacy table wins'))
        strictAssert.equal(compareFeeds(merged.feeds[0], merged.feeds[0], options).changed, false)
      }
      strictAssert.equal(reviewAliasFeed.models[0].distributions.length, 1)
    })
  }
}
for (const [label, markdown] of [
  ['missing ID table', fableMarkdown.replace('| **Model ID** |', '| **Other ID** |')],
  ['invalid ID', fableMarkdown.replace('| anthropic.claude-fable-5-1 |', '| bad id |')],
  ['invalid second ID', fableMarkdown.replace(/(\| anthropic\.claude-fable-5-1 \|[\s\S]*?)\| anthropic\.claude-fable-5-1 \|/, '$1| bad id |')],
  ['empty field', eolField('')],
  ['duplicate field', `${fableMarkdown}\n${cardField('Model EOL date', 'N/A')}`],
  ['invalid human date', eolField('February 30, 2026')],
  ['unlisted ISO date', eolField('2026-09-30')],
  ['unlisted date text', eolField('Around September 30, 2026')],
  ['trailing date text', eolField('September 30, 2026 or later')],
  ['invalid floor', fableMarkdown.replace('September 1, 2027', 'September 31, 2027')],
  ['unknown month floor', fableMarkdown.replace('September 1, 2027', 'Smarch 2027')],
  ['invalid legacy period', fableMarkdown.replace('at least 6 months', 'about a year')],
  ['HTML body', `<!DOCTYPE html>\n${fableMarkdown}`],
  ...['13/1/2026', '0/1/2026', '1/0/2026', '2/29/2025', '4/31/2026', '1/1/26', '1/1/2026 extra'].map(value => [`invalid US ${value}`, eolField(`No sooner than ${value}`)]),
]) {
  let reason = ''
  try { parseBedrockModelCardMarkdown(markdown, fableCard.source) } catch (error) { reason = error.message }
  assert(reason.includes(fableCard.source), `Bedrock fails closed and names the card for ${label}`)
}
let regionConflictReason = ''
try { parseBedrockModelCardMarkdown(canvasMarkdown.replace('Legacy (EOL: 2026-09-30)', 'Legacy (EOL: 2026-10-01)'), canvasCard.source) } catch (error) { regionConflictReason = error.message }
assert(regionConflictReason.includes(canvasCard.source) && regionConflictReason.includes('differs from Model EOL date'), 'regional EOL disagreement throws naming the card')
const leapFloor = parseBedrockModelCardMarkdown(eolField('No sooner than 2/29/2028'), fableCard.source).records[0]
assert(leapFloor.shutdown === '2028-02-29', 'Bedrock accepts valid US leap dates and chooses the later floor')
const monthWithUs = parseBedrockModelCardMarkdown(eolField('No sooner than 4/28/2026').replace('September 1, 2027', 'Aug 2025'), fableCard.source).records[0]
assert(monthWithUs.shutdown === '2026-04-28', 'a month-only floor leaves the day-precision US floor operative')
assert(parseBedrockModelCardsIndexMarkdown(cardIndexMarkdown + cardIndexMarkdown).length === 12, 'Bedrock index deduplicates card links')
assert(parseBedrockModelCardsIndexMarkdown('[card](model-card-example_v1.2.md)\n<!-- [hidden](model-card-hidden.md) -->\n```\n[fenced](model-card-fenced.md)\n```\n').length === 1, 'Bedrock index accepts safe slug punctuation and ignores comments and fenced code')
for (const href of ['model-card-x.md', './model-card-x.md#lifecycle', './model-card-x.md?view=1&amp;lang=en#lifecycle', 'model-card-x.html', '<model-card-x.md>', 'model-card-x.md "Card title"', new URL('model-card-x.md', BEDROCK_MODEL_CARDS_URL).href]) {
  reviewTest(`Second pass F7: Bedrock resolves index href ${href} to the human card page`, () => {
    strictAssert.deepEqual(parseBedrockModelCardsIndexMarkdown(`[card](${href})`), [new URL('model-card-x.html', BEDROCK_MODEL_CARDS_URL).href])
  })
}
reviewTest('Second pass F7: Bedrock reads reference links and raw anchors in the index', () => {
  strictAssert.deepEqual(parseBedrockModelCardsIndexMarkdown('[card][x]\n\n[x]: model-card-x.md\n'), [new URL('model-card-x.html', BEDROCK_MODEL_CARDS_URL).href])
  strictAssert.deepEqual(parseBedrockModelCardsIndexMarkdown('Cards: <a href="./model-card-x.html">x</a>\n'), [new URL('model-card-x.html', BEDROCK_MODEL_CARDS_URL).href])
})
for (const href of ['../model-card-x.md', './nested/model-card-x.md', './model-card-.md', './model-card-x.pdf', 'https://example.test/model-card-foreign.md', 'http://[bad/model-card-x.md', 'mailto:model-card-x.md']) {
  reviewTest(`Second pass F7: Bedrock rejects an invalid card href alongside a valid link: ${href}`, () => {
    strictAssert.throws(() => parseBedrockModelCardsIndexMarkdown(`[valid](model-card-valid.md), [invalid](${href})`), error =>
      error.message.includes(BEDROCK_MODEL_CARDS_URL) && error.message.includes(href))
  })
}
const boundedIndex = count => Array.from({ length: count }, (_, index) => `[card](model-card-example-${index}.md)`).join(', ')
assert(parseBedrockModelCardsIndexMarkdown(boundedIndex(MAX_BEDROCK_MODEL_CARDS)).length === 400, 'Bedrock index accepts exactly 400 unique card links')
for (const markdown of ['', '[foreign](https://example.test/model-card-foreign.md)', boundedIndex(MAX_BEDROCK_MODEL_CARDS + 1), '<!DOCTYPE html><a href="./model-card-x.html">x</a>', '# Models\n\nNo cards yet.\n']) {
  let reason = ''
  try { parseBedrockModelCardsIndexMarkdown(markdown) } catch (error) { reason = error.message }
  assert(reason.includes(BEDROCK_MODEL_CARDS_URL), 'empty, HTML, link-free, or oversized Bedrock index fails closed with its URL')
}

const missingCardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bedrock-cards-'))
try {
  fs.writeFileSync(path.join(missingCardDir, 'bedrock-lifecycle.md'), bedrockMarkdown)
  fs.writeFileSync(path.join(missingCardDir, 'bedrock-model-cards.md'), '[missing](model-card-missing.md)\n')
  let reason = ''
  try { await loadDistributorSource('aws-bedrock', { fixtures: missingCardDir, notice: () => {} }) } catch (error) { reason = error.message }
  assert(reason.includes('bedrock-model-cards/model-card-missing.md') && reason.includes('https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-missing.html'), 'missing card fixture throws with its path and the human card URL')
  const missingCardRun = run(['--distributor', 'aws-bedrock', '--fixtures', missingCardDir, '--out', path.join(missingCardDir, 'out')])
  assert(missingCardRun.code === 1 && !fs.existsSync(path.join(missingCardDir, 'out')), 'missing card fixture stops refresh before writing feeds')
  fs.writeFileSync(path.join(missingCardDir, 'bedrock-model-cards.md'), '# Models at a glance\n\nNo cards.\n')
  const noCardsRun = run(['--distributor', 'aws-bedrock', '--fixtures', missingCardDir, '--out', path.join(missingCardDir, 'out')])
  assert(noCardsRun.code === 1 && !fs.existsSync(path.join(missingCardDir, 'out')), 'zero-link index stops refresh before writing feeds')
  fs.mkdirSync(path.join(missingCardDir, 'bedrock-model-cards'))
  fs.writeFileSync(path.join(missingCardDir, 'bedrock-model-cards.md'), [canvasCard, commandCard].map(record => `[card](${path.basename(new URL(bedrockMarkdownUrl(record.source)).pathname)})`).join(', '))
  for (const record of [canvasCard, commandCard]) {
    const markdown = cardMarkdown.get(record.source).replace(/September 30, 2026|August 19, 2026/g, 'January 1, 2028').replace(/EOL: 2026-09-30|EOL: 2026-08-19/g, 'EOL: 2028-01-01')
    fs.writeFileSync(path.join(missingCardDir, 'bedrock-model-cards', path.basename(new URL(bedrockMarkdownUrl(record.source)).pathname)), markdown)
  }
  const conflictsRun = spawnSync(process.execPath, [refresh, '--distributor', 'aws-bedrock', '--check', '--fixtures', missingCardDir], { encoding: 'utf8' })
  assert([0, 3].includes(conflictsRun.status) && conflictsRun.stdout.includes('## Source conflicts') && conflictsRun.stderr.split('\n').filter(line => line.startsWith('notice:') && line.includes('legacy table wins')).length === 2, 'Bedrock exact conflicts reach CLI diff and notices without failing refresh')
  reviewTest('Second pass F8: Bedrock alias source conflicts reach CLI diff and notices', () => {
    const filename = path.basename(new URL(bedrockMarkdownUrl(commandCard.source)).pathname)
    fs.writeFileSync(path.join(missingCardDir, 'bedrock-model-cards.md'), `[card](${filename})`)
    const cardPath = path.join(missingCardDir, 'bedrock-model-cards', filename)
    fs.writeFileSync(cardPath, fs.readFileSync(cardPath, 'utf8').replaceAll('cohere.command-r-v1:0', 'cohere.command-r-03-2024-v1:0'))
    const result = spawnSync(process.execPath, [refresh, '--distributor', 'aws-bedrock', '--check', '--fixtures', missingCardDir], { encoding: 'utf8' })
    strictAssert.ok([0, 3].includes(result.status), result.stderr)
    strictAssert.ok(result.stdout.includes('## Source conflicts') && result.stdout.includes('legacy table wins'))
    strictAssert.equal(result.stderr.split('\n').filter(line => line.startsWith('notice:') && line.includes('legacy table wins')).length, 1)
  })
} finally {
  fs.rmSync(missingCardDir, { recursive: true, force: true })
}

const crawlRequests = []
const crawlNotices = []
let activeCardRequests = 0
let maximumCardRequests = 0
const cardMarkdownByFetchUrl = new Map([...cardMarkdown].map(([url, markdown]) => [bedrockMarkdownUrl(url), markdown]))
const crawledBedrock = await loadDistributorSource('aws-bedrock', {
  notice: value => crawlNotices.push(value),
  fetchImpl: async (url, options) => {
    crawlRequests.push({ url, options })
    activeCardRequests++
    maximumCardRequests = Math.max(maximumCardRequests, activeCardRequests)
    await new Promise(resolve => setImmediate(resolve))
    activeCardRequests--
    const markdown = url === BEDROCK_LIFECYCLE_MARKDOWN_URL ? bedrockMarkdown : url === BEDROCK_MODEL_CARDS_MARKDOWN_URL ? cardIndexMarkdown : cardMarkdownByFetchUrl.get(url)
    if (markdown === undefined) throw new Error(`unexpected request ${url}`)
    return new Response(markdown)
  },
})
assert(crawlRequests.length === 14 && maximumCardRequests === 1 && JSON.stringify(crawledBedrock.records) === JSON.stringify(loadedBedrock.records), 'mocked live crawl fetches legacy, index, and twelve cards sequentially')
assert(JSON.stringify(crawlRequests.map(request => request.url)) === JSON.stringify([BEDROCK_LIFECYCLE_MARKDOWN_URL, BEDROCK_MODEL_CARDS_MARKDOWN_URL, ...cardUrls.map(bedrockMarkdownUrl)]) && crawlRequests.every(request => request.url.endsWith('.md')), 'the Bedrock crawl fetches only the Markdown copies')
assert(crawledBedrock.sourceUrl === BEDROCK_LIFECYCLE_URL && crawledBedrock.records.every(record => record.source.endsWith('.html')) && crawledBedrock.skipped.every(item => item.source.endsWith('.html')), 'Bedrock records and skipped cards cite the human pages')
assert(crawlNotices.length === 2 && crawlNotices.every(notice => /model-card-[a-z0-9-]+\.html: skipped/.test(notice) && !notice.includes('.md')), 'live crawl reports both skips with human card URLs and no floor disagreement notices')
assert(crawlRequests.every(request => request.options.headers['accept-language'] === 'en' && request.options.signal instanceof AbortSignal), 'all distributor requests use English and an abort deadline')
for (const [label, response] of [
  ['HTTP failure', () => new Response('unavailable', { status: 503 })],
  ['empty response', () => new Response('')],
  ['advertised oversized body', () => new Response('small', { headers: { 'content-length': String(MAX_DISTRIBUTOR_BODY_BYTES + 1) } })],
  ['streamed oversized body', () => ({ ok: true, body: (async function* () { yield Buffer.alloc(MAX_DISTRIBUTOR_BODY_BYTES); yield Buffer.from('x') })() })],
  ['HTML page', () => new Response('<!DOCTYPE html><html><body>card</body></html>')],
]) {
  let reason = ''
  try {
    await loadDistributorSource('aws-bedrock', {
      notice: () => {},
      fetchImpl: async url => url === BEDROCK_LIFECYCLE_MARKDOWN_URL ? new Response(bedrockMarkdown) : url === BEDROCK_MODEL_CARDS_MARKDOWN_URL ? new Response(`[card](${path.basename(new URL(bedrockMarkdownUrl(fableCard.source)).pathname)})`) : response(),
    })
  } catch (error) { reason = error.message }
  assert(reason.includes(fableCard.source), `Bedrock ${label} fails closed and names the card URL`)
}
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
const autoRouteFields = extractReplacementFields('<code>gemini-3.8-flash</code> (not available to select in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to <code>gemini-3.8-flash</code>)')
const midProseFields = extractReplacementFields('Use <code>new-model</code> instead of the old endpoint')
const trailingFields = extractReplacementFields('Migrate to <code>a-model</code> or <code>b-model</code>')
const bracketedProseFields = extractReplacementFields('Use <code>new-model</code> with [regional endpoints]')
const wrappedTokenFields = extractReplacementFields('[<code>a-model</code>]')
const caseFields = extractReplacementFields('<code>a-model</code> or the A-MODEL family')
const edgeCaseFields = extractReplacementFields('<code>a-model</code> or A-MODEL')
const prefixFields = extractReplacementFields('<code>gpt-5</code> or gpt-5-mini')
const escapedFields = extractReplacementFields('gpt-4x1 or <code>gpt-4.1</code>')
const proseConnectorFields = extractReplacementFields('or later, use <code>x-model</code>')
const separateBracketFields = extractReplacementFields('<code>x-model</code> (beta) or (preview)')
const finalPeriodFields = extractReplacementFields('Use <code>a-model</code> or <code>b-model</code>.')
const bracketedListFields = extractReplacementFields('(<code>a-model</code>) or (<code>b-model</code>)')
const spacingFields = extractReplacementFields('Use <code>a-model</code>, or <code>b-model</code> for chat')
const wildcardMarkFields = extractReplacementFields('<code>gpt-4.1</code>*')
const dotWordFields = extractReplacementFields('Use the .NET SDK with <code>a-model</code>')
const bracketedListPeriodFields = extractReplacementFields('(<code>a-model</code>) or (<code>b-model</code>).')
const openBracketSpacingFields = extractReplacementFields('Use <code>a-model</code> (<code>b-model</code> for chat)')
const squareListFields = extractReplacementFields('[<code>a-model</code>] or [<code>b-model</code>]')
const braceListFields = extractReplacementFields('{<code>a-model</code>} or {<code>b-model</code>}')
const closeBracketSpacingFields = extractReplacementFields('Use <code>a-model</code> [beta ]')
assert(parameterFields.replacement === 'target-model' && parameterFields.replacement_note === 'reasoning.mode: pro', 'replacement extraction keeps one ID and parameter guidance')
assert(JSON.stringify(optionFields.replacement_options) === JSON.stringify(['first-model', 'second-model']), 'replacement extraction preserves ordered options')
assert(!wildcardFields.replacement && JSON.stringify(wildcardFields.replacement_options) === JSON.stringify(['first-model']) && wildcardFields.replacement_note === 'second-model*', 'prose replacement tokens remain issue-only when wildcard text is present')
assert(!proseFields.replacement && JSON.stringify(proseFields.replacement_options) === JSON.stringify(['v1']), 'prose-derived replacement tokens never become patch targets')
assert(wholeCellFields.replacement === 'gemini-2.0-flash', 'whole-cell model IDs remain patchable replacements')
assert(autoRouteFields.replacement === 'gemini-3.8-flash' && autoRouteFields.replacement_note === 'not available to select in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to gemini-3.8-flash', 'replacement extraction keeps a repeated token and punctuation inside prose')
assert(midProseFields.replacement_note === 'Use new-model instead of the old endpoint', 'replacement extraction keeps a token mentioned inside prose')
assert(JSON.stringify(trailingFields.replacement_options) === JSON.stringify(['a-model', 'b-model']) && trailingFields.replacement_note === 'Migrate to', 'replacement extraction removes a trailing replacement list')
assert(bracketedProseFields.replacement_note === 'Use new-model with [regional endpoints]', 'replacement extraction keeps non-wrapper brackets inside prose')
assert(wrappedTokenFields.replacement === 'a-model' && wrappedTokenFields.replacement_note === undefined, 'replacement extraction leaves no note for a bracket-wrapped token')
assert(caseFields.replacement_note === 'the A-MODEL family', 'replacement extraction matches tokens case-sensitively')
assert(edgeCaseFields.replacement_note === 'A-MODEL', 'replacement extraction strips only exact-case tokens at the edge')
assert(prefixFields.replacement_note === 'gpt-5-mini', 'replacement extraction never strips a token out of a longer ID')
assert(escapedFields.replacement_note === 'gpt-4x1', 'replacement extraction escapes regex characters in tokens')
assert(proseConnectorFields.replacement_note === 'or later, use', 'replacement extraction keeps a leading connector that is not beside a token')
assert(separateBracketFields.replacement_note === '(beta) or (preview)', 'replacement extraction unwraps only one enclosing bracket pair')
assert(finalPeriodFields.replacement_note === 'Use', 'replacement extraction strips a trailing list that ends a sentence')
assert(JSON.stringify(bracketedListFields.replacement_options) === JSON.stringify(['a-model', 'b-model']) && bracketedListFields.replacement_note === undefined, 'replacement extraction leaves no note for a list of bracketed tokens')
assert(spacingFields.replacement_note === 'Use a-model, or b-model for chat', 'replacement extraction removes tag spacing before punctuation')
assert(wildcardMarkFields.replacement_note === undefined, 'replacement extraction drops a note without letters or digits')
assert(dotWordFields.replacement_note === 'Use the .NET SDK with', 'replacement extraction keeps the space before a word that starts with a dot')
assert(bracketedListPeriodFields.replacement_note === undefined, 'replacement extraction leaves no note for a bracketed token list that ends a sentence')
assert(openBracketSpacingFields.replacement_note === 'Use a-model (b-model for chat)', 'replacement extraction removes tag spacing after an opening bracket')
assert(squareListFields.replacement_note === undefined && braceListFields.replacement_note === undefined, 'replacement extraction leaves no note for square- or brace-bracketed token lists')
assert(closeBracketSpacingFields.replacement_note === 'Use a-model [beta]', 'replacement extraction removes spacing before a closing bracket')
assert(dateFromText('2026‑08‑26') === '2026-08-26', 'OpenAI parses nonbreaking-hyphen dates')
assert(openaiEntries.every(entry => entry.source.startsWith('https://')), 'OpenAI dated entries carry a source URL')
const feedById = new Map(openaiFeed.models.map(model => [model.id, model]))
const overlapping = openaiEntries.filter(entry => feedById.has(entry.id))
assert(overlapping.length > 0, 'OpenAI fixture overlaps the committed feed')
assert(anthropicEntries.length === 9, 'Anthropic deprecation fixture parses announcement and active status entries')
assert(anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805')?.replacement === 'claude-opus-4-8', 'Anthropic replacement parses')
assert(PROVIDERS.anthropic.deprecationsFetchUrl === `${PROVIDERS.anthropic.deprecationsUrl}.md` && anthropicEntries.every(entry => entry.source === PROVIDERS.anthropic.deprecationsUrl), 'Anthropic fetches the Markdown page but cites the human page as source')
assert(!anthropicEntries.some(entry => /temperature|top_p|top_k/.test(entry.id)), 'Anthropic Markdown fixture: the API parameter table yields no model records')
const anthropicTentative = anthropicEntries.find(entry => entry.id === 'claude-fable-5-1')
assert(anthropicTentative?.shutdown === '2027-09-01' && anthropicTentative.date_precision === 'tentative' && anthropicTentative.announced === undefined, 'Anthropic parses active tentative retirement dates without an announcement date')
assert(anthropicTentative?.source === PROVIDERS.anthropic.deprecationsUrl, 'Anthropic tentative entries carry deprecations-page provenance')
const anthropicExact = anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805')
assert(anthropicExact?.shutdown === '2026-08-05' && anthropicExact.announced === '2026-06-05' && anthropicExact.date_precision === undefined, 'Anthropic announcement rows take precedence over duplicate status rows')
assert(openaiIds.length === 3 && openaiIds.includes('gpt-5.6-sol'), 'OpenAI models endpoint fixture parses')
assert(anthropicIds.includes('claude-sonnet-4-6'), 'Anthropic models endpoint fixture parses')
const googleFixtureRows = [
  ['gemini-4-hydrogen'],
  ['gemini-3.8-live'],
  ['gemini-3.7-flash', {}, { replacement: 'gemini-3.8-flash', replacement_note: 'gemini-3.7-flash is no longer available in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to gemini-3.8-flash' }],
  ['gemini-3.6-flash'],
  ['gemini-3.5-flash', {}, { replacement: 'gemini-3.6-flash', replacement_note: 'gemini-3.5-flash is no longer available in Google AI Studio; the endpoint is not shutting down and automatically routes API requests to gemini-3.6-flash' }],
  ['gemini-3.1-flash-lite', { shutdown: '2027-05-07' }, { replacement: 'gemini-3.5-flash-lite' }],
  ['gemini-3.1-flash-tts-preview', { shutdown: '2026-12-18' }, { replacement_options: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'] }],
  ['gemini-3-pro-preview', { shutdown: '2026-03-09' }, { replacement: 'gemini-3.1-pro-preview' }],
  ['gemini-2.5-pro', { shutdown: '2026-12-01' }, { replacement: 'gemini-3.8-flash', replacement_note: 'gemini-2.5-pro is no longer available in Google AI Studio; effective December 1, 2026, API requests to gemini-2.5-pro will automatically route to gemini-3.8-flash' }],
  ['embedding-gecko-001', { shutdown: '2025-10-30' }, { replacement: 'gemini-embedding-2' }],
  ['veo-3.0-generate-001', { shutdown: '2026-06-30' }, { replacement: 'gemini-omni-1.2-flash', replacement_note: 'the GA models on the Gemini Enterprise Agent Platform' }],
  ['gemini-omni-1.1-flash', { shutdown: '2026-12-03' }, { replacement: 'gemini-omni-1.2-flash', replacement_note: 'Effective December 3, 2026, the endpoint is automatically routing API requests to gemini-omni-1.2-flash' }],
  ['gemini-decision-1'],
  ['deep-research-pro-preview-12-2025', { shutdown: '2026-10-23' }, { replacement: 'deep-research-preview-04-2026' }],
].map(([id, dates = {}, replacement = {}]) => ({ id, source: PROVIDERS.google.deprecationsUrl, ...dates, ...(dates.shutdown ? { date_precision: 'earliest' } : {}), ...replacement }))
strictAssert.deepEqual(googleEntries, googleFixtureRows, 'Google Markdown fixture: every row parses with the callout precision, deprecated sections, wrapped and linked cells, and the agent table')
assert(PROVIDERS.google.deprecationsFetchUrl === `${PROVIDERS.google.deprecationsUrl}.md` && googleEntries.every(entry => entry.source === PROVIDERS.google.deprecationsUrl), 'Google fetches the Markdown page but cites the human page as source')
assert(googleIds.length === 3 && googleIds.includes('gemini-2.5-pro'), 'Google models endpoint fixture strips the models/ prefix')
const genericStructuredMarkdown = `## 2026-01-01\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`generic-structured`', '`first-model` or `second-model`']])}${anthropicStatusTable('generic-structured', 'Retired', '2026-01-01', '2027-01-01')}`
const googleStructuredHtml = '<table><tr><th>Model</th><th>Shutdown date</th><th>Recommended replacement</th></tr><tr><td><code>google-structured</code></td><td>2027-01-01</td><td>first-model or second-model*</td></tr></table>'
const genericStructured = parseAnthropicDeprecations(genericStructuredMarkdown)[0]
const googleStructured = parseGoogleDeprecationsHtml(googleStructuredHtml)[0]
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
const anthropicAliasAnnouncementMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: aliasAnnouncementId, aliases: [aliasStatusId] }, { id: 'claude-next' }],
}, {
  deprecations: matchingAliasAnnouncement,
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const mergedAliasAnnouncement = anthropicAliasAnnouncementMerge.feed.models.find(model => model.id === aliasAnnouncementId)
assert(mergedAliasAnnouncement?.shutdown === '2027-01-01' && mergedAliasAnnouncement.date_precision === undefined && mergedAliasAnnouncement.aliases?.filter(alias => alias === aliasStatusId).length === 1, 'Anthropic merge keeps an exact announcement and its deduplicated alias')
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

const anthropicRetiredStatusMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-retired-without-announcement' }],
}, {
  deprecations: [anthropicRetiredStatus],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const mergedRetiredStatus = anthropicRetiredStatusMerge.feed.models[0]
assert(mergedRetiredStatus.announced === '2026-06-01' && mergedRetiredStatus.shutdown === '2026-08-01', 'Anthropic status lifecycle dates fill an entry without committed lifecycle data')

const anthropicRetiredStatusPreserve = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [
    { id: 'claude-retired-without-announcement', announced: '2026-05-01', shutdown: '2026-07-01', replacement: 'claude-next' },
    { id: 'claude-next' },
  ],
}, {
  deprecations: [anthropicRetiredStatus],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const preservedRetiredStatus = anthropicRetiredStatusPreserve.feed.models.find(model => model.id === 'claude-retired-without-announcement')
assert(preservedRetiredStatus.announced === '2026-06-01' && preservedRetiredStatus.shutdown === '2026-08-01' && preservedRetiredStatus.replacement === 'claude-next', 'Anthropic retired status dates replace stale exact dates while preserving replacement guidance')

const anthropicTentativeMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-opus-4-6' }],
}, {
  currentIds: ['claude-opus-4-6'],
  deprecations: [anthropicEntries.find(entry => entry.id === 'claude-opus-4-6')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const mergedTentative = anthropicTentativeMerge.feed.models[0]
assert(mergedTentative.shutdown === '2027-02-05' && mergedTentative.date_precision === 'tentative' && mergedTentative.announced === undefined, 'Anthropic tentative status fills a current model without lifecycle dates')

const anthropicAnnouncedFloorMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-opus-4-6', announced: '2026-06-01' }],
}, {
  currentIds: ['claude-opus-4-6'],
  deprecations: [anthropicEntries.find(entry => entry.id === 'claude-opus-4-6')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const announcedFloor = anthropicAnnouncedFloorMerge.feed.models[0]
assert(announcedFloor.announced === undefined && announcedFloor.shutdown === '2027-02-05' && announcedFloor.date_precision === 'tentative', 'Anthropic active status retracts a committed announcement before applying its tentative floor')

const anthropicExactMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-opus-4-6', announced: '2026-06-01', shutdown: '2026-12-01', replacement: 'claude-next' }, { id: 'claude-next' }],
}, {
  currentIds: ['claude-opus-4-6', 'claude-next'],
  deprecations: [anthropicEntries.find(entry => entry.id === 'claude-opus-4-6')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const preservedExact = anthropicExactMerge.feed.models.find(model => model.id === 'claude-opus-4-6')
assert(preservedExact.shutdown === '2027-02-05' && preservedExact.announced === undefined && preservedExact.replacement === undefined && preservedExact.date_precision === 'tentative', 'Anthropic active status retracts exact lifecycle and replacement fields before applying its floor')

const anthropicBareExactMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-opus-4-6', shutdown: '2026-06-01' }],
}, {
  currentIds: ['claude-opus-4-6'],
  deprecations: [anthropicEntries.find(entry => entry.id === 'claude-opus-4-6')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const preservedBareExact = anthropicBareExactMerge.feed.models[0]
assert(preservedBareExact.shutdown === '2027-02-05' && preservedBareExact.date_precision === 'tentative', 'Anthropic active status replaces a committed exact shutdown with its tentative floor')

const anthropicTentativeDrop = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [
    { id: 'claude-no-tentative-date', shutdown: '2027-01-01', date_precision: 'tentative', replacement: 'claude-next' },
    { id: 'claude-next' },
  ],
}, {
  currentIds: ['claude-no-tentative-date', 'claude-next'],
  deprecations: [anthropicStatusEdges.find(entry => entry.id === 'claude-no-tentative-date')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const droppedTentative = anthropicTentativeDrop.feed.models.find(model => model.id === 'claude-no-tentative-date')
assert(droppedTentative.shutdown === undefined && droppedTentative.date_precision === undefined && droppedTentative.announced === undefined && droppedTentative.replacement === undefined, 'Anthropic active N/A status retracts committed tentative lifecycle and replacement fields')

const anthropicTentativeToDeprecated = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-deprecated-exact', shutdown: '2027-01-01', date_precision: 'tentative' }],
}, {
  deprecations: [anthropicDeprecatedExact],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const exactFromDeprecated = anthropicTentativeToDeprecated.feed.models[0]
assert(exactFromDeprecated.announced === '2026-07-01' && exactFromDeprecated.shutdown === '2026-10-01' && exactFromDeprecated.date_precision === undefined, 'Anthropic deprecated status replaces a committed tentative floor with exact lifecycle dates')

const anthropicDeprecatedStatusMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-deprecated-exact' }],
}, {
  deprecations: [anthropicDeprecatedExact],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const mergedDeprecatedStatus = anthropicDeprecatedStatusMerge.feed.models[0]
assert(mergedDeprecatedStatus.announced === '2026-07-01' && mergedDeprecatedStatus.shutdown === '2026-10-01', 'Anthropic deprecated status creates an exact lifecycle entry from no committed data')

const anthropicTentativeMove = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: 'claude-opus-4-6', shutdown: '2027-01-01', date_precision: 'tentative' }],
}, {
  currentIds: ['claude-opus-4-6'],
  deprecations: [anthropicEntries.find(entry => entry.id === 'claude-opus-4-6')],
  generated: '2026-08-01T00:00:00Z',
  provider: PROVIDERS.anthropic,
})
const movedTentative = anthropicTentativeMove.feed.models[0]
assert(movedTentative.shutdown === '2027-02-05' && movedTentative.date_precision === 'tentative', 'Anthropic status replaces a committed tentative shutdown with the current floor')

for (const result of [
  anthropicAliasAnnouncementMerge,
  anthropicRetiredStatusMerge,
  anthropicRetiredStatusPreserve,
  anthropicTentativeMerge,
  anthropicAnnouncedFloorMerge,
  anthropicExactMerge,
  anthropicBareExactMerge,
  anthropicTentativeDrop,
  anthropicTentativeToDeprecated,
  anthropicDeprecatedStatusMerge,
  anthropicTentativeMove,
]) {
  const errors = validateFeed(result.feed)
  assert(errors.length === 0, `Anthropic status merge produces a valid feed: ${errors.map(error => `${error.path}: ${error.message}`).join('; ')}`)
}

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
    { bedrockId: 'anthropic.existing-model-20250101-v2:0', legacy: '2026-02-01', eol: '2027-01-01', status: 'extended-access' },
    { bedrockId: 'meta.llama3-1-405b-instruct-v1:0', legacy: '2026-08-01', eol: '2027-02-01' },
  ],
})
const distributorFeed = distributorMerge.feeds[0]
const publisherModel = distributorFeed.models.find(model => model.id === 'publisher-model-20260101')
assert(publisherModel.distributions?.[0]?.via === 'aws-bedrock' && publisherModel.distributions[0].shutdown === '2027-02-01', 'Bedrock merge upserts a distribution through a publisher alias')
const existingModel = distributorFeed.models.find(model => model.id === 'existing-model-20250101')
assert(existingModel.distributions[1].shutdown === '2027-01-01', 'Bedrock merge updates a changed EOL date in place')
assert(existingModel.distributions[1].status === 'extended-access', 'Bedrock merge carries a normalized Extended Access status')
assert(JSON.stringify(existingModel.distributions[0]) === existingBeforeForeign, 'Bedrock merge preserves foreign-via distributions')
const existingAfterFields = { ...existingModel }
delete existingAfterFields.distributions
assert(JSON.stringify(existingAfterFields) === JSON.stringify(existingBeforeFields), 'Bedrock merge preserves entry-level lifecycle and replacement fields')
assert(JSON.stringify(Object.keys(existingModel.distributions[1])) === JSON.stringify(['via', 'announced', 'shutdown', 'status', 'source']), 'Bedrock distribution fields retain canonical order')
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
let invalidBedrockRecordStatus = ''
try {
  mergeBedrockDistributions([{ publisher: 'anthropic', models: [{ id: 'invalid-status-model' }] }], {
    sourceUrl: BEDROCK_LIFECYCLE_URL,
    records: [{ bedrockId: 'anthropic.invalid-status-model-v1:0', legacy: '2026-08-01', eol: '2027-02-01', status: 'deprecated' }],
  })
} catch (error) {
  invalidBedrockRecordStatus = error.message
}
assert(invalidBedrockRecordStatus.includes('invalid status'), 'Bedrock merge refuses unknown parser status values before feed generation')

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

const azureHtml = fs.readFileSync(path.join(fixtures, 'azure-model-retirement-schedule.html'), 'utf8')
const azureSource = parseAzureModelRetirementScheduleHtml(azureHtml)
const azureRecords = azureSource.records
const azureById = id => azureRecords.find(record => record.azureId === id && record.publisher)
assert(azureRecords.length === 174, 'Azure fixture parses 174 records after duplicate collapse')
assert(azureRecords.filter(record => record.publisher === 'openai').length === 74, 'Azure OpenAI collapses 77 lifecycle rows into 74 records')
assert(azureRecords.filter(record => record.publisher === 'anthropic').length === 14, 'Azure Anthropic collapses 18 hosting rows into 14 records')
assert(azureRecords.filter(record => record.publisher === 'mistral').length === 8 && azureRecords.filter(record => record.publisher === 'cohere').length === 11, 'Azure binds both Mistral AI and Cohere hosting sections')
assert(azureRecords.filter(record => !record.publisher).length === 67, 'Azure retains all 67 unbound section rows for reporting')
assert(AZURE_PUBLISHER_BY_SECTION.size === 4 && AZURE_PUBLISHER_BY_SECTION.get('Azure OpenAI') === 'openai' && AZURE_PUBLISHER_BY_SECTION.get('Anthropic') === 'anthropic' && AZURE_PUBLISHER_BY_SECTION.get('Mistral AI') === 'mistral' && AZURE_PUBLISHER_BY_SECTION.get('Cohere') === 'cohere', 'Azure exports one publisher map keyed by section heading')
assert(azureById('gpt-4o-2024-05-13')?.shutdown === '2026-10-01' && azureById('sora-2-2025-12-08')?.shutdown === '2026-10-15', 'Azure keeps OpenAI dated versions as distinct feed candidates')
assert(azureById('text-embedding-ada-002')?.shutdown === '2028-02-09' && azureById('tts')?.version === '001', 'Azure integer versions bind to bare IDs')
assert(azureById('claude-mythos-preview')?.shutdown === '2027-04-02', 'Azure removes a trailing model qualifier before ID validation')
assert(!Object.hasOwn(azureById('claude-mythos-5-1'), 'shutdown'), 'Azure retirement dash omits shutdown')
assert(azureRecords.every(record => !Object.hasOwn(record, 'announced') && !Object.hasOwn(record, 'date_precision') && !Object.hasOwn(record, 'replacement')), 'Azure records invent no announcement, precision, or replacement')
assert(azureSource.conflicts.length === 2 && azureById('gpt-realtime-mini-2025-10-06')?.shutdown === '2026-09-21' && azureById('gpt-realtime-mini-2025-12-15')?.shutdown === '2026-12-15', 'Azure reports both fixture conflicts and keeps their earliest retirement dates')
assert(azureSource.conflicts[0]?.discarded.shutdown === '2027-04-06' && azureSource.conflicts[1]?.discarded.shutdown === '2027-06-15', 'Azure conflicts retain discarded source rows for review')

const azureRow = (model, version = '1', lifecycle = 'GA', retirement = '2027-01-01') => [model, version, lifecycle, retirement, 'ignored replacement']
const azureTable = (section, rows, headers = ['Model', 'Version', 'Lifecycle', 'Retirement date', 'Replacement']) => `<h3>${section}</h3><table><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`
const azureError = html => {
  try { parseAzureModelRetirementScheduleHtml(html) } catch (error) { return error.message }
  return ''
}
for (const [lifecycle, status] of [['GA', 'active'], ['Preview', 'active'], ['Legacy', 'active'], ['Deprecated', 'legacy'], ['Retired', 'retired']]) {
  const record = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('status-model', '-', lifecycle, '—')])).records[0]
  assert(record.status === status && !Object.hasOwn(record, 'shutdown'), `Azure ${lifecycle} maps to SPEC ${status} without inventing a date`)
}
const fineTuningHeaders = ['Model', 'Version', 'Training retirement date', 'Deployment retirement date']
const fineTuningTables = azureTable('Azure OpenAI', [['fine-tuned-openai', '1', 'invalid date', '2099-01-01']], fineTuningHeaders)
  + azureTable('Anthropic', [['fine-tuned-anthropic', '2', 'invalid date', '2099-01-01']], fineTuningHeaders)
const azureFineTuning = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('lifecycle-model')]) + fineTuningTables)
assert(azureFineTuning.records.length === 1 && azureFineTuning.records[0].azureId === 'lifecycle-model', 'Azure skips both fine-tuning tables by header detection')
assert(azureError(fineTuningTables).includes('no recognised lifecycle table'), 'fine-tuning tables alone cannot pass as an Azure lifecycle page')
assert(azureError(azureTable('Azure OpenAI', [azureRow('changed-header')], ['Model', 'Version', 'Status', 'Retirement date', 'Replacement'])).includes('invalid header row'), 'Azure rejects lifecycle header drift instead of silently skipping it')
const azureValidTable = azureTable('Azure OpenAI', [azureRow('valid-header')])
const reviewSpanGrid = tail => `<table><tr><td colspan="64" rowspan="64">x</td></tr>${'<tr></tr>'.repeat(63)}${'<tr><td colspan="64">x</td></tr>'.repeat(92)}<tr><td colspan="${tail}">x</td></tr></table>`
for (const [name, parse, html] of [
  ['Vertex', parseVertexModelVersionsHtml, vertexHtml],
  ['Azure', parseAzureModelRetirementScheduleHtml, azureValidTable],
]) {
  for (const attr of ['colspan', 'rowspan']) {
    reviewTest(`Second pass F4: ${name} rejects ${attr} above 64`, () => {
      strictAssert.throws(() => parse(`${html}<table><tr><td ${attr}="65">x</td></tr></table>`), new RegExp(`${attr}.*64`))
    })
  }
  reviewTest(`Second pass F4: ${name} accepts spans of 64 and exactly 10,000 expanded cells per table`, () => {
    strictAssert.deepEqual(parse(html + reviewSpanGrid(16) + reviewSpanGrid(16)), parse(html))
  })
  reviewTest(`Second pass F4: ${name} rejects 10,001 expanded cells including carried rowspans`, () => {
    strictAssert.throws(() => parse(html + reviewSpanGrid(17)), /10000.*expanded cells/)
  })
}
reviewTest('Comment stripping loops until no marker survives', () => {
  strictAssert.ok(!/<!--/.test(stripComments('<!<!---->--<p>Model EOL date: December 1, 2026</p>-->')))
  const nested = parseReviewCard(`${reviewCard}<!<!---->--${cardField('Model EOL date', 'December 1, 2026')}-->`)
  strictAssert.equal(nested.records[0]?.date_precision, 'tentative')
  strictAssert.throws(() => parseReviewCard(`${reviewCard}<!-- unterminated`), /unbalanced comment marker/)
  strictAssert.equal(parseReviewCard(`${reviewCard}<!--${cardField('Model EOL date', 'December 1, 2026')}--!>`).records[0]?.date_precision, 'tentative')
})
reviewTest('Second pass F4: the HTML table reader refuses colspan="9007199254740992" within bounded memory and time', () => {
  const html = `${vertexHtml}<table><tr><td colspan="9007199254740992">x</td></tr></table>`
  const script = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import { parseVertexModelVersionsHtml } from ${JSON.stringify(new URL('../distributors.mjs', import.meta.url).href)}; const html = fs.readFileSync(0, 'utf8'); assert.throws(() => parseVertexModelVersionsHtml(html), /colspan.*64/);`
  const result = spawnSync(process.execPath, ['--max-old-space-size=32', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, input: html })
  strictAssert.equal(result.status, 0, `bounded child failed: ${result.error?.code ?? result.signal ?? result.status}`)
})
for (const headers of [
  ['Model ID', 'Version', 'Status', 'Retirement date', 'Replacement'],
  ['Scheduled retirement', 'Details'],
  ['Lifecycle phase', 'Details'],
  ['Replacement model', 'Details'],
  ['Model ID', 'Version'],
  ['Model', 'Status'],
  ['Version', 'Status'],
  ['Model', 'Model ID'],
]) {
  const error = azureError(azureValidTable + azureTable('Azure OpenAI', [], headers))
  assert(error.includes('invalid header row') && error.includes(headers.join(' | ').toLowerCase()), `Azure names drifted headers: ${headers.join(' | ')}`)
}
const azureFaqTable = azureTable('FAQ', [['When is retirement?', 'See the lifecycle policy.', 'Replacement details']], ['Question', 'Answer', 'Learn more'])
assert(parseAzureModelRetirementScheduleHtml(azureFaqTable + azureValidTable + azureFaqTable).records.length === 1, 'Azure skips unrelated FAQ headers and lifecycle words in FAQ answers')
assert(azureError(azureTable('Anthropic', [azureRow('invalid model (preview)')])).includes('invalid model id'), 'Azure validates Anthropic IDs after removing a trailing qualifier')
assert(azureById('gpt-4.1-2025-04-14')?.shutdown === '2027-04-14', 'the live fine-tuning table cannot overwrite the base model retirement')

const duplicateRows = [azureRow('duplicate-model', '1', 'GA', '2027-04-06'), azureRow('duplicate-model', '2', 'Deprecated', '2026-09-21')]
for (const rows of [duplicateRows, [...duplicateRows].reverse()]) {
  const parsed = parseAzureModelRetirementScheduleHtml(azureTable('Anthropic', rows))
  assert(parsed.records.length === 1 && parsed.records[0].shutdown === '2026-09-21' && parsed.records[0].status === 'legacy' && parsed.conflicts.length === 1, 'Azure conflict resolution keeps the earlier row lifecycle regardless of source order')
}
for (const [row, diagnostic] of [
  [azureRow('invalid model'), 'invalid model id'],
  [azureRow('bad-version', 'latest'), 'unsupported version'],
  [azureRow('bad-version-date', '2026-02-30'), 'invalid date'],
  [azureRow('bad-status', '1', 'Current'), 'unsupported lifecycle status'],
  [azureRow('bad-date', '1', 'GA', '2026-02-30'), 'invalid date'],
  [azureRow('vague-date', '1', 'GA', 'No earlier than 2027-01-01'), 'invalid date'],
  [azureRow('empty-date', '1', 'GA', ''), 'invalid date'],
  [azureRow('missing-column').slice(0, 3), 'missing lifecycle columns'],
]) {
  const error = azureError(azureTable('Azure OpenAI', [row]))
  assert(error.includes(row[0]) && error.includes(diagnostic), `Azure fails closed with the row name for ${row[0]}`)
}
for (const [label, html, diagnostic] of [
  ['empty page', '', 'page is empty'],
  ['empty table', azureTable('Azure OpenAI', []), 'no model entries'],
  ['missing section', azureTable('', [azureRow('unowned-model')]), 'unowned-model'],
  ['same date conflict', azureTable('Anthropic', [azureRow('same-date'), azureRow('same-date', '2', 'Retired')]), 'same-date'],
  ['missing date conflict', azureTable('Anthropic', [azureRow('missing-date'), azureRow('missing-date', '2', 'GA', '—')]), 'missing-date'],
]) assert(azureError(html).includes(diagnostic), `Azure rejects ${label}`)

const footnoteNow = '2026-11-16T00:00:00Z'
const footnotedRow = (marker = '<sup>3</sup>') => azureRow('footnoted', '2025-04-14', 'Deprecated', `2027-04-14${marker}`)
const offerFootnote = (number, text = 'April 14, 2027 applies to all active offers for footnoted version 2025-04-14. Regional Standard deployments retired on March 31, 2026; that date is unchanged.') => `<p><sup>${number}</sup> ${text}</p>`
const footnotedTable = (rows = [footnotedRow()]) => azureTable('Azure OpenAI', rows)
const parseFootnoted = (html, now = footnoteNow) => parseAzureModelRetirementScheduleHtml(html, { now })
const footnotedError = (html, now = footnoteNow) => {
  try { parseFootnoted(html, now) } catch (error) { return error.message }
  return ''
}
const footnotedRecord = parseFootnoted(footnotedTable([footnotedRow(), azureRow('plain-row')]) + offerFootnote(3) + '<p>Provisioned deployments are not upgraded automatically; move your traffic before retirement.</p>').records[0]
assert(footnotedRecord.azureId === 'footnoted-2025-04-14' && footnotedRecord.shutdown === '2027-04-14' && !Object.hasOwn(footnotedRecord, 'date_precision'), 'Azure parses a retirement date carrying an offer-scoping footnote marker')
assert(parseFootnoted(footnotedTable() + offerFootnote(3) + azureTable('Cohere', [azureRow('other-section')]) + offerFootnote(3, 'April 1, 2027 applies to other offers.')).records[0].shutdown === '2027-04-14', 'Azure reads a retirement footnote only from its own table')
assert(parseFootnoted(footnotedTable() + offerFootnote(3) + azureTable('Azure OpenAI', [azureRow('second-table', '1', 'GA', '-')]) + '<p>Dates are subject to change.</p>').records[0].shutdown === '2027-04-14', 'Azure ends a footnote region at the next table in the same section')
assert(footnotedError(footnotedTable() + azureTable('Azure OpenAI', [azureRow('second-table')]) + offerFootnote(3)).includes('footnote 3, which the table does not define'), 'Azure does not read a footnote placed after a second table in the same section')
for (const phrase of [
  'No earlier than April 14, 2027', 'Retires at the earliest on April 14, 2027', 'April 14, 2027 or later', 'Not before April 14, 2027',
  'Earliest retirement is April 14, 2027', 'April 14, 2027 is not later than expected', 'Retirement may be extended past April 14, 2027',
  'Offers retire after April 14, 2027', 'Retirement begins on April 14, 2027', 'Retirement beginning April 14, 2027', 'Starting April 14, 2027 offers retire',
  'Retirement rolls out on April 14, 2027', 'Retirement rolling out April 14, 2027', 'A phased retirement ends April 14, 2027', 'Estimates put retirement at April 14, 2027',
  'The estimated date is April 14, 2027', 'April 14, 2027, other offers to be announced', 'April 14, 2027, other offers to be determined', 'April 14, 2027, Global Batch TBD',
  'April 14, 2027 may shift', 'April 14, 2027 might slip', 'April 14, 2027 could change', 'April 14, 2027 can be updated', 'April 14, 2027 will be revised',
  'Planned retirement is April 14, 2027', 'The target is April 14, 2027', 'Some offers retire earlier than April 14, 2027', 'Some offers retires later than April 14, 2027',
]) {
  const error = footnotedError(footnotedTable() + offerFootnote(3, `${phrase} for some offers.`))
  assert(error.includes('footnoted') && error.includes('footnote 3') && error.includes('approximate'), `Azure rejects a retirement footnote that loosens the date: ${phrase}`)
}
for (const [label, html] of [
  ['a continuation paragraph', footnotedTable() + offerFootnote(3) + '<p>Dates are subject to change.</p>'],
  ['a note before the first footnote', footnotedTable() + '<p>Dates are subject to change.</p>' + offerFootnote(3)],
  ['a footnote the row does not cite', footnotedTable() + offerFootnote(3) + offerFootnote(4, 'Dates are subject to change.')],
]) {
  const error = footnotedError(html)
  assert(error.includes('footnoted') && error.includes('footnote 3') && error.includes('subject to change'), `Azure applies the precision check to ${label} after a footnoted table`)
}
for (const hidden of ['ear\u{AD}liest', 'ear&shy;liest', 'ear&#173;liest', 'ear&#xAD;liest', 'ear\u{200B}liest', 'ear\u{200D}liest', 'ear\u{FEFF}liest', 'ear&#65279;liest', 'ear\u{2060}liest', 'ear&#8288;liest', 'ear\u{200E}liest', 'ear&#x200E;liest', 'ear\u{34F}liest', 'ear<span>liest</span>', 'ear<a href="#x">li</a>est']) {
  const error = footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 at the ${hidden} for some offers.`))
  assert(error.includes('footnote 3') && error.includes('approximate'), `Azure sees precision wording through invisible characters and inline tags: ${JSON.stringify(hidden)}`)
}
assert(footnotedError(footnotedTable() + offerFootnote(3, 'April 1<span>4</span>, 2027 applies to Global Standard.')).includes('footnote 3 has a date in an unrecognised format'), 'Azure rejects a footnote date that inline tags split into an ambiguous reading')
for (const [label, text, diagnostic, now] of [
  ['footnote without a date', 'Applies to all active customer-facing offers.', 'footnote 3 does not state the retirement date 2027-04-14'],
  ['footnote stating another date only', 'January 14, 2027 applies to all active offers.', 'footnote 3 does not state the retirement date 2027-04-14'],
  ['footnote with a later date', 'April 14, 2027 applies to Global Standard; provisioned offers retire on May 1, 2027.', 'footnote 3 states a later date 2027-05-01'],
  ['footnote with an earlier future date', 'April 14, 2027 applies to Global Standard; Regional Standard retires on December 1, 2026.', 'footnote 3 states an earlier date 2026-12-01 that is not past on 2026-11-16'],
  ['footnote date falling on the refresh day', 'April 14, 2027 applies to Global Standard; Regional Standard retired on March 31, 2026.', 'footnote 3 states an earlier date 2026-03-31 that is not past on 2026-03-31', '2026-03-31T12:00:00Z'],
  ['footnote with an invalid date', 'April 14, 2027 applies to Global Standard; Batch retired on February 30, 2026.', 'footnote 3 has an invalid date'],
  ['earlier date without a refresh day', 'April 14, 2027 applies to Global Standard; Regional Standard retired on March 31, 2026.', 'footnote 3 states an earlier date, but the parser has no valid refresh day', null],
  ['earlier date with an invalid refresh day', 'April 14, 2027 applies to Global Standard; Regional Standard retired on March 31, 2026.', 'footnote 3 states an earlier date, but the parser has no valid refresh day', 'not a date'],
]) {
  const html = footnotedTable() + offerFootnote(3, text)
  const error = now === null ? azureError(html) : footnotedError(html, now ?? footnoteNow)
  assert(error.includes('footnoted') && error.includes(diagnostic), `Azure rejects a retirement ${label}`)
}
assert(parseFootnoted(footnotedTable() + offerFootnote(3, 'April 14, 2027 applies to Global Standard; Regional Standard retired on March 31, 2026.'), '2026-04-01T00:00:00Z').records[0].shutdown === '2027-04-14', 'Azure accepts an earlier footnote date already past on the refresh day')
assert(parseFootnoted(footnotedTable() + offerFootnote(3, 'Applies on April 14, 2027 to all offers.')).records[0].shutdown === '2027-04-14' && parseAzureModelRetirementScheduleHtml(footnotedTable() + offerFootnote(3, 'Applies on April 14, 2027 to all offers.')).records[0].shutdown === '2027-04-14', 'Azure needs no refresh day when a footnote states only the cell date')
for (const hiddenDate of ['April 1\u{2060}4, 2027', 'April 1&#8288;4, 2027', 'April\u{200E} 14, 2027', 'April&#x200E; 14, 2027']) {
  assert(parseFootnoted(footnotedTable() + offerFootnote(3, `${hiddenDate} applies to Global Standard.`)).records[0].shutdown === '2027-04-14', `Azure reads a footnote date through format characters: ${JSON.stringify(hiddenDate)}`)
}
for (const hiddenDate of ['May 1\u{2060}5, 2027', 'May&#x200E; 15, 2027']) {
  assert(footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies; Batch retires on ${hiddenDate}.`)).includes('footnote 3 states a later date 2027-05-15'), `Azure sees a later footnote date through format characters: ${JSON.stringify(hiddenDate)}`)
}
for (const phrase of ['Batch is TBA', 'Batch is TBC', 'Batch retires at a later date', 'Batch dates will be communicated', 'Batch dates to be decided', 'Batch stays available until further notice']) {
  const error = footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies to Global Standard. ${phrase}.`))
  assert(error.includes('footnote 3') && error.includes('approximate'), `Azure rejects a retirement footnote that leaves a date open: ${phrase}`)
}
for (const unrecognised of ['in May 2027', 'on 1 May 2027', 'on Sept. 1, 2027', 'on 05/01/2027', 'on 2027/05/01', 'in Q3 2027', 'in mid-2027']) {
  const error = footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies to Global Standard; Batch retires ${unrecognised}.`))
  assert(error.includes('footnoted') && error.includes('footnote 3 has a date in an unrecognised format') && error.includes('2027'), `Azure rejects a footnote year outside a recognised date: ${unrecognised}`)
}
assert(footnotedError(footnotedTable() + '<p>Batch offers retire in Q3 2027.</p>' + offerFootnote(3)).includes('notes before the first footnote has a date in an unrecognised format'), 'Azure rejects an unrecognised year in the notes before the first footnote')
for (const [label, notes, diagnostic] of [
  ['a later date', 'Batch retires on May 1, 2027.', 'notes before the first footnote states a later date 2027-05-01'],
  ['an earlier future date', 'Regional Standard retires on December 1, 2026.', 'notes before the first footnote states an earlier date 2026-12-01 that is not past on 2026-11-16'],
]) {
  const error = footnotedError(footnotedTable() + `<p>${notes}</p>` + offerFootnote(3))
  assert(error.includes('footnoted') && error.includes('footnote 3') && error.includes(diagnostic), `Azure applies the footnote date rules to notes before the first footnote: ${label}`)
}
assert(parseFootnoted(footnotedTable() + '<p>Regional Standard retired on March 31, 2026.</p>' + offerFootnote(3)).records[0].shutdown === '2027-04-14', 'Azure accepts an already-past earlier date in the notes before the first footnote')
const twoFootnoteRows = [azureRow('first-cited', '2024-05-13', 'Deprecated', '2027-01-14<sup>2</sup>'), azureRow('second-cited', '2024-08-06', 'Deprecated', '2027-04-14<sup>3</sup>')]
const twoFootnotes = parseFootnoted(footnotedTable(twoFootnoteRows) + offerFootnote(2, 'Offers retire on January 14, 2027. Regional Standard retired on March 31, 2026.') + offerFootnote(3, 'April 14, 2027 applies to all active offers.'))
assert(twoFootnotes.records.map(record => record.shutdown).join() === '2027-01-14,2027-04-14', 'Azure applies footnote date rules per footnote, not across every footnote after the table')
assert(footnotedError(footnotedTable() + offerFootnote(3, 'Applies to Global Standard.') + '<p>April 14, 2027 is the date.</p>').includes('footnote 3 does not state the retirement date 2027-04-14'), 'Azure requires the cell date in the footnote paragraph itself')
assert(footnotedError(footnotedTable() + '<!-- <p><sup>3</sup> April 14, 2027 applies to all offers.</p> -->').includes('footnote 3, which the table does not define'), 'Azure ignores a commented-out footnote')
assert(parseFootnoted(footnotedTable() + offerFootnote(3) + '<!-- <p><sup>3</sup> No earlier than April 14, 2027.</p> -->').records[0].shutdown === '2027-04-14', 'Azure ignores a commented-out duplicate footnote')
for (const [lt, gt] of [['&lt;', '&gt;'], ['&#60;', '&#62;'], ['&#x3C;', '&#x3E;'], ['&amp;lt;', '&amp;gt;']]) {
  const later = footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies to Global Standard. Offers with ${lt}1,000 TPM retire on May 1, 2027. Use Portal -${gt} Deployments.`))
  assert(later.includes('footnote 3 states a later date 2027-05-01'), `Azure sees a later footnote date between encoded angle brackets: ${lt}`)
  const comment = footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies to Global Standard. ${lt}!-- No earlier than April 14, 2027 --${gt}`))
  assert(comment.includes('footnote 3') && comment.includes('approximate'), `Azure treats an encoded comment as text: ${lt}`)
}
for (const later of ['May 1, 20\u{FE0F}27', 'May 1, 20&#xFE0F;27', 'May 1\u{180B}, 2027', 'May\u{17B4} 1, 2027']) {
  assert(footnotedError(footnotedTable() + offerFootnote(3, `April 14, 2027 applies; Batch retires on ${later}.`)).includes('footnote 3 states a later date 2027-05-01'), `Azure sees a later footnote date through default-ignorable characters: ${JSON.stringify(later)}`)
}
assert(footnotedError(footnotedTable() + offerFootnote(3, 'No ear\u{FE0F}lier than April 14, 2027.')).includes('approximate'), 'Azure sees precision wording through a variation selector')
const tailRows = [azureRow('first-cited', '2024-05-13', 'Deprecated', '2027-01-14<sup>2</sup>'), azureRow('second-cited', '2024-08-06', 'Deprecated', '2027-04-14<sup>3</sup>')]
const tailFootnotes = offerFootnote(2, 'Offers retire on January 14, 2027.') + offerFootnote(3, 'April 14, 2027 applies to all active offers.')
assert(footnotedError(footnotedTable(tailRows) + tailFootnotes + '<p>Global Batch for every version above retires on May 1, 2027.</p>').includes('first-cited version 2024-05-13 retirement cites footnote 2, and the notes after the last footnote states a later date 2027-05-01'), 'Azure applies the footnote date rules to notes after the last footnote')
assert(parseFootnoted(footnotedTable(tailRows) + tailFootnotes + '<p>Regional Standard retired on March 31, 2026.</p>').records.length === 2, 'Azure accepts an already-past date after the last footnote and does not read later footnotes as trailing notes')
const azureMarkdownFootnotePage = '### Azure OpenAI\n\n| Model | Version | Lifecycle | Retirement date | Replacement |\n| --- | --- | --- | --- | --- |\n| footnoted | 2025-04-14 | Deprecated | 2027-04-14^3^ | - |\n\n^3^ April 14, 2027 applies to all active offers for footnoted version 2025-04-14. Regional Standard deployments retired on March 31, 2026; that date is unchanged.\n'
const azureClockLoad = now => loadDistributorSource('azure-ai-foundry', { fetchImpl: async () => new Response(azureMarkdownFootnotePage), now, env: {}, notice: () => {} }).then(() => '', error => error.message)
assert(await azureClockLoad('2026-11-16T00:00:00Z') === '' && (await azureClockLoad('2026-03-31T00:00:00Z')).includes('not past on 2026-03-31'), 'Azure source loading passes the injected refresh clock to the parser')
for (const [label, html] of [
  ['missing footnote', footnotedTable([footnotedRow('<sup>4</sup>')]) + offerFootnote(3)],
  ['footnote after the next heading', footnotedTable() + '<h3>Cohere</h3>' + offerFootnote(3)],
]) assert(footnotedError(html).includes('footnoted') && footnotedError(html).includes('which the table does not define'), `Azure rejects a retirement ${label}`)
assert(footnotedError(footnotedTable() + offerFootnote(3) + offerFootnote(3)).includes('footnote 3, which the table defines more than once'), 'Azure rejects a retirement duplicate footnote')
for (const marker of [' 3', '<sup>3</sup> or later', ' or later<sup>3</sup>', '<sup>3a</sup>', '<sup>3</sup><sup>4</sup>', '<b>3</b>', '<sup>approx</sup>']) {
  const error = footnotedError(footnotedTable([footnotedRow(marker)]) + offerFootnote(3) + offerFootnote(4))
  assert(error.includes('footnoted') && error.includes('invalid date'), `Azure still rejects trailing retirement junk: ${marker}`)
}
assert(footnotedError(footnotedTable([azureRow('marked-version', '2025-04-14<sup>3</sup>')]) + offerFootnote(3)).includes('unsupported version'), 'Azure still rejects a footnote marker in the version column')
assert(footnotedError(footnotedTable([azureRow('marked-lifecycle', '1', 'GA<sup>3</sup>')]) + offerFootnote(3)).includes('unsupported lifecycle status'), 'Azure still rejects a footnote marker in the lifecycle column')
assert(footnotedError(footnotedTable([azureRow('marked-model<sup>3</sup>')]) + offerFootnote(3)).includes('invalid model id'), 'Azure still rejects a footnote marker in a publisher-section model cell')

const azureSnapshotSource = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [['gpt-4', '0314', 'Retired', '2026-01-01', '-']]))
const azureSnapshotFeeds = [{ publisher: 'openai', models: [{ id: 'gpt-4-0613', aliases: ['gpt-4'] }, { id: 'gpt-4-0314' }] }]
const azureSnapshotMerge = mergeDistributions(azureSnapshotFeeds, { via: 'azure-ai-foundry', records: azureSnapshotSource.records })
assert(!azureSnapshotMerge.feeds[0].models[0].distributions && azureSnapshotMerge.feeds[0].models[1].distributions?.[0]?.shutdown === '2026-01-01' && azureSnapshotMerge.feeds[0].models[1].distributions?.[0]?.status === 'retired', 'Azure review row gpt-4 0314 retires only gpt-4-0314 despite the gpt-4 alias on gpt-4-0613')
for (const version of ['0314', '0613', '1106', '2025-01-01']) {
  const source = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('snapshot-model', version)]))
  const missing = mergeDistributions([{ publisher: 'openai', models: [{ id: 'bare-target', aliases: ['snapshot-model'] }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(!missing.feeds[0].models[0].distributions && missing.unconfirmedDistributions.some(item => item.id === `snapshot-model-${version}` && item.reason === 'source model is absent from publisher feed'), `Azure missing snapshot ${version} never falls back through a bare alias`)
  const alias = mergeDistributions([{ publisher: 'openai', models: [{ id: 'exact-alias-target', aliases: [`snapshot-model-${version}`] }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(alias.feeds[0].models[0].distributions?.length === 1, `Azure snapshot ${version} binds through an exact alias`)
}
for (const version of ['1', '2', '001', '-']) {
  assert(parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('bare-model', version)])).records[0].azureId === 'bare-model', `Azure OpenAI version ${version} uses the bare ID`)
}
for (const version of ['3', '01', '123', '12345', 'latest']) {
  assert(azureError(azureTable('Azure OpenAI', [azureRow('unsupported-version', version)])).includes('unsupported version'), `Azure OpenAI rejects unsupported version ${version}`)
}

const azureMistralFeed = JSON.parse(fs.readFileSync(path.join(root, 'feeds/mistral.json'), 'utf8'))
const azureMistralMerge = mergeDistributions([azureMistralFeed], { via: 'azure-ai-foundry', records: azureRecords.filter(record => record.section === 'Mistral AI') })
for (const id of ['mistral-medium-2505', 'mistral-small-2503']) {
  const model = azureMistralMerge.feeds[0].models.find(model => model.id === id)
  const distribution = model.distributions?.find(item => item.via === 'azure-ai-foundry')
  assert(distribution?.status === 'active' && !Object.hasOwn(distribution, 'shutdown'), `Azure fixture binds ${id} as active without shutdown`)
  const lifecycle = lifecycleFor(model, { via: 'azure-ai-foundry', today: new Date('2026-09-08T00:00:00Z'), days: 90 })
  assert(lifecycle.via === 'azure-ai-foundry' && lifecycle.status === 'ok', `Azure ${id} avoids the retired publisher fallback`)
}
for (const [section, publisher, prefix] of [['Mistral AI', 'mistral', ''], ['Cohere', 'cohere', 'Cohere-']]) {
  const modelId = publisher === 'cohere' ? 'command-r-08-2024' : 'mistral-medium-2505'
  const rows = ['1', '2', '001', '0314', '-'].map(version => azureRow(`${prefix}${modelId}`, version, 'GA', '-'))
  const source = parseAzureModelRetirementScheduleHtml(`<h2>Models sold by Azure</h2>${azureTable(section, rows)}<h2>Models from partners</h2>${azureTable(section, rows)}`)
  const merged = mergeDistributions([{ publisher, models: [{ id: modelId }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(source.records.length === 1 && merged.feeds[0].models[0].distributions?.length === 1, `Azure ${section} collapses matching integer and dash hosting rows into one distribution`)
  const alias = mergeDistributions([{ publisher, models: [{ id: 'alias-target', aliases: [modelId] }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(alias.feeds[0].models[0].distributions?.length === 1, `Azure ${section} binds exact aliases`)
  const unresolved = mergeDistributions([{ publisher, models: [{ id: modelId.toUpperCase() }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(!unresolved.feeds[0].models[0].distributions && unresolved.noPublisherFeed.length === 0 && unresolved.unconfirmedDistributions.some(item => item.publisher === publisher && item.id === modelId && item.reason), `Azure ${section} reports unresolved IDs without changing case`)
  for (const conflicting of [azureRow(`${prefix}${modelId}`, '2', 'Retired', '-'), azureRow(`${prefix}${modelId}`, '2', 'GA', '2028-01-01')]) {
    const error = azureError(azureTable(section, [azureRow(`${prefix}${modelId}`), conflicting]))
    assert(error.includes('conflicting rows') && error.includes(modelId), `Azure ${section} rejects conflicting hosting rows`)
  }
  for (const version of ['2025-01-01', 'latest']) {
    assert(azureError(azureTable(section, [azureRow(`${prefix}${modelId}`, version)])).includes('unsupported version'), `Azure ${section} rejects version ${version}`)
  }
  let wrongPublisher = ''
  try {
    mergeDistributions([{ publisher: 'openai', models: [{ id: modelId }] }], { via: 'azure-ai-foundry', records: source.records })
  } catch (error) { wrongPublisher = error.message }
  assert(wrongPublisher.includes(`binds to ${publisher}`) && wrongPublisher.includes('openai feed'), `Azure ${section} derives the publisher from its heading`)
}
for (const [sourceId, normalizedId, binds] of [
  ['Cohere-command-r-08-2024', 'command-r-08-2024', true],
  ['cohere-command-r-08-2024', 'command-r-08-2024', true],
  ['command-r-08-2024', 'command-r-08-2024', true],
  ['COHERE-command-r-08-2024', 'COHERE-command-r-08-2024', false],
  ['Cohere-cohere-command-r-08-2024', 'cohere-command-r-08-2024', false],
]) {
  const source = parseAzureModelRetirementScheduleHtml(azureTable('Cohere', [azureRow(sourceId)]))
  const merged = mergeDistributions([{ publisher: 'cohere', models: [{ id: 'command-r-08-2024' }] }], { via: 'azure-ai-foundry', records: source.records })
  assert(binds ? merged.feeds[0].models[0].distributions?.length === 1 : !merged.feeds[0].models[0].distributions && merged.unconfirmedDistributions.some(item => item.id === normalizedId), `Azure Cohere strips at most one supported prefix from ${sourceId}`)
}

const azureSingleSource = parseAzureModelRetirementScheduleHtml(
  azureTable('Azure OpenAI', [
    ['gpt-5.5', '2026-04-24', 'GA', '2027-10-26', '-'],
    ['gpt-5-chat', '2025-08-07', 'GA', '2027-01-01', 'gpt-5.5'],
    ['gpt-5-chat', '2025-10-03', 'GA', '2027-02-01', 'gpt-5.5'],
    azureRow('absent-bare-model', '2026-04-24'),
  ]) + azureTable('OpenAI-OSS', [azureRow('gpt-5.5', '2026-04-24')]),
)
const azureSingleFeed = { publisher: 'openai', models: [{ id: 'gpt-5.5' }, { id: 'gpt-5-chat' }] }
const azureSingleBinding = mergeDistributions([azureSingleFeed], { via: 'azure-ai-foundry', records: azureSingleSource.records })
assert(azureSingleBinding.feeds[0].models[0].distributions?.[0]?.shutdown === '2027-10-26' && azureSingleBinding.feeds[0].models[0].distributions[0].status === 'active' && !azureSingleBinding.unconfirmedDistributions.some(row => row.id.startsWith('gpt-5.5')), 'Azure single dated gpt-5.5 row binds to its bare ID despite replacement mentions and other sections')
assert(!azureSingleBinding.feeds[0].models[1].distributions && azureSingleBinding.unconfirmedDistributions.filter(row => row.id.startsWith('gpt-5-chat-')).length === 2, 'Azure gpt-5-chat with two source rows stays unconfirmed')
assert(azureSingleBinding.unconfirmedDistributions.some(row => row.id === 'absent-bare-model-2026-04-24'), 'Azure single dated row stays unconfirmed when its bare ID is absent')
const azureWrongBare = mergeDistributions([{ publisher: 'anthropic', models: [{ id: 'gpt-5.5' }] }], { via: 'azure-ai-foundry', records: azureSingleSource.records })
assert(!azureWrongBare.feeds[0].models[0].distributions && azureWrongBare.unconfirmedDistributions.some(row => row.id === 'gpt-5.5-2026-04-24'), 'Azure single dated fallback resolves only within the OpenAI feed')
const azureFourDigitSource = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [['gpt-4-32k', '2023-06-13', 'GA', '2027-01-01', '-']]))
const azureFourDigit = mergeDistributions([{ publisher: 'openai', models: [{ id: 'gpt-4-32k' }, { id: 'gpt-4-32k-0613' }, { id: 'gpt-4-32k-0314' }] }], { via: 'azure-ai-foundry', records: azureFourDigitSource.records })
assert(azureFourDigit.feeds[0].models.every(model => !model.distributions) && azureFourDigit.unconfirmedDistributions.some(row => row.id === 'gpt-4-32k-2023-06-13'), 'Azure single dated fallback stays unconfirmed when four-digit snapshots exist')
for (const duplicateRetirement of ['2027-10-26', '2027-09-26']) {
  const parsed = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('gpt-5.5', '2026-04-24', 'GA', '2027-10-26')]) + azureTable('Azure OpenAI', [azureRow('gpt-5.5', '2026-04-24', 'GA', duplicateRetirement)]))
  const merged = mergeDistributions([azureSingleFeed], { via: 'azure-ai-foundry', records: parsed.records })
  assert(parsed.records.length === 1 && parsed.records[0].modelRowCount === 2 && !merged.feeds[0].models[0].distributions && merged.unconfirmedDistributions.some(row => row.id === 'gpt-5.5-2026-04-24'), 'Azure counts source rows across tables before deduplication or conflict resolution')
}
const azureFixtureSingle = mergeDistributions([azureSingleFeed], { via: 'azure-ai-foundry', records: azureSource.records })
assert(azureFixtureSingle.feeds[0].models[0].distributions?.[0]?.shutdown === '2027-10-26' && !azureFixtureSingle.feeds[0].models[1].distributions && azureFixtureSingle.unconfirmedDistributions.filter(row => row.id.startsWith('gpt-5-chat-')).length === 2, 'Azure fixture confirms gpt-5.5 and keeps both gpt-5-chat rows unconfirmed')

const azureMergeInput = [
  { publisher: 'openai', models: [
    { id: 'dated-model-2025-01-01', aliases: ['dated-model'], shutdown: '2026-01-01', notes: 'preserve', distributions: [{ via: 'vertex-ai', shutdown: '2026-02-01' }] },
    { id: 'alias-target', aliases: ['dated-alias-2025-01-01'] },
    { id: 'missing-dated', distributions: [{ via: 'azure-ai-foundry', shutdown: '2026-03-01' }] },
    { id: 'integer-model' },
    { id: 'dash-model' },
    { id: 'unbound-collision' },
  ] },
  { publisher: 'anthropic', models: [{ id: 'claude-sonnet-4-5-20250929', aliases: ['claude-sonnet-4-5'] }] },
]
const azureMergeBefore = JSON.stringify(azureMergeInput)
const azureBindingSource = parseAzureModelRetirementScheduleHtml(
  azureTable('Azure OpenAI', [azureRow('dated-model', '2025-01-01'), azureRow('dated-alias', '2025-01-01'), azureRow('missing-dated', '2025-01-01'), azureRow('missing-dated', '2025-02-01'), azureRow('integer-model', '001'), azureRow('dash-model', '-')])
  + azureTable('Anthropic', [azureRow('claude-sonnet-4-5', '1'), azureRow('claude-sonnet-4-5', '2')])
  + azureTable('OpenAI-OSS', [azureRow('unbound-collision'), azureRow('invalid model'), azureRow('')])
)
const azureBinding = mergeDistributions(azureMergeInput, { via: 'azure-ai-foundry', records: azureBindingSource.records })
const boundAzureModel = id => azureBinding.feeds.flatMap(feed => feed.models).find(model => model.id === id)
const azureDistribution = id => boundAzureModel(id)?.distributions?.find(distribution => distribution.via === 'azure-ai-foundry')
assert(azureDistribution('dated-model-2025-01-01')?.shutdown === '2027-01-01' && azureDistribution('alias-target')?.shutdown === '2027-01-01', 'Azure dated candidates resolve only by exact ID or exact alias')
assert(azureDistribution('missing-dated')?.shutdown === '2026-03-01' && azureBinding.unconfirmedDistributions.some(item => item.id === 'missing-dated-2025-01-01' && item.reason), 'multiple Azure dated rows remain unconfirmed without falling back to the bare model')
assert(azureBinding.unconfirmedDistributions.some(item => item.id === 'missing-dated' && item.distribution), 'Azure retains and reports existing distributions absent from the source')
assert(azureDistribution('integer-model')?.shutdown === '2027-01-01' && azureDistribution('dash-model')?.shutdown === '2027-01-01', 'Azure integer and dash versions merge through bare IDs')
assert(azureDistribution('claude-sonnet-4-5-20250929')?.shutdown === '2027-01-01' && boundAzureModel('claude-sonnet-4-5-20250929').distributions.length === 1, 'Azure Anthropic hosting variants resolve through the bare alias exactly once')
assert(azureBinding.noPublisherFeed.length === 3 && azureBinding.noPublisherFeed.filter(item => item.reason === 'invalid model id').length === 2 && !azureDistribution('unbound-collision'), 'unbound Azure sections never bind to matching IDs and report invalid IDs without throwing')
assert(JSON.stringify(azureMergeInput) === azureMergeBefore && boundAzureModel('dated-model-2025-01-01').shutdown === '2026-01-01' && boundAzureModel('dated-model-2025-01-01').notes === 'preserve' && boundAzureModel('dated-model-2025-01-01').distributions[0].via === 'vertex-ai', 'Azure merge preserves input feeds, publisher fields, and foreign distributions')
assert(azureDistribution('integer-model').source === AZURE_MODEL_RETIREMENT_SCHEDULE_URL && JSON.stringify(Object.keys(azureDistribution('integer-model'))) === JSON.stringify(['via', 'shutdown', 'status', 'source']), 'Azure writes only the supported distribution fields and schedule source')
const azureDateRemoval = mergeDistributions(azureBinding.feeds, {
  via: 'azure-ai-foundry', records: parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [azureRow('integer-model', '1', 'Retired', '—')])).records,
})
const azureWithoutDate = azureDateRemoval.feeds[0].models.find(model => model.id === 'integer-model').distributions[0]
assert(azureWithoutDate.status === 'retired' && !Object.hasOwn(azureWithoutDate, 'shutdown') && !Object.hasOwn(azureWithoutDate, 'announced'), 'Azure dash removes a prior shutdown while preserving explicit retired status')
let azureBindingReason = ''
try {
  mergeDistributions([{ publisher: 'openai', models: [{ id: 'claude-collision' }] }], {
    via: 'azure-ai-foundry', records: parseAzureModelRetirementScheduleHtml(azureTable('Anthropic', [azureRow('claude-collision')])).records,
  })
} catch (error) { azureBindingReason = error.message }
assert(azureBindingReason.includes('binds to anthropic') && azureBindingReason.includes('openai feed'), 'Azure section binding refuses a cross-publisher match')
const azureNotices = []
const loadedAzure = await loadDistributorSource('azure-ai-foundry', { fixtures, notice: notice => azureNotices.push(notice) })
assert(loadedAzure.records.length === 168 && loadedAzure.conflicts.length === 2 && azureNotices.filter(notice => notice.startsWith('notice:') && notice.includes('earliest retirement wins')).length === 2, 'Azure fixture loading emits one notice per source conflict')
const azureUnchangedFeed = { publisher: 'openai', models: [] }
const azureInformationalOptions = { sourceConflicts: azureSource.conflicts, unconfirmedDistributions: azureBinding.unconfirmedDistributions, noPublisherFeed: azureBinding.noPublisherFeed }
const azureInformationalDiff = compareFeeds(azureUnchangedFeed, azureUnchangedFeed, azureInformationalOptions)
const azureInformationalMarkdown = renderSemanticDiff(azureUnchangedFeed, azureUnchangedFeed, azureInformationalOptions)
assert(!azureInformationalDiff.changed && azureInformationalMarkdown.includes('## Source conflicts') && azureInformationalMarkdown.includes('2026-09-21') && azureInformationalMarkdown.includes('2027-04-06'), 'Azure source conflicts appear in semantic diffs without creating material changes')
assert(azureInformationalMarkdown.includes('distribution unconfirmed; source model is absent from publisher feed') && azureInformationalMarkdown.includes('invalid model id'), 'Azure semantic diffs distinguish unmatched source IDs from retained distributions and report invalid unbound IDs')

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
const tentativeDateDiff = renderSemanticDiff(
  { ...oldFeed, models: [{ id: 'tentative-date' }] },
  { ...oldFeed, models: [{ id: 'tentative-date', shutdown: '2027-06-09', date_precision: 'tentative' }] },
)
assert(tentativeDateDiff.includes('## Shutdown date changes') && tentativeDateDiff.includes('`not set` -> `2027-06-09` (tentative)'), 'semantic diff renders a newly added tentative shutdown in the existing date section')

const statusOld = { ...oldFeed, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', announced: '2026-03-01', shutdown: '2026-09-01', status: 'legacy' }] }] }
const statusNew = { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', announced: '2026-03-01', shutdown: '2026-09-01', status: 'extended-access' }] }] }
const statusDiff = compareFeeds(statusOld, statusNew)
const statusMarkdown = renderSemanticDiff(statusOld, statusNew)
assert(statusDiff.changed && statusDiff.distributionChanges.length === 1, 'semantic diff treats a distribution status-only transition as material')
assert(statusMarkdown.includes('status changed `legacy` -> `extended-access`'), 'semantic diff renders status-only transitions for refresh PR and Atom inputs')
const statusAdded = compareFeeds(
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01' }] }] },
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01', status: 'legacy' }] }] },
)
const statusAddedMarkdown = renderSemanticDiff(
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01' }] }] },
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01', status: 'legacy' }] }] },
)
const statusRemovedMarkdown = renderSemanticDiff(
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01', status: 'legacy' }] }] },
  { ...statusOld, models: [{ id: 'bedrock-status', distributions: [{ via: 'aws-bedrock', shutdown: '2026-09-01' }] }] },
)
assert(statusAdded.changed && statusAdded.distributionChanges.length === 1 && statusAddedMarkdown.includes('status changed `not set` -> `legacy`'), 'semantic diff treats adding a distribution status as material and rendered')
assert(statusRemovedMarkdown.includes('status changed `legacy` -> `not set`'), 'semantic diff treats removing a distribution status as material and rendered')
const distributionAdded = compareFeeds(
  { ...oldFeed, models: [{ id: 'distribution-membership' }] },
  { ...oldFeed, models: [{ id: 'distribution-membership', distributions: [{ via: 'aws-bedrock', status: 'legacy' }] }] },
)
const distributionAddedMarkdown = renderSemanticDiff(
  { ...oldFeed, models: [{ id: 'distribution-membership' }] },
  { ...oldFeed, models: [{ id: 'distribution-membership', distributions: [{ via: 'aws-bedrock', status: 'legacy' }] }] },
)
const distributionRemovedMarkdown = renderSemanticDiff(
  { ...oldFeed, models: [{ id: 'distribution-membership', distributions: [{ via: 'aws-bedrock', status: 'legacy' }] }] },
  { ...oldFeed, models: [{ id: 'distribution-membership' }] },
)
assert(distributionAdded.changed && distributionAdded.distributionChanges[0]?.kind === 'added' && distributionAddedMarkdown.includes('distribution added') && distributionAddedMarkdown.includes('status: `legacy`'), 'semantic diff keeps distribution additions material and renders status')
assert(distributionRemovedMarkdown.includes('distribution removed'), 'semantic diff keeps distribution removals material and rendered')

const aliasDiffOld = { ...oldFeed, models: [{ id: 'alias-model', aliases: ['old-alias'], shutdown: '2026-10-01' }] }
const aliasDiffNew = { ...aliasDiffOld, models: [{ id: 'alias-model', aliases: ['new-alias'], shutdown: '2026-10-01' }] }
const aliasDiff = compareFeeds(aliasDiffOld, aliasDiffNew)
const aliasDiffMarkdown = renderSemanticDiff(aliasDiffOld, aliasDiffNew)
assert(aliasDiff.changed && aliasDiffMarkdown.includes('## Alias changes') && aliasDiffMarkdown.includes('new-alias') && aliasDiffMarkdown.includes('old-alias'), 'semantic diff marks and renders alias changes')

const azureReviewSnapshot = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [
  ['gpt-4o', '2024-05-13', 'GA', '2026-09-30', '-'],
]))
for (const [label, models] of [
  ['bare alias to another snapshot', [{ id: 'gpt-4o-2024-08-06', aliases: ['gpt-4o'] }]],
  ['another dated canonical ID', [{ id: 'gpt-4o' }, { id: 'gpt-4o-2024-08-06' }]],
  ['another dated alias', [{ id: 'gpt-4o' }, { id: 'snapshot-target', aliases: ['gpt-4o-2024-08-06'] }]],
  ['dated alias on the bare model', [{ id: 'gpt-4o', aliases: ['gpt-4o-2024-08-06'] }]],
]) {
  reviewTest(`Alias review F1: Azure refuses fallback with ${label}`, () => {
    const result = mergeDistributions([{ publisher: 'openai', models }], { via: 'azure-ai-foundry', records: azureReviewSnapshot.records })
    strictAssert.ok(result.feeds[0].models.every(model => !model.distributions))
    strictAssert.deepEqual(result.unconfirmedDistributions.map(row => row.id), ['gpt-4o-2024-05-13'])
  })
}
reviewTest('Alias review F1: Azure still binds the single gpt-5.5 version', () => {
  strictAssert.equal(azureSingleBinding.feeds[0].models[0].distributions[0].shutdown, '2027-10-26')
})

const anthropicReviewRow = '| Claude API | `claude-sonnet-4-6` |'
const anthropicReviewAlias = '| Claude API alias | `claude-opus-4-5` |'
const anthropicReviewTable = anthropicTestTable(anthropicReviewRow)
for (const [label, markdown] of [
  ['comment input outside a table', `${anthropicReviewRow}\n<!-- ${anthropicReviewAlias} -->`],
  ['commented identity table', `<!--\n${anthropicReviewTable}\n-->`],
  ['backtick fenced identity table', ['```markdown', anthropicReviewTable, '```'].join('\n')],
  ['tilde fenced identity table', ['~~~markdown', anthropicReviewTable, '~~~'].join('\n')],
  ['unterminated fenced identity table', ['```markdown', anthropicReviewTable].join('\n')],
  ['three-column header', `| Platform | Model ID | Extra |\n| --- | --- | --- |\n${anthropicReviewRow}`],
  ['three-column separator', `| Platform | Model ID |\n| --- | --- | --- |\n${anthropicReviewRow}`],
  ['three-column platform row', `${anthropicReviewTable}\n| Amazon Bedrock | unused | extra |`],
  ['unknown header text', anthropicReviewTable.replace('Platform', 'Provider')],
  ['missing separator', `| Platform | Model ID |\n${anthropicReviewRow}`],
  ['nonseparator cells', `| Platform | Model ID |\n| invalid | --- |\n${anthropicReviewRow}`],
  ['detached identity row', `| Platform | Model ID |\n| --- | --- |\n\n${anthropicReviewRow}`],
  ['detached alias row', `${anthropicReviewTable}\n\n${anthropicReviewAlias}`],
]) {
  reviewTest(`Alias review F2: Anthropic refuses ${label} and names the URL`, () => {
    strictAssert.throws(() => parseAnthropicModelPage(markdown, anthropicTestUrl), error => error.message.includes(anthropicTestUrl))
  })
}
for (const [label, hidden] of [
  ['inline comment', `<!-- ${anthropicReviewAlias} -->`],
  ['multiline comment', `<!--\n${anthropicReviewAlias}\n-->`],
  ['backtick block', ['```markdown', anthropicTestTable(anthropicReviewAlias), '```'].join('\n')],
  ['tilde block', ['~~~markdown', anthropicTestTable(anthropicReviewAlias), '~~~'].join('\n')],
  ['shorter interior fence', ['````markdown', '```', anthropicTestTable(anthropicReviewAlias), '````'].join('\n')],
  ['different interior fence', ['~~~markdown', '```', anthropicTestTable(anthropicReviewAlias), '~~~'].join('\n')],
]) {
  reviewTest(`Alias review F2: Anthropic ignores alias rows inside ${label}`, () => {
    strictAssert.deepEqual(parseAnthropicModelPage(`${anthropicReviewTable}\n\n${hidden}`, anthropicTestUrl), { id: 'claude-sonnet-4-6', aliases: [] })
  })
}
reviewTest('Alias review F2: all 13 fixtures use Platform and Model ID headers and yield three aliases', () => {
  strictAssert.equal(anthropicModelUrls.length, 13)
  for (const url of anthropicModelUrls) {
    strictAssert.match(anthropicModelMarkdown(url), /^\| Platform\s+\| Model ID\s+\|\s*$/m)
  }
  strictAssert.deepEqual(anthropicPageModels.filter(model => model.aliases.length), anthropicExpectedAliases)
})

reviewTest('Alias review F3: deprecations cannot absorb a committed canonical ID', () => {
  const committed = { ...anthropicFeed, models: [{ id: 'claude-a' }, { id: 'claude-b' }] }
  const before = structuredClone(committed)
  strictAssert.throws(() => mergeFeed(committed, {
    deprecations: [{ id: 'claude-a', aliases: ['claude-b'] }],
    currentIds: ['claude-a'], provider: PROVIDERS.anthropic, notice: () => {},
  }), error => error.message.includes('claude-a') && error.message.includes('claude-b') && error.message.includes('canonical model id'))
  strictAssert.deepEqual(committed, before)
})
reviewTest('Alias review F3: deprecations cannot absorb a committed canonical ID through its alias', () => {
  strictAssert.throws(() => mergeFeed({ ...anthropicFeed, models: [{ id: 'claude-a' }, { id: 'claude-b', aliases: ['claude-indirect'] }] }, {
    deprecations: [{ id: 'claude-a', aliases: ['claude-indirect'] }],
    currentIds: ['claude-a'], provider: PROVIDERS.anthropic, notice: () => {},
  }), error => error.message.includes('claude-a') && error.message.includes('claude-b') && error.message.includes('canonical model id'))
})

reviewTest('Alias review F4: Azure counts case variants together and leaves both versions unconfirmed', () => {
  const source = parseAzureModelRetirementScheduleHtml(azureTable('Azure OpenAI', [
    ['gpt-5-chat', '2025-08-07', 'GA', '2027-01-01', '-'],
    [' GPT-5-CHAT ', '2025-10-03', 'GA', '2027-02-01', '-'],
  ]))
  const result = mergeDistributions([{ publisher: 'openai', models: [{ id: 'gpt-5-chat' }] }], { via: 'azure-ai-foundry', records: source.records })
  strictAssert.deepEqual(source.records.map(row => row.modelRowCount), [2, 2])
  strictAssert.ok(!result.feeds[0].models[0].distributions)
  strictAssert.deepEqual(result.unconfirmedDistributions.map(row => row.id), ['gpt-5-chat-2025-08-07', 'GPT-5-CHAT-2025-10-03'])
})

for (const lifecycle of [{}, { shutdown: '2026-12-01' }]) {
  reviewTest(`Alias review F5: a new ${lifecycle.shutdown ? 'dated' : 'current'} model lists its aliases`, () => {
    const committed = { ...anthropicFeed, models: [] }
    const generated = { ...committed, models: [{ id: 'claude-new', aliases: ['claude-moving', 'claude-added'], ...lifecycle }] }
    const rendered = renderSemanticDiff(committed, generated)
    strictAssert.match(rendered, /^- `claude-new`[^\n]*aliases: `claude-moving`, `claude-added`/m)
  })
}
reviewTest('Alias review F5: moving an alias to a newly added model names its destination', () => {
  const committed = { ...anthropicFeed, models: [{ id: 'claude-old', aliases: ['claude-moving'] }] }
  const incoming = { id: 'claude-new', aliases: ['claude-moving'] }
  const merged = mergeFeed(committed, { currentModels: [incoming], provider: PROVIDERS.anthropic, notice: () => {} }).feed
  strictAssert.deepEqual(compareFeeds(committed, merged).added.map(model => model.id), ['claude-new'])
  const rendered = renderSemanticDiff(committed, merged)
  strictAssert.match(rendered, /^- `claude-new`[^\n]*aliases: `claude-moving`/m)
  strictAssert.match(rendered, /^- `claude-old` - aliases removed: `claude-moving`/m)
  const direct = { ...committed, models: [incoming] }
  strictAssert.deepEqual(compareFeeds(committed, direct).added.map(model => model.id), ['claude-new'])
  strictAssert.match(renderSemanticDiff(committed, direct), /^- `claude-new`[^\n]*aliases: `claude-moving`/m)
})

reviewTest('Alias review F6: keyless page-only discoveries appear only as added', () => {
  const committed = { ...anthropicFeed, models: [] }
  const merged = mergeFeed(committed, { currentIds: null, currentModels: anthropicExpectedAliases, provider: PROVIDERS.anthropic, notice: () => {} })
  strictAssert.deepEqual(merged.unconfirmedIds, [])
  const diff = compareFeeds(committed, merged.feed, merged)
  strictAssert.deepEqual(diff.added, anthropicExpectedAliases)
  strictAssert.deepEqual(diff.unconfirmed, [])
  strictAssert.doesNotMatch(renderSemanticDiff(diff), /Unconfirmed entries|retained because neither source confirmed it/)
})
reviewTest('Alias review F6: retained models remain unconfirmed when only page identities confirm them', () => {
  const committed = { ...anthropicFeed, models: [{ id: 'claude-retained', shutdown: '2026-12-01' }] }
  const merged = mergeFeed(committed, {
    currentIds: null, currentModels: [{ id: 'claude-retained' }, { id: 'claude-discovered' }],
    provider: PROVIDERS.anthropic, notice: () => {},
  })
  strictAssert.deepEqual(merged.unconfirmedIds, ['claude-retained'])
  strictAssert.deepEqual(merged.feed.models[0], committed.models[0])
  strictAssert.deepEqual(compareFeeds(committed, merged.feed, merged).added, [{ id: 'claude-discovered' }])
})

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
const openaiMarkdown = fs.readFileSync(path.join(fixtures, 'openai-deprecations.md'), 'utf8')

const responseFor = body => ({ ok: true, status: 200, text: async () => body })

const anthropicKeylessRequests = []
const anthropicKeylessNotices = []
const anthropicKeyless = await loadProviderSources(PROVIDERS.anthropic, {
  env: {}, notice: message => anthropicKeylessNotices.push(message),
  fetchImpl: async (url, options) => {
    anthropicKeylessRequests.push({ url, options })
    if (url === PROVIDERS.anthropic.deprecationsFetchUrl) return responseFor(anthropicMarkdown)
    if (url === PROVIDERS.anthropic.aliasesUrl) return responseFor(`${anthropicIndex}\n${anthropicIndex}`)
    strictAssert.ok(anthropicModelUrls.includes(url))
    return responseFor(anthropicModelMarkdown(url))
  },
})
assert(anthropicKeyless.currentIds === null && !anthropicKeyless.endpointAvailable && JSON.stringify(anthropicKeyless.currentModels) === JSON.stringify(anthropicPageModels) && anthropicKeylessRequests.length === 15, 'keyless Anthropic refresh reads the index and every unique model page')
assert(anthropicKeylessRequests.every(({ options }) => options.signal instanceof AbortSignal && options.headers['accept-language'] === 'en' && !options.headers['x-api-key']), 'Anthropic index and page requests use bounded fetches without credentials')
assert(!anthropicKeylessRequests.some(({ url }) => new URL(url).hostname === 'api.anthropic.com') && JSON.stringify(anthropicKeyless.deprecations) === JSON.stringify(anthropicEntries) && !anthropicKeyless.sourceConflicts.length, 'keyless Anthropic refresh never calls the models API and reports no lifecycle conflicts')
strictAssert.deepEqual(anthropicKeylessNotices, ['notice: ANTHROPIC_API_KEY is unset; skipping anthropic models endpoint and preserving committed entries'])
assert(true, 'keyless Anthropic refresh prints only the unset-key notice, with no models API lifecycle summary')
for (const [index, expectedPages, diagnostic] of [
  [[...anthropicCapUrls, ...anthropicCapUrls].join('\n'), 100, undefined],
  [[...anthropicCapUrls, anthropicTestUrl].join('\n'), 0, 'cap of 100 pages'],
  ['no models', 0, 'has no model pages'],
]) {
  let pageCalls = 0
  let reason = ''
  try {
    await loadProviderSources(PROVIDERS.anthropic, {
      env: {}, notice: () => {},
      fetchImpl: async url => {
        if (url === PROVIDERS.anthropic.deprecationsFetchUrl) return responseFor(anthropicMarkdown)
        if (url === PROVIDERS.anthropic.aliasesUrl) return responseFor(index)
        pageCalls++
        return responseFor(anthropicTestTable(`| Claude API | \`claude-test-${pageCalls}\` |`))
      },
    })
  } catch (error) { reason = error.message }
  assert(pageCalls === expectedPages && (diagnostic ? reason.includes(diagnostic) : !reason), `Anthropic index loading enforces page bounds before crawling: ${diagnostic ?? '100 unique pages'}`)
}
for (const failure of ['HTTP', 'empty', 'oversized-header', 'oversized-stream']) {
  await strictAssert.rejects(loadProviderSources(PROVIDERS.anthropic, {
    env: {}, notice: () => {},
    fetchImpl: async url => {
      if (url === PROVIDERS.anthropic.deprecationsFetchUrl) return responseFor(anthropicMarkdown)
      if (url === PROVIDERS.anthropic.aliasesUrl) return responseFor(anthropicTestUrl)
      if (failure === 'HTTP') return { ok: false, status: 503 }
      if (failure === 'empty') return responseFor('')
      if (failure === 'oversized-header') return { ok: true, headers: { get: () => String(MAX_DISTRIBUTOR_BODY_BYTES + 1) } }
      return { ok: true, body: (async function* () { yield Buffer.alloc(MAX_DISTRIBUTOR_BODY_BYTES + 1) })() }
    },
  }), error => error.message.includes(anthropicTestUrl) && /HTTP 503|empty response|exceeds/.test(error.message))
  assert(true, `Anthropic page loading fails closed on ${failure}`)
}
const boundedPublishers = {
  openai: { env: { OPENAI_API_KEY: 'fixture-key' }, html: openaiMarkdown, credential: 'Authorization' },
  anthropic: { env: { ANTHROPIC_API_KEY: 'fixture-key', MODEL_EOL_CROSS_CHECKS: 'strict' }, html: anthropicMarkdown, credential: 'x-api-key' },
  google: { env: { GEMINI_API_KEY: 'fixture-key' }, html: googleMarkdown, credential: 'x-goog-api-key' },
  mistral: { env: { MISTRAL_API_KEY: 'fixture-key' }, html: mistralMarkdown, credential: 'Authorization' },
  cohere: { env: { COHERE_API_KEY: 'fixture-key' }, html: cohereMarkdown, credential: 'Authorization' },
}
const isModelsUrl = (publisher, url) => {
  const expected = new URL(PROVIDERS[publisher].modelsUrl)
  const actual = new URL(url)
  return actual.origin === expected.origin && actual.pathname === expected.pathname
}
const deprecationsPageUrl = publisher => PROVIDERS[publisher].deprecationsFetchUrl ?? PROVIDERS[publisher].deprecationsUrl
const boundedResponse = (publisher, url, override) => {
  const page = isModelsUrl(publisher, url) ? 'models' : url === deprecationsPageUrl(publisher) ? 'deprecations' : 'anthropic-page'
  if (override?.[page]) return override[page]()
  if (page === 'models') return new Response(fs.readFileSync(path.join(fixtures, `${publisher}-models.json`), 'utf8'))
  if (page === 'deprecations') return new Response(boundedPublishers[publisher].html)
  return new Response(url === PROVIDERS.anthropic.aliasesUrl ? anthropicIndex : anthropicModelMarkdown(url))
}
const loadBounded = (publisher, fetchImpl) => loadProviderSources(PROVIDERS[publisher], { env: boundedPublishers[publisher].env, notice: () => {}, fetchImpl })
for (const publisher of Object.keys(boundedPublishers)) {
  const requests = []
  const result = await loadBounded(publisher, async (url, options) => {
    requests.push({ url, options })
    return boundedResponse(publisher, url)
  })
  const { credential } = boundedPublishers[publisher]
  const models = requests.filter(request => isModelsUrl(publisher, request.url))
  assert(result.endpointAvailable && models.length >= 1 && requests.some(request => request.url === deprecationsPageUrl(publisher)), `${publisher} bounded refresh still reads its models endpoint and deprecations page`)
  assert(requests.every(({ options }) => options.signal instanceof AbortSignal && options.headers['accept-language'] === 'en'), `${publisher} models and deprecations requests carry an abort deadline and request English`)
  assert(models.every(({ options }) => options.headers[credential]?.includes('fixture-key')) && requests.filter(request => !isModelsUrl(publisher, request.url)).every(({ options }) => !Object.hasOwn(options.headers, credential)), `${publisher} bounded fetch sends ${credential} only to the models endpoint`)

  assert(models.every(({ options }) => options.redirect === 'error') && requests.filter(request => !isModelsUrl(publisher, request.url)).every(({ options }) => options.redirect === 'follow'), `${publisher} credentialed models requests refuse redirects while uncredentialed pages follow them`)
}
const oversizedBody = () => new Response(Buffer.alloc(MAX_DISTRIBUTOR_BODY_BYTES + 1, 0x20))
const oversizedHeader = () => new Response('{}', { headers: { 'content-length': String(MAX_DISTRIBUTOR_BODY_BYTES + 1) } })
const paddedModels = publisher => () => new Response(fs.readFileSync(path.join(fixtures, `${publisher}-models.json`), 'utf8') + ' '.repeat(MAX_DISTRIBUTOR_BODY_BYTES))
for (const publisher of Object.keys(boundedPublishers)) {
  for (const [label, override] of [
    ['a streamed oversized deprecations page', { deprecations: oversizedBody }],
    ['an advertised oversized deprecations page', { deprecations: oversizedHeader }],
    ['valid models JSON padded past the cap', { models: paddedModels(publisher) }],
    ['an advertised oversized models response', { models: oversizedHeader }],
  ]) {
    let reason = ''
    try { await loadBounded(publisher, async url => boundedResponse(publisher, url, override)) } catch (error) { reason = error.message }
    assert(reason.includes(`exceeds ${MAX_DISTRIBUTOR_BODY_BYTES} bytes`), `${publisher} refresh fails closed on ${label}`)
  }
}
let googleOversizedPages = 0
let googleOversizedReason = ''
try {
  await loadBounded('google', async url => {
    if (!isModelsUrl('google', url)) return boundedResponse('google', url)
    googleOversizedPages++
    return googleOversizedPages === 1 ? new Response(JSON.stringify({ models: [{ name: 'models/google-page-one' }], nextPageToken: 'two' })) : oversizedBody()
  })
} catch (error) { googleOversizedReason = error.message }
assert(googleOversizedPages === 2 && googleOversizedReason.includes('pageToken=two') && googleOversizedReason.includes('exceeds'), 'Google pagination fails closed when a later page exceeds the body cap')
let unauthorizedReason = ''
try { await loadBounded('openai', async url => boundedResponse('openai', url, { models: () => new Response('invalid api key', { status: 401 }) })) } catch (error) { unauthorizedReason = error.message }
assert(unauthorizedReason.includes('HTTP 401 - invalid api key'), 'models endpoint HTTP errors keep the response detail')
const realSetTimeout = globalThis.setTimeout
for (const page of ['deprecations', 'models']) {
  const deadlines = []
  let reason = ''
  globalThis.setTimeout = (callback, ms, ...args) => { deadlines.push(ms); return realSetTimeout(callback, ms === SOURCE_FETCH_DEADLINE_MS ? 0 : ms, ...args) }
  try {
    await loadBounded('openai', async (url, options) => {
      const target = isModelsUrl('openai', url) ? 'models' : 'deprecations'
      if (target !== page) return boundedResponse('openai', url)
      if (!options.signal) throw new Error('request has no deadline signal')
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    })
  } catch (error) { reason = error.message } finally { globalThis.setTimeout = realSetTimeout }
  assert(deadlines.includes(SOURCE_FETCH_DEADLINE_MS) && reason.includes(`exceeded the ${SOURCE_FETCH_DEADLINE_MS} ms deadline`), `a stalled ${page} request fails at the source fetch deadline`)
}
const vertexRequests = []
await loadDistributorSource('vertex-ai', { fetchImpl: async (url, options) => { vertexRequests.push(options); return new Response(fs.readFileSync(path.join(fixtures, 'vertex-model-versions.md'), 'utf8')) }, notice: () => {} })
assert(vertexRequests.length === 1 && vertexRequests[0].redirect === 'follow', 'uncredentialed distributor pages still follow redirects')
let redirectReason = ''
try {
  await loadBounded('google', async url => {
    if (!isModelsUrl('google', url)) return boundedResponse('google', url)
    throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
  })
} catch (error) { redirectReason = error.message }
assert(redirectReason.includes('fetch failed (unexpected redirect)'), 'a refused models endpoint redirect names its cause')
let rejectedHeaderReason = ''
try {
  await fetchBoundedBody('https://api.example.test/v1/models', 'openai', async () => {
    throw new TypeError('Headers.append: "Bearer sk-test-secret-value\nabc" is an invalid header value.')
  }, { headers: { authorization: 'Bearer sk-test-secret-value\nabc' } })
} catch (error) { rejectedHeaderReason = error.message }
assert(rejectedHeaderReason.includes('[redacted]') && !rejectedHeaderReason.includes('sk-test-secret-value') && !/[\r\n]/.test(rejectedHeaderReason), 'a rejected credential header is redacted and the error stays on one line')
const redirectModes = []
for (const headers of [{}, { Accept: 'text/markdown' }, { 'anthropic-version': '2023-06-01', accept: 'application/json' }, { Authorization: 'Bearer x' }, { 'x-api-key': 'k' }, { 'X-Goog-Api-Key': 'k' }, { 'X-Custom-Token': 't' }, { Cookie: 'c' }]) {
  await fetchBoundedBody('https://docs.example.test/page.md', 'example', async (url, options) => { redirectModes.push(options.redirect); return new Response('body') }, { headers })
}
await fetchBoundedBody('https://docs.example.test/page.md', 'example', async (url, options) => { redirectModes.push(options.redirect); return new Response('body') }, { headers: { 'X-Tenant': 'acme' }, secretHeaders: ['x-tenant'] })
assert(JSON.stringify(redirectModes) === JSON.stringify(['follow', 'follow', 'follow', 'error', 'error', 'error', 'error', 'error', 'error']), 'only credential headers, including ones the caller marks secret, make a fetch refuse redirects')
assert(JSON.stringify(credentialHeaderNames({ Accept: 'text/markdown', 'anthropic-version': '2023-06-01', 'x-api-key': 'k', Authorization: 'a', 'X-Tenant': 't' }, ['X-TENANT'])) === JSON.stringify(['x-api-key', 'Authorization', 'X-Tenant']), 'credentialHeaderNames separates credential headers from ordinary ones')
let ordinaryHeaderReason = ''
try {
  await fetchBoundedBody('https://api.example.test/v1/models', 'anthropic', async () => {
    throw new TypeError('request with accept text/markdown and anthropic-version 2023-06-01 failed for key sk-ant-test-secret and token tok-secret-value')
  }, { headers: { accept: 'text/markdown', 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-test-secret', Authorization: 'Bearer tok-secret-value' } })
} catch (error) { ordinaryHeaderReason = error.message }
assert(ordinaryHeaderReason.includes('accept text/markdown and anthropic-version 2023-06-01') && !ordinaryHeaderReason.includes('sk-ant-test-secret') && !ordinaryHeaderReason.includes('tok-secret-value') && ordinaryHeaderReason.split('[redacted]').length === 3, 'only credential header values are redacted, including a bearer token echoed without its scheme')
let downgradeReason = ''
try {
  await fetchBoundedBody('https://docs.example.test/page.md', 'example', async () => Object.defineProperty(new Response('body'), 'url', { value: 'http://docs.example.test/page.md' }), { headers: { Accept: 'text/markdown' } })
} catch (error) { downgradeReason = error.message }
assert(downgradeReason === 'example fetch failed for https://docs.example.test/page.md: redirected to a http: URL', 'a followed redirect from https to http is refused')
const httpsLanding = await fetchBoundedBody('https://docs.example.test/page.md', 'example', async () => Object.defineProperty(new Response('moved body'), 'url', { value: 'https://docs.example.test/moved.md' }), { headers: { Accept: 'text/markdown' } })
const plainHttp = await fetchBoundedBody('http://127.0.0.1:1/feed.json', '--feeds-url', async () => Object.defineProperty(new Response('local body'), 'url', { value: 'http://127.0.0.1:1/feed.json' }))
assert(httpsLanding === 'moved body' && plainHttp === 'local body', 'an https redirect target and a caller-chosen http URL still load')
let bomModels = null
try {
  bomModels = await loadBounded('openai', async url => isModelsUrl('openai', url)
    ? new Response(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(path.join(fixtures, 'openai-models.json'))]))
    : boundedResponse('openai', url))
} catch {}
assert(bomModels?.endpointAvailable && bomModels.currentIds.length > 0, 'a models endpoint body with a UTF-8 BOM still parses as JSON')
const slowErrorDeadlines = []
let slowErrorReason = ''
globalThis.setTimeout = (callback, ms, ...args) => { slowErrorDeadlines.push(ms); return realSetTimeout(callback, ms === SOURCE_FETCH_DEADLINE_MS ? 20 : ms, ...args) }
try {
  await loadBounded('openai', async (url, options) => {
    if (!isModelsUrl('openai', url)) return boundedResponse('openai', url)
    let sent = false
    return new Response(new ReadableStream({
      pull(stream) {
        if (!sent) { sent = true; stream.enqueue(new TextEncoder().encode('partial')); return }
        if (options.signal?.aborted) return stream.error(options.signal.reason)
        return new Promise(resolve => options.signal?.addEventListener('abort', () => { stream.error(options.signal.reason); resolve() }, { once: true }))
      },
    }), { status: 500 })
  })
} catch (error) { slowErrorReason = error.message } finally { globalThis.setTimeout = realSetTimeout }
assert(slowErrorDeadlines.includes(SOURCE_FETCH_DEADLINE_MS) && slowErrorReason.includes(`HTTP 500, then exceeded the ${SOURCE_FETCH_DEADLINE_MS} ms deadline reading the body`), 'a slow error body keeps its HTTP status when the deadline fires')
let errorPulls = 0
let errorCancelled = false
let longErrorReason = ''
try {
  await loadBounded('openai', async url => isModelsUrl('openai', url)
    ? new Response(new ReadableStream({
        pull(stream) { errorPulls++; stream.enqueue(new Uint8Array(512).fill(0x41)) },
        cancel() { errorCancelled = true },
      }), { status: 500 })
    : boundedResponse('openai', url))
} catch (error) { longErrorReason = error.message }
assert(errorCancelled && errorPulls <= 4 && longErrorReason.includes(`HTTP 500 - ${'A'.repeat(300)}`) && !longErrorReason.includes('A'.repeat(301)), 'error detail reads about 1 KiB, cancels the body, and keeps 300 characters')
const multilineError = () => new Response('first line\n::error::injected\r\n\tthird', { status: 502 })
let multilineProviderReason = ''
try { await loadBounded('openai', async url => isModelsUrl('openai', url) ? boundedResponse('openai', url) : multilineError()) } catch (error) { multilineProviderReason = error.message }
let multilineDistributorReason = ''
try { await loadDistributorSource('vertex-ai', { fetchImpl: async () => multilineError(), notice: () => {} }) } catch (error) { multilineDistributorReason = error.message }
assert([multilineProviderReason, multilineDistributorReason].every(reason => reason.includes('HTTP 502 - first line ::error::injected third') && !/[\r\n\t]/.test(reason)), 'error detail collapses whitespace so a body line cannot start an Actions workflow command')
const cohereRequests = []
const cohereLiveNotices = []
const cohereAuthenticated = await loadProviderSources(PROVIDERS.cohere, {
  env: { COHERE_API_KEY: 'fixture-key' },
  notice: message => cohereLiveNotices.push(message),
  fetchImpl: async (url, options) => {
    cohereRequests.push({ url: new URL(url), headers: options.headers })
    if (url === PROVIDERS.cohere.deprecationsFetchUrl) return responseFor(cohereMarkdown)
    if (new URL(url).searchParams.get('page_token')) {
      return responseFor(JSON.stringify({ models: [
        { name: 'command-a-03-2025', is_deprecated: false },
        { name: 'cohere-live-undated', is_deprecated: true, announced: '2000-01-01', shutdown: '2000-02-01' },
        { name: 'command-r', is_deprecated: true },
      ] }))
    }
    return responseFor(JSON.stringify({ models: [
      { name: 'command-a-03-2025', is_deprecated: false },
      { name: 'command-r-03-2024', is_deprecated: true, shutdown: '2099-01-01' },
    ], next_page_token: 'page two+/=' }))
  },
})
assert(cohereRequests.length === 3 && cohereRequests.slice(0, 2).every(request => request.headers.Authorization === 'Bearer fixture-key' && request.url.searchParams.get('page_size') === '1000') && !Object.hasOwn(cohereRequests[2].headers, 'Authorization') && cohereRequests.every(request => request.headers['accept-language'] === 'en'), 'Cohere sends Bearer credentials only to paginated models requests and requests English documents')
assert(cohereRequests[0].url.searchParams.get('page_token') === null && cohereRequests[1].url.searchParams.get('page_token') === 'page two+/=' && cohereAuthenticated.currentIds.length === 4, 'Cohere follows encoded page_token values and deduplicates ids across pages')
const cohereAuthenticatedFeed = mergeFeed(cohereSeed, { ...cohereAuthenticated, provider: PROVIDERS.cohere }).feed
assert(cohereAuthenticatedFeed.models.find(model => model.id === 'command-r-03-2024')?.shutdown === undefined && !cohereAuthenticatedFeed.models.find(model => model.id === 'cohere-live-undated')?.announced && !cohereAuthenticatedFeed.models.find(model => model.id === 'cohere-live-undated')?.shutdown && !cohereAuthenticatedFeed.models.some(model => model.id === 'command-r'), 'Cohere ignores endpoint dates and resolves endpoint aliases through page records')
assert(cohereAuthenticated.undatedDeprecatedIds.join() === 'cohere-live-undated' && cohereLiveNotices.filter(message => message.includes('without a dated announcement')).length === 1, 'Cohere endpoint notices exclude dated canonical ids and their page aliases')
const cohereKeylessRequests = []
const cohereKeyless = await loadProviderSources(PROVIDERS.cohere, {
  env: {}, notice: () => {},
  fetchImpl: async url => { cohereKeylessRequests.push(url); return responseFor(cohereMarkdown) },
})
const cohereKeylessFeed = mergeFeed(cohereMerged.feed, { ...cohereKeyless, provider: PROVIDERS.cohere }).feed
assert(cohereKeyless.currentIds === null && !cohereKeyless.endpointAvailable && cohereKeylessRequests.join() === PROVIDERS.cohere.deprecationsFetchUrl && cohereKeylessFeed.models.length === cohereMerged.feed.models.length && cohereKeylessFeed.models.find(model => model.id === 'command-r-03-2024')?.aliases?.join() === 'command-r', 'keyless Cohere refresh uses only the page and preserves committed models and aliases')
for (const mode of ['http', 'malformed', 'cycle', 'cap']) {
  let calls = 0
  let reason = ''
  try {
    await loadProviderSources(PROVIDERS.cohere, {
      env: { COHERE_API_KEY: 'fixture-key' }, notice: () => {},
      fetchImpl: async () => {
        calls++
        if (calls === 2 && mode === 'http') return { ok: false, status: 503, text: async () => 'unavailable' }
        if (calls === 2 && mode === 'malformed') return responseFor(JSON.stringify({ models: {} }))
        return responseFor(JSON.stringify({ models: [{ name: `cohere-page-${calls}` }], next_page_token: mode === 'cycle' ? ['a', 'b', 'a'][calls - 1] : `page-${calls}` }))
      },
    })
  } catch (error) {
    reason = error.message
  }
  const expected = { http: [2, 'HTTP 503'], malformed: [2, 'no models array'], cycle: [3, 'token repeated'], cap: [20, 'pagination cap of 20 pages'] }[mode]
  assert(calls === expected[0] && reason.includes(expected[1]), `Cohere pagination fails closed without partial results: ${mode}`)
}

const mistralRequests = []
const mistralEndpointBody = JSON.parse(mistralModels)
mistralEndpointBody.data[0].shutdown = '2099-01-01'
mistralEndpointBody.data.push({ id: 'mistral-fixture-current', aliases: ['mistral-fixture-latest'], announced: '2000-01-01', shutdown: '2000-02-01' })
const mistralAuthenticated = await loadProviderSources(PROVIDERS.mistral, {
  env: { MISTRAL_API_KEY: 'fixture-key' },
  notice: () => {},
  fetchImpl: async (url, options) => {
    mistralRequests.push({ url, headers: options.headers })
    return responseFor(url === PROVIDERS.mistral.modelsUrl ? JSON.stringify(mistralEndpointBody) : mistralMarkdown)
  },
})
assert(mistralRequests.length === 2 && mistralRequests[0].headers.Authorization === 'Bearer fixture-key' && !Object.hasOwn(mistralRequests[1].headers, 'Authorization') && mistralRequests.every(request => request.headers['accept-language'] === 'en'), 'Mistral sends Bearer auth only to its models endpoint')
const mistralAuthenticatedFeed = mergeFeed(mistralSeed, { ...mistralAuthenticated, provider: PROVIDERS.mistral }).feed
const mistralCurrent = mistralAuthenticatedFeed.models.find(model => model.id === 'mistral-fixture-current')
assert(mistralAuthenticatedFeed.models.find(model => model.id === 'mistral-medium-2508')?.shutdown === '2026-08-31' && mistralCurrent?.aliases?.includes('mistral-fixture-latest') && !mistralCurrent?.announced && !mistralCurrent?.shutdown, 'Mistral uses endpoint data only for current ids and aliases, never lifecycle dates')
const mistralKeylessRequests = []
const mistralKeyless = await loadProviderSources(PROVIDERS.mistral, {
  env: {},
  notice: () => {},
  fetchImpl: async url => {
    mistralKeylessRequests.push(url)
    return responseFor(mistralMarkdown)
  },
})
const mistralKeylessFeed = mergeFeed(mistralMerged.feed, { ...mistralKeyless, provider: PROVIDERS.mistral }).feed
assert(mistralKeyless.currentIds === null && !mistralKeyless.endpointAvailable && mistralKeylessRequests.join() === PROVIDERS.mistral.deprecationsFetchUrl && mistralKeylessFeed.models.find(model => model.id === 'mistral-medium-2508')?.aliases?.includes('mistral-medium-latest'), 'keyless Mistral refresh reads only the public page and preserves committed aliases')
for (const aliases of ['not-an-array', ['bad alias'], [42]]) {
  let reason = ''
  try {
    await loadProviderSources(PROVIDERS.mistral, {
      env: { MISTRAL_API_KEY: 'fixture-key' }, notice: () => {},
      fetchImpl: async () => responseFor(JSON.stringify({ object: 'list', data: [{ id: 'mistral-invalid-alias', aliases }] })),
    })
  } catch (error) {
    reason = error.message
  }
  assert(reason.includes('mistral-invalid-alias') && reason.includes('invalid aliases'), 'Mistral refuses malformed endpoint aliases with the canonical id')
}
let mistralAmbiguousAliasReason = ''
try {
  await loadProviderSources(PROVIDERS.mistral, {
    env: { MISTRAL_API_KEY: 'fixture-key' }, notice: () => {},
    fetchImpl: async () => responseFor(JSON.stringify({ object: 'list', data: [
      { id: 'mistral-first', aliases: ['mistral-shared'] },
      { id: 'mistral-second', aliases: ['mistral-shared'] },
    ] })),
  })
} catch (error) {
  mistralAmbiguousAliasReason = error.message
}
assert(mistralAmbiguousAliasReason.includes('ambiguous id or alias: mistral-shared'), 'Mistral refuses an endpoint alias claimed by multiple models')
const googleFetchOptions = fetchImpl => ({
  env: { GEMINI_API_KEY: 'fixture-key' },
  notice: () => {},
  fetchImpl,
})
const googleModelsPath = '/v1beta/models'

const googlePageUrls = []
const googlePageToken = 'opaque+/='
const paginatedGoogle = await loadProviderSources({
  ...PROVIDERS.google,
  modelsUrl: `${PROVIDERS.google.modelsUrl}?pageSize=2&alt=json&pageToken=stale`,
}, googleFetchOptions(async url => {
  const parsedUrl = new URL(url)
  if (parsedUrl.pathname === googleModelsPath) {
    googlePageUrls.push(parsedUrl)
    return parsedUrl.searchParams.get('pageToken')
      ? responseFor(JSON.stringify({
          models: [
            { name: 'models/google-shared' },
            { name: 'models/google-page-two' },
            { name: 'models/google-page-two' },
          ],
        }))
      : responseFor(JSON.stringify({
          models: [
            { name: 'models/google-page-one' },
            { name: 'models/google-shared' },
            { name: 'models/google-page-one' },
          ],
          nextPageToken: googlePageToken,
        }))
  }
  return responseFor(googleMarkdown)
}))
assert(JSON.stringify(paginatedGoogle.currentIds) === JSON.stringify(['google-page-one', 'google-shared', 'google-page-two']), 'Google models pagination combines pages and de-duplicates ids in first-seen order')
assert(googlePageUrls.length === 2 && !googlePageUrls[0].searchParams.has('pageToken') && googlePageUrls[1].searchParams.get('pageToken') === googlePageToken, 'Google models pagination starts at page one and forwards the opaque nextPageToken')
assert(googlePageUrls.every(url => url.searchParams.get('pageSize') === '2' && url.searchParams.get('alt') === 'json'), 'Google models pagination preserves page size and existing query parameters')

let googleHttpCalls = 0
let googleHttpReason = ''
const googleHttpUrls = []
try {
  await loadProviderSources(PROVIDERS.google, googleFetchOptions(async url => {
    const parsedUrl = new URL(url)
    if (parsedUrl.pathname === googleModelsPath) {
      googleHttpCalls++
      googleHttpUrls.push(parsedUrl)
      if (googleHttpCalls === 1) {
        return responseFor(JSON.stringify({ models: [{ name: 'models/google-http-one' }], nextPageToken: 'http-page-two' }))
      }
      return { ok: false, status: 503, text: async () => 'try later' }
    }
    return responseFor(googleMarkdown)
  }))
} catch (error) {
  googleHttpReason = error.message
}
assert(googleHttpCalls === 2 && googleHttpReason.includes('google fetch failed') && googleHttpReason.includes('HTTP 503'), 'Google models pagination fails closed when a later page request fails')
assert(googleHttpUrls[0]?.searchParams.get('pageSize') === '1000', 'Google models pagination requests the documented maximum page size by default')

let googleMalformedCalls = 0
let googleMalformedReason = ''
try {
  await loadProviderSources(PROVIDERS.google, googleFetchOptions(async url => {
    const parsedUrl = new URL(url)
    if (parsedUrl.pathname === googleModelsPath) {
      googleMalformedCalls++
      return googleMalformedCalls === 1
        ? responseFor(JSON.stringify({ models: [{ name: 'models/google-malformed-one' }], nextPageToken: 'malformed-page-two' }))
        : responseFor(JSON.stringify({ models: {} }))
    }
    return responseFor(googleMarkdown)
  }))
} catch (error) {
  googleMalformedReason = error.message
}
assert(googleMalformedCalls === 2 && googleMalformedReason.includes('google models response has no models array'), 'Google models pagination rejects a malformed later page without returning partial results')

let googleCycleCalls = 0
let googleCycleReason = ''
const googleCycleTokens = ['cycle-a', 'cycle-b', 'cycle-a']
try {
  await loadProviderSources(PROVIDERS.google, googleFetchOptions(async url => {
    const parsedUrl = new URL(url)
    if (parsedUrl.pathname === googleModelsPath) {
      const call = googleCycleCalls++
      return responseFor(JSON.stringify({
        models: [{ name: `models/google-cycle-${call + 1}` }],
        nextPageToken: googleCycleTokens[call],
      }))
    }
    return responseFor(googleMarkdown)
  }))
} catch (error) {
  googleCycleReason = error.message
}
assert(googleCycleCalls === 3 && googleCycleReason.includes('pagination token repeated'), 'Google models pagination rejects a non-adjacent token cycle')

let googleCapCalls = 0
let googleCapReason = ''
try {
  await loadProviderSources(PROVIDERS.google, googleFetchOptions(async url => {
    const parsedUrl = new URL(url)
    if (parsedUrl.pathname === googleModelsPath) {
      googleCapCalls++
      return responseFor(JSON.stringify({
        models: [{ name: `models/google-cap-${googleCapCalls}` }],
        nextPageToken: `google-cap-token-${googleCapCalls}`,
      }))
    }
    return responseFor(googleMarkdown)
  }))
} catch (error) {
  googleCapReason = error.message
}
assert(googleCapCalls === 20 && googleCapReason.includes('pagination cap of 20 pages'), 'Google models pagination fails loudly at the hard page cap')

let googleInvalidTokenReason = ''
try {
  parseGoogleModels({ models: [{ name: 'models/google-invalid-token' }], nextPageToken: 42 })
} catch (error) {
  googleInvalidTokenReason = error.message
}
assert(googleInvalidTokenReason.includes('invalid nextPageToken'), 'Google models parsing rejects a malformed pagination token')

let googleInvalidResourceReason = ''
try {
  parseGoogleModels({ models: [{ name: 'google-invalid-resource' }] })
} catch (error) {
  googleInvalidResourceReason = error.message
}
assert(googleInvalidResourceReason.includes('invalid model resource name'), 'Google models parsing enforces the documented models resource prefix')

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
    return responseFor(openaiMarkdown)
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
      const row = id => ({ type: 'model', id, lifecycle: 'active', deprecated_at: null, retires_at: null })
      return parsedUrl.searchParams.get('after_id')
        ? responseFor(JSON.stringify({ data: [row('anthropic-page-two')], has_more: false, first_id: 'anthropic-page-two', last_id: 'anthropic-page-two' }))
        : responseFor(JSON.stringify({ data: [row('anthropic-page-one')], has_more: true, first_id: 'anthropic-page-one', last_id: 'anthropic-page-one' }))
    }
    if (url === PROVIDERS.anthropic.aliasesUrl) return responseFor(anthropicIndex)
    if (anthropicModelUrls.includes(url)) return responseFor(anthropicModelMarkdown(url))
    return responseFor(anthropicMarkdown)
  },
})
const anthropicModelsRequests = anthropicPageUrls.filter(url => url.pathname === '/v1/models')
assert(paginatedAnthropic.currentIds.length === 2 && anthropicModelsRequests[1]?.searchParams.get('after_id') === 'anthropic-page-one', 'Anthropic models pagination follows after_id from last_id')
assert(anthropicModelsRequests.length === 2 && anthropicModelsRequests.every(url => url.searchParams.getAll('lifecycle[]').join() === 'active,deprecated,retired' && url.searchParams.get('limit') === '1000' && !url.searchParams.has('lifecycle')), 'Anthropic models pagination asks every page for all three lifecycle stages, 1000 at a time, in the SDK bracket encoding')

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
      return responseFor(openaiMarkdown)
    },
  })
} catch (error) {
  paginationCapReason = error.message
}
assert(capCalls === 20 && paginationCapReason.includes('pagination cap of 20 pages'), 'models pagination fails loudly at the hard page cap')

const anthropicCheck = run(['--provider', 'anthropic', '--check', '--fixtures', fixtures])
const anthropicCliNotices = spawnSync(process.execPath, [refresh, '--provider', 'anthropic', '--check', '--fixtures', fixtures], { encoding: 'utf8' })
const expectedAnthropicAttachments = anthropicExpectedAliases.filter(model => !anthropicFeed.models.find(entry => entry.id === model.id)?.aliases?.includes(model.aliases[0]))
assert([0, 3].includes(anthropicCliNotices.status) && anthropicCliNotices.stderr.split('\n').filter(line => line.startsWith('notice: anthropic alias ')).length === expectedAnthropicAttachments.length, 'Anthropic CLI emits exactly one notice per newly attached alias')
assert(anthropicCheck.code === 0 || anthropicCheck.code === 3, 'Anthropic --check exits 0 or 3 depending on committed feed state, never a failure')

const googleCheck = run(['--provider', 'google', '--check', '--fixtures', fixtures])
assert(googleCheck.code === 0 || googleCheck.code === 3, 'Google --check exits 0 or 3 depending on committed feed state, never a failure')

const cohereCheck = spawnSync(process.execPath, [refresh, '--provider', 'cohere', '--check', '--fixtures', fixtures], { encoding: 'utf8' })
assert([0, 3].includes(cohereCheck.status) && cohereCheck.stdout.includes(cohereNoticeLine), 'Cohere --check exits 0 or 3 depending on committed feed state and renders undated endpoint notices')
assert(cohereCheck.stderr.includes('models endpoint flags cohere-fixture-undated as deprecated without a dated announcement'), 'Cohere CLI reports undated endpoint deprecations on stderr')
const cohereCorruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-cohere-corrupt-'))
try {
  fs.writeFileSync(path.join(cohereCorruptDir, 'cohere-models.json'), cohereModels)
  fs.writeFileSync(path.join(cohereCorruptDir, 'cohere-deprecations.md'), cohereMdUnknown)
  const out = path.join(cohereCorruptDir, 'out')
  const invalid = run(['--provider', 'cohere', '--fixtures', cohereCorruptDir, '--out', out])
  assert(invalid.code === 1 && invalid.err.includes('2026-04-04: Embed') && !fs.existsSync(out), 'Cohere refuses unknown page shapes before writing any feed')
} finally {
  fs.rmSync(cohereCorruptDir, { recursive: true, force: true })
}

const mistralCheck = spawnSync(process.execPath, [refresh, '--provider', 'mistral', '--check', '--fixtures', fixtures], { encoding: 'utf8' })
assert([0, 3].includes(mistralCheck.status) && mistralCheck.stdout.includes('## Rows without an API id') && mistralExpectedSkipped.every(row => mistralCheck.stdout.includes(row.model)), 'Mistral --check lists skipped rows in the semantic diff')
assert(mistralCheck.stderr.split('\n').filter(line => line.startsWith('notice: mistral skipped ')).length === 3, 'Mistral --check prints each skipped row as a notice on stderr')
const mistralCorruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-mistral-corrupt-'))
try {
  fs.writeFileSync(path.join(mistralCorruptDir, 'mistral-models.json'), mistralModels)
  fs.writeFileSync(path.join(mistralCorruptDir, 'mistral-deprecations.md'), mistralWithRow(5, '5/22/2026'))
  const out = path.join(mistralCorruptDir, 'out')
  const invalid = run(['--provider', 'mistral', '--fixtures', mistralCorruptDir, '--out', out])
  assert(invalid.code === 1 && invalid.err.includes('mistral-medium-2508') && !fs.existsSync(out), 'Mistral refuses malformed dates before writing any feed')
} finally {
  fs.rmSync(mistralCorruptDir, { recursive: true, force: true })
}

const bedrockCheck = run(['--distributor', 'aws-bedrock', '--check', '--fixtures', fixtures])
assert(bedrockCheck.code === 0 || bedrockCheck.code === 3, 'Bedrock --check exits 0 or 3 depending on committed feed state, never a failure')
assert(bedrockCheck.out.includes('## Distribution changes'), 'Bedrock --check renders the Distribution changes section')
assert(bedrockCheck.out.includes('no publisher feed'), 'Bedrock --check reports unmatched models (moved-EOL rendering is covered by the merge unit tests)')
assert(['canvas', 'reel', 'premier', 'sonic'].every(name => !bedrockCheck.out.includes(`normalized id \`nova-${name}\``)), 'Bedrock --check keeps the existing Nova models bound')
assert(bedrockCheck.out.includes('normalized id `nova-lite`'), 'Bedrock --check reports card-only Nova Lite as unmatched')
assert(bedrockCheck.out.includes('## Model cards without lifecycle fields') && bedrockCheck.out.includes('no day-precision date'), 'Bedrock --check renders skipped model cards in stdout')

const vertexCheck = run(['--distributor', 'vertex-ai', '--check', '--fixtures', fixtures])
assert([0, 3].includes(vertexCheck.code), 'Vertex --check exits 0 or 3 depending on committed feed state, never a failure')
assert(vertexCheck.out.includes('no publisher feed'), 'Vertex --check reports unmatched models')

const azureCheck = spawnSync(process.execPath, [refresh, '--distributor', 'azure-ai-foundry', '--check', '--fixtures', fixtures], { encoding: 'utf8' })
assert([0, 3].includes(azureCheck.status) && azureCheck.stdout.includes('## Source conflicts'), 'Azure CLI check renders source conflicts through distributor wiring')
assert(azureCheck.stderr.split('\n').filter(line => line.startsWith('notice:') && line.includes('earliest retirement wins')).length === 2, 'Azure CLI prints both source conflicts on stderr')
const allDistributorsCheck = run(['--distributor', 'aws-bedrock,vertex-ai,azure-ai-foundry', '--check', '--fixtures', fixtures])
assert([0, 3].includes(allDistributorsCheck.code) && allDistributorsCheck.out.includes('## Source conflicts'), 'refresh composes Azure with Bedrock and Vertex offline')

const bothDistributorsCheck = run(['--distributor', 'aws-bedrock,vertex-ai', '--check', '--fixtures', fixtures])
assert(bothDistributorsCheck.code === 3 && bothDistributorsCheck.out.includes('vertex-ai'), 'refresh accepts comma-separated distributors')

const mixedDistributorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-mixed-distributors-'))
const mixedGenerated = '2099-01-02T03:04:05Z'
const mixedDistributorWrite = run([
  '--distributor', 'aws-bedrock,vertex-ai',
  '--out', mixedDistributorOut,
  '--fixtures', fixtures,
], { env: { ...process.env, MODEL_EOL_GENERATED: mixedGenerated } })
assert(mixedDistributorWrite.code === 0, 'mixed distributor refresh writes successfully')
const mixedOutputs = Object.fromEntries(['amazon', 'anthropic', 'cohere', 'google', 'mistral', 'openai'].map(publisher => [
  publisher,
  JSON.parse(fs.readFileSync(path.join(mixedDistributorOut, `${publisher}.json`), 'utf8')),
]))
const mixedCommitted = Object.fromEntries(['amazon', 'anthropic', 'cohere', 'google', 'mistral', 'openai'].map(publisher => [
  publisher,
  JSON.parse(fs.readFileSync(path.join(root, 'feeds', `${publisher}.json`), 'utf8')),
]))
assert(mixedOutputs.anthropic.generated === mixedGenerated && mixedOutputs.anthropic.generated !== mixedCommitted.anthropic.generated, 'mixed distributor write advances generated for the publisher with material distribution changes')
const mixedChanged = publisher => JSON.stringify({ ...mixedOutputs[publisher], generated: null }) !== JSON.stringify({ ...mixedCommitted[publisher], generated: null })
assert(Object.keys(mixedOutputs).every(publisher => mixedOutputs[publisher].generated === (mixedChanged(publisher) ? mixedGenerated : mixedCommitted[publisher].generated)), 'mixed distributor write advances generated exactly for the publishers whose feed changed')
assert(Object.keys(mixedOutputs).some(publisher => !mixedChanged(publisher)), 'mixed distributor write leaves at least one publisher feed semantically unchanged')

const refreshWorkflow = fs.readFileSync(path.join(root, '.github/workflows/feed-refresh.yml'), 'utf8')
for (const [output, file] of [['providers', 'provider-diff.md'], ['distributors', 'distributor-diff.md']]) {
  assert(refreshWorkflow.includes(`if [ "\${{ steps.check.outputs.${output} }}" = "3" ] || grep -q '^## Source conflicts$' ${file}; then cat ${file};`), `workflow includes ${file} for source conflicts even when its check exits zero`)
}
assert(refreshWorkflow.includes('[ "$providers" -ne 0 ] && [ "$providers" -ne 3 ]') && refreshWorkflow.includes('exit code $providers'), 'workflow fails explicitly on unexpected provider refresh exit codes')
assert(refreshWorkflow.includes('[ "$distributors" -ne 0 ] && [ "$distributors" -ne 3 ]') && refreshWorkflow.includes('exit code $distributors'), 'workflow fails explicitly on unexpected distributor refresh exit codes')
assert(refreshWorkflow.includes('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}'), 'workflow passes the Google models endpoint credential')
assert(refreshWorkflow.match(/--distributor aws-bedrock,vertex-ai,azure-ai-foundry/g)?.length === 2, 'workflow checks and writes every implemented distributor')
assert(refreshWorkflow.split('MISTRAL_API_KEY: ${{ secrets.MISTRAL_API_KEY }}').length === 3, 'workflow passes the Mistral credential to both check and regeneration')
assert(refreshWorkflow.split('COHERE_API_KEY: ${{ secrets.COHERE_API_KEY }}').length === 3 && refreshWorkflow.includes(' / COHERE_API_KEY enable'), 'workflow documents the Cohere credential and passes it to both check and regeneration')
assert(refreshWorkflow.includes('--distributor aws-bedrock,vertex-ai'), 'workflow refreshes every implemented distributor')
assert(refreshWorkflow.includes('issues: write') && refreshWorkflow.includes('if: failure() || cancelled()') && refreshWorkflow.includes('Feed refresh automation failed'), 'workflow gives failed or cancelled refreshes a durable issue')
assert(/^    timeout-minutes: \d+$/m.test(refreshWorkflow), 'workflow bounds the refresh job so a stuck run is cancelled and reported')
assert(refreshWorkflow.includes('gh issue comment "$issue" --body "$body"') && refreshWorkflow.includes('gh issue create --title "$title"'), 'workflow updates one failure issue instead of silently repeating failures')
assert(refreshWorkflow.includes('Resolve prior feed refresh failure') && refreshWorkflow.includes('gh issue close "$issue" --reason completed'), 'a successful refresh resolves the prior failure issue')
assert(refreshWorkflow.includes('$GITHUB_STEP_SUMMARY') && refreshWorkflow.includes('no material feed changes were found') && refreshWorkflow.includes('feed-generated date is intentionally unchanged'), 'a successful no-change refresh records an honest result without changing feed freshness')
assert(refreshWorkflow.includes('node scripts/feed-refresh-receipt.mjs "${args[@]}"') && refreshWorkflow.includes('name: feed-refresh-receipt'), 'every successful refresh uploads a dependency-free receipt artifact')
assert(refreshWorkflow.includes('--state pending --pending-pr-url "$PR_URL"') && refreshWorkflow.includes('--state clean'), 'refresh receipts distinguish pending material changes from clean committed feeds')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
assert(readme.includes('actions/workflows/feed-refresh.yml/badge.svg'), 'README exposes feed-refresh workflow health')
const releaseWorkflow = fs.readFileSync(path.join(root, '.github/workflows/npm-release.yml'), 'utf8')
assert(releaseWorkflow.includes('release_version:') && releaseWorkflow.includes('type: string') && !releaseWorkflow.includes('release_version:\n        default:'), 'manual releases require an explicit exact version')
assert(validateReleaseVersion({ current: '0.2.4', requested: '0.3.0', published: ['0.2.4'] }) === '0.3.0', 'release validation accepts the requested 0.3.0 minor release')
for (const requested of ['0.2.4', '0.2.3', '0.3.0-beta.1', 'v0.3.0']) {
  let rejected = false
  try {
    validateReleaseVersion({ current: '0.2.4', requested, published: ['0.2.4'] })
  } catch {
    rejected = true
  }
  assert(rejected, `release validation rejects unsafe version ${requested}`)
}
let publishedReleaseRejected = false
try {
  validateReleaseVersion({ current: '0.2.4', requested: '0.3.0', published: ['0.2.4', '0.3.0'] })
} catch {
  publishedReleaseRejected = true
}
assert(publishedReleaseRejected, 'release validation refuses a version already published to npm')
assert(targetReleaseVersion({ eventName: 'push', sourceVersion: '0.4.1' }) === '0.4.2', 'automatic feed release state resolves the exact next patch')
assert(targetReleaseVersion({ eventName: 'workflow_dispatch', sourceVersion: '0.4.1', requestedVersion: '0.5.0' }) === '0.5.0', 'manual release state preserves the exact requested version')
const releaseSource = 'a'.repeat(40)
const releaseCommit = 'b'.repeat(40)
const releaseIntegrity = sha512Integrity(Buffer.from('model-eol@0.5.0'))
assert(assertSha512Integrity(releaseIntegrity) === releaseIntegrity, 'release package integrity accepts one canonical SHA-512 SRI digest')
const stableReleaseApiEntry = { tag_name: 'v0.5.0', draft: false, prerelease: false }
assert(stableGithubReleaseExists({ pages: [[stableReleaseApiEntry]], tag: 'v0.5.0' }), 'release recovery recognizes an exact published stable GitHub release from paginated API state')
assert(!stableGithubReleaseExists({ pages: [[{ tag_name: 'v0.4.1', draft: false, prerelease: false }]], tag: 'v0.5.0' }), 'release recovery recognizes an absent exact GitHub release')
for (const candidate of [
  { ...stableReleaseApiEntry, draft: true },
  { ...stableReleaseApiEntry, prerelease: true },
]) {
  let unstableReleaseRejected = false
  try {
    stableGithubReleaseExists({ pages: [[candidate]], tag: 'v0.5.0' })
  } catch {
    unstableReleaseRejected = true
  }
  assert(unstableReleaseRejected, `release recovery rejects a matching ${candidate.draft ? 'draft' : 'prerelease'} GitHub release`)
}
let malformedReleaseApiRejected = false
try {
  stableGithubReleaseExists({ pages: [{ tag_name: 'v0.5.0', draft: false, prerelease: false }], tag: 'v0.5.0' })
} catch {
  malformedReleaseApiRejected = true
}
assert(malformedReleaseApiRejected, 'release recovery fails closed on malformed paginated GitHub API state')
const newReleaseState = resolveReleaseState({
  eventName: 'workflow_dispatch',
  sourceVersion: '0.4.1',
  requestedVersion: '0.5.0',
  sourceCommit: releaseSource,
  mainCommit: releaseSource,
  publishedVersions: ['0.4.1'],
  githubReleaseExists: false,
})
assert(newReleaseState.mode === 'create' && newReleaseState.publish && newReleaseState.createGithubRelease, 'release state creates a wholly missing exact release')
const resumableTag = {
  commit: releaseCommit,
  parent: releaseSource,
  version: '0.5.0',
  movingCommit: releaseCommit,
  mainContainsRelease: true,
  changedPaths: ['package.json'],
}
const tagOnlyState = resolveReleaseState({
  eventName: 'workflow_dispatch',
  sourceVersion: '0.4.1',
  requestedVersion: '0.5.0',
  sourceCommit: releaseSource,
  mainCommit: releaseCommit,
  publishedVersions: ['0.4.1'],
  githubReleaseExists: false,
  tag: resumableTag,
})
assert(tagOnlyState.mode === 'resume' && tagOnlyState.publish && tagOnlyState.createGithubRelease, 'same-event workflow rerun resumes after tags were pushed but npm is missing')
const registryOnlyState = resolveReleaseState({
  eventName: 'workflow_dispatch',
  sourceVersion: '0.4.1',
  requestedVersion: '0.5.0',
  sourceCommit: releaseSource,
  mainCommit: releaseCommit,
  publishedVersions: ['0.4.1', '0.5.0'],
  githubReleaseExists: false,
  tag: resumableTag,
})
assert(registryOnlyState.mode === 'resume' && !registryOnlyState.publish && registryOnlyState.createGithubRelease, 'same-event workflow rerun resumes after npm publish when the GitHub release is missing')
const completeReleaseState = resolveReleaseState({
  eventName: 'workflow_dispatch',
  sourceVersion: '0.4.1',
  requestedVersion: '0.5.0',
  sourceCommit: releaseSource,
  mainCommit: releaseCommit,
  publishedVersions: ['0.4.1', '0.5.0'],
  githubReleaseExists: true,
  tag: resumableTag,
})
assert(completeReleaseState.mode === 'resume' && !completeReleaseState.publish && !completeReleaseState.createGithubRelease, 'release state recognizes an already complete release without repeating publication')
let orphanRegistryRejected = false
try {
  resolveReleaseState({
    eventName: 'workflow_dispatch',
    sourceVersion: '0.4.1',
    requestedVersion: '0.5.0',
    sourceCommit: releaseSource,
    mainCommit: releaseSource,
    publishedVersions: ['0.5.0'],
    githubReleaseExists: false,
  })
} catch {
  orphanRegistryRejected = true
}
assert(orphanRegistryRejected, 'release state refuses an npm version without an immutable release tag')
let movingTagMismatchRejected = false
try {
  resolveReleaseState({
    eventName: 'workflow_dispatch',
    sourceVersion: '0.4.1',
    requestedVersion: '0.5.0',
    sourceCommit: releaseSource,
    mainCommit: releaseCommit,
    publishedVersions: ['0.4.1'],
    githubReleaseExists: false,
    tag: { ...resumableTag, movingCommit: 'c'.repeat(40) },
  })
} catch {
  movingTagMismatchRejected = true
}
assert(movingTagMismatchRejected, 'release state refuses recovery when moving v0 and the immutable tag diverge')
let wrongReleaseParentRejected = false
try {
  resolveReleaseState({
    eventName: 'workflow_dispatch',
    sourceVersion: '0.4.1',
    requestedVersion: '0.5.0',
    sourceCommit: releaseSource,
    mainCommit: releaseCommit,
    publishedVersions: ['0.4.1'],
    githubReleaseExists: false,
    tag: { ...resumableTag, parent: 'c'.repeat(40) },
  })
} catch {
  wrongReleaseParentRejected = true
}
assert(wrongReleaseParentRejected, 'release state refuses a version tag whose release commit has the wrong source parent')
let mainDriftRejected = false
try {
  resolveReleaseState({
    eventName: 'workflow_dispatch',
    sourceVersion: '0.4.1',
    requestedVersion: '0.5.0',
    sourceCommit: releaseSource,
    mainCommit: 'c'.repeat(40),
    publishedVersions: ['0.4.1'],
    githubReleaseExists: false,
  })
} catch {
  mainDriftRejected = true
}
assert(mainDriftRejected, 'new release state refuses to push after origin/main drifts from the workflow source')
const releasedReceipt = createReleaseReceipt({ sourceCommit: releaseSource, version: '0.5.0', releaseCommit, registryIntegrity: releaseIntegrity })
const validatedReleaseReceipt = validateReleaseReceipt(releasedReceipt, { expectedSourceCommit: releaseSource })
assert(validatedReleaseReceipt.release_commit === releaseCommit && validatedReleaseReceipt.registry_integrity === releaseIntegrity, 'release receipt binds the workflow source, exact version, release commit, and registry tarball integrity')
let invalidReleaseIntegrityRejected = false
try {
  validateReleaseReceipt({ ...releasedReceipt, registry_integrity: 'sha512-not-base64' })
} catch {
  invalidReleaseIntegrityRejected = true
}
assert(invalidReleaseIntegrityRejected, 'release receipt rejects malformed registry integrity')
assert(!validateReleaseReceipt(createReleaseReceipt({ sourceCommit: releaseSource })).released, 'release receipt represents intentional no-op runs without guessing a version')
assert(releaseWorkflow.includes('node scripts/validate-release-version.mjs "$current" "$RELEASE_VERSION" "$published"'), 'manual releases run the tested release-version validator')
assert(releaseWorkflow.includes('npm version "$RELEASE_VERSION"'), 'manual releases apply the exact requested version')
assert(releaseWorkflow.includes("npm version patch -m 'model-eol v%s - automated feed-data release'"), 'automated feed releases remain patch-only')
const feedOnlyRelease = classifyFeedReleasePaths(['feeds/openai.json', 'feeds/google.json', 'README.md'])
assert(feedOnlyRelease.changed && feedOnlyRelease.blockedPaths.length === 0, 'feed and generated README metadata changes may publish an automatic patch')
const mixedRelease = classifyFeedReleasePaths(['feeds/openai.json', 'README.md', 'lib/scanner.mjs', '.github/workflows/ci.yml'])
assert(!mixedRelease.changed && JSON.stringify(mixedRelease.blockedPaths) === JSON.stringify(['lib/scanner.mjs', '.github/workflows/ci.yml']), 'code mixed with feeds requires an explicit release')
assert(!classifyFeedReleasePaths(['README.md']).changed, 'README-only changes do not publish an automatic feed patch')
assert(releaseWorkflow.includes('node scripts/feed-release-guard.mjs "$last"') && !releaseWorkflow.includes('git diff --quiet "$last"..HEAD -- feeds/'), 'npm release workflow uses the tested mixed-change guard')
assert(releaseWorkflow.includes('git push --atomic origin main "$version" +refs/tags/v0:refs/tags/v0') && !releaseWorkflow.includes('git push -f origin v0'), 'release commit, immutable version tag, and moving v0 tag push atomically')
assert(releaseWorkflow.includes("steps.state.outputs.publish == 'true'") && releaseWorkflow.includes("steps.state.outputs.create_github_release == 'true'"), 'release workflow independently resumes missing npm publication and GitHub release phases')
assert(releaseWorkflow.includes("pre-release GITHUB_SHA") && releaseWorkflow.includes('--source-sha "$GITHUB_SHA"'), 'release recovery is explicitly bound to rerunning the original event and its pre-release source commit')
assert(releaseWorkflow.includes('name: npm-release-result') && releaseWorkflow.includes('node scripts/release-receipt.mjs "${args[@]}"') && releaseWorkflow.includes('--registry-integrity "$RELEASE_INTEGRITY"'), 'release workflow exports its exact version, commit, and registry integrity through an artifact')
assert(releaseWorkflow.includes('id-token: write') && releaseWorkflow.includes('npm publish "$RELEASE_TARBALL" --ignore-scripts'), 'release workflow preserves npm trusted publishing through OIDC')
assert(releaseWorkflow.includes('npm install -g npm@11.6.4') && releaseWorkflow.includes(`test "$(npm --version)" = '11.6.4'`) && !releaseWorkflow.includes('npm@latest'), 'OIDC release execution pins and verifies its npm CLI instead of running a mutable latest version')
assert(releaseWorkflow.includes('npm pack --json --ignore-scripts') && releaseWorkflow.includes('verifyPackageIntegrity') && releaseWorkflow.includes('--expected-integrity "$RELEASE_INTEGRITY"'), 'release publication hashes exact tag bytes, publishes that tarball, and verifies registry integrity')
assert(releaseWorkflow.includes('gh api --paginate --slurp') && releaseWorkflow.includes('node scripts/github-release-state.mjs') && releaseWorkflow.includes('isDraft !== false') && !releaseWorkflow.includes('if gh release view'), 'release existence lookup fails closed and accepts only a published stable GitHub release')
const publicWorkflow = fs.readFileSync(path.join(root, '.github/workflows/public-contract.yml'), 'utf8')
assert(publicWorkflow.includes('no successful feed-refresh receipt matches every feed currently on main') && publicWorkflow.includes('successful receipt-era refresh run $run_id has no downloadable receipt') && publicWorkflow.includes('refusing stale receipt fallback'), 'public contract advances only from the newest valid receipt and fails closed on missing or mismatching receipt-era artifacts')
assert(publicWorkflow.includes('.status, .conclusion') && !publicWorkflow.includes('--status success') && publicWorkflow.includes('refusing fallback until a newer refresh succeeds'), 'newer failed, queued, or in-progress receipt-era refreshes block fallback to older clean receipts')
assert(publicWorkflow.includes('.isCrossRepository == false') && publicWorkflow.includes('startswith("feed-refresh/")') && publicWorkflow.includes('refusing to advance last_checked') && publicWorkflow.includes('pull-requests: read'), 'an unresolved same-repository material-change PR prevents later clean receipts without trusting fork branch names')
assert(publicWorkflow.includes('Confirm this refresh event has not been superseded') && publicWorkflow.includes('it cannot roll the public contract back'), 'a delayed workflow_run event cannot deploy an older matching receipt after a newer refresh')
assert(['lib/cli.mjs', 'lib/receipts.mjs', 'lib/validate-document.mjs', 'lib/validate-feed.mjs', 'refresh/diff.mjs'].every(file => publicWorkflow.includes(`- '${file}'`)), 'public contract redeploys when any transitive build dependency changes')
assert(publicWorkflow.includes('node scripts/verify-public-site.mjs') && publicWorkflow.includes('name: public-contract-expectation'), 'Pages verification compares the live deployment with the exact built artifact')
const publishedUatWorkflow = fs.readFileSync(path.join(root, '.github/workflows/published-consumer-uat.yml'), 'utf8')
assert(publishedUatWorkflow.includes('name: npm-release-result') && publishedUatWorkflow.includes('run-id: ${{ github.event.workflow_run.id }}') && !publishedUatWorkflow.includes('dist-tags.latest'), 'workflow-run UAT consumes the exact release result instead of npm latest')
assert(publishedUatWorkflow.includes('moving_commit') && publishedUatWorkflow.includes('immutable_commit') && publishedUatWorkflow.includes('Moving v0 Action validate round-trip UAT') && publishedUatWorkflow.includes('Reverify remote v0 after the Action ran'), 'published UAT brackets the moving v0 Action with immutable-ref checks and validates its output round-trip')
assert(publishedUatWorkflow.includes('Immutable release Action inventory UAT') && publishedUatWorkflow.includes('Immutable release Action validate round-trip UAT') && publishedUatWorkflow.match(/uses: \.\//g)?.length === 2, 'published UAT validates the exact immutable release Action locally before treating v0 as a moving-line monitor')
assert(publishedUatWorkflow.includes("git ls-remote \"$remote\" 'refs/tags/v0^{}'") && publishedUatWorkflow.includes('--expected-integrity "$INTEGRITY"'), 'published UAT peels the moving Action tag and binds installed package bytes to the registry digest')
assert(publishedUatWorkflow.includes("needs.resolve.outputs.moving_current == 'true'") && publishedUatWorkflow.includes('exact v$VERSION UAT remains authoritative'), 'superseded moving aliases are monitoring results and never invalidate immutable exact-version UAT')
assert(publishedUatWorkflow.includes('v0 or immutable v$VERSION moved while the moving Action UAT was running') && publishedUatWorkflow.includes('exit 1'), 'moving Action monitoring fails if either bound ref changes during its two-step round-trip')
assert(publishedUatWorkflow.includes('const r=Array.isArray(v)?v.at(-1):v') && publishedUatWorkflow.includes('if(typeof r!=="string")process.exit(1)'), 'moving npm-line recheck normalizes npm view arrays to the resolved latest version')
assert(releaseWorkflow.includes('group: model-eol-release-and-moving-uat') && releaseWorkflow.includes('queue: max') && publishedUatWorkflow.includes('group: model-eol-release-and-moving-uat') && publishedUatWorkflow.includes('queue: max'), 'release and moving-alias UAT serialize through one non-cancelling queued concurrency group')
assert(publishedUatWorkflow.includes('workflows: [npm-release]') && publishedUatWorkflow.includes('branches: [main]') && publishedUatWorkflow.includes('types: [completed]'), 'published UAT is triggered by completed npm-release runs on main')
assert(!publishedUatWorkflow.includes('workflow_dispatch') && !publishedUatWorkflow.includes('inputs.version') && !publishedUatWorkflow.includes('REQUESTED_VERSION') && !publishedUatWorkflow.includes('manually requested immutable'), 'published UAT has no workflow-dispatch or manual-version execution fallback')
assert(publishedUatWorkflow.includes("if: github.event.workflow_run.conclusion == 'success'") && publishedUatWorkflow.includes('ref: ${{ github.event.workflow_run.head_sha }}'), 'workflow-run UAT executes only after success and resolves its receipt with the triggering release commit\'s own verifier')
assert(publishedUatWorkflow.includes('--expected-source-sha "$EXPECTED_SOURCE_SHA"'), 'workflow-run UAT binds the downloaded receipt to the triggering release source')
assert(publishedUatWorkflow.includes('ref: ${{ needs.resolve.outputs.release_commit }}'), 'package UAT runs the exact release commit\'s own consumer harness')
const freshnessScript = fs.readFileSync(path.join(root, 'scripts/update-readme-freshness.mjs'), 'utf8')
assert(freshnessScript.includes('AWS Bedrock, Google Vertex AI, and Azure Foundry lifecycle pages'), 'README freshness metadata names every automated distributor source')

const composedBedrockCheck = run(['--provider', 'anthropic', '--distributor', 'aws-bedrock', '--check', '--fixtures', fixtures])
assert(composedBedrockCheck.code === 3 && composedBedrockCheck.out.includes('Distribution changes'), 'Bedrock distributor composes with a selected publisher refresh')

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-test-'))
const beforeOpenAI = fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8')
const beforeAnthropic = fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8')
const writeRun = run(['--provider', 'all', '--out', outputDir, '--fixtures', fixtures])
assert(writeRun.code === 0, 'non-check refresh writes valid fixture output')
assert(Object.values(PROVIDERS).every(provider => fs.existsSync(path.join(outputDir, provider.feedFile))), 'non-check refresh writes every selected publisher feed')
const generatedAnthropic = JSON.parse(fs.readFileSync(path.join(outputDir, 'anthropic.json'), 'utf8'))
const generatedOpenAI = JSON.parse(fs.readFileSync(path.join(outputDir, 'openai.json'), 'utf8'))
assert(generatedAnthropic.models.some(model => model.id === 'claude-sonnet-4-6' && !model.shutdown && !model.announced), 'written output includes a current model without lifecycle dates')
assert(generatedOpenAI.models.some(model => model.id === 'sora-2' && !model.replacement), 'written OpenAI output preserves a missing replacement')
assert(generatedOpenAI.models.some(model => model.id === 'gpt-4-0613' && model.aliases?.includes('gpt-4')), 'written OpenAI output preserves every model-cell code token as an alias')
assert(fs.readFileSync(path.join(root, 'feeds', 'openai.json'), 'utf8') === beforeOpenAI, 'refresh does not modify committed OpenAI feeds during tests')
assert(fs.readFileSync(path.join(root, 'feeds', 'anthropic.json'), 'utf8') === beforeAnthropic, 'refresh does not modify committed Anthropic feeds during tests')

const corruptBedrockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-bedrock-corrupt-'))
fs.writeFileSync(path.join(corruptBedrockDir, 'bedrock-lifecycle.md'), '# Model lifecycle (Legacy)\n\n- **Amazon**\n  - **Model ID:** amazon.corrupt-v1:0\n  - **Legacy date:** March 1, 2026\n')
const corruptBedrockOut = path.join(corruptBedrockDir, 'out')
const corruptBedrockRun = run(['--distributor', 'aws-bedrock', '--out', corruptBedrockOut, '--fixtures', corruptBedrockDir])
assert(corruptBedrockRun.code === 1, 'corrupted Bedrock fixture exits nonzero')
assert(!fs.existsSync(corruptBedrockOut), 'corrupted Bedrock fixture produces no output directory')

const corruptOpenAIDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-openai-corrupt-'))
fs.copyFileSync(path.join(fixtures, 'openai-models.json'), path.join(corruptOpenAIDir, 'openai-models.json'))
fs.writeFileSync(path.join(corruptOpenAIDir, 'openai-deprecations.md'), '# Deprecations\n\ncorrupt\n')
const corruptOpenAIOut = path.join(corruptOpenAIDir, 'out')
const corruptOpenAIRun = run(['--provider', 'openai', '--out', corruptOpenAIOut, '--fixtures', corruptOpenAIDir])
assert(corruptOpenAIRun.code === 1, 'corrupted OpenAI fixture exits nonzero')
assert(!fs.existsSync(corruptOpenAIOut), 'corrupted OpenAI fixture produces no output directory')
const corruptOpenAIMarkdown = fs.readFileSync(path.join(corruptOpenAIDir, 'openai-deprecations.md'), 'utf8')
let corruptOpenAIMessage
try {
  parseOpenAIDeprecationsMarkdown(corruptOpenAIMarkdown)
} catch (error) {
  corruptOpenAIMessage = error.message
}
assert(corruptOpenAIMessage && corruptOpenAIRun.err.includes(`- openai: ${corruptOpenAIMessage}`) && corruptOpenAIRun.err.includes('refresh failed for 1 source:'), 'a single failing source keeps its original error message')
assert(!corruptOpenAIRun.err.includes('refresh failed: refresh failed'), 'a source failure is not printed with a doubled prefix')

const multiFailureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-multi-failure-'))
try {
  const sources = path.join(multiFailureDir, 'sources')
  fs.cpSync(fixtures, sources, { recursive: true })
  fs.writeFileSync(path.join(sources, 'openai-deprecations.md'), corruptOpenAIMarkdown)
  fs.writeFileSync(path.join(sources, 'google-deprecations.md'), '# Gemini deprecations\n\nNo lifecycle table here.\n')
  fs.writeFileSync(path.join(sources, 'bedrock-lifecycle.md'), '<html><body><table><tr><th>Model ID</th><th>Legacy date</th></tr></table></body></html>')
  fs.writeFileSync(path.join(sources, 'azure-model-retirement-schedule.md'), '# Retirements\n\ncorrupt\n')
  const out = path.join(multiFailureDir, 'out')
  fs.mkdirSync(out)
  const sourceLines = text => text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2, line.indexOf(':')))

  const providersRun = run(['--provider', 'all', '--out', out, '--fixtures', sources])
  assert(providersRun.code === 1 && providersRun.err.includes('refresh failed for 2 sources:') && JSON.stringify(sourceLines(providersRun.err)) === JSON.stringify(['openai', 'google']), 'refresh reports every failing provider in one run')
  assert(fs.readdirSync(out).length === 0 && providersRun.out === '', 'failing providers write no feed and print no diff')

  const providersCheck = run(['--provider', 'all', '--check', '--out', out, '--fixtures', sources])
  assert(providersCheck.code === 1 && sourceLines(providersCheck.err).length === 2 && providersCheck.out === '' && fs.readdirSync(out).length === 0, 'failing providers under --check exit 1, write nothing, and print no diff')

  const mixedRun = run(['--provider', 'openai', '--distributor', 'aws-bedrock,vertex-ai,azure-ai-foundry', '--out', out, '--fixtures', sources])
  assert(mixedRun.code === 1 && mixedRun.err.includes('refresh failed for 3 sources:') && JSON.stringify(sourceLines(mixedRun.err)) === JSON.stringify(['openai', 'aws-bedrock', 'azure-ai-foundry']), 'refresh reports a failing provider and every failing distributor in source order')
  assert(fs.readdirSync(out).length === 0 && mixedRun.out === '', 'a provider and distributor failure write no feed and print no diff')

  const distributorsRun = run(['--distributor', 'aws-bedrock,vertex-ai,azure-ai-foundry', '--check', '--out', out, '--fixtures', sources])
  assert(distributorsRun.code === 1 && JSON.stringify(sourceLines(distributorsRun.err)) === JSON.stringify(['aws-bedrock', 'azure-ai-foundry']) && distributorsRun.out === '', 'a failing distributor does not stop the next distributor')
} finally {
  fs.rmSync(multiFailureDir, { recursive: true, force: true })
}

const exitCoded = (message, exitCode) => Object.assign(new Error(message), { exitCode })
const sameCodeError = sourceFailureError([{ source: 'openai', error: exitCoded('first', 2) }, { source: 'google', error: exitCoded('second', 2) }])
assert(sameCodeError.message === 'refresh failed for 2 sources:\n- openai: first\n- google: second' && sameCodeError.exitCode === 2, 'source failures that share an exit code keep it')
assert(sourceFailureError([{ source: 'openai', error: exitCoded('first', 2) }, { source: 'google', error: new Error('second') }]).exitCode === 1, 'source failures with mixed exit codes exit 1')
for (const code of [0, 3]) {
  assert(sourceFailureError([{ source: 'openai', error: exitCoded('first', code) }, { source: 'google', error: exitCoded('second', code) }]).exitCode === 1, `source failures that share exit code ${code} exit 1, never a healthy --check code`)
}

const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-corrupt-'))
for (const file of ['openai-models.json', 'anthropic-models.json', 'openai-deprecations.md']) {
  fs.copyFileSync(path.join(fixtures, file), path.join(corruptDir, file))
}
fs.writeFileSync(path.join(corruptDir, 'anthropic-deprecations.md'), '<html><body><table><tr><td>corrupt</td></tr></table></body></html>')
const corruptOut = path.join(corruptDir, 'out')
const corruptRun = run(['--provider', 'anthropic', '--out', corruptOut, '--fixtures', corruptDir])
assert(corruptRun.code === 1 && corruptRun.err.includes('unsupported markup'), 'an HTML body where the Markdown deprecations page belongs exits nonzero')
assert(!fs.existsSync(corruptOut), 'corrupted fixture produces no output directory')

const malformedStatusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-malformed-status-'))
fs.copyFileSync(path.join(fixtures, 'anthropic-models.json'), path.join(malformedStatusDir, 'anthropic-models.json'))
fs.writeFileSync(
  path.join(malformedStatusDir, 'anthropic-deprecations.md'),
  anthropicStatusTable('claude-malformed-status-floor', 'Active', 'N/A', 'Not sooner than Q4 2027'),
)
const malformedStatusOut = path.join(malformedStatusDir, 'out')
const malformedStatusRun = run(['--provider', 'anthropic', '--check', '--out', malformedStatusOut, '--fixtures', malformedStatusDir])
assert(malformedStatusRun.code === 1 && malformedStatusRun.err.includes('claude-malformed-status-floor') && malformedStatusRun.err.includes('Not sooner than Q4 2027'), 'Anthropic refresh check fails loudly on an unparseable status floor')
assert(!fs.existsSync(malformedStatusOut), 'an unparseable Anthropic status floor writes no feed output')

const shapesBedrockEntry = ([provider, name, id, regions, legacy, eol, extended], extra = []) => bedrockEntry([['Model name', name], ['Model ID', id], ['Regions', regions], ['Legacy date', legacy], ['EOL date', eol], ['Public extended access start date', extended], ...extra], provider)
const shapesBedrockPage = rows => bedrockPage(...rows.map(row => shapesBedrockEntry(row)))
const shapesBedrockRegional = (provider, name, id, groups, extra = []) => bedrockEntry([['Model name', name], ['Model ID', id], ...groups.map(([regions, legacy, eol, extended, ...more]) => [['Regions', regions], ['Legacy date', legacy], ['EOL date', eol], ['Public extended access start date', extended], ...more])], provider)
reviewTest('2026-10-18 shapes: Bedrock card accepts bare regional EOL cells that match the Model EOL date', () => {
  strictAssert.deepEqual(parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable('EOL: 2028-01-01', 'EOL: 2028-01-01')}`).records,
    [{ bedrockId: 'anthropic.example-v1:0', shutdown: '2028-01-01', status: 'legacy', source: reviewCardSource }])
})
reviewTest('2026-10-18 shapes: Bedrock card fails closed on a bare regional EOL that differs from the Model EOL date', () => {
  strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable('EOL: 2028-01-02')}`), /region EOL 2028-01-02 differs/)
  strictAssert.throws(() => parseReviewCard(`${reviewIdTable}${cardField('Model EOL date', 'January 1, 2028')}${cellTable('EOL: soon')}`), /unrecognised region EOL: EOL: soon/)
})
reviewTest('2026-10-18 shapes: Bedrock lifecycle treats a To be announced Extended Access start as unscheduled', () => {
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(shapesBedrockPage([['DeepSeek', 'DeepSeek-R1', 'deepseek.r1-v1:0', 'us-east-1', 'September 30, 2026', 'March 30, 2027', 'To be announced']])),
    [{ bedrockId: 'deepseek.r1-v1:0', status: 'legacy', legacy: '2026-09-30', eol: '2027-03-30' }])
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(shapesBedrockPage([['DeepSeek', 'DeepSeek-R1', 'deepseek.r1-v1:0', 'us-east-1', 'September 30, 2026', 'To be announced', 'To be announced']])), /unrecognised EOL date: To be announced/)
})
reviewTest('2026-10-18 shapes: Bedrock lifecycle records every endpoint-qualified model ID in one entry', () => {
  const records = parseBedrockLifecycleMarkdown(shapesBedrockPage([['DeepSeek', 'DeepSeek-V3.1', 'deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-mantle)', 'us-east-2, us-west-2', 'September 30, 2026', 'March 30, 2027', 'To be announced']]))
  strictAssert.deepEqual(records.map(record => [record.bedrockId, record.eol]), [['deepseek.v3-v1:0', '2027-03-30'], ['deepseek.v3.1', '2027-03-30']])
  for (const id of ['deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-runtime)', 'deepseek.v3-v1:0 (bedrock-runtime), deepseek.v3.1 (bedrock-other)', 'deepseek.v3-v1:0 (bedrock-runtime), DeepSeek V3 (bedrock-mantle)', 'deepseek.v3-v1:0 (bedrock-runtime)']) {
    strictAssert.throws(() => parseBedrockLifecycleMarkdown(shapesBedrockPage([['DeepSeek', 'DeepSeek V3', id, 'us-east-2', 'September 30, 2026', 'March 30, 2027', 'To be announced']])), /invalid model id/)
  }
})
const labelledDates = ['September 30, 2026', 'March 30, 2027', 'To be announced']
reviewTest('Labelled entries: Bedrock reads the Model ID from its label even when the display name looks like an ID', () => {
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(shapesBedrockPage([['Z.AI', 'zai.glm-4.6', 'zai.glm-4.7', 'us-east-1, us-west-2', ...labelledDates]])),
    [{ bedrockId: 'zai.glm-4.7', status: 'legacy', legacy: '2026-09-30', eol: '2027-03-30' }])
})
for (const row of [
  ['DeepSeek', 'DeepSeek-V3.1', 'see endpoint table', 'us-east-2', ...labelledDates],
  ['Z.AI', 'GLM 4.7', 'GLM 4.7', 'us-east-1', ...labelledDates],
  ['Z.AI', 'GLM 4.7', 'us-east-1', 'zai.glm-4.7', ...labelledDates],
  ['DeepSeek', 'DeepSeek V3', 'September 30, 2026', 'us-east-2', ...labelledDates],
]) {
  reviewTest(`Labelled entries: Bedrock refuses a Model ID label holding a display name, provider, region, or date: ${row[2]}`, () => {
    strictAssert.throws(() => parseBedrockLifecycleMarkdown(shapesBedrockPage([row])), /invalid model id/)
  })
}
for (const [label, row, pattern] of [
  ['a Legacy date label holding a model ID', ['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'meta.a-v1:0', 'December 1, 2026', 'To be announced'], /meta\.a-v1:0 has an unrecognised legacy date: meta\.a-v1:0/],
  ['an EOL date label holding a region list', ['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'September 1, 2026', 'us-east-1', 'To be announced'], /meta\.a-v1:0 has an unrecognised EOL date: us-east-1/],
  ['an EOL date before the legacy date', ['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'September 1, 2026', 'August 1, 2026', 'To be announced'], /meta\.a-v1:0 has EOL before legacy date/],
  ['an Extended Access start before the legacy date', ['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'September 1, 2026', 'December 1, 2026', 'August 1, 2026'], /public extended access before legacy date/],
  ['an Extended Access start after the EOL date', ['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'September 1, 2026', 'December 1, 2026', 'December 2, 2026'], /public extended access after EOL date/],
]) {
  reviewTest(`Labelled entries: Bedrock refuses ${label}`, () => {
    strictAssert.throws(() => parseBedrockLifecycleMarkdown(shapesBedrockPage([row])), pattern)
  })
}
reviewTest('Labelled entries: Bedrock refuses Extended Access status without a start date', () => {
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockEntry(['Meta', 'Llama A', 'meta.a-v1:0', 'us-east-1', 'September 1, 2026', 'December 1, 2026', '\u2014'], [['Status', 'Extended access']]))), /reports extended access without a start date/)
})
reviewTest('Labelled entries: the Bedrock lifecycle fixture parses to the same records', () => {
  strictAssert.equal(bedrockEntries.length, 19)
  strictAssert.deepEqual(parseBedrockLifecycleMarkdown(fs.readFileSync(path.join(fixtures, 'bedrock-lifecycle.md'), 'utf8')), bedrockEntries)
  strictAssert.equal(bedrockMarkdown.match(/^ {2}- \*\*Regions:\*\* .* \/ \*\*Legacy date:\*\*/gm)?.length, 10)
})
reviewTest('2026-10-18 shapes: Bedrock lifecycle keeps the earliest deadline across disjoint region groups', () => {
  const groups = [
    ['ap-northeast-2, ap-south-1', 'October 10, 2026', 'November 13, 2026', 'October 10, 2026'],
    ['us-east-1, us-west-2', 'March 10, 2026', 'September 10, 2026', 'June 10, 2026'],
  ]
  const expected = [{ bedrockId: 'anthropic.claude-3-haiku-20240307-v1:0', status: 'extended-access', legacy: '2026-03-10', eol: '2026-09-10' }]
  for (const order of [groups, [...groups].reverse()]) {
    strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockRegional('Anthropic', 'Claude 3 Haiku', 'anthropic.claude-3-haiku-20240307-v1:0', order))), expected)
    strictAssert.deepEqual(parseBedrockLifecycleMarkdown(shapesBedrockPage(order.map(group => ['Anthropic', 'Claude 3 Haiku', 'anthropic.claude-3-haiku-20240307-v1:0', ...group]))), expected)
  }
  const overlapping = [groups[0], ['us-east-1, ap-south-1', ...groups[1].slice(1)]]
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockRegional('Anthropic', 'Claude 3 Haiku', 'anthropic.claude-3-haiku-20240307-v1:0', overlapping))), /conflicting rows for anthropic.claude-3-haiku-20240307-v1:0/)
  const noRegions = bedrockPage(...[['March 1, 2026', 'September 1, 2026'], ['April 1, 2026', 'October 1, 2026']].map(([legacy, eol]) =>
    bedrockEntry([['Model ID', 'amazon.split-v1:0'], ['Legacy date', legacy], ['EOL date', eol], ['Public extended access start date', '\u2014']], 'Amazon')))
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(noRegions), /conflicting rows for amazon.split-v1:0/)
})
reviewTest('2026-10-18 review: disjoint region groups merge each field to its earliest value and the furthest phase', () => {
  const groups = [
    ['us-east-1', 'January 1, 2026', 'December 1, 2026', 'March 1, 2026'],
    ['eu-west-1', 'June 1, 2026', 'October 1, 2026', 'To be announced'],
  ]
  for (const order of [groups, [...groups].reverse()]) {
    strictAssert.deepEqual(parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockRegional('Example', 'Model', 'a.m-v1:0', order))), [{ bedrockId: 'a.m-v1:0', status: 'extended-access', legacy: '2026-01-01', eol: '2026-10-01' }])
  }
})
reviewTest('2026-10-18 review: region groups with non-region-code tokens never merge different dates', () => {
  for (const regions of [['us-east-1', 'us-east-1*'], ['All Regions', 'us-gov-west-1']]) {
    const groups = [
      [regions[0], 'January 1, 2026', 'December 1, 2026', '\u2014'],
      [regions[1], 'June 1, 2026', 'October 1, 2026', '\u2014'],
    ]
    strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockRegional('Example', 'Model', 'a.m-v1:0', groups))), /conflicting rows for a.m-v1:0/)
  }
})
reviewTest('2026-10-18 review: disjoint region groups with an explicit retired status still conflict', () => {
  const groups = [
    ['us-east-1', 'January 1, 2026', 'July 1, 2026', 'March 1, 2026', ['Status', 'EOL']],
    ['eu-west-1', 'June 1, 2026', 'December 1, 2026', 'September 1, 2026', ['Status', 'Legacy']],
  ]
  strictAssert.throws(() => parseBedrockLifecycleMarkdown(bedrockPage(shapesBedrockRegional('Example', 'Model', 'a.m-v1:0', groups))), /conflicting rows for a.m-v1:0/)
})
const shapesOpenAIPage = cell => `<h2>2026-10-14: GPT-4 series model deprecations</h2><table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr><tr><td>January 14, 2027</td><td>${cell}</td><td><code>gpt-6-luna</code></td></tr></table>`
reviewTest('2026-10-18 shapes: OpenAI splits a row that lists several dated snapshots into one record each', () => {
  strictAssert.deepEqual(parseOpenAIDeprecations(shapesOpenAIPage('GPT-4o ( <code>gpt-4o-2024-08-06</code> , <code>gpt-4o-2024-11-20</code> )')).map(record => [record.id, record.aliases, record.shutdown, record.replacement]),
    [['gpt-4o-2024-08-06', undefined, '2027-01-14', 'gpt-6-luna'], ['gpt-4o-2024-11-20', undefined, '2027-01-14', 'gpt-6-luna']])
  strictAssert.deepEqual(parseOpenAIDeprecations(shapesOpenAIPage('<code>o1-2024-12-17</code> <code>o1</code>')).map(record => [record.id, record.aliases]), [['o1-2024-12-17', ['o1']]])
})
reviewTest('2026-10-18 shapes: OpenAI fails closed when several dated snapshots share an undated alias outside their family', () => {
  strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage('<code>chatgpt-4o-latest</code> <code>gpt-4o-2024-08-06</code> <code>gpt-4o-2024-11-20</code>')), /ambiguous alias chatgpt-4o-latest/)
  strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage('<code>gpt-4o</code> <code>gpt-4o-2024-08-06</code> <code>gpt-4o-mini-2024-07-18</code>')), /ambiguous alias gpt-4o/)
  strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage('<code>gpt-4o</code> <code>gpt-4o-2024-08-06</code> <code>gpt-4o-0806</code>')), /ambiguous alias gpt-4o/)
})
reviewTest('Notice-date layout: OpenAI gives a family alias to every dated snapshot of its family listed in one cell', () => {
  const records = parseOpenAIDeprecations(shapesOpenAIPage('<code>gpt-4o</code> <code>gpt-4o-2024-08-06</code> <code>gpt-4o-2024-11-20</code>'))
  strictAssert.deepEqual(records.map(record => [record.id, record.aliases]), [['gpt-4o-2024-08-06', ['gpt-4o']], ['gpt-4o-2024-11-20', ['gpt-4o']]])
})
reviewTest('2026-10-23 review: an OpenAI endpoint token beside dated snapshots refuses the row instead of dropping the snapshots', () => {
  const page = shapesOpenAIPage('<code>/v1/foo</code> <code>gpt-4o-2024-08-06</code> <code>gpt-4o-2024-11-20</code>')
    + '<h2>2026-10-15: Other</h2><table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr><tr><td>January 14, 2027</td><td><code>gpt-4.1-2025-04-14</code></td><td><code>gpt-6-luna</code></td></tr></table>'
  strictAssert.throws(() => parseOpenAIDeprecations(page), /model ids beside endpoint-or-product tokens/)
})
const openAICodes = (...ids) => ids.map(id => `<code>${id}</code>`).join(', ')
const openAISnapshots = (...ids) => parseOpenAIDeprecations(shapesOpenAIPage(openAICodes(...ids))).map(record => [record.id, record.aliases])
reviewTest('Month-day snapshots: OpenAI parses the live multi-code cells exactly as before', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4-0613', 'gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions'), [['gpt-4-0613', ['gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-3.5-turbo-0125', 'gpt-3.5-turbo', 'gpt-3.5-turbo-completions'), [['gpt-3.5-turbo-0125', ['gpt-3.5-turbo', 'gpt-3.5-turbo-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0125-preview', 'gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions'), [['gpt-4-0125-preview', ['gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4o-2024-08-06', 'gpt-4o-2024-11-20'), [['gpt-4o-2024-08-06', undefined], ['gpt-4o-2024-11-20', undefined]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-turbo', 'gpt-4-turbo-2024-04-09', 'gpt-4-turbo-completions'), [['gpt-4-turbo-2024-04-09', ['gpt-4-turbo', 'gpt-4-turbo-completions']]])
})
reviewTest('Month-day snapshots: OpenAI splits a cell that lists two month-day snapshots into one record each', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4-0314', 'gpt-4-0613'), [['gpt-4-0314', undefined], ['gpt-4-0613', undefined]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-1106-preview', 'gpt-4-0125-preview'), [['gpt-4-1106-preview', undefined], ['gpt-4-0125-preview', undefined]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0613', 'gpt-4o-2024-08-06'), [['gpt-4-0613', undefined], ['gpt-4o-2024-08-06', undefined]])
})
reviewTest('Month-day snapshots: OpenAI fails closed on an undated alias shared by several month-day snapshots', () => {
  strictAssert.throws(() => openAISnapshots('gpt-4-0314', 'gpt-4-0613', 'gpt-4'), /lists snapshots gpt-4-0314, gpt-4-0613 with ambiguous alias gpt-4$/)
  strictAssert.throws(() => openAISnapshots('gpt-4-0314', 'gpt-4-0613', 'gpt-4-completions'), /ambiguous alias gpt-4-completions/)
})
reviewTest('Month-day snapshots: OpenAI attaches a -completions variant to its own snapshot', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4-0314', 'gpt-4-0613', 'gpt-4-0613-completions'), [['gpt-4-0314', undefined], ['gpt-4-0613', ['gpt-4-0613-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0314-completions', 'gpt-4-0314', 'gpt-4-0613'), [['gpt-4-0314', ['gpt-4-0314-completions']], ['gpt-4-0613', undefined]])
})
reviewTest('Month-day snapshots: OpenAI does not read an invalid month or day as a snapshot', () => {
  for (const token of ['model-1399', 'model-0230', 'model-0431', 'model-0000', 'model-0100', 'model-1301-preview', 'model-0613-latest']) {
    strictAssert.deepEqual(openAISnapshots(token, 'gpt-4-0613'), [['gpt-4-0613', [token]]], token)
  }
})
reviewTest('Month-day snapshots: OpenAI accepts February 29 and rejects February 30', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4-0229', 'gpt-4-0613'), [['gpt-4-0229', undefined], ['gpt-4-0613', undefined]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0230', 'gpt-4-0613'), [['gpt-4-0613', ['gpt-4-0230']]])
})
reviewTest('Month-day snapshots: OpenAI keeps a full-date -completions variant on its snapshot', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4o-2024-08-06', 'gpt-4o-2024-08-06-completions'), [['gpt-4o-2024-08-06', ['gpt-4o-2024-08-06-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4o-2024-08-06-completions', 'gpt-4o-2024-08-06'), [['gpt-4o-2024-08-06', ['gpt-4o-2024-08-06-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0613', 'gpt-4o-2024-08-06', 'gpt-4o-2024-08-06-completions'), [['gpt-4-0613', undefined], ['gpt-4o-2024-08-06', ['gpt-4o-2024-08-06-completions']]])
})
reviewTest('Month-day snapshots: OpenAI picks the snapshot as the canonical ID of a single-snapshot cell', () => {
  strictAssert.deepEqual(openAISnapshots('gpt-4', 'gpt-4-0613'), [['gpt-4-0613', ['gpt-4']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4-0613-completions', 'gpt-4-0613'), [['gpt-4-0613', ['gpt-4-0613-completions']]])
  strictAssert.deepEqual(openAISnapshots('gpt-4', 'gpt-4-turbo'), [['gpt-4', ['gpt-4-turbo']]])
})
const familyPage = (...rows) => `<h2>2026-10-01: Family deprecations</h2><table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr>${rows.map(([shutdown, cell, replacement = 'gpt-next']) => `<tr><td>${shutdown}</td><td>${cell}</td><td><code>${replacement}</code></td></tr>`).join('')}</table>`
const familyCell = (...ids) => ids.map(id => `<code>${id}</code>`).join(' | ')
const familyFeed = models => ({ ...minimalCommitted, models })
const familyMerge = (models, page, extra = {}) => mergeFeed(familyFeed(models), { deprecations: parseOpenAIDeprecations(page), currentIds: null, generated: '2026-10-23T00:00:00Z', provider: PROVIDERS.openai, notice: () => {}, ...extra })
const familyLifecycle = model => model && [model.announced, model.shutdown, model.replacement ?? model.replacement_options?.join(), model.source, model.aliases]
const familyDated = ['2026-10-01', '2027-04-01', 'gpt-next', PROVIDERS.openai.deprecationsUrl, undefined]
const familyDistribution = { via: 'azure-ai-foundry', shutdown: '2027-09-21', status: 'active', source: 'https://example.test/azure' }
reviewTest('Family alias: an OpenAI row naming a committed alias and its committed snapshot dates both and joins neither', () => {
  const committed = [{ id: 'gpt-fam-2026-03-17', distributions: [familyDistribution] }, { id: 'gpt-fam' }]
  const page = familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')])
  const before = structuredClone(committed)
  const merged = familyMerge(committed, page)
  strictAssert.deepEqual(committed, before)
  strictAssert.deepEqual(merged.feed.models.map(model => model.id), ['gpt-fam-2026-03-17', 'gpt-fam'])
  for (const model of merged.feed.models) strictAssert.deepEqual(familyLifecycle(model), familyDated, model.id)
  strictAssert.deepEqual(merged.feed.models[0].distributions, [familyDistribution])
  strictAssert.deepEqual(merged.unconfirmedIds, [])
  const reversed = familyMerge(committed, familyPage(['Apr 1, 2027', familyCell('gpt-fam-2026-03-17', 'gpt-fam')]))
  strictAssert.deepEqual(reversed.feed, merged.feed)
})
reviewTest('Family alias: endpoint presence keeps the page lifecycle on both entries', () => {
  const merged = familyMerge([{ id: 'gpt-fam-2026-03-17' }, { id: 'gpt-fam' }], familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]), { currentIds: ['gpt-fam', 'gpt-fam-2026-03-17'] })
  for (const model of merged.feed.models) strictAssert.deepEqual(familyLifecycle(model), familyDated, model.id)
})
reviewTest('Family alias: a committed alias with a new snapshot adds the snapshot as its own dated entry', () => {
  const merged = familyMerge([{ id: 'gpt-fam' }], familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]))
  strictAssert.deepEqual(merged.feed.models.map(model => [model.id, ...familyLifecycle(model)]), [['gpt-fam', ...familyDated], ['gpt-fam-2026-03-17', ...familyDated]])
})
reviewTest('Family alias: an uncommitted alias still binds to its snapshot as before', () => {
  const merged = familyMerge([{ id: 'gpt-fam-2026-03-17' }], familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]))
  strictAssert.deepEqual(merged.feed.models.map(model => [model.id, model.aliases]), [['gpt-fam-2026-03-17', ['gpt-fam']]])
})
reviewTest('Family alias: two snapshots on the same lifecycle stay separate, and the alias is dated once or follows the newest snapshot, in either order', () => {
  const rows = [['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-20')], ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-12-15')]]
  const byId = merged => Object.fromEntries(merged.feed.models.map(model => [model.id, familyLifecycle(model)]))
  const newestKeeps = { 'gpt-fam-2025-03-20': familyDated, 'gpt-fam-2025-12-15': [...familyDated.slice(0, 4), ['gpt-fam']] }
  for (const order of [rows, [...rows].reverse()]) {
    const page = familyPage(...order)
    const committedAlias = familyMerge([{ id: 'gpt-fam-2025-03-20' }, { id: 'gpt-fam-2025-12-15' }, { id: 'gpt-fam' }], page)
    strictAssert.deepEqual(byId(committedAlias), { 'gpt-fam-2025-03-20': familyDated, 'gpt-fam-2025-12-15': familyDated, 'gpt-fam': familyDated })
    strictAssert.deepEqual(familyMerge(committedAlias.feed.models, page).feed.models, committedAlias.feed.models)
    for (const committed of [[], [{ id: 'gpt-fam-2025-03-20' }], [{ id: 'gpt-fam-2025-03-20', aliases: ['gpt-fam'] }]]) {
      const first = familyMerge(committed, page)
      strictAssert.deepEqual(byId(first), newestKeeps, JSON.stringify(committed))
      strictAssert.deepEqual(familyMerge(first.feed.models, page).feed.models, first.feed.models)
    }
  }
})
reviewTest('Family alias: two snapshot rows with different lifecycles date the alias from the earliest shutdown, and a tie fails closed', () => {
  const committed = [{ id: 'gpt-fam-2025-03-20' }, { id: 'gpt-fam-2025-12-15' }, { id: 'gpt-fam' }]
  const early = ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-20')]
  const late = ['Jun 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-12-15')]
  for (const rows of [[early, late], [late, early]]) {
    const merged = familyMerge(committed, familyPage(...rows))
    strictAssert.deepEqual(Object.fromEntries(merged.feed.models.map(model => [model.id, familyLifecycle(model)])), {
      'gpt-fam-2025-03-20': familyDated, 'gpt-fam-2025-12-15': ['2026-10-01', '2027-06-01', 'gpt-next', PROVIDERS.openai.deprecationsUrl, undefined], 'gpt-fam': familyDated,
    })
  }
  strictAssert.throws(() => familyMerge(committed, familyPage(early, ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-12-15'), 'gpt-other-next'])), /family alias gpt-fam different lifecycles with no single earliest shutdown/)
})
reviewTest('Family alias: fails closed when the alias has its own row with a different lifecycle, in either order', () => {
  const committed = [{ id: 'gpt-fam-2026-03-17' }, { id: 'gpt-fam' }]
  const familyRow = ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]
  const ownRow = ['Jun 1, 2027', familyCell('gpt-fam')]
  for (const rows of [[familyRow, ownRow], [ownRow, familyRow]]) {
    strictAssert.throws(() => familyMerge(committed, familyPage(...rows)), /gpt-fam conflicting lifecycles/)
  }
  const merged = familyMerge(committed, familyPage(familyRow, ['Apr 1, 2027', familyCell('gpt-fam')]))
  for (const model of merged.feed.models) strictAssert.deepEqual(familyLifecycle(model), familyDated, model.id)
})
reviewTest('Family alias: a committed canonical alias outside the snapshot family still throws', () => {
  for (const [alias, snapshot] of [['gpt-other', 'gpt-fam-2026-03-17'], ['gpt-fam-mini', 'gpt-fam-2026-03-17'], ['gpt-fa', 'gpt-fam-2026-03-17'], ['gpt-fam', 'gpt-fam-mini-2026-03-17'], ['gpt-fam', 'gpt-fam-0613'], ['gpt-fam', 'gpt-fam-2026-03-17-completions']]) {
    strictAssert.throws(() => familyMerge([{ id: snapshot }, { id: alias }], familyPage(['Apr 1, 2027', familyCell(alias, snapshot)])), /conflicts with (?:a )?canonical model id/, `${alias} | ${snapshot}`)
  }
})
reviewTest('Family alias: an alias owned by a third committed entry still throws', () => {
  strictAssert.throws(() => familyMerge([{ id: 'gpt-fam-2026-03-17' }, { id: 'gpt-third', aliases: ['gpt-fam'] }], familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')])), /conflicts with canonical model id gpt-third/)
})
reviewTest('Family alias: the rule is OpenAI-only; other publishers still refuse a committed canonical alias', () => {
  strictAssert.throws(() => mergeFeed({ ...anthropicFeed, models: [{ id: 'claude-x-2026-03-17' }, { id: 'claude-x' }] }, {
    deprecations: [{ id: 'claude-x-2026-03-17', aliases: ['claude-x'], announced: '2026-10-01', shutdown: '2027-04-01' }],
    currentIds: null, provider: PROVIDERS.anthropic, notice: () => {},
  }), /deprecation alias claude-x for claude-x-2026-03-17 conflicts with a canonical model id/)
})
const familyTable = (heading, shutdown, cell) => `<h2>${heading}</h2><table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr><tr><td>${shutdown}</td><td>${cell}</td><td><code>gpt-next</code></td></tr></table>`
reviewTest('PR 128 review 1: OpenAI refuses a later announcement that drops an alias the earlier row named, in either order', () => {
  const earlier = familyTable('2026-06-01: Earlier', 'Dec 1, 2026', familyCell('gpt-fam', 'gpt-fam-2026-03-17'))
  const later = familyTable('2026-10-01: Later', 'Jun 1, 2027', familyCell('gpt-fam-2026-03-17'))
  for (const page of [earlier + later, later + earlier]) {
    strictAssert.throws(() => parseOpenAIDeprecations(page), /conflicting rows for gpt-fam-2026-03-17/)
    strictAssert.throws(() => familyMerge([{ id: 'gpt-fam-2026-03-17' }, { id: 'gpt-fam' }], page), /conflicting rows for gpt-fam-2026-03-17/)
  }
})
reviewTest('PR 128 review 1: OpenAI still keeps a later announcement that adds the alias itself', () => {
  const earlier = familyTable('2026-06-01: Earlier', 'Dec 1, 2026', familyCell('gpt-fam-2026-03-17'))
  const later = familyTable('2026-10-01: Later', 'Jun 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17'))
  for (const page of [earlier + later, later + earlier]) {
    strictAssert.deepEqual(parseOpenAIDeprecations(page).map(record => [record.id, record.announced, record.shutdown, record.aliases]), [['gpt-fam-2026-03-17', '2026-10-01', '2027-06-01', ['gpt-fam']]])
  }
})
reviewTest('PR 128 review 2: the family rule refuses a row whose replacement is the family alias itself', () => {
  const committed = [{ id: 'gpt-fam-2026-03-17' }, { id: 'gpt-fam' }]
  strictAssert.throws(() => familyMerge(committed, familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17'), 'gpt-fam'])), /names its family alias gpt-fam as the replacement/)
  const options = familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]).replace('<code>gpt-next</code>', '<code>gpt-next</code> or <code>gpt-fam</code>')
  strictAssert.throws(() => familyMerge(committed, options), /names its family alias gpt-fam as the replacement/)
})
reviewTest('PR 128 review 3: a row reaching its target through an alias cannot silently override an earlier lifecycle, in either order', () => {
  const familyRow = ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2026-03-17')]
  const aliasRow = ['Jun 1, 2027', familyCell('gpt-fam')]
  for (const rows of [[familyRow, aliasRow], [aliasRow, familyRow]]) {
    strictAssert.throws(() => familyMerge([{ id: 'gpt-fam-2026-03-17' }], familyPage(...rows)), /conflicting lifecycles/)
  }
  const committedAlias = [{ id: 'gpt-fam-2026-03-17', aliases: ['gpt-fam'] }]
  for (const rows of [[aliasRow, ['Apr 1, 2027', familyCell('gpt-fam-2026-03-17')]], [['Apr 1, 2027', familyCell('gpt-fam-2026-03-17')], aliasRow]]) {
    strictAssert.throws(() => familyMerge(committedAlias, familyPage(...rows)), /conflicting lifecycles/)
  }
  const agreeing = familyMerge([{ id: 'gpt-fam-2026-03-17' }], familyPage(familyRow, ['Apr 1, 2027', familyCell('gpt-fam')]))
  strictAssert.deepEqual(agreeing.feed.models.map(model => [model.id, ...familyLifecycle(model)]), [['gpt-fam-2026-03-17', '2026-10-01', '2027-04-01', 'gpt-next', PROVIDERS.openai.deprecationsUrl, ['gpt-fam']]])
})
reviewTest('PR 128 late review: the family rule also refuses a replacement that is the alias\'s own newer snapshot', () => {
  const committed = [{ id: 'gpt-fam-2025-08-07' }, { id: 'gpt-fam' }]
  strictAssert.throws(() => familyMerge(committed, familyPage(['Dec 11, 2026', familyCell('gpt-fam', 'gpt-fam-2025-08-07'), 'gpt-fam-2026-03-01'])), /names its family alias gpt-fam as the replacement/)
})
reviewTest('PR 128 late review: alias rows that differ only in a note or option order do not conflict', () => {
  const committed = { ...anthropicFeed, models: [{ id: 'claude-x-20250514', aliases: ['claude-x'] }] }
  const base = { announced: '2026-10-01', shutdown: '2027-04-01', replacement_options: ['claude-a', 'claude-b'] }
  const merged = mergeFeed(committed, {
    deprecations: [{ id: 'claude-x-20250514', ...base }, { id: 'claude-x', ...base, replacement_options: ['claude-b', 'claude-a'], replacement_note: 'Either works.' }],
    currentIds: null, provider: PROVIDERS.anthropic, notice: () => {},
  })
  strictAssert.equal(merged.feed.models.find(model => model.id === 'claude-x-20250514').shutdown, '2027-04-01')
  strictAssert.throws(() => mergeFeed(committed, {
    deprecations: [{ id: 'claude-x-20250514', ...base }, { id: 'claude-x', ...base, shutdown: '2027-06-01' }],
    currentIds: null, provider: PROVIDERS.anthropic, notice: () => {},
  }), /conflicting lifecycles/)
})
const splitEarly = ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-01-01')]
const splitLate = ['Jun 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-06-01')]
const splitEarliest = ['Jan 1, 2027', familyCell('gpt-fam', 'gpt-fam-2024-11-01')]
const splitShape = merged => merged.feed.models.map(model => [model.id, model.shutdown, model.aliases]).sort(([a], [b]) => a.localeCompare(b))
const splitExpected = [['gpt-fam-2025-01-01', '2027-04-01', ['gpt-fam']], ['gpt-fam-2025-06-01', '2027-06-01', undefined]]
reviewTest('Issue 135: two new snapshots sharing an alias with different shutdowns stay separate and the earliest keeps the alias, in either order', () => {
  for (const rows of [[splitEarly, splitLate], [splitLate, splitEarly]]) {
    strictAssert.deepEqual(splitShape(familyMerge([], familyPage(...rows))), splitExpected)
  }
})
reviewTest('Issue 135: merging the split result again with the same page changes nothing, in either order', () => {
  for (const rows of [[splitEarly, splitLate], [splitLate, splitEarly]]) {
    const page = familyPage(...rows)
    const first = familyMerge([], page)
    const second = familyMerge(first.feed.models, page)
    strictAssert.deepEqual(second.feed.models, first.feed.models)
    strictAssert.equal(compareFeeds(first.feed, second.feed).changed, false)
    strictAssert.deepEqual(second.unconfirmedIds, [])
  }
})
reviewTest('Issue 135: a committed alias stays with the earliest snapshot when a later one joins, and moves when an earlier one joins', () => {
  const committed = [{ id: 'gpt-fam-2025-01-01', aliases: ['gpt-fam'] }]
  for (const rows of [[splitEarly, splitLate], [splitLate, splitEarly]]) {
    strictAssert.deepEqual(splitShape(familyMerge(committed, familyPage(...rows))), splitExpected)
  }
  const twoRows = familyMerge([], familyPage(splitEarly, splitLate))
  for (const rows of [[splitEarly, splitLate, splitEarliest], [splitEarliest, splitLate, splitEarly]]) {
    const notices = []
    const page = familyPage(...rows)
    const moved = familyMerge(twoRows.feed.models, page, { notice: message => notices.push(message) })
    strictAssert.deepEqual(splitShape(moved), [['gpt-fam-2024-11-01', '2027-01-01', ['gpt-fam']], ...splitExpected.map(([id, shutdown]) => [id, shutdown, undefined])])
    strictAssert.deepEqual(notices, ['notice: openai alias gpt-fam moved from gpt-fam-2025-01-01 to gpt-fam-2024-11-01'])
    const diff = compareFeeds(twoRows.feed, moved.feed)
    strictAssert.deepEqual(diff.aliasChanges, [{ id: 'gpt-fam-2025-01-01', added: [], removed: ['gpt-fam'] }])
    strictAssert.deepEqual(diff.added.map(model => [model.id, model.aliases]), [['gpt-fam-2024-11-01', ['gpt-fam']]])
    strictAssert.deepEqual(familyMerge(moved.feed.models, page).feed.models, moved.feed.models)
  }
})
reviewTest('Issue 135: the alias\'s own row beside snapshot rows with different shutdowns fails closed, in every order', () => {
  const permutations = items => items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]))
  for (const shutdown of ['Apr 1, 2027', 'Jun 1, 2027']) {
    for (const rows of permutations([splitEarly, splitLate, [shutdown, familyCell('gpt-fam')]])) {
      strictAssert.throws(() => familyMerge([], familyPage(...rows)), /share their family alias gpt-fam beside its own row/, rows.map(row => row[1]).join(' / '))
    }
  }
})
reviewTest('Issue 135: snapshot rows that tie on the earliest shutdown with different lifecycles fail closed', () => {
  const tied = ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-01'), 'gpt-other-next']
  for (const rows of [[splitEarly, tied], [tied, splitEarly], [splitEarly, splitLate, ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-01')]]]) {
    strictAssert.throws(() => familyMerge([], familyPage(...rows)), /family alias gpt-fam different lifecycles with no single earliest shutdown/)
  }
})
const splitLateDated = ['2026-10-01', '2027-06-01', 'gpt-next', PROVIDERS.openai.deprecationsUrl, undefined]
reviewTest('Issue 135 round 2: a committed alias takes the earliest snapshot row\'s lifecycle in either order, and a second run changes nothing', () => {
  for (const committed of [[{ id: 'gpt-fam' }], [{ id: 'gpt-fam-2025-06-01' }, { id: 'gpt-fam' }, { id: 'gpt-fam-2025-01-01' }]]) {
    for (const rows of [[splitEarly, splitLate], [splitLate, splitEarly]]) {
      const page = familyPage(...rows)
      const first = familyMerge(committed, page)
      strictAssert.deepEqual(Object.fromEntries(first.feed.models.map(model => [model.id, familyLifecycle(model)])), { 'gpt-fam': familyDated, 'gpt-fam-2025-01-01': familyDated, 'gpt-fam-2025-06-01': splitLateDated })
      const second = familyMerge(first.feed.models, page)
      strictAssert.deepEqual(second.feed.models, first.feed.models)
      strictAssert.equal(compareFeeds(first.feed, second.feed).changed, false)
      strictAssert.deepEqual(second.unconfirmedIds, [])
    }
  }
})
reviewTest('Issue 135 round 2: a committed alias\'s own row may match the earliest snapshot row, but a disagreeing own row or a repointing row still fails closed', () => {
  const permutations = items => items.length < 2 ? [items] : items.flatMap((item, index) => permutations(items.filter((_, other) => other !== index)).map(rest => [item, ...rest]))
  for (const rows of permutations([splitEarly, splitLate, ['Apr 1, 2027', familyCell('gpt-fam')]])) {
    strictAssert.deepEqual(familyLifecycle(familyMerge([{ id: 'gpt-fam' }], familyPage(...rows)).feed.models.find(model => model.id === 'gpt-fam')), familyDated)
  }
  for (const rows of permutations([splitEarly, splitLate, ['Jun 1, 2027', familyCell('gpt-fam')]])) {
    strictAssert.throws(() => familyMerge([{ id: 'gpt-fam' }], familyPage(...rows)), /gpt-fam conflicting lifecycles/)
  }
  for (const rows of [[splitEarly, [...splitLate.slice(0, 2), 'gpt-fam']], [[...splitLate.slice(0, 2), 'gpt-fam'], splitEarly]]) {
    strictAssert.throws(() => familyMerge([{ id: 'gpt-fam' }], familyPage(...rows)), /names its family alias gpt-fam as the replacement/)
  }
})
reviewTest('Issue 135 round 2: a row that would fold in an entry dated earlier in the run through an alias with a different lifecycle fails closed', () => {
  const chat = ['Jul 1, 2027', familyCell('gpt-fam-chat', 'gpt-fam')]
  const monthDay = [['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0101')], ['Jun 1, 2027', familyCell('gpt-md', 'gpt-md-0601')]]
  for (const rows of [[splitEarly, splitLate, chat], [chat, splitEarly, splitLate], monthDay, [...monthDay].reverse()]) {
    strictAssert.throws(() => familyMerge([], familyPage(...rows)), /would join gpt-\S+ through alias gpt-(?:fam|md) with a different lifecycle/, rows.map(row => row[1]).join(' / '))
  }
  const mistralRows = ['2027-04-01', '2027-06-01'].map((shutdown, index) => ({ id: `mistral-fam-250${index + 1}`, aliases: ['mistral-fam-latest'], announced: '2026-10-01', shutdown }))
  strictAssert.throws(() => mergeFeed({ spec: 'model-eol/0.1', publisher: 'mistral', models: [] }, { deprecations: mistralRows, currentIds: null, provider: PROVIDERS.mistral, notice: () => {} }), /would join mistral-fam-2501 through alias mistral-fam-latest/)
  const sameLifecycle = familyMerge([], familyPage(['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0101')], ['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0601')]))
  strictAssert.deepEqual(splitShape(sameLifecycle), [['gpt-md-0601', '2027-04-01', ['gpt-md-0101', 'gpt-md']]])
})
const repointing = (row, replacement) => [row[0], row[1], replacement]
reviewTest('Issue 135 round 3: any snapshot row that repoints its family alias stops the run, whether or not the alias is committed', () => {
  for (const committed of [[], [{ id: 'gpt-fam' }]]) {
    for (const rows of [
      [repointing(splitEarly, 'gpt-fam-2025-06-01'), splitLate], [splitLate, repointing(splitEarly, 'gpt-fam-2025-06-01')],
      [repointing(splitEarly, 'gpt-fam'), splitLate], [splitEarly, repointing(splitLate, 'gpt-fam')], [splitEarly, repointing(splitLate, 'gpt-fam-2025-01-01')],
      [repointing(splitEarly, 'gpt-fam')], [repointing(splitEarly, 'gpt-fam-2025-06-01')],
    ]) {
      strictAssert.throws(() => familyMerge(committed, familyPage(...rows)), /names its family alias gpt-fam as the replacement/, `${JSON.stringify(committed)} ${rows.map(row => row[2] ?? 'gpt-next').join(' / ')}`)
    }
  }
})
reviewTest('Issue 135 round 3: an OpenAI dated snapshot never folds into another entry or takes one in, in either order', () => {
  const sameLifecycle = (cell, page = familyPage) => [page(splitEarly, ['Apr 1, 2027', cell]), page(['Apr 1, 2027', cell], splitEarly)]
  for (const page of [...sameLifecycle(familyCell('gpt-fam-chat', 'gpt-fam')), ...sameLifecycle(familyCell('gpt-fam', 'gpt-fam-mini-2025-06-01'))]) {
    strictAssert.throws(() => familyMerge([], page), /an OpenAI dated snapshot is always its own entry/)
  }
  const oldFold = [{ id: 'gpt-fam-2025-06-01', aliases: ['gpt-fam-2025-01-01', 'gpt-fam'] }]
  for (const rows of [[splitEarly, ['Apr 1, 2027', splitLate[1]]], [['Apr 1, 2027', splitLate[1]], splitEarly]]) {
    strictAssert.throws(() => familyMerge(oldFold, familyPage(...rows)), /OpenAI snapshot gpt-fam-2025-01-01 reaches gpt-fam-2025-06-01 through an alias/)
  }
})
reviewTest('Issue 135 round 3: a committed split whose snapshots converge on one lifecycle moves the alias to the newest snapshot, in either order, and a second run changes nothing', () => {
  const split = [{ id: 'gpt-fam-2025-01-01', aliases: ['gpt-fam'] }, { id: 'gpt-fam-2025-06-01' }]
  for (const [shutdown, rows] of [['2027-06-01', [['Jun 1, 2027', splitEarly[1]], splitLate]], ['2027-04-01', [splitEarly, ['Apr 1, 2027', splitLate[1]]]]]) {
    for (const order of [rows, [...rows].reverse()]) {
      const notices = []
      const page = familyPage(...order)
      const first = familyMerge(split, page, { notice: message => notices.push(message) })
      strictAssert.deepEqual(splitShape(first), [['gpt-fam-2025-01-01', shutdown, undefined], ['gpt-fam-2025-06-01', shutdown, ['gpt-fam']]])
      strictAssert.deepEqual(notices, ['notice: openai alias gpt-fam moved from gpt-fam-2025-01-01 to gpt-fam-2025-06-01'])
      strictAssert.deepEqual(familyMerge(first.feed.models, page).feed.models, first.feed.models)
    }
  }
  const committedAlias = familyMerge([{ id: 'gpt-fam' }], familyPage(splitEarly, splitLate)).feed.models
  for (const rows of [[['Jun 1, 2027', splitEarly[1]], splitLate], [splitLate, ['Jun 1, 2027', splitEarly[1]]]]) {
    const first = familyMerge(committedAlias, familyPage(...rows))
    strictAssert.deepEqual(first.feed.models.map(model => [model.id, model.shutdown]).sort(), [['gpt-fam', '2027-06-01'], ['gpt-fam-2025-01-01', '2027-06-01'], ['gpt-fam-2025-06-01', '2027-06-01']])
    strictAssert.deepEqual(familyMerge(first.feed.models, familyPage(...rows)).feed.models, first.feed.models)
  }
})
reviewTest('Issue 135 round 3: only rows that list the alias join its group, and the models endpoint confirms a split', () => {
  const lateAlone = ['Apr 1, 2027', familyCell('gpt-fam-2025-06-01')]
  for (const rows of [[splitEarly, lateAlone], [lateAlone, splitEarly], [splitEarly, [...lateAlone, 'gpt-other']]]) {
    strictAssert.deepEqual(splitShape(familyMerge([], familyPage(...rows))), [['gpt-fam-2025-01-01', '2027-04-01', ['gpt-fam']], ['gpt-fam-2025-06-01', '2027-04-01', undefined]])
  }
  const currentIds = ['gpt-fam', 'gpt-fam-2025-01-01', 'gpt-fam-2025-06-01']
  for (const rows of [[splitEarly, splitLate], [splitLate, splitEarly]]) {
    const first = familyMerge([], familyPage(...rows), { currentIds })
    strictAssert.deepEqual(splitShape(first), splitExpected)
    const second = familyMerge(first.feed.models, familyPage(...rows), { currentIds })
    strictAssert.deepEqual(second.feed.models, first.feed.models)
    strictAssert.deepEqual(second.unconfirmedIds, [])
  }
})
reviewTest('Issue 135 round 3: the same-run fold check compares the whole lifecycle and covers entries dated through an alias', () => {
  const pages = [
    familyPage(['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0101')], ['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0601'), 'gpt-other']),
    familyTable('2026-09-01: Earlier', 'Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0101')) + familyTable('2026-10-01: Later', 'Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0601')),
    familyPage(['Apr 1, 2027', familyCell('gpt-md', 'gpt-md-0101')], ['Apr 1, 2027', familyCell('gpt-md')], ['Jun 1, 2027', familyCell('gpt-md', 'gpt-md-0601')]),
  ]
  for (const page of pages) strictAssert.throws(() => familyMerge([], page), /would join gpt-md-0101 through alias gpt-md with a different lifecycle/)
})
reviewTest('Issue 135 late pass: one snapshot row beside its uncommitted alias\'s own row gives the same result in either order', () => {
  const own = ['Apr 1, 2027', familyCell('gpt-fam')]
  for (const models of [[], [{ id: 'gpt-fam-2025-01-01' }]]) {
    for (const rows of [[splitEarly, own], [own, splitEarly]]) {
      const first = familyMerge(models, familyPage(...rows))
      strictAssert.deepEqual(splitShape(first), [['gpt-fam-2025-01-01', '2027-04-01', ['gpt-fam']]])
      strictAssert.deepEqual(familyMerge(first.feed.models, familyPage(...rows)).feed.models, first.feed.models)
    }
    for (const rows of [[splitEarly, ['Jun 1, 2027', familyCell('gpt-fam')]], [['Jun 1, 2027', familyCell('gpt-fam')], splitEarly]]) {
      strictAssert.throws(() => familyMerge(models, familyPage(...rows)), /conflicting lifecycles/)
    }
  }
  for (const rows of [[splitEarly, own], [own, splitEarly]]) {
    strictAssert.deepEqual(familyMerge([{ id: 'gpt-fam' }], familyPage(...rows)).feed.models.map(model => [model.id, model.shutdown]).sort(), [['gpt-fam', '2027-04-01'], ['gpt-fam-2025-01-01', '2027-04-01']])
  }
})
reviewTest('Issue 135 late pass: an ID that only contains a date is not a dated snapshot, so same-lifecycle rows still merge it', () => {
  const preview = ['Apr 1, 2027', familyCell('gpt-fam-2025-01-01-preview', 'gpt-fam-pre')]
  const chat = ['Apr 1, 2027', familyCell('gpt-fam-pre-chat', 'gpt-fam-pre')]
  for (const rows of [[preview, chat], [chat, preview]]) {
    const ids = familyMerge([], familyPage(...rows)).feed.models.map(model => [model.id, ...(model.aliases ?? [])].sort())
    strictAssert.equal(ids.length, 1)
    strictAssert.deepEqual(ids[0], ['gpt-fam-2025-01-01-preview', 'gpt-fam-pre', 'gpt-fam-pre-chat'])
  }
})
const noticeDateHtml = fs.readFileSync(path.join(fixtures, 'openai-deprecations-notice-date.html'), 'utf8')
const noticeNow = new Date('2026-11-16T12:00:00Z')
const noticeParse = (page, now = noticeNow) => parseOpenAIDeprecations(page, undefined, { now })
const noticeDateRecords = () => noticeParse(noticeDateHtml)
const noticeDateRecord = id => noticeDateRecords().find(record => record.id === id)
const noticeDateEdit = (from, to) => {
  strictAssert.equal(noticeDateHtml.split(from).length, 2, from)
  return noticeDateHtml.replace(from, to)
}
const noticeCyberRow = '<td><span data-deprecation-status="deprecated">Deprecated</span></td>\n<td>The most capable cyber model available to you.</td>\n<td>Nov 5, 2026</td>'
reviewTest('Notice-date layout: each OpenAI row takes its announcement from its own notice date', () => {
  const lifecycle = id => { const { announced, shutdown } = noticeDateRecord(id) ?? {}; return [announced, shutdown] }
  strictAssert.deepEqual(lifecycle('gpt-5-2025-08-07'), ['2026-06-11', '2026-12-11'])
  strictAssert.deepEqual(lifecycle('gpt-5.5-cyber-preview'), ['2026-11-05', '2027-02-01'])
  strictAssert.deepEqual(lifecycle('gpt-4o-mini-transcribe-2025-03-20'), ['2026-07-20', '2027-01-20'])
  strictAssert.deepEqual(lifecycle('gpt-4o-mini-transcribe-2025-12-15'), ['2026-08-26', '2027-02-26'])
  strictAssert.deepEqual(lifecycle('gpt-4-32k-0314'), ['2023-06-13', '2025-06-06'])
  strictAssert.deepEqual(lifecycle('babbage-002'), ['2025-09-26', '2026-09-28'])
  strictAssert.deepEqual(lifecycle('gpt-4-0314'), ['2025-09-26', '2026-03-26'])
  strictAssert.deepEqual(lifecycle('code-davinci-002'), ['2023-07-06', '2024-01-04'])
  const dated = noticeParse(noticeDateHtml.replace('<span class="min-w-0">Upcoming deprecations</span>', '2026-01-01: Upcoming deprecations'))
  strictAssert.deepEqual(dated, noticeDateRecords())
})
reviewTest('Notice-date layout: every OpenAI record carries the shutdown, notice date, replacement, and aliases of a row that names it', () => {
  const rows = [...noticeDateHtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].flatMap(table => {
    const cells = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(cell => cell[1]))
    const header = cells[0].map(cell => cell.split(/<[^>]*>/).join('').trim())
    const at = label => header.indexOf(label)
    const model = at('Affected model') >= 0 ? at('Affected model') : at('Affected model or feature')
    if (model < 0) return []
    const replacement = at('Recommended replacement') >= 0 ? at('Recommended replacement') : at('Listed replacement')
    const codes = html => [...html.matchAll(/<code>([^<]*)<\/code>/g)].map(match => match[1])
    return cells.slice(1).map(row => ({ ids: codes(row[model]), shutdown: dateFromText(row[at('Shutdown date')]), announced: dateFromText(row[at('Notice date')]), replacements: codes(row[replacement]) }))
  })
  strictAssert.equal(rows.length, 24)
  for (const record of noticeDateRecords()) {
    const own = rows.filter(row => row.ids.includes(record.id) && row.shutdown === record.shutdown && row.announced === record.announced)
    strictAssert.ok(own.length, record.id)
    const targets = [record.replacement, ...(record.replacement_options ?? [])].filter(Boolean)
    strictAssert.ok(own.some(row => targets.every(target => row.replacements.includes(target))), `${record.id} replacement`)
    for (const alias of record.aliases ?? []) strictAssert.ok(own.some(row => row.ids.includes(alias)), `${record.id} alias ${alias}`)
    const latest = Math.max(...rows.filter(row => row.ids.includes(record.id)).map(row => Date.parse(row.announced)))
    strictAssert.equal(Date.parse(record.announced), latest, `${record.id} keeps the latest notice`)
  }
})
reviewTest('Notice-date layout: an OpenAI model row with an empty, unparseable, or ambiguous notice date fails closed naming the model', () => {
  for (const notice of ['', 'TBD', 'Nov 5, 2026 (updated Nov 9, 2026)', 'Nov 31, 2026']) {
    const page = noticeDateEdit('<td>Nov 5, 2026</td>', `<td>${notice}</td>`)
    strictAssert.throws(() => noticeParse(page), notice === 'Nov 31, 2026' ? /entry gpt-5\.5-cyber-preview has no valid notice date: invalid date "Nov 31, 2026"$/ : /entry gpt-5\.5-cyber-preview has no valid notice date$/, notice)
  }
})
const noticeStatusPage = status => noticeDateEdit(noticeCyberRow, noticeCyberRow.replace('>Deprecated<', `>${status}<`))
const openaiMdParse = (page, now = noticeNow) => parseOpenAIDeprecationsMarkdown(page, undefined, { now })
const openaiMdRow = (token, edit) => {
  const lines = openaiMarkdown.split('\n')
  const at = lines.flatMap((line, index) => line.startsWith('|') && line.includes(token) ? [index] : [])
  strictAssert.equal(at.length, 1, token)
  lines[at[0]] = `| ${edit(lines[at[0]].split('|').slice(1, -1).map(cell => cell.trim())).join(' | ')} |`
  return lines.join('\n')
}
const openaiMdCyber = '`gpt-5.5-cyber-preview`'
const openaiMdStatusPage = status => openaiMdRow(openaiMdCyber, cells => cells.with(2, status))
reviewTest('Notice-date layout: an OpenAI Status other than Deprecated or a past Shut down fails closed naming the model', () => {
  for (const status of ['Read-only', 'Retired', 'Deprecated soon', '']) {
    strictAssert.throws(() => noticeParse(noticeStatusPage(status), new Date('2027-06-01T00:00:00Z')), new RegExp(`entry gpt-5\\.5-cyber-preview has an unrecognised status for shutdown 2027-02-01 on 2027-06-01: ${status || '\\(empty\\)'}$`), status)
  }
})
reviewTest('Notice-date layout: OpenAI accepts Shut down only on or after the shutdown date of its row, read from the injected clock', () => {
  for (const status of ['Shut down', 'shut down', 'Shutdown', 'SHUTDOWN']) {
    strictAssert.throws(() => noticeParse(noticeStatusPage(status), new Date('2027-01-31T23:59:59Z')), new RegExp(`entry gpt-5\\.5-cyber-preview has an unrecognised status for shutdown 2027-02-01 on 2027-01-31: ${status}$`), status)
    for (const now of ['2027-02-01T00:00:00Z', '2027-02-02T00:00:00Z']) {
      strictAssert.deepEqual(noticeParse(noticeStatusPage(status), new Date(now)), noticeDateRecords(), `${status} ${now}`)
    }
  }
  strictAssert.throws(() => noticeParse(noticeDateHtml, new Date('not a date')), /refresh clock is not a valid date/)
})
reviewTest('Refresh clock: the CLI reads MODEL_EOL_GENERATED as the refresh day for the OpenAI and Azure parsers', () => {
  const clockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-clock-'))
  try {
    fs.copyFileSync(path.join(fixtures, 'openai-models.json'), path.join(clockDir, 'openai-models.json'))
    fs.writeFileSync(path.join(clockDir, 'openai-deprecations.md'), openaiMdStatusPage('Shut down'))
    fs.writeFileSync(path.join(clockDir, 'azure-model-retirement-schedule.md'), azureMarkdownFootnotePage)
    const refreshAt = (source, generated) => run([...source, '--check', '--fixtures', clockDir], { env: { ...process.env, MODEL_EOL_GENERATED: generated } })
    const openai = ['--provider', 'openai']
    const azure = ['--distributor', 'azure-ai-foundry']
    const openaiBefore = refreshAt(openai, '2027-01-31T23:59:59Z')
    strictAssert.equal(openaiBefore.code, 1)
    strictAssert.match(openaiBefore.err, /entry gpt-5\.5-cyber-preview has an unrecognised status for shutdown 2027-02-01 on 2027-01-31: Shut down/)
    const openaiAfter = refreshAt(openai, '2027-02-01T00:00:00Z')
    strictAssert.ok([0, 3].includes(openaiAfter.code), `OpenAI Shut down row refused on its shutdown day: ${openaiAfter.err}`)
    const azureBefore = refreshAt(azure, '2026-03-31T12:00:00Z')
    strictAssert.equal(azureBefore.code, 1)
    strictAssert.match(azureBefore.err, /footnote 3 states an earlier date 2026-03-31 that is not past on 2026-03-31/)
    const azureAfter = refreshAt(azure, '2026-04-01T00:00:00Z')
    strictAssert.ok([0, 3].includes(azureAfter.code), `Azure footnote date refused once past: ${azureAfter.err}`)
  } finally {
    fs.rmSync(clockDir, { recursive: true, force: true })
  }
})
reviewTest('Notice-date layout: the OpenAI feature and endpoint table and the fine-tuning timeline produce no records', () => {
  const ids = noticeDateRecords().flatMap(record => [record.id, ...(record.aliases ?? [])])
  for (const token of ['/v1/prompts', '/v1/audio/translations', '/v1/realtime/translations', 'Agent Builder', 'Videos API', 'Assistants API', 'OpenAI-Beta: realtime=v1', '/v1/edits']) {
    strictAssert.ok(!ids.includes(token), token)
  }
  strictAssert.ok(noticeDateRecords().every(record => record.announced !== '2026-06-03' && record.announced !== '2026-05-07'))
  strictAssert.ok(noticeDateRecords().every(record => record.shutdown !== '2026-11-30'))
  const modelTables = noticeDateHtml.replace(/<table\b[^>]*>(?:(?!<\/table>)[\s\S])*?Affected model[\s\S]*?<\/table>/g, '')
  strictAssert.throws(() => noticeParse(modelTables), /has no recognisable deprecations content: endpoint-or-product-deprecation-table$/)
})
reviewTest('Notice-date layout: OpenAI multi-ID cells keep their aliases as before', () => {
  const aliases = id => noticeDateRecord(id)?.aliases
  strictAssert.deepEqual(aliases('gpt-3.5-turbo-0125'), ['gpt-3.5-turbo', 'gpt-3.5-turbo-completions'])
  strictAssert.deepEqual(aliases('gpt-4-0613'), ['gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions'])
  strictAssert.deepEqual(aliases('gpt-4-0125-preview'), ['gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions'])
  strictAssert.deepEqual(aliases('gpt-5-2025-08-07'), ['gpt-5'])
  strictAssert.deepEqual(aliases('gpt-4o-mini-transcribe-2025-12-15'), ['gpt-4o-mini-transcribe'])
  strictAssert.deepEqual([aliases('gpt-4o-2024-08-06'), aliases('gpt-4o-2024-11-20')], [undefined, undefined])
  strictAssert.deepEqual([aliases('gpt-4o-mini-tts-2025-03-20'), aliases('gpt-4o-mini-tts-2025-12-15')], [['gpt-4o-mini-tts'], ['gpt-4o-mini-tts']])
  strictAssert.ok(!noticeDateRecord('gpt-4o-mini-tts') && !noticeDateRecord('GPT-4o'))
})
reviewTest('Notice-date layout: one OpenAI cell listing a family alias and its snapshots merges like one row per snapshot', () => {
  const oneCell = familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-20', 'gpt-fam-2025-12-15')])
  const twoRows = familyPage(['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-03-20')], ['Apr 1, 2027', familyCell('gpt-fam', 'gpt-fam-2025-12-15')])
  for (const committed of [[], [{ id: 'gpt-fam' }], [{ id: 'gpt-fam-2025-03-20', aliases: ['gpt-fam'] }]]) {
    strictAssert.deepEqual(familyMerge(committed, oneCell).feed, familyMerge(committed, twoRows).feed, JSON.stringify(committed))
  }
})
reviewTest('Notice-date layout: an OpenAI replacement cell without code elements is a note unless it is a plain list of IDs', () => {
  strictAssert.deepEqual(Object.entries(noticeDateRecord('sora-2')).filter(([key]) => key.startsWith('replacement')), [['replacement_note', 'No one-to-one replacement']])
  strictAssert.deepEqual(Object.entries(noticeDateRecord('gpt-5.5-cyber-preview')).filter(([key]) => key.startsWith('replacement')), [['replacement_note', 'The most capable cyber model available to you.']])
  strictAssert.equal(noticeDateRecord('gpt-5-pro-2025-10-06').replacement, 'gpt-6.1-sol')
  const bare = parseOpenAIDeprecations(shapesOpenAIPage('<code>gpt-4o-2024-08-06</code>').replace('<code>gpt-6-luna</code>', 'gpt-6-luna'))
  strictAssert.equal(bare[0].replacement, 'gpt-6-luna')
  const replacementOf = cell => {
    const [record] = parseOpenAIDeprecations(shapesOpenAIPage('<code>gpt-4o-2024-08-06</code>').replace('<code>gpt-6-luna</code>', cell))
    return Object.fromEntries(Object.entries(record).filter(([key]) => key.startsWith('replacement')))
  }
  for (const cell of ['gpt-5 or gpt-4.1', 'gpt-5, gpt-4.1', 'gpt-5 / gpt-4.1', 'gpt-5, or gpt-4.1', 'gpt-5 and gpt-4.1']) {
    strictAssert.deepEqual(replacementOf(cell), { replacement_options: ['gpt-5', 'gpt-4.1'] }, cell)
  }
  strictAssert.deepEqual(replacementOf('gpt-6-luna'), { replacement: 'gpt-6-luna' })
  for (const cell of ['No one-to-one replacement', 'gpt-5 or later', 'gpt-5 for most tasks', 'GPT-5 / GPT-4.1', 'Text-to-speech / Speech-to-text', 'TBD', 'None.', 'Discontinued']) {
    strictAssert.deepEqual(replacementOf(cell), { replacement_note: cell }, cell)
  }
  for (const cell of ['---', 'N/A', 'none']) strictAssert.deepEqual(replacementOf(cell), {}, cell)
})
reviewTest('Notice-date layout: an OpenAI table with neither a notice-date column nor a dated heading still fails', () => {
  const page = '<h2>Past deprecations</h2><table><tr><th>Shutdown date</th><th>Affected model or feature</th><th>Listed replacement</th></tr><tr><td>Oct 23, 2026</td><td><code>gpt-4o-2024-05-13</code></td><td><code>gpt-5.6-sol</code></td></tr></table>'
  strictAssert.throws(() => parseOpenAIDeprecations(page), /^Error: openai deprecations table has no announcement date$/)
  const dated = parseOpenAIDeprecations(page.replace('Past deprecations', '2026-04-22: Past deprecations'))
  strictAssert.deepEqual(dated.map(record => [record.id, record.announced, record.shutdown, record.replacement]), [['gpt-4o-2024-05-13', '2026-04-22', '2026-10-23', 'gpt-5.6-sol']])
})
const noticeHeaders = ['Shutdown date', 'Affected model', 'Status', 'Recommended replacement', 'Notice date']
const noticeRow = ['Jan 6, 2027', '<code>m-1</code>', 'Deprecated', '<code>gpt-next</code>', 'Oct 1, 2026']
const noticeTable = (headers = noticeHeaders, rows = [noticeRow]) => `<h1>2026-01-01: Deprecations</h1><h2>Upcoming deprecations</h2><table><tr>${headers.map(label => `<th>${label}</th>`).join('')}</tr>${rows.map(cells => `<tr>${cells.map(cell => cell.startsWith('<td') ? cell : `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`
const noticeTableRecords = (...args) => noticeParse(noticeTable(...args)).map(record => [record.id, record.announced, record.shutdown, record.replacement ?? record.replacement_options])
reviewTest('Notice-date layout: an OpenAI row whose cells do not line up with the notice-date header stops the run naming the row', () => {
  strictAssert.deepEqual(noticeTableRecords(), [['m-1', '2026-10-01', '2027-01-06', 'gpt-next']])
  const sixCells = ['Jan 6, 2027', '<code>m-1</code>', 'Deprecated', '<code>gpt-next</code>', 'Updated Nov 1, 2026', 'Oct 1, 2026']
  strictAssert.throws(() => noticeTableRecords(undefined, [noticeRow, sixCells]), /table row "Jan 6, 2027 m-1 Deprecated gpt-next Updated Nov 1, 2026 Oct 1, 2026" has 6 cells, but its header has 5 columns$/)
  strictAssert.throws(() => noticeTableRecords(undefined, [noticeRow.slice(0, 4)]), /table row "Jan 6, 2027 m-1 Deprecated gpt-next" has 4 cells, but its header has 5 columns$/)
  const colspan = ['Jan 6, 2027', '<code>m-1</code>', '<td colspan="2">Deprecated</td>', 'Oct 1, 2026']
  strictAssert.throws(() => noticeTableRecords(undefined, [colspan]), /table row "Jan 6, 2027 m-1 Deprecated Oct 1, 2026" has a spanning cell, but its header has 5 columns$/)
  const rowspan = ['<td rowspan="2">Jan 6, 2027</td>', ...noticeRow.slice(1)]
  strictAssert.throws(() => noticeTableRecords(undefined, [rowspan]), /has a spanning cell, but its header has 5 columns$/)
  const spanningHeader = noticeTable(noticeHeaders).replace('<th>Recommended replacement</th>', '<th colspan="2">Recommended replacement</th>')
  strictAssert.throws(() => noticeParse(spanningHeader), /table row "Shutdown date Affected model Status Recommended replacement Notice date" has a spanning cell, but its header has 5 columns$/)
  const missingNotice = noticeDateEdit(noticeCyberRow, noticeCyberRow.replace('\n<td>Nov 5, 2026</td>', ''))
  strictAssert.throws(() => noticeParse(missingNotice), /table row "Feb 1, 2027 gpt-5\.5-cyber-preview Deprecated The most capable cyber model available to you\." has 4 cells, but its header has 5 columns$/)
})
reviewTest('Notice-date layout: an OpenAI notice header the parser does not accept stops the run instead of falling back to a dated heading', () => {
  strictAssert.deepEqual(noticeTableRecords(noticeHeaders.map(label => label === 'Notice date' ? 'Announcement date' : label)), [['m-1', '2026-10-01', '2027-01-06', 'gpt-next']])
  for (const label of ['Notice date (UTC)', 'Notice date¹', 'Date announced', 'Last notice date', 'Notice', 'Announced', 'Notice dates']) {
    const headers = noticeHeaders.filter(header => header !== 'Status').map(header => header === 'Notice date' ? label : header)
    const rows = [noticeRow.filter(cell => cell !== 'Deprecated')]
    strictAssert.throws(() => noticeTableRecords(headers, rows), new RegExp(`table has an unrecognised notice header: ${label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), label)
  }
  const fallback = noticeTable(noticeHeaders.filter(header => header !== 'Status' && header !== 'Notice date'), [noticeRow.filter(cell => cell !== 'Deprecated' && cell !== 'Oct 1, 2026')])
  strictAssert.deepEqual(noticeParse(fallback).map(record => record.announced), ['2026-01-01'])
})
reviewTest('Notice-date layout: an OpenAI status column needs a notice-date column, and only one status column is allowed', () => {
  const withoutNotice = noticeHeaders.filter(header => header !== 'Notice date')
  strictAssert.throws(() => noticeTableRecords(withoutNotice, [noticeRow.slice(0, 4)]), /table has a status column but no notice date column$/)
  const twoStatuses = [...noticeHeaders, 'Migration status']
  strictAssert.throws(() => noticeTableRecords(twoStatuses, [[...noticeRow, 'Deprecated']]), /table has more than one status column$/)
})
reviewTest('Notice-date layout: an OpenAI status column is any label naming a status, such as Current status', () => {
  const headers = noticeHeaders.map(label => label === 'Status' ? 'Current status' : label)
  strictAssert.deepEqual(noticeTableRecords(headers), [['m-1', '2026-10-01', '2027-01-06', 'gpt-next']])
  const shutDown = noticeRow.map(cell => cell === 'Deprecated' ? 'Shut down' : cell)
  strictAssert.throws(() => noticeTableRecords(headers, [shutDown]), /entry m-1 has an unrecognised status for shutdown 2027-01-06 on 2026-11-16: Shut down$/)
  strictAssert.throws(() => noticeTableRecords(headers.map(label => label === 'Current status' ? 'Status (GA)' : label), [shutDown]), /entry m-1 has an unrecognised status/)
})
reviewTest('Notice-date layout: an OpenAI family cell needs exactly one undated ID and only -YYYY-MM-DD snapshots of it', () => {
  for (const ids of [['f', 'f-latest', 'f-2025-03-20', 'f-2025-12-15'], ['f', '/v1/foo', 'f-2025-03-20', 'f-2025-12-15'], ['f', 'f-2025_03_20', 'f-2025-12-15']]) {
    strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage(openAICodes(...ids))), /with ambiguous alias f$/, ids.join(', '))
  }
  strictAssert.deepEqual(openAISnapshots('f', 'f-2025-03-20', 'f-2025-12-15'), [['f-2025-03-20', ['f']], ['f-2025-12-15', ['f']]])
})
const openaiMdHeaders = ['Shutdown date', 'Affected model', 'Status', 'Recommended replacement', 'Notice date']
const openaiMdLine = cells => `| ${cells.join(' | ')} |`
const openaiMdTable = (headers = openaiMdHeaders, rows = [['Jan 6, 2027', '`m-1`', 'Deprecated', '`gpt-next`', 'Oct 1, 2026']], heading = '## Upcoming deprecations') => `# Deprecations\n\n${heading}\n\n${openaiMdLine(headers)}\n${openaiMdLine(headers.map(() => '---'))}\n${rows.map(openaiMdLine).join('\n')}\n`
const openaiMdRecords = page => openaiMdParse(page).map(record => [record.id, record.announced, record.shutdown, record.replacement ?? record.replacement_options])
const openaiMdRecord = (id, page = openaiMarkdown) => openaiMdParse(page).find(record => record.id === id)
reviewTest('Markdown source: the OpenAI Markdown fixture parses to the records of the rendered excerpt with the same rows, apart from curled apostrophes', () => {
  strictAssert.deepEqual(openaiMdParse(openaiMarkdown), noticeParse(noticeDateHtml.replaceAll('’', "'")))
  strictAssert.notDeepEqual(openaiMdParse(openaiMarkdown), noticeDateRecords())
})
reviewTest('Markdown source: each OpenAI row takes its announcement from its own notice date, and a bad notice cell stops the run naming the model', () => {
  const lifecycle = id => { const { announced, shutdown } = openaiMdRecord(id) ?? {}; return [announced, shutdown] }
  strictAssert.deepEqual(lifecycle('gpt-5-2025-08-07'), ['2026-06-11', '2026-12-11'])
  strictAssert.deepEqual(lifecycle('gpt-5.5-cyber-preview'), ['2026-11-05', '2027-02-01'])
  strictAssert.deepEqual(lifecycle('gpt-4-32k-0314'), ['2023-06-13', '2025-06-06'])
  strictAssert.deepEqual(lifecycle('code-davinci-002'), ['2023-07-06', '2024-01-04'])
  for (const notice of ['', 'TBD', 'Nov 5, 2026 (updated Nov 9, 2026)', 'Nov 31, 2026']) {
    const page = openaiMdRow(openaiMdCyber, cells => cells.with(4, notice))
    strictAssert.throws(() => openaiMdParse(page), notice === 'Nov 31, 2026' ? /entry gpt-5\.5-cyber-preview has no valid notice date: invalid date "Nov 31, 2026"$/ : /entry gpt-5\.5-cyber-preview has no valid notice date$/, notice)
  }
})
reviewTest('Markdown source: an OpenAI status is Deprecated, or Shut down once the refresh clock reaches the shutdown date', () => {
  for (const status of ['Read-only', 'Retired', 'Deprecated soon', '']) {
    strictAssert.throws(() => openaiMdParse(openaiMdStatusPage(status), new Date('2027-06-01T00:00:00Z')), new RegExp(`entry gpt-5\\.5-cyber-preview has an unrecognised status for shutdown 2027-02-01 on 2027-06-01: ${status || '\\(empty\\)'}$`), status)
  }
  for (const status of ['Shut down', 'Shutdown']) {
    strictAssert.throws(() => openaiMdParse(openaiMdStatusPage(status), new Date('2027-01-31T23:59:59Z')), /unrecognised status for shutdown 2027-02-01 on 2027-01-31/, status)
    strictAssert.deepEqual(openaiMdParse(openaiMdStatusPage(status), new Date('2027-02-01T00:00:00Z')), openaiMdParse(openaiMarkdown), status)
  }
  strictAssert.throws(() => openaiMdParse(openaiMarkdown, new Date('not a date')), /refresh clock is not a valid date/)
})
reviewTest('Markdown source: OpenAI family-alias cells give one record per snapshot, and other multi-ID cells keep their aliases', () => {
  const aliases = id => openaiMdRecord(id)?.aliases
  strictAssert.deepEqual([aliases('gpt-4o-mini-tts-2025-03-20'), aliases('gpt-4o-mini-tts-2025-12-15')], [['gpt-4o-mini-tts'], ['gpt-4o-mini-tts']])
  strictAssert.deepEqual([aliases('gpt-4o-2024-08-06'), aliases('gpt-4o-2024-11-20')], [undefined, undefined])
  strictAssert.deepEqual(aliases('gpt-4-0613'), ['gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions'])
  strictAssert.deepEqual(aliases('gpt-4-0125-preview'), ['gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions'])
  strictAssert.ok(!openaiMdRecord('gpt-4o-mini-tts') && !openaiMdRecord('GPT-4o'))
  const ambiguous = openaiMdRow('`gpt-4o-mini-tts-2025-03-20`', cells => cells.with(1, `${cells[1]}, \`gpt-4o-mini-tts-latest\``))
  strictAssert.throws(() => openaiMdParse(ambiguous), /with ambiguous alias gpt-4o-mini-tts$/)
})
reviewTest('Markdown source: an OpenAI replacement cell without code spans is a note unless every part has the lowercase ID shape', () => {
  const replacementOf = cell => Object.fromEntries(Object.entries(openaiMdRecord('gpt-4o-mini-transcribe-2025-03-20', openaiMdRow('`gpt-4o-mini-transcribe-2025-03-20`', cells => cells.with(3, cell)))).filter(([key]) => key.startsWith('replacement')))
  strictAssert.deepEqual(replacementOf('`gpt-6-luna`'), { replacement: 'gpt-6-luna' })
  strictAssert.deepEqual(replacementOf('gpt-6-luna'), { replacement: 'gpt-6-luna' })
  for (const cell of ['gpt-5 or gpt-4.1', 'gpt-5, gpt-4.1', 'gpt-5 / gpt-4.1', '`gpt-5` or `gpt-4.1`']) strictAssert.deepEqual(replacementOf(cell), { replacement_options: ['gpt-5', 'gpt-4.1'] }, cell)
  for (const cell of ['No one-to-one replacement', 'gpt-5 or later', 'GPT-5 / GPT-4.1', 'TBD']) strictAssert.deepEqual(replacementOf(cell), { replacement_note: cell }, cell)
  for (const cell of ['---', 'N/A', 'none']) strictAssert.deepEqual(replacementOf(cell), {}, cell)
  strictAssert.deepEqual(replacementOf('**No** one-to-one _replacement_'), { replacement_note: 'No one-to-one replacement' })
  strictAssert.deepEqual(Object.entries(openaiMdRecord('sora-2')).filter(([key]) => key.startsWith('replacement')), [['replacement_note', 'No one-to-one replacement']])
  strictAssert.deepEqual(Object.entries(openaiMdRecord('gpt-5.5-cyber-preview')).filter(([key]) => key.startsWith('replacement')), [['replacement_note', 'The most capable cyber model available to you.']])
})
reviewTest('Markdown source: an OpenAI notice header the parser does not accept stops the run, and a table without one dates from its heading', () => {
  strictAssert.deepEqual(openaiMdRecords(openaiMdTable()), [['m-1', '2026-10-01', '2027-01-06', 'gpt-next']])
  strictAssert.deepEqual(openaiMdRecords(openaiMdTable(openaiMdHeaders.with(4, 'Announcement date'))), [['m-1', '2026-10-01', '2027-01-06', 'gpt-next']])
  const noStatus = [['Jan 6, 2027', '`m-1`', '`gpt-next`', 'Oct 1, 2026']]
  for (const label of ['Notice date (UTC)', 'Date announced', 'Notice']) {
    strictAssert.throws(() => openaiMdParse(openaiMdTable(['Shutdown date', 'Affected model', 'Recommended replacement', label], noStatus)), new RegExp(`table has an unrecognised notice header: ${label.toLowerCase().replace(/[()]/g, '\\$&')}$`), label)
  }
  strictAssert.throws(() => openaiMdParse(openaiMdTable(openaiMdHeaders.slice(0, 4), [['Jan 6, 2027', '`m-1`', 'Deprecated', '`gpt-next`']])), /table has a status column but no notice date column$/)
  const undated = openaiMdTable(['Shutdown date', 'Affected model', 'Recommended replacement'], [['Jan 6, 2027', '`m-1`', '`gpt-next`']])
  strictAssert.throws(() => openaiMdParse(undated), /^Error: openai deprecations table has no announcement date$/)
  strictAssert.deepEqual(openaiMdRecords(undated.replace('## Upcoming deprecations', '## 2026-04-22: Upcoming deprecations')), [['m-1', '2026-04-22', '2027-01-06', 'gpt-next']])
  const nested = undated.replace('## Upcoming deprecations', '## 2026-04-22: Legacy snapshots\n\n```\n## 2026-05-01: Fenced\n```\n\n<!--\n### 2026-05-02: Commented\n-->\n\n### July shutdown')
  strictAssert.deepEqual(openaiMdRecords(nested), [['m-1', '2026-04-22', '2027-01-06', 'gpt-next']])
})
reviewTest('Markdown source: an OpenAI row whose cells do not line up with its header stops the run naming the line', () => {
  const row = ['Jan 6, 2027', '`m-1`', 'Deprecated', '`gpt-next`', 'Oct 1, 2026']
  strictAssert.throws(() => openaiMdParse(openaiMdTable(undefined, [row, [...row.slice(0, 4), 'Updated Nov 1, 2026', 'Oct 1, 2026']])), /^Error: openai deprecations page: line 8: table row has 6 cells; the header has 5$/)
  strictAssert.throws(() => openaiMdParse(openaiMdTable(undefined, [row.slice(0, 4)])), /^Error: openai deprecations page: line 7: table row has 4 cells; the header has 5$/)
  const missingNotice = openaiMdRow(openaiMdCyber, cells => cells.slice(0, 4))
  const line = missingNotice.split('\n').findIndex(text => text.includes(openaiMdCyber)) + 1
  strictAssert.throws(() => openaiMdParse(missingNotice), new RegExp(`^Error: openai deprecations page: line ${line}: table row has 4 cells; the header has 5$`))
  strictAssert.deepEqual(openaiMdRecords(openaiMdTable(undefined, [row.with(3, '`gpt-next` \\| `gpt-other`')])), [['m-1', '2026-10-01', '2027-01-06', ['gpt-next', 'gpt-other']]])
})
reviewTest('Markdown source: OpenAI feature, endpoint, and product rows produce no records, and a model ID beside one stops the run', () => {
  const ids = openaiMdParse(openaiMarkdown).flatMap(record => [record.id, ...(record.aliases ?? [])])
  for (const token of ['/v1/prompts', '/v1/audio/translations', '/v1/realtime/translations', 'Agent Builder', 'Videos API', 'Assistants API', 'OpenAI-Beta: realtime=v1', '/v1/edits']) {
    strictAssert.ok(!ids.includes(token), token)
  }
  strictAssert.ok(openaiMdParse(openaiMarkdown).every(record => record.shutdown !== '2026-11-30' && record.announced !== '2026-05-07'))
  const features = openaiMdTable(openaiMdHeaders.with(1, 'Affected feature or endpoint'), [['Nov 30, 2026', '`/v1/prompts` and reusable prompt objects', 'Deprecated', 'Move prompt content into your application code.', 'Jun 3, 2026']])
  strictAssert.throws(() => openaiMdParse(features), /has no recognisable deprecations content: endpoint-or-product-deprecation-table$/)
  const mixed = openaiMdTable(undefined, [['Jan 6, 2027', '`m-1`, `/v1/m-1`', 'Deprecated', '`gpt-next`', 'Oct 1, 2026']])
  strictAssert.throws(() => openaiMdParse(mixed), /refused row: model ids beside endpoint-or-product tokens: m-1, \/v1\/m-1$/)
})
reviewTest('Markdown source: an OpenAI page that is empty, has no pipe table, or carries an HTML table fails closed', () => {
  strictAssert.throws(() => openaiMdParse(''), /^Error: openai deprecations page is empty$/)
  strictAssert.throws(() => openaiMdParse('# Deprecations\n\nNo tables here.\n'), /^Error: openai deprecations page has no recognisable deprecations content$/)
  strictAssert.throws(() => openaiMdParse('```\n| Shutdown date | Affected model | Recommended replacement |\n| --- | --- | --- |\n| Jan 6, 2027 | `m-1` | `gpt-next` |\n```\n'), /^Error: openai deprecations page has no recognisable deprecations content$/)
  strictAssert.throws(() => openaiMdParse(`${openaiMdTable()}\n<table><tr><th>Shutdown date</th></tr></table>\n`), /^Error: openai deprecations page: line 9: HTML table in the Markdown source$/)
  strictAssert.throws(() => openaiMdParse(noticeDateHtml), /^Error: openai deprecations page/)
})
{
  const requested = []
  const sources = await loadProviderSources(PROVIDERS.openai, { env: {}, notice: () => {}, fetchImpl: async url => { requested.push(url); return responseFor(openaiMarkdown) } })
  assert(
    PROVIDERS.openai.deprecationsFetchUrl === `${PROVIDERS.openai.deprecationsUrl}.md`
      && JSON.stringify(requested) === JSON.stringify([PROVIDERS.openai.deprecationsFetchUrl])
      && sources.deprecations.length === openaiMdParse(openaiMarkdown).length
      && sources.deprecations.every(record => record.source === PROVIDERS.openai.deprecationsUrl),
    'OpenAI deprecations are fetched from the Markdown copy and cite the human page',
  )
}
const anthropicAnnouncement = `## 2026-01-01\n${mdTable(anthropicAnnouncementColumns, [['2027-01-01', '`claude-y-20250101`', '`claude-next`']])}`
const anthropicStatusRows = rows => mdTable(anthropicStatusColumns, rows)
const anthropicAliasMerge = (markdown, reverse = false, models = [{ id: 'claude-y-20250101', aliases: ['claude-y'] }]) => {
  const deprecations = parseAnthropicDeprecations(markdown)
  return mergeFeed({ spec: 'model-eol/0.1', publisher: 'anthropic', models }, { deprecations: reverse ? deprecations.reverse() : deprecations, currentIds: null, provider: PROVIDERS.anthropic, notice: () => {} })
}
reviewTest('Issue 135 round 3: an Anthropic status row reaching an entry through an alias follows the rules for naming it directly, in either order', () => {
  for (const reverse of [false, true]) {
    strictAssert.throws(() => anthropicAliasMerge(anthropicAnnouncement + anthropicStatusRows([['claude-y', 'Active', 'N/A', 'Not sooner than September 1, 2027']]), reverse), /status row claude-y conflicts with announcement: status state Active/)
    strictAssert.throws(() => anthropicAliasMerge(anthropicAnnouncement + anthropicStatusRows([['claude-y', 'Deprecated', 'March 1, 2026', 'June 1, 2027']]), reverse), /status row claude-y conflicts with announcement: status deprecated 2026-03-01/)
    strictAssert.throws(() => anthropicAliasMerge(anthropicStatusRows([['claude-y', 'Deprecated', 'March 1, 2026', 'June 1, 2027'], ['claude-y-20250101', 'Active', 'N/A', 'Not sooner than September 1, 2027']]), reverse), /status rows give claude-y-20250101 conflicting lifecycles via claude-y/)
    strictAssert.throws(() => anthropicAliasMerge(anthropicStatusRows([['claude-y', 'Deprecated', 'January 1, 2026', 'January 1, 2027'], ['claude-y-20250101', 'Deprecated', 'January 1, 2026', 'June 1, 2027']]), reverse), /status rows give claude-y-20250101 conflicting lifecycles/)
    const html = anthropicAnnouncement + anthropicStatusRows([['claude-y', 'Deprecated', 'January 1, 2026', 'January 1, 2027']])
    const first = anthropicAliasMerge(html, reverse)
    strictAssert.deepEqual(first.feed.models, anthropicAliasMerge(anthropicAnnouncement + anthropicStatusRows([['claude-other', 'Active', 'N/A', 'N/A']])).feed.models.filter(model => model.id === 'claude-y-20250101'))
    strictAssert.deepEqual(anthropicAliasMerge(html, reverse, first.feed.models).feed.models, first.feed.models)
  }
})
reviewTest('2026-10-18 shapes: Google reads an N/A shutdown date as no shutdown', () => {
  const [record] = parseGoogleDeprecationsHtml('<table><tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr><tr><td><code>gemini-3.7-flash</code></td><td>August 13, 2026</td><td>N/A</td><td><code>gemini-3.8-flash</code></td></tr></table>')
  strictAssert.equal(record.id, 'gemini-3.7-flash')
  strictAssert.equal(record.shutdown, undefined)
  strictAssert.equal(record.replacement, 'gemini-3.8-flash')
  strictAssert.throws(() => parseGoogleDeprecationsHtml('<table><tr><th>Model</th><th>Shutdown date</th><th>Recommended replacement</th></tr><tr><td><code>gemini-3.7-flash</code></td><td>N/A soon</td><td>---</td></tr></table>'), /unrecognised shutdown date: N\/A soon/)
})
const precisionGoogleTable = (id, date) => `<table><tr><th>Model</th><th>Release date</th><th>Shutdown date</th><th>Recommended replacement</th></tr><tr><td><code>${id}</code></td><td>January 1, 2026</td><td>${date}</td><td><code>gemini-next</code></td></tr></table>`
const googlePrecisions = html => Object.fromEntries(parseGoogleDeprecationsHtml(html).map(record => [record.id, record.date_precision ?? 'exact']))
reviewTest('Scoped precision: Google applies the page note to every model section below it', () => {
  const html = `<h1>Gemini deprecations</h1><p>Note: The shutdown dates listed in the table indicate the earliest possible dates on which a model might be retired.</p><h2>Gemini 3 models</h2>${precisionGoogleTable('gemini-a', 'May 7, 2027')}<h2>Embedding models</h2>${precisionGoogleTable('gemini-b', 'May 14, 2028')}`
  strictAssert.deepEqual(googlePrecisions(html), { 'gemini-a': 'earliest', 'gemini-b': 'earliest' })
})
reviewTest('Scoped precision: Google ignores a precision phrase in an unrelated section', () => {
  const html = `<h1>Gemini deprecations</h1><h2>Gemini 3 models</h2>${precisionGoogleTable('gemini-a', 'May 7, 2027')}<h2>Pricing</h2><p>Batch discounts apply to requests made on or later than June 1, 2026.</p>`
  strictAssert.deepEqual(googlePrecisions(html), { 'gemini-a': 'exact' })
})
reviewTest('Scoped precision: Google keeps a sibling section qualifier and script text out of other tables', () => {
  const html = `<h1>Gemini deprecations</h1><h2>Gemini 3 models</h2><p>These dates are no sooner than listed.</p>${precisionGoogleTable('gemini-a', 'May 7, 2027')}<h2>Embedding models</h2>${precisionGoogleTable('gemini-b', 'May 14, 2028')}<script>const hint = "earliest possible"</script>`
  strictAssert.deepEqual(googlePrecisions(html), { 'gemini-a': 'earliest', 'gemini-b': 'exact' })
})
const googleMarkdocCells = cells => cells.map(cell => `  * ${cell}`).join('\n')
const googleMarkdocTable = (rows, header = ['Model', 'Release date', 'Shutdown date', 'Recommended replacement']) =>
  `{% table %}\n${[header, ...rows].map(googleMarkdocCells).join('\n\n  ---\n\n')}\n{% /table %}`
const googleMarkdocRow = (id, date, replacement = '`gemini-next`') => [`\`${id}\``, 'January 1, 2026', date, replacement]
const googleMarkdocNote = '{% callout type="note" %}\n  Note: The **shutdown dates listed in the table indicate the *earliest possible\n  dates* on which a model might be retired**.\n\n{% /callout %}'
const googleMarkdocPage = (body, note = googleMarkdocNote) => `# Gemini deprecations\n\n${note}\n\n${body}\n`
const googleMarkdownPrecisions = markdown => Object.fromEntries(parseGoogleDeprecations(markdown).map(record => [record.id, record.date_precision ?? 'exact']))
reviewTest('Google Markdown: heading ids are stripped into attributes and table rows become cells', () => {
  const html = googleMarkdownToHtml(googleMarkdocPage(`## Gemini 3 models  {% id="gemini-3-models" %}\n\n${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}`))
  assert(html.includes('<h2 id="gemini-3-models">Gemini 3 models</h2>') && html.includes('<td><code>gemini-a</code></td><td>January 1, 2026</td><td>May 7, 2027</td><td><code>gemini-next</code></td>'), 'Markdoc heading and table convert')
})
reviewTest('Google Markdown: the page callout makes every dated row earliest, and a page without it stays exact', () => {
  const body = `## Gemini 3 models  {% id="gemini-3-models" %}\n\n${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027'), googleMarkdocRow('gemini-b', 'No shutdown date announced', '')])}\n\n### Deprecated models  {% id="gemini-3-deprecated-models" %}\n\n${googleMarkdocTable([googleMarkdocRow('gemini-old', 'March 9, 2026')])}`
  strictAssert.deepEqual(googleMarkdownPrecisions(googleMarkdocPage(body)), { 'gemini-a': 'earliest', 'gemini-b': 'exact', 'gemini-old': 'earliest' })
  strictAssert.deepEqual(googleMarkdownPrecisions(googleMarkdocPage(body, 'Shutdown dates are listed below.')), { 'gemini-a': 'exact', 'gemini-b': 'exact', 'gemini-old': 'exact' })
  strictAssert.equal(parseGoogleDeprecations(googleMarkdocPage(body)).find(record => record.id === 'gemini-b').shutdown, undefined)
})
reviewTest('Google Markdown: a retired-models archive id reaches the archive rule and yields to the available row', () => {
  const available = `## Gemini 3 models\n\n${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}`
  const archive = `## Archive  {% id="retired-models" %}\n\n${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027'), googleMarkdocRow('gemini-old', 'March 9, 2026')])}`
  strictAssert.deepEqual(googleMarkdownPrecisions(googleMarkdocPage(`${archive}\n\n${available}`)), { 'gemini-a': 'earliest', 'gemini-old': 'exact' })
})
reviewTest('Google Markdown: wrapped cells, linked IDs, agent tables, and self-routing replacements', () => {
  const rows = [
    ['[`gemini-a`](/docs/models/gemini-a)', 'November 11, 2026', 'December 3,\n    2026', '`gemini-next` (Effective December 3, 2026, requests to `gemini-a` route to\n    `gemini-next`)'],
  ]
  const [record] = parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable(rows)))
  strictAssert.deepEqual(record, { id: 'gemini-a', source: PROVIDERS.google.deprecationsUrl, shutdown: '2026-12-03', date_precision: 'earliest', replacement: 'gemini-next', replacement_note: 'Effective December 3, 2026, requests to gemini-a route to gemini-next' })
  const [agent] = parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([googleMarkdocRow('agent-preview-05-2026', 'October 5, 2026')], ['Agent', 'Release date', 'Shutdown date', 'Recommended replacement'])))
  strictAssert.equal(agent.shutdown, '2026-10-05')
})
reviewTest('Google Markdown: a row whose cell count differs from the header stops the run', () => {
  for (const row of [['`gemini-a`', 'January 1, 2026', 'May 7, 2027'], [...googleMarkdocRow('gemini-a', 'May 7, 2027'), 'extra']]) {
    strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(`## Gemini 3 models\n\n${googleMarkdocTable([row])}`)), /^Error: google deprecations table under "Gemini 3 models" row 1 has \d cells; the header has 4$/)
  }
})
reviewTest('Google Markdown: an unknown header layout stops the run', () => {
  for (const header of [['Model', 'Shutdown date', 'Recommended replacement'], ['Model', 'Release date', 'Shutdown date', 'Recommended replacement', 'Notes'], ['Endpoint', 'Release date', 'Shutdown date', 'Recommended replacement'], ['Model', 'Release date', 'Retirement date', 'Recommended replacement']]) {
    strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([header.map((_, index) => index ? 'x' : '`gemini-a`')], header))), /^Error: google deprecations table under "Gemini deprecations" has an unrecognised header layout: /, header.join())
  }
})
reviewTest('Google Markdown: zero tables, header-only tables, and an empty page stop the run', () => {
  strictAssert.throws(() => parseGoogleDeprecations('<!doctype html><html><body><div id="root"></div></body></html>'), /^Error: google deprecations page has no recognised model tables$/)
  strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage('No tables here.')), /^Error: google deprecations page has no recognised model tables$/)
  strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([]))), /google deprecations table under "Gemini deprecations" has no rows/)
  strictAssert.throws(() => parseGoogleDeprecations('  \n'), /google deprecations page is empty/)
})
reviewTest('Google Markdown: malformed Markdoc stops the run instead of guessing', () => {
  const cases = [
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')]).replace('{% /table %}', ''), /is not closed/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')]).replace('  * `gemini-a`', 'stray text\n  * `gemini-a`'), /has text outside a cell: stray text/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')]).replace('  * May 7, 2027', '    * May 7, 2027'), /has a nested list/],
    [googleMarkdocTable([['`gemini-a` or `gemini-b`', 'January 1, 2026', 'May 7, 2027', '']]), /under "Gemini deprecations" row 1 model cell is not one model ID: `gemini-a` or `gemini-b`$/],
    [googleMarkdocTable([['`gemini-a` and gemini-b', 'January 1, 2026', 'May 7, 2027', '']]), /under "Gemini deprecations" row 1 model cell is not one model ID: `gemini-a` and gemini-b$/],
    [googleMarkdocTable([['Gemini 3.1 Flash-Lite', 'January 1, 2026', 'May 7, 2027', '']]), /under "Gemini deprecations" row 1 model cell is not one model ID: Gemini 3.1 Flash-Lite$/],
    ...['gemini-_a', 'gemini__a', 'gemini-a_'].map(id => [googleMarkdocTable([[id, 'January 1, 2026', 'May 7, 2027', '']]), new RegExp(`row 1 model cell is not one model ID: ${id}$`)]),
    ...['- | - | -', ':-- | :-: | --:'].map(delimiter => [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\nModel | Shutdown date | Replacement\n${delimiter}`, /has an unsupported table/]),
    [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\n> | Model | Shutdown date |\n> | --- | --- |\n> | gemini-b | May 7, 2027 |`, /has an unsupported table/],
    [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\n> Model | Shutdown date\n> --- | ---`, /has an unsupported table/],
    [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\nModel | Shutdown date\n--- | ---\ngemini-b | May 7, 2027`, /has an unsupported table/],
    [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\nModel | Shutdown date\n:--- | ---:`, /has an unsupported table/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')]).replace('  * May 7, 2027', '  * May 7, 2027\n\n    ---\n'), /has a row separator inside a cell/],
    [googleMarkdocTable([['', 'January 1, 2026', 'May 7, 2027', '']]), /row 1 has an empty model cell/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027', '`gemini-next')]), /has an unbalanced code span/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', '{% colspan=2 %} May 7, 2027')]), /has a Markdoc tag in a cell/],
    [`${googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])}\n\n| Model | Shutdown date |\n| --- | --- |`, /has an unsupported table/],
    [googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')]).replace('\n\n  ---\n\n', '\n\n  ---\n\n  ---\n\n'), /has an empty row/],
    [googleMarkdocTable([googleMarkdocRow('gemini a', 'May 7, 2027')]), /refused row: endpoint-or-product-row: gemini a/],
  ]
  for (const [body, pattern] of cases) strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(body)), error => error.message.startsWith('google deprecations ') && pattern.test(error.message), String(pattern))
})
reviewTest('Google Markdown: emphasis and inline Markdoc tags in prose still carry the earliest qualifier', () => {
  const table = googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])
  for (const note of [
    'Note: The shutdown dates indicate the *earliest*\n  possible dates on which a model might be retired.',
    'Note: The shutdown dates indicate the **earliest** possible dates.',
    'Note: The shutdown dates indicate the _earliest_ possible dates.',
    '{% callout type="note" %}Note: The shutdown dates indicate the earliest possible dates.{% /callout %}',
  ]) {
    strictAssert.deepEqual(googleMarkdownPrecisions(googleMarkdocPage(table, note)), { 'gemini-a': 'earliest' }, note)
  }
})
reviewTest('Google Markdown: struck-through prose stops the run instead of being read with the struck words', () => {
  const table = googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])
  for (const note of ['Note: The shutdown dates indicate the _earliest_ ~~possible~~ possible dates.', 'Note: The shutdown dates are ~not~ the earliest possible dates.']) {
    strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(table, note)), /struck-through text in Markdown is refused/, note)
  }
})
reviewTest('Google Markdown: reworded earliest wording stops the run instead of turning dates exact', () => {
  const table = googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027')])
  for (const note of ['Note: Models retire on the listed date at the *earliest*.', 'Note: Shutdown will come no sooner.', 'Note: Retirement is not earlier than listed.', 'Note: Models retire no earlier than the listed date.', 'Note: Models retire not before the listed date.', 'Note: Models retire on or after the listed date.', 'Note: The listed date is the soonest a model retires.']) {
    strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(table, note)), /^Error: google deprecations section prose qualifies dates in unrecognised words: /, note)
  }
  strictAssert.throws(() => parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027 at the earliest')]), '')), /^Error: google deprecations entry gemini-a shutdown cell qualifies dates in unrecognised words: May 7, 2027 at the earliest$/)
})
reviewTest('Google Markdown: the row\'s own ID is never its replacement, but a longer ID that contains it is', () => {
  const replacementOf = cell => {
    const { id, source, shutdown, date_precision: precision, ...fields } = parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([googleMarkdocRow('gemini-a', 'May 7, 2027', cell)])))[0]
    return fields
  }
  strictAssert.deepEqual(replacementOf('`gemini-a`'), {})
  strictAssert.deepEqual(replacementOf('gemini-a'), {})
  strictAssert.deepEqual(replacementOf('`gemini-a` (still served until shutdown)'), { replacement_note: 'still served until shutdown' })
  strictAssert.deepEqual(replacementOf('`gemini-a-002` (requests to `gemini-a` route to `gemini-a-002`)'), { replacement: 'gemini-a-002', replacement_note: 'requests to gemini-a route to gemini-a-002' })
  strictAssert.deepEqual(replacementOf('`gemini-b` or `gemini-a`'), { replacement: 'gemini-b', replacement_note: 'gemini-a' })
  for (const [cell, note] of [
    ['`gemini-a` on the v1beta API', 'on the v1beta API'],
    ['`gemini-a` (no change; v2 endpoint)', 'no change; v2 endpoint'],
    ['`gemini-a` remains available; the endpoint routes to Gemini 3.8 Flash', 'remains available; the endpoint routes to Gemini 3.8 Flash'],
    ['Keep using `gemini-a` with thinking_budget=0', 'Keep using gemini-a with thinking_budget=0'],
  ]) strictAssert.deepEqual(replacementOf(cell), { replacement_note: note }, cell)
})
reviewTest('Google Markdown: cells drop emphasis and process backslash escapes', () => {
  const [record] = parseGoogleDeprecations(googleMarkdocPage(googleMarkdocTable([['gemini\\_a', 'January 1, 2026', '*May 7, 2027*', '_Use_ `gemini-next` **now**']]), ''))
  strictAssert.deepEqual(record, { id: 'gemini_a', source: PROVIDERS.google.deprecationsUrl, shutdown: '2027-05-07', replacement: 'gemini-next', replacement_note: 'Use gemini-next now' })
})
reviewTest('Google Markdown: offline runs read the Markdown fixture and cite the human page', () => {
  assert(findFixture(fixtures, 'google', 'deprecations').endsWith('google-deprecations.md'), 'Google fixture is the Markdown page')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-google-md-'))
  const generated = run(['--provider', 'google', '--fixtures', fixtures, '--out', out])
  strictAssert.equal(generated.code, 0, generated.err)
  const feed = JSON.parse(fs.readFileSync(path.join(out, 'google.json'), 'utf8'))
  strictAssert.equal(feed.source, PROVIDERS.google.deprecationsUrl)
  strictAssert.equal(feed.models.find(model => model.id === 'gemini-3.1-flash-lite')?.source, PROVIDERS.google.deprecationsUrl)
})
const precisionVertexTable = (...rows) => `<table><tr><th>Model ID</th><th>Release date</th><th>Retirement date</th><th>Replacement model ID</th></tr>${rows.map(([id, date]) => `<tr><td><code>${id}</code></td><td>May 1, 2025</td><td>${date}</td><td></td></tr>`).join('')}</table>`
const vertexPrecisions = html => Object.fromEntries(parseVertexModelVersionsHtml(html).map(record => [record.vertexId, record.date_precision ?? 'exact']))
reviewTest('Scoped precision: Vertex applies the available-models statement but not to its retired section', () => {
  const html = `<h1>Model versions and lifecycle</h1><h2>Latest available models</h2><p>The following tables list the available models and their retirement dates. While retirement timelines may be extended, they won't be moved to an earlier date than what is listed.</p><h3>Models available for at least 12 months after release</h3><p>The following table lists the models that will be available for at least 12 months after initial release:</p><section><h3>Gemini models</h3>${precisionVertexTable(['gemini-a', 'May 19, 2027 or later'], ['gemini-b', 'October 20, 2026'])}</section><h3>Embeddings models</h3>${precisionVertexTable(['text-embedding-a', 'April 1, 2027'])}<h3>Retired models</h3><div><h4>The following table lists the retired models (click to expand)</h4>${precisionVertexTable(['gemini-old', 'April 21, 2025'], ['gemini-old-floor', 'June 30, 2026 or later'])}</div><h2>Migrate to a latest available model</h2><p>Update your application to point to the recommended upgrades.</p>`
  strictAssert.deepEqual(vertexPrecisions(html), { 'gemini-a': 'earliest', 'gemini-b': 'earliest', 'text-embedding-a': 'earliest', 'gemini-old': 'exact', 'gemini-old-floor': 'earliest' })
})
reviewTest('Scoped precision: Vertex ignores a precision phrase in an unrelated section or a sibling table', () => {
  const html = `<h2>Latest available models</h2><h3>Gemini models</h3>${precisionVertexTable(['gemini-a', 'May 19, 2027 or later'])}<h3>Embeddings models</h3>${precisionVertexTable(['gemini-b', 'October 20, 2026'])}<h2>What's next</h2><p>Quotas may be raised for projects created on or later than 2026.</p>`
  strictAssert.deepEqual(vertexPrecisions(html), { 'gemini-a': 'earliest', 'gemini-b': 'exact' })
})
const openAIValidTable = '<h2>2026-10-15: Other</h2><table><tr><th>Shutdown date</th><th>Model / system</th><th>Recommended replacement</th></tr><tr><td>January 14, 2027</td><td><code>gpt-4.1-2025-04-14</code></td><td><code>gpt-6-luna</code></td></tr></table>'
reviewTest('OpenAI fails closed on a grammar-invalid model token instead of skipping its row', () => {
  for (const [cell, token] of [['<code>gpt-4o*</code>', 'gpt-4o\\*'], ['<code>gpt-4o-2024-08-06</code> <code>gpt-4o:latest</code>', 'gpt-4o:latest'], ['<code>/v1/foo</code> <code>gpt-4o*</code>', 'gpt-4o\\*']]) {
    strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage(cell) + openAIValidTable), new RegExp(`refused row: invalid-model-id: ${token}$`), cell)
  }
})
reviewTest('OpenAI still skips endpoint and product rows inside a lifecycle table', () => {
  for (const cell of ['Videos API', '<code>OpenAI-Beta: realtime=v1</code>', '<code>/v1/audio/translations</code>']) {
    strictAssert.deepEqual(parseOpenAIDeprecations(shapesOpenAIPage(cell) + openAIValidTable).map(record => record.id), ['gpt-4.1-2025-04-14'], cell)
  }
})
reviewTest('PR 126 review: OpenAI skips exactly the live endpoint and product shapes', () => {
  for (const cell of ['/v1/audio/translations', 'Videos API', 'OpenAI-Beta: realtime=v1', 'Assistants API', 'OpenAI-Beta: assistants=v1', '/v1/fine-tunes', '/v1/edits', '/v1/engines', '/v1/search', '/v1/classifications', '/v1/answers']) {
    strictAssert.deepEqual(parseOpenAIDeprecations(shapesOpenAIPage(cell) + openAIValidTable).map(record => record.id), ['gpt-4.1-2025-04-14'], cell)
  }
})
reviewTest('PR 126 review: OpenAI refuses rows whose model IDs would otherwise be dropped silently', () => {
  for (const cell of ['<code>gpt-4o-2024-05-13</code> <code>/v1/chat/completions</code>', '<code>gpt-4o-mini-tts</code> (<code>/v1/audio/speech</code>)', '<code>gpt-image-1</code> in <code>Images API</code>', '<code>gpt-4o-mini, gpt-4o</code>', '<code>gpt-4o (2024-05-13)</code>', '<code>openai/gpt-oss-120b</code>', '<code>gpt-4o&#8201;-mini</code>']) {
    strictAssert.throws(() => parseOpenAIDeprecations(shapesOpenAIPage(cell) + openAIValidTable), /openai deprecations table refused row: (?:invalid-model-id|model ids beside endpoint-or-product tokens): /, cell)
  }
})
const qualifiedVertexPage = body => `<h1>Model versions and lifecycle</h1><h2>Latest available models</h2><p>While retirement timelines may be extended, they won't be moved to an earlier date than what is listed.</p>${body}`
reviewTest('PR 126 review: Vertex refuses a retirement-worded section beneath a qualifier instead of guessing', () => {
  for (const heading of ['Models retired after 2027', 'Models scheduled to be retired', 'Not yet retired']) {
    strictAssert.throws(() => parseVertexModelVersionsHtml(qualifiedVertexPage(`<h3>${heading}</h3>${precisionVertexTable(['gemini-a', 'October 20, 2026'])}`)), /mentions retirement beneath the date qualifier of "Latest available models"/, heading)
  }
  strictAssert.deepEqual(vertexPrecisions(`<h2>Models scheduled to be retired</h2>${precisionVertexTable(['gemini-a', 'October 20, 2026'])}`), { 'gemini-a': 'exact' })
})
reviewTest('PR 126 review: Vertex recognises the retired-models archive by its anchor id', () => {
  strictAssert.deepEqual(vertexPrecisions(qualifiedVertexPage(`<h3 id="retired-models">Archive</h3>${precisionVertexTable(['gemini-old', 'April 21, 2025'])}`)), { 'gemini-old': 'exact' })
})
reviewTest('PR 126 late review: an unclosed heading inside a table does not swallow the archive heading after it', () => {
  const html = qualifiedVertexPage(`<table><tr><td><h3>Note</td></tr></table><h3>Retired models</h3>${precisionVertexTable(['gemini-old', 'April 21, 2025'])}`)
  strictAssert.deepEqual(vertexPrecisions(html), { 'gemini-old': 'exact' })
})
reviewTest('PR 126 late review: OpenAI skips a hyphenated product name such as Fine-tuning API', () => {
  strictAssert.deepEqual(parseOpenAIDeprecations(shapesOpenAIPage('Fine-tuning API') + openAIValidTable).map(record => record.id), ['gpt-4.1-2025-04-14'])
})
reviewTest('PR 126 review: Vertex keeps the available row when the archive repeats it with the same date', () => {
  for (const [first, second] of [['available', 'archive'], ['archive', 'available']]) {
    const tables = { available: `<h3>Embeddings models</h3>${precisionVertexTable(['text-embedding-a', 'April 1, 2027'])}`, archive: `<h3 id="retired-models">Retired models</h3>${precisionVertexTable(['text-embedding-a', 'April 1, 2027'])}` }
    strictAssert.deepEqual(vertexPrecisions(qualifiedVertexPage(tables[first] + tables[second])), { 'text-embedding-a': 'earliest' }, first)
  }
  const moved = qualifiedVertexPage(`<h3>Embeddings models</h3>${precisionVertexTable(['text-embedding-a', 'April 1, 2027'])}<h3>Retired models</h3>${precisionVertexTable(['text-embedding-a', 'April 21, 2025'])}`)
  strictAssert.throws(() => parseVertexModelVersionsHtml(moved), /conflicting rows for text-embedding-a: 2027-04-01 \(earliest\) and 2025-04-21 \(exact\)/)
})
reviewTest('PR 126 review: Google names both precisions when two available sections disagree', () => {
  const html = `<h1>Gemini deprecations</h1><h2>Gemini 3 models</h2><p>These dates are no sooner than listed.</p>${precisionGoogleTable('gemini-a', 'May 7, 2027')}<h2>Live API models</h2>${precisionGoogleTable('gemini-a', 'May 7, 2027')}`
  strictAssert.throws(() => parseGoogleDeprecationsHtml(html), /conflicting rows for gemini-a: 2027-05-07 \(earliest\) and 2027-05-07 \(exact\)/)
})
reviewTest('PR 126 review: section prose excludes table text behind a heading inside a table or a nested table', () => {
  const lifecycle = precisionVertexTable(['gemini-y', 'October 20, 2026'])
  const headingInTable = `<h2>Models</h2><table><tr><td><h4>Footnotes</h4></td></tr><tr><td>Dates may slip to May 2027 or later.</td></tr></table>${lifecycle}`
  const nestedTable = `<h2>Models</h2><table><tr><td><table><tr><td>x</td></tr></table> Retirement may come on or later dates.</td></tr></table>${lifecycle}`
  strictAssert.deepEqual(vertexPrecisions(headingInTable), { 'gemini-y': 'exact' })
  strictAssert.deepEqual(vertexPrecisions(nestedTable), { 'gemini-y': 'exact' })
})
reviewTest('PR 126 review: a table with no heading above it reads the whole root section, including text after it', () => {
  const lifecycle = precisionVertexTable(['gemini-z', 'October 20, 2026'])
  strictAssert.deepEqual(vertexPrecisions(`${lifecycle}<p>Retirement timelines may be extended, but they will not be moved to an earlier date.</p>`), { 'gemini-z': 'earliest' })
  strictAssert.deepEqual(vertexPrecisions(`${lifecycle}<h2>Quotas</h2><p>Quotas rise for projects created on or later than 2026.</p>`), { 'gemini-z': 'exact' })
})

const reviewNow = new Date('2026-11-17T12:00:00Z')
const reviewMistralHeader = '| Model | API name | Status | Context | Summary | Deprecation | Retirement | Replacement |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n'
const reviewMistralRow = (id, deprecation, retirement) => `| X | \`${id}\` | Deprecated | 1k | s | ${deprecation} | ${retirement} | Y |\n`
const reviewMistral = markdown => parseMistralDeprecationsMarkdown(markdown, undefined, { now: reviewNow }).records.map(record => [record.id, record.announced, record.shutdown])
const reviewOpenAIHeader = '| Shutdown date | Affected model | Status | Recommended replacement | Notice date |\n| --- | --- | --- | --- | --- |\n'
const reviewOpenAIRow = (shutdown, id = 'gpt-x') => `| ${shutdown} | \`${id}\` | Deprecated | \`gpt-y\` | Jun 2, 2026 |\n`
const reviewOpenAI = markdown => parseOpenAIDeprecationsMarkdown(markdown, undefined, { now: reviewNow }).map(record => [record.id, record.announced, record.shutdown, record.date_precision])
const reviewOpenAIDated = '| Shutdown date | Model | Recommended replacement |\n| --- | --- | --- |\n'
const reviewAnthropicStatus = '## Model status\n\n| API model name | Current state | Deprecated | Tentative retirement date |\n| :-- | :-- | :-- | :-- |\n| claude-a-1 | Deprecated | September 30, 2026 | November 30, 2026 |\n\n## Deprecation history\n\n'
const reviewAnthropicTable = '| Retirement date | Deprecated model | Recommended replacement |\n| --- | --- | --- |\n'
const reviewAnthropicA = `### 2026-09-30: A\n\n${reviewAnthropicTable}| November 30, 2026 | \`claude-a-1\` | \`claude-b\` |\n`
const reviewCohere = body => parseCohereDeprecationsMarkdown(`# Deprecations\n\n## Deprecation History\n\n${body}\n# Best Practices\n\n1. x\n`)
const reviewCohereTable = '| Shutdown Date | Deprecated Model | Recommended Replacement |\n| --- | --- | --- |\n'
const reviewCohereRetirement = ids => `### 2026-04-04: Embed v2.0\n\nEffective April 4th, 2026, the following models will be retired:\n\n${ids}\nWe encourage you to migrate:\n\n* Chat tasks alternatives:\n  * \`command-a-03-2025\`\n`

reviewTest('S1: a lone trailing * footnote marker on a date is refused by every Markdown provider instead of publishing the date as exact', () => {
  strictAssert.throws(() => reviewMistral(`${reviewMistralHeader}${reviewMistralRow('mistral-a-1', '2026-01-01', '2027-06-01*')}\n\\* Tentative: the retirement date may move.\n`), /mistral deprecations row mistral-a-1 has an invalid retirement date: 2027-06-01\*/)
  strictAssert.deepEqual(reviewMistral(`${reviewMistralHeader}${reviewMistralRow('mistral-a-1', '2026-01-01', '**2027-06-01**')}`), [['mistral-a-1', '2026-01-01', '2027-06-01']])
  strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus.replace('| November 30, 2026 |', '| November 30, 2026* |')}${reviewAnthropicA}\n\\* Subject to change.\n`), /claude-a-1 has an unrecognised retirement date: November 30, 2026\*/)
  strictAssert.throws(() => reviewCohere(`### 2024-12-02: Rerank v2.0\n\n${reviewCohereTable}| 2025-04-30* | \`rerank-english-v2.0\` | \`rerank-v3.5\` |\n\n\\* Earliest date.\n`), /invalid date: 2025-04-30\*/)
  strictAssert.throws(() => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('Dec 1, 2026*')}`), /^Error: openai deprecations entry gpt-x has an unrecognised shutdown date: Dec 1, 2026\*$/)
})
reviewTest('S1: an OpenAI shutdown cell holds exactly one date, and the page\'s own "Earliest estimate" label makes it earliest', () => {
  for (const cell of ['Dec 1, 2026 (tentative)', 'Dec 1, 2026 or later', 'Dec 1, 2026 / Jan 5, 2027', 'Dec 1, 2026 Earliest estimates']) {
    strictAssert.throws(() => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow(cell)}`), /has an unrecognised shutdown date/, cell)
  }
  strictAssert.deepEqual(reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('**Dec 1, 2026** Earliest estimate')}`), [['gpt-x', '2026-06-02', '2026-12-01', 'earliest']])
  strictAssert.throws(() => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('**Dec 1, 2026** Earliest estimate')}${reviewOpenAIRow('Dec 1, 2026')}`), /openai deprecations page has conflicting rows for gpt-x$/)
})
reviewTest('S2: struck-through dates in OpenAI, Anthropic, Mistral, and Cohere tables and prose stop the run', () => {
  for (const [label, parse] of [
    ['openai double tilde', () => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('~~Jan 5, 2027~~ **Dec 1, 2026**')}`)],
    ['openai single tilde', () => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('~Jan 5, 2027~ Dec 1, 2026')}`)],
    ['openai <s>', () => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('<s>Jan 5, 2027</s> Dec 1, 2026')}`)],
    ['anthropic', () => parseAnthropicDeprecations(`${reviewAnthropicStatus}${reviewAnthropicA}\n### 2026-08-01: Z\n\n${reviewAnthropicTable}| ~~November 15, 2026~~ December 30, 2026 | \`claude-z-1\` | \`claude-b\` |\n`)],
    ['mistral', () => reviewMistral(`${reviewMistralHeader}${reviewMistralRow('mistral-a-1', '2026-01-01', '~~2026-10-31~~')}`)],
    ['cohere table', () => reviewCohere(`### 2024-12-02: Rerank v2.0\n\n${reviewCohereTable}| ~~2025-04-30~~ | \`rerank-english-v2.0\` | \`rerank-v3.5\` |\n`)],
    ['cohere prose', () => reviewCohere(reviewCohereRetirement('* `embed-english-v2.0`\n').replace('April 4th, 2026', '~~March 1, 2026~~ April 4th, 2026'))],
  ]) strictAssert.throws(parse, /struck-through text in Markdown is refused/, label)
})
reviewTest('S3: tables that render as code or are hidden by a comment stop the Mistral, OpenAI, Anthropic, and Cohere readers', () => {
  const real = `${reviewMistralHeader}${reviewMistralRow('mistral-a-1', '2026-01-01', '2026-06-01')}`
  const hiddenTable = `${reviewMistralHeader}${reviewMistralRow('mistral-b-1', '2026-02-01', '2026-03-01')}`
  strictAssert.throws(() => reviewMistral(`${real}\n<!-- draft below, not published\n\n${hiddenTable}`), /line 5: unbalanced comment marker: an unclosed HTML comment hides the rest of the page/)
  strictAssert.throws(() => reviewMistral(`${real}\nExample:\n\n${hiddenTable.split('\n').map(line => line && `    ${line}`).join('\n')}`), /table indented 4 or more spaces renders as code/)
  strictAssert.throws(() => reviewMistral(`${real.replace('| Y |', '| `<!--` |')}\nText\n\n${hiddenTable}\nmore \`-->\`\n`), /line 3: HTML comment marker inside a code span/)
  const fake = '| Jan 1, 2028 | `gpt-x` | Deprecated | `gpt-z` | Jul 1, 2026 |'
  const quoted = text => text.split('\n').map(line => line ? `> ${line}` : '>').join('\n')
  strictAssert.deepEqual(reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('Dec 1, 2026')}\nExample:\n\n${quoted(`\`\`\`\n${reviewOpenAIHeader}${fake}\n\n\`\`\``)}\n`), [['gpt-x', '2026-06-02', '2026-12-01', undefined]])
  strictAssert.deepEqual(reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('Dec 1, 2026')}\n\`\`\`\nexample\n    \`\`\`\n${reviewOpenAIHeader}${fake}\n\`\`\`\n`), [['gpt-x', '2026-06-02', '2026-12-01', undefined]])
  strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus}${reviewAnthropicA}\nOld example:\n\n    ${reviewAnthropicTable.replace('\n', '\n    ')}    | January 1, 2020 | \`claude-z-1\` | \`claude-b\` |\n`), /table indented 4 or more spaces/)
  strictAssert.throws(() => reviewCohere(`### 2024-12-02: Rerank v2.0\n\nSee:\n\n    ${reviewCohereTable.replace('\n', '\n    ')}    | 2025-04-30 | \`rerank-english-v2.0\` | \`rerank-v3.5\` |\n`), /table indented 4 or more spaces/)
})
reviewTest('S3: an indented code block stops the Cohere run even when its first line is a table header', () => {
  const lines = ['# Deprecations', '', '    | Shutdown Date | Model |', '| --- | --- |']
  strictAssert.throws(() => cohereMarkdownToHtml(lines.join('\n')), /^Error: cohere deprecations page: line 3: (?:indented code block|table indented 4 or more spaces renders as code or inside a list item)$/)
})
reviewTest('S4: an OpenAI table row that starts with inline HTML stops the run instead of being dropped', () => {
  strictAssert.throws(() => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('Dec 1, 2026')}<s>Jan 1, 2027</s> Dec 2, 2026 | \`gpt-q\` | Deprecated | \`gpt-y\` | Jun 2, 2026 |\n`), /line 6: table row starts with block or HTML markup/)
  strictAssert.throws(() => reviewOpenAI(`## Upcoming\n\n${reviewOpenAIHeader}${reviewOpenAIRow('Dec 1, 2026')}<b>Jan 1, 2027</b> | \`gpt-q\` | Deprecated | \`gpt-y\` | Jun 2, 2026 |\n`), /line 6: table row starts with block or HTML markup/)
})
reviewTest('P1: an OpenAI setext heading, raw HTML heading, or heading in a list item stops the run instead of leaving a table under an older date', () => {
  const page = heading => `## 2025-01-01: old\n\n${reviewOpenAIDated}| 2025-06-01 | \`a-1\` | \`b-1\` |\n\n${heading}\n\n${reviewOpenAIDated}| 2026-09-01 | \`c-1\` | \`d-1\` |\n`
  for (const [heading, message] of [
    ['2026-03-01: newer\n---', 'line 8: setext heading; headings must use #'],
    ['2026-03-01: newer\n=', 'line 8: setext heading; headings must use #'],
    ['2026-03-01: newer\n-', 'line 8: setext heading; headings must use #'],
    ['<h2>2026-03-01: newer</h2>', 'line 7: HTML heading in the Markdown source'],
    ['- ## 2026-03-01: newer', 'line 7: heading inside a list item'],
    ['1. - ### 2026-03-01: newer', 'line 7: heading inside a list item'],
  ]) strictAssert.throws(() => reviewOpenAI(page(heading)), new RegExp(`^Error: openai deprecations page: ${message}$`), heading)
  strictAssert.deepEqual(reviewOpenAI(page('## 2026-03-01: newer\n\n---')).map(record => record[1]), ['2025-01-01', '2026-03-01'])
})
reviewTest('P2: an Anthropic one-dash setext underline or a heading inside a list item stops the run', () => {
  const later = `\n${reviewAnthropicTable}| December 30, 2026 | \`claude-z-1\` | \`claude-b\` |\n`
  strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus}${reviewAnthropicA}\n2026-10-15: Claude Z model\n-\n${later}`), /has a setext heading under "2026-09-30: A": 2026-10-15: Claude Z model/)
  strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus}${reviewAnthropicA}\n- ### 2026-10-15: Claude Z model\n${later}`), /has a heading inside a list item under "2026-09-30: A": - ### 2026-10-15: Claude Z model/)
})
reviewTest('P3: an Anthropic section whose only date sits in a <Note> stops the run instead of using it as the announcement', () => {
  const table = `${reviewAnthropicTable}| December 30, 2026 | \`claude-z-1\` | \`claude-b\` |\n`
  for (const note of ['<Note>\n  Retired 2026-12-30.\n</Note>', '<Note>Retired 2026-12-30.</Note>', '<Warning>\nNotice\n\nRetired 2026-12-30.\n</Warning>']) {
    strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus}### Claude Z model\n\n${note}\n\n${table}`), /table under "Claude Z model" takes its only announcement date from a <Note> or other callout/, note)
  }
  strictAssert.throws(() => parseAnthropicDeprecations(`${reviewAnthropicStatus}${reviewAnthropicA}\n<Note>\n### 2026-10-15: Claude Z model\n</Note>\n\n${table}`), /has a heading inside a <Note> or other callout/)
  strictAssert.deepEqual(parseAnthropicDeprecations(`${reviewAnthropicStatus}### 2026-10-01: Claude Z model\n\n<Note>\n  Retired 2026-12-30.\n</Note>\n\n${table}`).find(record => record.id === 'claude-z-1').announced, '2026-10-01')
  strictAssert.deepEqual(parseAnthropicDeprecations(`${reviewAnthropicStatus}### Claude Z model\n\n<Note>See the guide.</Note>\n\nOn October 1, 2026 we notified developers.\n\n${table}`).find(record => record.id === 'claude-z-1').announced, '2026-10-01')
})
reviewTest('P4: a Cohere list whose bullet character changes is two lists in GFM, so the run stops', () => {
  strictAssert.throws(() => reviewCohere(reviewCohereRetirement('* `embed-english-v2.0`\n- `c4ai-aya-expanse-8b`\n')), /line 10: list marker changes, which starts a new list/)
  strictAssert.throws(() => reviewCohere(reviewCohereRetirement('1. `embed-english-v2.0`\n2) `c4ai-aya-expanse-8b`\n')), /line 10: list marker changes, which starts a new list/)
  strictAssert.deepEqual(reviewCohere(reviewCohereRetirement('* `embed-english-v2.0`\n* `c4ai-aya-expanse-8b`\n')).map(record => record.id), ['embed-english-v2.0', 'c4ai-aya-expanse-8b'])
})
reviewTest('P1 for Cohere: a heading inside a list item stops the run', () => {
  strictAssert.throws(() => reviewCohere(`${reviewCohereRetirement('* `embed-english-v2.0`\n')}\n* ### 2026-05-01: Something\n\n### 2024-12-02: Rerank v2.0\n\n${reviewCohereTable}| 2025-04-30 | \`rerank-english-v2.0\` | \`rerank-v3.5\` |\n`), /heading inside a list item/)
})

fs.rmSync(outputDir, { recursive: true, force: true })
fs.rmSync(mixedDistributorOut, { recursive: true, force: true })
fs.rmSync(corruptBedrockDir, { recursive: true, force: true })
fs.rmSync(corruptOpenAIDir, { recursive: true, force: true })
fs.rmSync(corruptDir, { recursive: true, force: true })
fs.rmSync(malformedStatusDir, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)` : '\nall refresh assertions passed')
process.exit(failures ? 1 : 0)
