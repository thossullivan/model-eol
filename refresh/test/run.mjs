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
  mergeDistributions,
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
import { validateFeed } from '../../lib/validate-feed.mjs'
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

const openaiHtml = fs.readFileSync(path.join(fixtures, 'openai-deprecations.html'), 'utf8')
const anthropicHtml = fs.readFileSync(path.join(fixtures, 'anthropic-deprecations.html'), 'utf8')
const bedrockHtml = fs.readFileSync(path.join(fixtures, 'bedrock-lifecycle.html'), 'utf8')
const googleHtml = fs.readFileSync(path.join(fixtures, 'google-deprecations.html'), 'utf8')
const vertexHtml = fs.readFileSync(path.join(fixtures, 'vertex-model-versions.html'), 'utf8')
const endpointLookalikeHtml = fs.readFileSync(path.join(fixtures, 'anthropic-endpoint-lookalike.html'), 'utf8')
const statusExtraColumnHtml = '<table><tr><th>Recommended replacement</th><th>Current state</th><th>API model name</th><th>Tentative retirement date</th><th>Deprecated</th></tr><tr><td><code>claude-next</code></td><td>Active</td><td><code>claude-extra-column</code></td><td>Not sooner than September 1, 2027</td><td>N/A</td></tr></table>'
const statusRenamedColumnHtml = '<table><tr><th>API model name</th><th>Lifecycle state</th><th>Deprecated</th><th>Tentative retirement date</th></tr><tr><td><code>claude-renamed-column</code></td><td>Active</td><td>N/A</td><td>Not sooner than September 1, 2027</td></tr></table>'
const openaiEntries = parseOpenAIDeprecations(openaiHtml)
const anthropicEntries = parseAnthropicDeprecations(anthropicHtml)
const bedrockEntries = parseBedrockLifecycleHtml(bedrockHtml)
const bedrockById = new Map(bedrockEntries.map(entry => [entry.bedrockId, entry]))
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
const anthropicStatusHeader = '<tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr>'
const anthropicStatusTable = (id, state, deprecated, retirement) => `<table>${anthropicStatusHeader}<tr><td><code>${id}</code></td><td>${state}</td><td>${deprecated}</td><td>${retirement}</td></tr></table>`
const anthropicAnnouncementTable = (id, announced, shutdown, aliases = []) => `<h2>${announced}: Model retirement</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>${shutdown}</td><td>${[id, ...aliases].map(token => `<code>${token}</code>`).join(' / ')}</td><td><code>claude-next</code></td></tr></table>`

let endpointLookalikeReason = ''
try {
  parseAnthropicDeprecations(endpointLookalikeHtml)
} catch (error) {
  endpointLookalikeReason = error.message
}
assert(endpointLookalikeReason.includes('missing required columns') && endpointLookalikeReason.includes('api model name'), 'Anthropic rejects an endpoint lookalike carrying the status retirement header')

const mixedEndpointHtml = `<h2>2026-01-01: Endpoint notice</h2><table><tr><th>Retirement date</th><th>Deprecated endpoint</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>/v1/old</code></td><td><code>/v1/new</code></td></tr></table><h2>2025-01-01: Model notice</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-mixed</code></td><td><code>claude-next</code></td></tr></table>${anthropicStatusTable('claude-mixed', 'Retired', '2025-01-01', '2027-01-01')}`
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

const anthropicApiModelHtml = `<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>API model name</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-api-model</code></td><td><code>claude-next</code></td></tr></table>${anthropicStatusTable('claude-api-model', 'Retired', '2026-01-01', '2027-01-01')}`
const anthropicApiModel = parseAnthropicDeprecations(anthropicApiModelHtml)
assert(anthropicApiModel.length === 1 && anthropicApiModel[0].id === 'claude-api-model' && anthropicApiModel[0].replacement === 'claude-next', 'Anthropic announcement tables keep their recommended replacement column')

const ambiguousAnnouncementHtml = '<h1>Model deprecations</h1><h2>Announcement context</h2><p>Notified 2025-01-01; retirement 2026-01-01.</p><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-ambiguous</code></td><td><code>claude-next</code></td></tr></table>'
let ambiguousAnnouncementReason = ''
try {
  parseAnthropicDeprecations(ambiguousAnnouncementHtml)
} catch (error) {
  ambiguousAnnouncementReason = error.message
}
assert(ambiguousAnnouncementReason.includes('ambiguous-announcement-date'), 'generic deprecation parser rejects ambiguous announcement context')

const anthropicStatusEdgeHtml = '<table><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr><tr><td><code>claude-no-tentative-date</code></td><td>Active</td><td>N/A</td><td>N/A</td></tr><tr><td><code>claude-empty-tentative-date</code></td><td>Active</td><td>N/A</td><td></td></tr><tr><td><code>claude-retired-without-announcement</code></td><td>Retired</td><td>June 1, 2026</td><td>August 1, 2026</td></tr><tr><td><code>claude-deprecated-without-retirement</code></td><td>Deprecated</td><td>July 1, 2026</td><td>N/A</td></tr></table>'
const anthropicStatusEdges = parseAnthropicDeprecations(anthropicStatusEdgeHtml)
const anthropicNoDates = anthropicStatusEdges.filter(entry => entry.id === 'claude-no-tentative-date' || entry.id === 'claude-empty-tentative-date')
assert(anthropicNoDates.length === 2 && anthropicNoDates.every(entry => entry.shutdown === undefined && entry.date_precision === undefined), 'Anthropic treats active N/A and empty retirement dates as no date')
const anthropicRetiredStatus = anthropicStatusEdges.find(entry => entry.id === 'claude-retired-without-announcement')
assert(anthropicRetiredStatus?.announced === '2026-06-01' && anthropicRetiredStatus.shutdown === '2026-08-01' && anthropicRetiredStatus.date_precision === undefined, 'Anthropic converts an unmatched retired status row into an exact lifecycle record')
const anthropicDeprecatedStatus = anthropicStatusEdges.find(entry => entry.id === 'claude-deprecated-without-retirement')
assert(anthropicDeprecatedStatus?.announced === '2026-07-01' && anthropicDeprecatedStatus.shutdown === undefined, 'Anthropic converts a deprecated N/A status row into an announced-only record')

const anthropicStatusError = html => {
  try {
    parseAnthropicDeprecations(html)
    return ''
  } catch (error) {
    return error.message
  }
}
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
const extraColumnStatus = parseAnthropicDeprecations(statusExtraColumnHtml)
assert(extraColumnStatus.length === 1 && extraColumnStatus[0].id === 'claude-extra-column' && extraColumnStatus[0].date_precision === 'tentative' && extraColumnStatus[0].replacement === undefined, 'Anthropic status parsing owns a table with an extra recommended replacement column')
const footnotedStatusHtml = '<h2>2026-01-01</h2><table><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date¹</th><th>Recommended replacement</th></tr><tr><td><code>claude-footnoted-status</code></td><td>Active</td><td>N/A</td><td>Not sooner than September 1, 2027</td><td><code>claude-next</code></td></tr></table>'
const footnotedStatus = parseAnthropicDeprecations(footnotedStatusHtml)
assert(footnotedStatus.length === 1 && footnotedStatus[0].date_precision === 'tentative' && footnotedStatus[0].announced === undefined && footnotedStatus[0].replacement === undefined, 'Anthropic parses a footnoted tentative header only as status data')
const tdHeaderStatusHtml = '<h2>2026-01-01</h2><table><tr><td>API model name</td><td>Current state</td><td>Deprecated</td><td>Tentative retirement *</td><td>Recommended replacement</td></tr><tr><td><code>claude-td-header-status</code></td><td>Active</td><td>N/A</td><td>Not sooner than October 1, 2027</td><td><code>claude-next</code></td></tr></table>'
const tdHeaderStatus = parseAnthropicDeprecations(tdHeaderStatusHtml)
assert(tdHeaderStatus.length === 1 && tdHeaderStatus[0].date_precision === 'tentative' && tdHeaderStatus[0].announced === undefined && tdHeaderStatus[0].replacement === undefined, 'Anthropic treats a td-only first row with the status signature as the header')
const leadingTitleStatusHtml = '<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-leading-title-announcement</code></td><td><code>claude-next</code></td></tr></table><table><tr><th colspan="4">Model status</th></tr><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Tentative retirement date</th></tr><tr><td><code>claude-leading-title-status</code></td><td>Active</td><td>N/A</td><td>Not sooner than November 1, 2027</td></tr></table>'
const leadingTitleStatus = parseAnthropicDeprecations(leadingTitleStatusHtml)
const leadingTitleAnnouncement = leadingTitleStatus.find(entry => entry.id === 'claude-leading-title-announcement')
const leadingTitleTentative = leadingTitleStatus.find(entry => entry.id === 'claude-leading-title-status')
assert(leadingTitleStatus.length === 2 && leadingTitleAnnouncement?.replacement === 'claude-next', 'Anthropic keeps announcements beside a status table with a leading title row')
assert(leadingTitleTentative?.date_precision === 'tentative' && leadingTitleTentative.announced === undefined && leadingTitleTentative.replacement === undefined, 'Anthropic owns a status table across its leading header block')
const renamedColumnReason = anthropicStatusError(statusRenamedColumnHtml)
assert(renamedColumnReason.includes('missing required columns') && renamedColumnReason.includes('current state'), 'Anthropic status parsing fails loudly on a renamed required column')
const multipleStatusDriftReason = anthropicStatusError(`${anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'Not sooner than September 1, 2027')}<h2>2026-01-01</h2><table><tr><th>API model name</th><th>Lifecycle state</th><th>Deprecated</th><th>Tentative retirement [1]</th><th>Recommended replacement</th></tr><tr><td><code>claude-drifted-status</code></td><td>Active</td><td>N/A</td><td>September 1, 2027</td><td><code>claude-next</code></td></tr></table>`)
assert(multipleStatusDriftReason.includes('missing required columns') && multipleStatusDriftReason.includes('current state'), 'Anthropic never classifies a drifted second status table as an announcement')
const ambiguousStatusSignatureReason = anthropicStatusError(`<table><tr><th colspan="4">Tentative retirement overview</th></tr>${anthropicStatusHeader}<tr><td><code>claude-ambiguous-status-header</code></td><td>Active</td><td>N/A</td><td>Not sooner than September 1, 2027</td></tr></table>`)
assert(ambiguousStatusSignatureReason.includes('ambiguous signature rows'), 'Anthropic rejects two status signature rows in one leading header block')
const missingStatusReason = anthropicStatusError('<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th></tr><tr><td>2027-01-01</td><td><code>claude-no-status-table</code></td></tr></table>')
assert(missingStatusReason === 'anthropic deprecations page has no model status table', 'Anthropic parsing requires a recognised model status table')
const headerOnlyStatusReason = anthropicStatusError(`<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>claude-header-only-status</code></td><td><code>claude-next</code></td></tr></table><table>${anthropicStatusHeader}</table>`)
assert(headerOnlyStatusReason === 'anthropic model status table has no rows', 'Anthropic rejects a header-only status table even when announcements parsed')
const duplicateStatusHeaderReason = anthropicStatusError('<table><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Deprecated</th><th>Tentative retirement date</th></tr><tr><td><code>claude-duplicate-header</code></td><td>Active</td><td>N/A</td><td>N/A</td><td>Not sooner than September 1, 2027</td></tr></table>')
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
const populatedRowWithoutIdReason = anthropicStatusError(`<table>${anthropicStatusHeader}<tr><td><code>claude-kept-row</code></td><td>Active</td><td>N/A</td><td>Not sooner than June 9, 2027</td></tr><tr><td></td><td>Active</td><td>N/A</td><td>Not sooner than July 1, 2027</td></tr></table>`)
assert(populatedRowWithoutIdReason.includes('populated row without a model id'), 'a populated status row with an empty model cell fails closed')
const spacerRowRecords = parseAnthropicDeprecations(`<table>${anthropicStatusHeader}<tr><td><code>claude-kept-row</code></td><td>Active</td><td>N/A</td><td>Not sooner than June 9, 2027</td></tr><tr><td></td><td></td><td></td><td></td></tr></table>`)
assert(spacerRowRecords.length === 1 && spacerRowRecords[0].id === 'claude-kept-row', 'a wholly empty spacer row is still skipped')
const renamedSignatureReason = anthropicStatusError(`${anthropicStatusTable('claude-valid-status', 'Active', 'N/A', 'Not sooner than June 9, 2027')}<table><tr><th>API model name</th><th>Current state</th><th>Deprecated</th><th>Retirement date</th></tr><tr><td><code>claude-drifted-status</code></td><td>Active</td><td>N/A</td><td>September 1, 2027</td></tr></table>`)
assert(renamedSignatureReason.includes('missing required columns: tentative retirement'), 'a status-shaped table with a renamed tentative column fails closed instead of parsing as an announcement')
const missingDeprecatedReason = anthropicStatusError(anthropicStatusTable('claude-missing-deprecated-date', 'Deprecated', 'N/A', 'September 1, 2027'))
assert(missingDeprecatedReason.includes('claude-missing-deprecated-date') && missingDeprecatedReason.includes('N/A'), 'Anthropic rejects a non-active status row without a deprecated date')
const unknownStateReason = anthropicStatusError(anthropicStatusTable('claude-preview-state', 'Preview', 'N/A', 'N/A'))
assert(unknownStateReason.includes('claude-preview-state') && unknownStateReason.includes('Preview'), 'Anthropic rejects an undocumented model state')
const activeDeprecatedReason = anthropicStatusError(anthropicStatusTable('claude-active-deprecated', 'Active', 'June 1, 2026', 'Not sooner than September 1, 2027'))
assert(activeDeprecatedReason.includes('claude-active-deprecated') && activeDeprecatedReason.includes('June 1, 2026'), 'Anthropic rejects an active row with a deprecated date')
const reversedLifecycleReason = anthropicStatusError(anthropicStatusTable('claude-reversed-lifecycle', 'Retired', 'August 1, 2026', 'June 1, 2026'))
assert(reversedLifecycleReason.includes('claude-reversed-lifecycle') && reversedLifecycleReason.includes('before'), 'Anthropic rejects retirement before deprecation')

assert(openaiEntries.every(entry => !/[\s/]/.test(entry.id)), 'OpenAI endpoint and product retirement rows are excluded from the model feed')
assert(normalizeBedrockId('anthropic.claude-3-haiku-20240307-v1:0') === 'claude-3-haiku-20240307', 'Bedrock normalization strips a known provider prefix and v1 suffix')
assert(normalizeBedrockId('meta.llama3-1-405b-instruct-v2:0') === 'llama3-1-405b-instruct', 'Bedrock normalization strips v2 suffixes')
assert(normalizeBedrockId('future-provider.example-model:0') === 'example-model', 'Bedrock normalization handles an unknown provider prefix generically')
assert(normalizeBedrockId('cohere.command-r:0') === 'command-r', 'Bedrock normalization strips a bare colon version suffix')
assert(normalizeVertexId('publishers/google/models/gemini-2.5-pro') === 'gemini-2.5-pro', 'Vertex normalization strips a publisher resource prefix')
assert(bedrockEntries.length === 17, 'Bedrock lifecycle fixture parses and deduplicates logical model rows')
assert(bedrockEntries.find(entry => entry.bedrockId === 'anthropic.claude-3-haiku-20240307-v1:0')?.eol === '2026-09-10', 'Bedrock parser handles rowspan model rows')
assert(bedrockEntries.find(entry => entry.bedrockId === 'amazon.nova-canvas-v1:0')?.legacy === '2026-03-30', 'Bedrock parser reads human legacy dates')
assert(bedrockEntries.every(entry => entry.legacy && entry.eol), 'Bedrock lifecycle records preserve parsed Legacy and EOL dates')
assert(bedrockById.get('amazon.nova-canvas-v1:0')?.status === 'legacy', 'Bedrock parser marks rows without a public Extended Access date as Legacy')
assert(bedrockById.get('anthropic.claude-3-haiku-20240307-v1:0')?.status === 'extended-access', 'Bedrock parser ingests the public Extended Access lifecycle phase')
assert(bedrockById.get('anthropic.claude-3-sonnet-20240229-v1:0')?.status === 'extended-access', 'Bedrock parser conservatively combines regional Legacy and Extended Access rows')
const shiftedBedrockRow = parseBedrockLifecycleHtml(`
  <table>
    <tr><th>Provider</th><th>Model</th><th>Model ID</th><th>Regions</th><th>Legacy date</th><th>EOL date</th><th>Public extended access date</th></tr>
    <tr><td>Command R</td><td>cohere.command-r-v1:0</td><td>us-east-1, us-west-2</td><td>February 19, 2026</td><td>August 19, 2026</td><td>May 19, 2026</td></tr>
  </table>
`)
assert(shiftedBedrockRow[0]?.bedrockId === 'cohere.command-r-v1:0' && shiftedBedrockRow[0]?.eol === '2026-08-19' && shiftedBedrockRow[0]?.status === 'extended-access', 'Bedrock parser realigns rows whose provider cell is omitted')
const explicitBedrockStatuses = parseBedrockLifecycleHtml(`
  <table>
    <tr><th>Model ID</th><th>Legacy date</th><th>EOL date</th><th>Public extended access start date</th><th>Lifecycle status</th></tr>
    <tr><td>amazon.legacy-model-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td><td>—</td><td>Legacy</td></tr>
    <tr><td>amazon.extended-model-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td><td>June 1, 2026</td><td>Public Extended Access</td></tr>
    <tr><td>amazon.eol-model-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td><td>June 1, 2026</td><td>End-of-Life (EOL)</td></tr>
  </table>
`)
assert(JSON.stringify(explicitBedrockStatuses.map(entry => entry.status)) === JSON.stringify(['legacy', 'extended-access', 'retired']), 'Bedrock parser normalizes explicit official lifecycle statuses')
for (const [label, value] of [['unknown', 'Deprecated'], ['empty', '']]) {
  let reason = ''
  try {
    parseBedrockLifecycleHtml(`
      <table>
        <tr><th>Model ID</th><th>Legacy date</th><th>EOL date</th><th>Public extended access start date</th><th>Status</th></tr>
        <tr><td>amazon.bad-status-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td><td>—</td><td>${value}</td></tr>
      </table>
    `)
  } catch (error) {
    reason = error.message
  }
  assert(reason.includes('unsupported lifecycle status'), `Bedrock parser fails closed on ${label} lifecycle status values`)
}
let malformedExtendedAccessReason = ''
try {
  parseBedrockLifecycleHtml(`
    <table>
      <tr><th>Model ID</th><th>Legacy date</th><th>EOL date</th><th>Public extended access start date</th></tr>
      <tr><td>amazon.bad-extended-date-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td><td>Eventually</td></tr>
    </table>
  `)
} catch (error) {
  malformedExtendedAccessReason = error.message
}
assert(malformedExtendedAccessReason.includes('unrecognised public extended access date'), 'Bedrock parser fails closed on malformed public Extended Access dates')
let missingExtendedAccessColumnReason = ''
try {
  parseBedrockLifecycleHtml(`
    <table>
      <tr><th>Model ID</th><th>Legacy date</th><th>EOL date</th></tr>
      <tr><td>amazon.schema-drift-v1:0</td><td>March 1, 2026</td><td>September 1, 2026</td></tr>
    </table>
  `)
} catch (error) {
  missingExtendedAccessColumnReason = error.message
}
assert(missingExtendedAccessColumnReason.includes('missing the Public extended access start date column'), 'Bedrock parser fails closed when the official table schema drops the Extended Access column')
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
assert(overlapping.length > 0, 'OpenAI fixture overlaps the committed feed')
assert(anthropicEntries.length === 9, 'Anthropic deprecation fixture parses announcement and active status entries')
assert(anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805')?.replacement === 'claude-opus-4-6', 'Anthropic replacement parses')
const anthropicTentative = anthropicEntries.find(entry => entry.id === 'claude-fable-5-1')
assert(anthropicTentative?.shutdown === '2027-09-01' && anthropicTentative.date_precision === 'tentative' && anthropicTentative.announced === undefined, 'Anthropic parses active tentative retirement dates without an announcement date')
assert(anthropicTentative?.source === PROVIDERS.anthropic.deprecationsUrl, 'Anthropic tentative entries carry deprecations-page provenance')
const anthropicExact = anthropicEntries.find(entry => entry.id === 'claude-opus-4-1-20250805')
assert(anthropicExact?.shutdown === '2026-08-05' && anthropicExact.announced === '2026-06-05' && anthropicExact.date_precision === undefined, 'Anthropic announcement rows take precedence over duplicate status rows')
assert(openaiIds.length === 3 && openaiIds.includes('gpt-5.6-sol'), 'OpenAI models endpoint fixture parses')
assert(anthropicIds.includes('claude-sonnet-4-6'), 'Anthropic models endpoint fixture parses')
assert(googleEntries.length === 64, 'Google deprecations fixture parses all model rows')
assert(googleEntries.find(entry => entry.id === 'gemini-2.5-pro')?.date_precision === 'earliest', 'Google marks earliest possible shutdown dates')
assert(googleEntries.find(entry => entry.id === 'gemini-2.5-pro')?.shutdown === '2026-10-16', 'Google parses a human shutdown date')
assert(googleEntries.find(entry => entry.id === 'gemini-3.6-flash')?.shutdown === undefined, 'Google preserves models without a shutdown date')
assert(googleIds.length === 3 && googleIds.includes('gemini-2.5-pro'), 'Google models endpoint fixture strips the models/ prefix')
const genericStructuredHtml = `<h2>2026-01-01</h2><table><tr><th>Retirement date</th><th>Deprecated model</th><th>Recommended replacement</th></tr><tr><td>2027-01-01</td><td><code>generic-structured</code></td><td><code>first-model</code> or <code>second-model</code></td></tr></table>${anthropicStatusTable('generic-structured', 'Retired', '2026-01-01', '2027-01-01')}`
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
const anthropicAliasAnnouncementMerge = mergeFeed({
  ...minimalCommitted,
  publisher: 'anthropic',
  source: PROVIDERS.anthropic.deprecationsUrl,
  models: [{ id: aliasStatusId }, { id: 'claude-next' }],
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
  return responseFor(googleHtml)
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
    return responseFor(googleHtml)
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
    return responseFor(googleHtml)
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
    return responseFor(googleHtml)
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
    return responseFor(googleHtml)
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

const mixedDistributorOut = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-mixed-distributors-'))
const mixedGenerated = '2099-01-02T03:04:05Z'
const mixedDistributorWrite = run([
  '--distributor', 'aws-bedrock,vertex-ai',
  '--out', mixedDistributorOut,
  '--fixtures', fixtures,
], { env: { ...process.env, MODEL_EOL_GENERATED: mixedGenerated } })
assert(mixedDistributorWrite.code === 0, 'mixed distributor refresh writes successfully')
const mixedOutputs = Object.fromEntries(['amazon', 'anthropic', 'google', 'openai'].map(publisher => [
  publisher,
  JSON.parse(fs.readFileSync(path.join(mixedDistributorOut, `${publisher}.json`), 'utf8')),
]))
const mixedCommitted = Object.fromEntries(['amazon', 'anthropic', 'google', 'openai'].map(publisher => [
  publisher,
  JSON.parse(fs.readFileSync(path.join(root, 'feeds', `${publisher}.json`), 'utf8')),
]))
assert(mixedOutputs.anthropic.generated === mixedGenerated && mixedOutputs.anthropic.generated !== mixedCommitted.anthropic.generated, 'mixed distributor write advances generated for the publisher with material distribution changes')
assert(['amazon', 'google', 'openai'].every(publisher => mixedOutputs[publisher].generated === mixedCommitted[publisher].generated), 'mixed distributor write preserves generated for every semantically unchanged publisher')

const refreshWorkflow = fs.readFileSync(path.join(root, '.github/workflows/feed-refresh.yml'), 'utf8')
assert(refreshWorkflow.includes('[ "$providers" -ne 0 ] && [ "$providers" -ne 3 ]') && refreshWorkflow.includes('exit code $providers'), 'workflow fails explicitly on unexpected provider refresh exit codes')
assert(refreshWorkflow.includes('[ "$distributors" -ne 0 ] && [ "$distributors" -ne 3 ]') && refreshWorkflow.includes('exit code $distributors'), 'workflow fails explicitly on unexpected distributor refresh exit codes')
assert(refreshWorkflow.includes('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}'), 'workflow passes the Google models endpoint credential')
assert(refreshWorkflow.includes('--distributor aws-bedrock,vertex-ai'), 'workflow refreshes every implemented distributor')
assert(refreshWorkflow.includes('issues: write') && refreshWorkflow.includes('if: failure()') && refreshWorkflow.includes('Feed refresh automation failed'), 'workflow gives failed refreshes a durable issue')
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
assert(['lib/cli.mjs', 'lib/validate-feed.mjs', 'refresh/diff.mjs'].every(file => publicWorkflow.includes(`- '${file}'`)), 'public contract redeploys when any transitive build dependency changes')
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
assert(freshnessScript.includes('AWS Bedrock and Google Vertex AI lifecycle pages'), 'README freshness metadata names every automated distributor source')

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

const malformedStatusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-refresh-malformed-status-'))
fs.copyFileSync(path.join(fixtures, 'anthropic-models.json'), path.join(malformedStatusDir, 'anthropic-models.json'))
fs.writeFileSync(
  path.join(malformedStatusDir, 'anthropic-deprecations.html'),
  anthropicStatusTable('claude-malformed-status-floor', 'Active', 'N/A', 'Not sooner than Q4 2027'),
)
const malformedStatusOut = path.join(malformedStatusDir, 'out')
const malformedStatusRun = run(['--provider', 'anthropic', '--check', '--out', malformedStatusOut, '--fixtures', malformedStatusDir])
assert(malformedStatusRun.code === 1 && malformedStatusRun.err.includes('claude-malformed-status-floor') && malformedStatusRun.err.includes('Not sooner than Q4 2027'), 'Anthropic refresh check fails loudly on an unparseable status floor')
assert(!fs.existsSync(malformedStatusOut), 'an unparseable Anthropic status floor writes no feed output')

fs.rmSync(outputDir, { recursive: true, force: true })
fs.rmSync(mixedDistributorOut, { recursive: true, force: true })
fs.rmSync(corruptBedrockDir, { recursive: true, force: true })
fs.rmSync(corruptOpenAIDir, { recursive: true, force: true })
fs.rmSync(corruptDir, { recursive: true, force: true })
fs.rmSync(malformedStatusDir, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)` : '\nall refresh assertions passed')
process.exit(failures ? 1 : 0)
