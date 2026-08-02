#!/usr/bin/env node
// Smoke test for the reference checker. Time-stable assertions only:
// o3-deep-research's shutdown (2026-07-23) is in the past forever, and
// claude-opus-4-1's (2026-08-05) is either retiring or retired - both flag.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { color, colorEnabled } from '../lib/color.mjs'
import { assertIsoDate, buildModelPattern, findingFromRef, lifecycleFor, loadFeeds } from '../lib/feeds.mjs'
import { formatCheck, formatSchedule } from '../lib/reports.mjs'

const root = path.join(import.meta.dirname, '..')
const run = (args, options = {}) => {
  const result = spawnSync('node', [path.join(root, 'check.mjs'), ...args], { encoding: 'utf8', ...options })
  return { out: result.stdout ?? '', err: result.stderr ?? '', code: result.status }
}

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failures++
  } else {
    console.log(`ok: ${msg}`)
  }
}

const unknownFlag = run([path.join(root, 'test/fixture'), '--dyas', '90'])
assert(unknownFlag.code === 2 && unknownFlag.err.includes('--dyas') && unknownFlag.err.includes('--help'), 'unknown check flags exit 2 with the bad flag and help hint')

const invalidDays = run([path.join(root, 'test/fixture'), '--days', 'banana'])
assert(invalidDays.code === 2 && invalidDays.err.includes('finite non-negative integer'), 'non-numeric --days exits 2')
const fractionalDays = run([path.join(root, 'test/fixture'), '--days', '1.5'])
assert(fractionalDays.code === 2, 'fractional --days exits 2')

assert(!colorEnabled({}, { isTTY: false }), 'color is off by default for non-TTY output')
assert(colorEnabled({ FORCE_COLOR: '1' }, { isTTY: false }), 'FORCE_COLOR enables color for non-TTY output')
assert(!colorEnabled({ NO_COLOR: '', FORCE_COLOR: '1' }, { isTTY: true }), 'NO_COLOR disables color even when forced')
assert(color('red', 'probe', { env: { FORCE_COLOR: '1' }, stdout: { isTTY: false } }).includes('\x1b[31m'), 'color helper emits the requested ANSI style')

const colorEnv = { ...process.env }
delete colorEnv.NO_COLOR
delete colorEnv.FORCE_COLOR
const forcedColor = run([path.join(root, 'test/fixture'), '--days', '90'], { env: { ...colorEnv, FORCE_COLOR: '1' } })
const plainColor = run([path.join(root, 'test/fixture'), '--days', '90'], { env: colorEnv })
assert(forcedColor.out.includes('\x1b['), 'FORCE_COLOR check output contains ANSI escapes')
assert(!plainColor.out.includes('\x1b['), 'plain piped check output contains no ANSI escapes')
const forcedJson = run([path.join(root, 'test/fixture'), '--days', '90', '--json'], { env: { ...colorEnv, FORCE_COLOR: '1' } })
assert(!forcedJson.out.includes('\x1b['), 'FORCE_COLOR does not color JSON output')
for (const [label, args] of [
  ['CycloneDX', ['inventory', path.join(root, 'test/fixture'), '--format', 'cyclonedx']],
  ['GitHub annotations', ['alert', path.join(root, 'test/fixture'), '--format', 'github']],
  ['Markdown', ['alert', path.join(root, 'test/fixture'), '--format', 'markdown']],
  ['badge', ['alert', path.join(root, 'test/fixture'), '--format', 'badge']],
]) {
  const output = run(args, { env: { ...colorEnv, FORCE_COLOR: '1' } })
  assert(!output.out.includes('\x1b['), `FORCE_COLOR does not color ${label} output`)
}

// Default clocks: both bad models flag, exit 1.
const a = run([path.join(root, 'test/fixture'), '--days', '30', '--json'])
const aj = JSON.parse(a.out)
const byId = id => aj.findings.find(f => f.id === id)
assert(a.code === 1, 'exit 1 when findings exist')
assert(Array.isArray(aj.scan_notes) && aj.scan_notes.length === 0, 'check JSON emits scan_notes')
assert(byId('o3-deep-research-2025-06-26')?.status === 'retired', 'o3-deep-research is retired')
assert(['retiring', 'retired'].includes(byId('claude-opus-4-1-20250805')?.status), 'opus 4.1 flags (retiring or retired)')
assert(byId('gpt-5.6-sol')?.status === 'ok', 'gpt-5.6-sol is clean')
assert(byId('gpt-5.6-sol')?.safe_until === null, 'OpenAI clean models make no forward claim without a policy floor')
assert(byId('o3-deep-research-2025-06-26')?.replacement === 'gpt-5.6-sol', 'replacement surfaced')

// Direct scope: the recommended direct-first CI mode leaves cloud/gateway-adjacent
// refs for inventory/resolvers while still failing on direct or generic refs.
const directScope = run([path.join(root, 'test/fixture'), '--days', '30', '--scope', 'direct', '--json'])
const directScopeJson = JSON.parse(directScope.out)
assert(directScope.code === 1, 'direct scope still fails on direct/generic retired refs')
assert(directScopeJson.findings.every(f => f.usage === 'direct-api' || f.usage === 'model-reference'), 'direct scope excludes cloud/gateway refs')

// Distributor clock: on Azure, o3-deep-research is scheduled (Dec 2026), not retired,
// until that date passes; assert it is never MORE severe than the publisher clock.
const b = run([path.join(root, 'test/fixture'), '--days', '30', '--via', 'azure-ai-foundry', '--json'])
const bj = JSON.parse(b.out)
const azure = bj.findings.find(f => f.id === 'o3-deep-research-2025-06-26')
assert(azure?.via === 'azure-ai-foundry', 'azure distribution clock applied')
assert(azure?.shutdown === '2026-12-26', 'azure shutdown date used')

// A model-eol feed document is lifecycle data, not usage - scanning one would
// flag every retired id it exists to describe (the repo's own feeds/ made the
// self-scan permanently red before this).
{
  const feedScanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-feedscan-'))
  fs.copyFileSync(path.join(root, 'feeds/openai.json'), path.join(feedScanDir, 'openai.json'))
  fs.writeFileSync(path.join(feedScanDir, 'app.py'), 'from openai import OpenAI\nmodel = "o3-deep-research"\n')
  const feedScan = run([feedScanDir, '--days', '90', '--json'])
  const feedScanFindings = JSON.parse(feedScan.out).findings
  assert(feedScanFindings.length === 1 && feedScanFindings[0].file.endsWith('app.py'), 'feed documents are skipped by the scanner; real usage beside them still flags')
  fs.rmSync(feedScanDir, { recursive: true, force: true })

  const boundaryPattern = buildModelPattern(['gpt-image-1', 'gpt-image-1-20260101'])
  boundaryPattern.lastIndex = 0
  assert(!'gpt-image-1.7'.match(boundaryPattern), 'model keys do not match inside dotted version extensions')
  boundaryPattern.lastIndex = 0
  assert('gpt-image-1-20260101'.match(boundaryPattern)?.[0] === 'gpt-image-1-20260101', 'dated model ids still match at a separator boundary')
  boundaryPattern.lastIndex = 0
  assert('gpt-image-1'.match(boundaryPattern)?.[0] === 'gpt-image-1', 'model ids still match at the string boundary')
}

// Inventory mode: keep the CI gate's findings, but also classify direct API
// usage separately from cloud/gateway references that need a resolver.
const c = run(['inventory', path.join(root, 'test/fixture'), '--days', '30', '--json'])
const cj = JSON.parse(c.out)
const defaultInventory = JSON.parse(run(['inventory', path.join(root, 'test/fixture'), '--days', '30']).out)
assert(defaultInventory.schema === 'model-eol/inventory@0.1', 'inventory defaults to the JSON format')
const ref = (file, matched) => cj.model_references.find(f => f.file.endsWith(file) && f.matched === matched)
const hint = provider => cj.integration_hints.find(h => h.provider === provider)
assert(c.code === 0, 'inventory exits 0')
assert(cj.schema === 'model-eol/inventory@0.1', 'inventory schema emitted')
assert(Array.isArray(cj.scan_notes), 'inventory JSON emits scan_notes')
assert(cj.candidate_model_references.some(f => f.matched === 'gpt-9-ultra-20990101'), 'unknown model-like candidate surfaced')
assert(cj.candidate_model_references.some(f => f.matched === 'anthropic.claude-3-7-sonnet-20250219-v1:0'), 'provider-prefixed unknown candidate surfaced')
assert(cj.model_references.some(f => f.file.endsWith('.env') && f.matched === 'o3-deep-research'), '.env dotfile is scanned')
assert(ref('direct.py', 'o3-deep-research')?.usage === 'direct-api', 'direct OpenAI usage classified')
assert(ref('direct.py', 'o3-deep-research')?.safe_until === '2026-07-23', 'scheduled/retired references carry safe_until')
assert(ref('cloud_gateway.ts', 'o3-deep-research')?.usage === 'cloud-provider', 'Azure-adjacent model classified as cloud provider')
assert(ref('cloud_gateway.ts', 'gpt-4-0613')?.usage === 'gateway', 'OpenRouter-adjacent model classified as gateway')
assert(hint('azure-ai-foundry')?.usage === 'cloud-provider', 'Azure integration hint emitted')
assert(hint('aws-bedrock')?.usage === 'cloud-provider', 'Bedrock integration hint emitted')
assert(hint('vertex-ai')?.usage === 'cloud-provider', 'Vertex integration hint emitted')
assert(hint('openrouter')?.usage === 'gateway', 'OpenRouter integration hint emitted')

// Schedule mode: summarize only lifecycle-relevant refs and unresolved
// cloud/gateway integrations. It should not fail CI by itself.
const d = run(['schedule', path.join(root, 'test/fixture'), '--days', '30', '--json'])
const dj = JSON.parse(d.out)
assert(d.code === 0, 'schedule exits 0')
assert(dj.schema === 'model-eol/schedule@0.1', 'schedule schema emitted')
assert(Array.isArray(dj.scan_notes), 'schedule JSON emits scan_notes')
assert(dj.items.some(f => f.id === 'gpt-4-0613'), 'scheduled model appears in schedule')
assert(dj.unresolved_integrations.some(h => h.provider === 'vertex-ai'), 'schedule carries unresolved Vertex hint')
assert(dj.earliest_risk?.safe_until === '2026-07-23', 'schedule carries the earliest safe_until')
assert(dj.earliest_risk?.id === 'o3-deep-research-2025-06-26', 'earliest risk names the model id')
const scheduleText = run(['schedule', path.join(root, 'test/fixture'), '--days', '90'])
assert(scheduleText.out.includes('earliest risk: 2026-07-23 (o3-deep-research-2025-06-26)'), 'human schedule prints the earliest-risk line')
const e = run(['schedule', path.join(root, 'test/fixture'), '--days', '30', '--scope', 'direct', '--json'])
const ej = JSON.parse(e.out)
assert(ej.items.every(f => f.usage === 'direct-api' || f.usage === 'model-reference'), 'direct schedule excludes cloud/gateway refs')
assert(ej.unresolved_integrations.some(h => h.provider === 'openrouter'), 'direct schedule still carries gateway hint')

// Alert mode: emits a real alert payload/annotation stream and fails on actionable
// retired/retiring direct-scope findings.
const f = run(['alert', path.join(root, 'test/fixture'), '--days', '30', '--scope', 'direct', '--json'])
const fj = JSON.parse(f.out)
assert(f.code === 1, 'alert exits 1 when errors exist')
assert(fj.schema === 'model-eol/alert@0.1', 'alert schema emitted')
assert(Array.isArray(fj.scan_notes), 'alert JSON emits scan_notes')
assert(fj.errors.some(item => item.status === 'retired'), 'alert carries retired errors')
assert(fj.warnings.some(item => item.status === 'unknown'), 'alert carries unknown candidate warnings')
assert(fj.warnings.some(item => item.status === 'unresolved'), 'alert carries unresolved integration warnings')
const g = run(['alert', path.join(root, 'test/fixture'), '--days', '30', '--scope', 'direct'])
assert(g.code === 1, 'github alert exits 1 when errors exist')
assert(g.out.includes('::error file='), 'github alert emits error annotations')
assert(g.out.includes('::warning file='), 'github alert emits warning annotations')

const cyclonedxRun = run(['inventory', path.join(root, 'test/fixture'), '--format', 'cyclonedx'])
const cyclonedx = JSON.parse(cyclonedxRun.out)
const cyclonedxComponent = cyclonedx.components.find(item => item.name === 'o3-deep-research-2025-06-26')
const property = (component, name) => component?.properties.find(item => item.name === name)?.value
assert(cyclonedxRun.code === 0, 'CycloneDX inventory exits 0')
assert(cyclonedx.bomFormat === 'CycloneDX' && cyclonedx.specVersion === '1.6' && cyclonedx.version === 1, 'CycloneDX required BOM keys emitted')
assert(cyclonedx.components.length === new Set(cj.model_references.map(item => item.id)).size, 'CycloneDX has one component per unique tracked model id')
assert(property(cyclonedxComponent, 'model-eol:status') === 'retired', 'CycloneDX carries model-eol status property')
assert(cyclonedxComponent?.evidence?.occurrences.some(item => item.location.endsWith('direct.py#8')), 'CycloneDX carries model reference occurrences')
assert(!cyclonedx.components.some(item => item.name === 'gpt-9-ultra-20990101'), 'CycloneDX omits candidate model references')

const badgeRun = run(['alert', path.join(root, 'test/fixture'), '--days', '30', '--format', 'badge'])
const badge = JSON.parse(badgeRun.out)
assert(badgeRun.code === 1, 'badge alert keeps existing alert exit semantics')
assert(badge.schemaVersion === 1 && badge.label === 'model-eol', 'badge emits Shields endpoint keys')
assert(badge.color === 'red' && badge.message.includes('retired') && badge.message.includes('retiring'), 'badge counts retired and retiring errors')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-test-'))

const incompleteDir = path.join(tempRoot, 'incomplete-scan')
fs.mkdirSync(incompleteDir)
fs.writeFileSync(path.join(incompleteDir, 'oversized.py'), Buffer.alloc(2 * 1024 * 1024 + 1))
fs.writeFileSync(path.join(incompleteDir, 'app.py'), 'MODEL = "o3-deep-research"\n')
const incompleteCheck = run([incompleteDir, '--json'])
assert(incompleteCheck.code === 2 && incompleteCheck.err.includes('INCOMPLETE SCAN'), 'incomplete check fails closed with a prominent stderr summary')
const allowedIncomplete = run([incompleteDir, '--allow-incomplete', '--json'])
const allowedIncompleteJson = JSON.parse(allowedIncomplete.out)
assert(allowedIncomplete.code === 1 && allowedIncompleteJson.scan_notes.some(note => note.reason === 'file-too-large'), 'allow-incomplete downgrades coverage loss and keeps finding exit semantics')
const incompletePlan = run(['plan', incompleteDir])
assert(incompletePlan.code === 2 && incompletePlan.err.includes('INCOMPLETE SCAN'), 'incomplete plan fails closed')
const allowedPlan = run(['plan', incompleteDir, '--allow-incomplete'])
assert(allowedPlan.code === 0 && JSON.parse(allowedPlan.out).scan_notes.length > 0, 'allow-incomplete plan emits its scan notes')
const incompleteInventoryText = run(['inventory', incompleteDir, '--format', 'text'])
assert(incompleteInventoryText.code === 0 && incompleteInventoryText.out.includes('WARNING: scan incomplete'), 'inventory human output warns about scan notes without failing')

const orangeBadgeDir = path.join(tempRoot, 'orange-badge')
fs.mkdirSync(orangeBadgeDir)
fs.writeFileSync(path.join(orangeBadgeDir, 'app.py'), 'MODEL = "claude-opus-4-1-20250805"\n')
const orangeBadge = JSON.parse(run(['alert', orangeBadgeDir, '--format', 'badge']).out)
assert(orangeBadge.color === 'orange' && orangeBadge.message === '1 retiring', 'badge is orange for only retiring errors')
const greenBadgeDir = path.join(tempRoot, 'green-badge')
fs.mkdirSync(greenBadgeDir)
fs.writeFileSync(path.join(greenBadgeDir, 'app.py'), 'MODEL = "gpt-5.6-sol"\n')
const greenBadge = JSON.parse(run(['alert', greenBadgeDir, '--format', 'badge']).out)
assert(greenBadge.color === 'brightgreen' && greenBadge.message === 'clear', 'badge is brightgreen when clear')

const loadedFeeds = loadFeeds(path.join(root, 'feeds'))
assert(assertIsoDate('2026-02-28') === '2026-02-28', 'assertIsoDate accepts a real calendar date')
let invalidIsoDate = false
try {
  assertIsoDate('2026-02-30')
} catch {
  invalidIsoDate = true
}
assert(invalidIsoDate, 'assertIsoDate rejects impossible calendar dates')
const anthropicFeed = loadedFeeds.feeds.find(feed => feed.publisher === 'anthropic')
const openaiFeed = loadedFeeds.feeds.find(feed => feed.publisher === 'openai')
assert(anthropicFeed?.policy?.min_notice_days === 60, 'Anthropic feed carries its 60-day policy floor')
assert(anthropicFeed?.policy?.source === anthropicFeed.source, 'Anthropic policy cites the feed source URL')
assert(!openaiFeed?.policy, 'OpenAI feed intentionally carries no policy floor')

const invalidDateFeeds = path.join(tempRoot, 'invalid-date-feeds')
fs.mkdirSync(invalidDateFeeds)
fs.writeFileSync(path.join(invalidDateFeeds, 'invalid.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  models: [{ id: 'bad-date-model', shutdown: '2026-02-30' }],
}))
let invalidFeedMessage = ''
try {
  loadFeeds(invalidDateFeeds)
} catch (error) {
  invalidFeedMessage = error.message
}
assert(invalidFeedMessage.includes('invalid.json') && invalidFeedMessage.includes('bad-date-model'), 'loadFeeds rejects impossible dates with feed file and model id')
const invalidPolicyFeeds = path.join(tempRoot, 'invalid-policy-feeds')
fs.mkdirSync(invalidPolicyFeeds)
fs.writeFileSync(path.join(invalidPolicyFeeds, 'invalid-policy.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  policy: { min_notice_days: -1 },
  models: [{ id: 'policy-model' }],
}))
let invalidPolicyMessage = ''
try {
  loadFeeds(invalidPolicyFeeds)
} catch (error) {
  invalidPolicyMessage = error.message
}
assert(invalidPolicyMessage.includes('invalid-policy.json') && invalidPolicyMessage.includes('policy-model') && invalidPolicyMessage.includes('min_notice_days'), 'loadFeeds rejects invalid policy thresholds')
const cleanAnthropic = findingFromRef({
  entry: { id: 'clean-anthropic-model' },
  matched: 'clean-anthropic-model',
  publisher: 'anthropic',
  usage: 'model-reference',
  resolved_provider: 'anthropic',
  confidence: 'medium',
  policy: anthropicFeed.policy,
  generated: anthropicFeed.generated,
}, { days: 90, today: new Date('2026-08-01T00:00:00Z') })
assert(cleanAnthropic.status === 'ok' && cleanAnthropic.safe_until === '2026-09-30', 'clean Anthropic model gets policy-floor safe_until')

const policyDir = path.join(tempRoot, 'policy-fixture')
const policyFeeds = path.join(policyDir, 'feeds')
fs.mkdirSync(policyFeeds, { recursive: true })
fs.writeFileSync(path.join(policyDir, 'app.py'), 'MODEL = "clean-anthropic-model"\n')
fs.writeFileSync(path.join(policyFeeds, 'anthropic.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'anthropic',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/anthropic',
  policy: { min_notice_days: 60, source: 'https://example.invalid/anthropic' },
  models: [{ id: 'clean-anthropic-model' }],
}))
const policySchedule = run(['schedule', policyDir, '--feeds', policyFeeds])
assert(policySchedule.code === 0, 'policy-floor schedule exits 0')
assert(policySchedule.out.includes('guaranteed until 2026-09-30 per anthropic stated policy (>=60d notice, feed generated 2026-08-01)'), 'schedule explains a policy-floor guarantee')

const changedRepo = path.join(tempRoot, 'changed-repo')
fs.mkdirSync(changedRepo)
const changedFile = path.join(changedRepo, 'app.py')
const git = args => spawnSync('git', args, { cwd: changedRepo, encoding: 'utf8' })
assert(git(['init', '-q']).status === 0, 'diff test initializes a git repository')
assert(git(['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'diff test configures git email')
assert(git(['config', 'user.name', 'model-eol test']).status === 0, 'diff test configures git name')
fs.writeFileSync(changedFile, 'MODEL = "o3-deep-research"\n')
assert(git(['add', 'app.py']).status === 0 && git(['commit', '-qm', 'base']).status === 0, 'diff test creates the base commit')
fs.writeFileSync(changedFile, 'MODEL = "o3-deep-research"\nNEW_MODEL = "claude-opus-4-1-20250805"\n')
const changedRun = run(['check', changedRepo, '--days', '30', '--changed', 'HEAD', '--json'])
assert(changedRun.out.trim().startsWith('{'), `--changed emits JSON (stderr: ${changedRun.err.trim()})`)
const changedJson = JSON.parse(changedRun.out)
assert(changedRun.code === 1, '--changed fails for an added bad model')
assert(changedJson.findings.length === 1 && changedJson.findings[0].id === 'claude-opus-4-1-20250805', '--changed filters out unchanged bad model lines')
const nonGit = path.join(tempRoot, 'not-a-git-repo')
fs.mkdirSync(nonGit)
fs.writeFileSync(path.join(nonGit, 'app.py'), 'MODEL = "o3-deep-research"\n')
const nonGitChanged = run(['check', nonGit, '--changed', 'HEAD', '--json'])
assert(nonGitChanged.code === 2, '--changed rejects a non-git target')
assert(nonGitChanged.err.includes('git repository'), '--changed reports the non-git target clearly')

const missing = run(['inventory', path.join(tempRoot, 'does-not-exist'), path.join(root, 'test/fixture'), '--json'])
assert(missing.code === 0, 'missing target does not abort valid targets')
assert(missing.err.includes('warning') && missing.err.includes('does-not-exist'), 'missing target emits a stderr warning')
assert(JSON.parse(missing.out).model_references.length > 0, 'scan continues after missing target')

const testToday = new Date('2026-08-01T00:00:00Z')
const noChannelShutdown = lifecycleFor({
  announced: '2026-04-01',
  shutdown: '2026-04-02',
  distributions: [{ via: 'test-channel' }],
}, { days: 90, via: 'test-channel', today: testToday })
assert(noChannelShutdown.status === 'ok' && noChannelShutdown.via === 'test-channel', 'distribution without shutdown does not inherit publisher clock')
const announcedChannel = lifecycleFor({ distributions: [{ via: 'test-channel', announced: '2026-04-01' }] }, { days: 90, via: 'test-channel', today: testToday })
assert(announcedChannel.status === 'watch' && announcedChannel.via === 'test-channel', 'announced distribution without shutdown is watch')
const fallbackLifecycle = lifecycleFor({ shutdown: '2026-07-23' }, { days: 90, via: 'missing-channel', today: testToday })
assert(fallbackLifecycle.status === 'retired' && fallbackLifecycle.via === 'publisher-fallback', 'missing distribution uses publisher-fallback clock')

const earliestFinding = findingFromRef({
  file: 'fixture.py',
  line: 1,
  matched: 'earliest-model',
  entry: { id: 'earliest-model', shutdown: '2026-08-20', date_precision: 'earliest' },
  publisher: 'google',
  usage: 'model-reference',
  resolved_provider: 'google',
  confidence: 'medium',
}, { days: 30, today: testToday })
assert(earliestFinding.date_precision === 'earliest', 'findings carry date precision')
const earliestCheck = formatCheck({ findings: [earliestFinding], bad: [earliestFinding], scannedFiles: 1, days: 30, scope: 'all' })
assert(earliestCheck.includes('no earlier than 2026-08-20'), 'human check output renders earliest shutdown as a lower bound')
const earliestSchedule = formatSchedule({
  items: [earliestFinding],
  candidate_model_references: [],
  unresolved_integrations: [],
  earliest_risk: { safe_until: '2026-08-20', id: 'earliest-model' },
}, 30)
assert(earliestSchedule.includes('no earlier than 2026-08-20'), 'human schedule output renders earliest shutdown as a lower bound')

const duplicateFeeds = path.join(tempRoot, 'duplicate-feeds')
fs.mkdirSync(duplicateFeeds)
const duplicateFeed = name => ({
  spec: 'model-eol/0.1',
  publisher: name,
  generated: '2026-08-01T00:00:00Z',
  models: [{ id: 'duplicate-model' }],
})
fs.writeFileSync(path.join(duplicateFeeds, 'one.json'), JSON.stringify(duplicateFeed('one')))
fs.writeFileSync(path.join(duplicateFeeds, 'two.json'), JSON.stringify(duplicateFeed('two')))
const duplicate = run(['check', path.join(root, 'test/fixture'), '--feeds', duplicateFeeds, '--json'])
assert(duplicate.code === 2, 'duplicate feed key rejects the feed set')
assert(duplicate.err.includes('duplicate-model') && duplicate.err.includes('one.json') && duplicate.err.includes('two.json'), 'duplicate feed error names key and both files')

const planRun = run(['plan', path.join(root, 'test/fixture'), '--days', '90'])
const plan = JSON.parse(planRun.out)
assert(planRun.code === 0, 'plan exits 0 and always emits JSON')
assert(plan.plan_schema === 'model-eol.plan/0.1', 'plan schema identifier emitted')
assert(Array.isArray(plan.scan_notes), 'plan emits scan_notes')
const patchItem = plan.items.find(item => item.file.endsWith('direct.py') && item.matched === 'o3-deep-research')
assert(patchItem?.replacement === 'gpt-5.6-sol' && patchItem?.status === 'retired', 'direct retired reference with valid replacement is patchable')
assert(/^[0-9a-f]{64}$/.test(patchItem?.expected_line_sha256 ?? ''), 'plan item carries a line SHA-256')
assert(!plan.items.some(item => item.file.endsWith('cloud_gateway.ts')), 'cloud and gateway references are not plan items')
assert(plan.issues.some(issue => issue.file.endsWith('cloud_gateway.ts') && issue.reason === 'not-direct-api'), 'cloud and gateway references become issues')

const fallbackPlanRun = run(['plan', path.join(root, 'test/fixture'), '--days', '90', '--via', 'missing-channel'])
const fallbackPlan = JSON.parse(fallbackPlanRun.out)
assert(fallbackPlan.issues.some(issue => issue.file.endsWith('direct.py') && issue.reason === 'publisher-fallback'), 'publisher-fallback findings are not patchable')

const gateDir = path.join(tempRoot, 'plan-gates')
const gateFeeds = path.join(gateDir, 'feeds')
fs.mkdirSync(gateFeeds, { recursive: true })
fs.writeFileSync(path.join(gateDir, 'direct.py'), 'from openai import OpenAI\nclient = OpenAI()\nmodel = "retired-without-replacement"\n')
fs.writeFileSync(path.join(gateFeeds, 'gate.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/feed',
  models: [{ id: 'retired-without-replacement', shutdown: '2026-07-01' }],
}))
const missingReplacementPlan = run(['plan', gateDir, '--feeds', gateFeeds, '--days', '90'])
const missingReplacementJson = JSON.parse(missingReplacementPlan.out)
assert(!missingReplacementJson.items.length && missingReplacementJson.issues.some(issue => issue.reason === 'no-replacement'), 'missing replacement is not patchable')

const ar6Dir = path.join(tempRoot, 'ar6-proximity')
const ar6Feeds = path.join(tempRoot, 'ar6-feeds')
fs.mkdirSync(ar6Dir)
fs.mkdirSync(ar6Feeds)
fs.writeFileSync(path.join(ar6Dir, 'cloud-mixed.ts'), 'import OpenAI from "openai";\nconst model = "ar6-cloud-mixed";\n\n\nconst azureDeployment = new AzureOpenAI({ deployment: "chat-prod" });\n')
fs.writeFileSync(path.join(ar6Dir, 'direct-call.py'), 'from openai import OpenAI\nclient = OpenAI()\nclient.chat.completions.create(model="ar6-direct-call")\n')
fs.writeFileSync(path.join(ar6Dir, 'gateway.py'), 'OPENROUTER_API_KEY = "test-key"\nMODEL = "ar6-gateway"\n')
fs.writeFileSync(path.join(ar6Feeds, 'ar6.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/ar6',
  models: [
    { id: 'ar6-cloud-mixed', shutdown: '2026-07-01', replacement: 'ar6-replacement' },
    { id: 'ar6-direct-call', shutdown: '2026-07-01', replacement: 'ar6-replacement' },
    { id: 'ar6-gateway', shutdown: '2026-07-01', replacement: 'ar6-replacement' },
    { id: 'ar6-replacement' },
  ],
}))
const ar6Inventory = JSON.parse(run(['inventory', ar6Dir, '--feeds', ar6Feeds, '--json']).out)
const ar6Ref = (file, matched) => ar6Inventory.model_references.find(ref => ref.file.endsWith(file) && ref.matched === matched)
assert(ar6Ref('cloud-mixed.ts', 'ar6-cloud-mixed')?.usage === 'direct-api' && ar6Ref('cloud-mixed.ts', 'ar6-cloud-mixed')?.confidence === 'medium', 'AR-6 competing Azure signal caps nearby direct usage at medium confidence')
assert(ar6Ref('direct-call.py', 'ar6-direct-call')?.usage === 'direct-api' && ar6Ref('direct-call.py', 'ar6-direct-call')?.confidence === 'high', 'AR-6 same-line direct call remains high confidence without competing signals')
assert(ar6Ref('gateway.py', 'ar6-gateway')?.usage === 'gateway' && ar6Ref('gateway.py', 'ar6-gateway')?.confidence === 'medium', 'AR-6 gateway-only usage remains medium confidence')
const ar6Plan = JSON.parse(run(['plan', ar6Dir, '--feeds', ar6Feeds, '--days', '90']).out)
assert(!ar6Plan.items.some(item => item.file.endsWith('cloud-mixed.ts')), 'AR-6 cloud-mixed reference is never patchable')
assert(ar6Plan.issues.some(issue => issue.file.endsWith('cloud-mixed.ts') && issue.reason === 'not-direct-api' && issue.confidence === 'medium'), 'AR-6 cloud-mixed reference is issue-only')
assert(ar6Plan.items.some(item => item.file.endsWith('direct-call.py') && item.matched === 'ar6-direct-call'), 'AR-6 same-line direct call remains patchable')
assert(!ar6Plan.items.some(item => item.file.endsWith('gateway.py')) && ar6Plan.issues.some(issue => issue.file.endsWith('gateway.py') && issue.reason === 'not-direct-api'), 'AR-6 gateway-only reference remains issue-only')

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const applyDir = path.join(tempRoot, 'apply')
fs.mkdirSync(applyDir)
const applyFile = path.join(applyDir, 'fixture.py')
const oldLine = 'MODEL = "old-model"'
const newLine = 'MODEL = "new-model"'
const applyItem = {
  file: applyFile,
  line: 1,
  occurrence: 0,
  matched: 'old-model',
  expected_line_sha256: hash(oldLine),
  id: 'old-model',
  publisher: 'test',
  replacement: 'new-model',
  shutdown: '2026-07-01',
  days: -31,
  status: 'retired',
  sources: [],
  notes: null,
}
const applyPlanFile = path.join(applyDir, 'plan.json')
const writeApplyPlan = item => fs.writeFileSync(applyPlanFile, JSON.stringify({
  plan_schema: 'model-eol.plan/0.1',
  generated: '2026-08-01T00:00:00Z',
  threshold_days: 90,
  via: null,
  items: Array.isArray(item) ? item : [item],
  issues: [],
}))
fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(applyItem)
const applied = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(applied.code === 0 && fs.readFileSync(applyFile, 'utf8') === `${newLine}\n`, 'apply rewrites the fixture')
const rerun = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(rerun.code === 0 && rerun.out.includes('already-applied'), 'apply is idempotent')

const mismatchItem = { ...applyItem, expected_line_sha256: hash('MODEL = "different-model"') }
fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(mismatchItem)
const mismatch = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(mismatch.code === 1, 'apply exits 1 on hash mismatch')
assert(mismatch.err.includes('hash does not match'), 'apply reports hash mismatch on stderr')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'hash mismatch does not write the file')

fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(applyItem)
const dryRun = run(['apply', '--plan', applyPlanFile, '--dry-run'], { cwd: applyDir })
assert(dryRun.code === 0 && dryRun.out.includes('would change'), 'apply dry-run reports the proposed change')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'apply dry-run writes nothing')

fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan([applyItem, { ...applyItem, line: 0 }])
const malformedPlan = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(malformedPlan.code === 2 && malformedPlan.err.includes('plan item 1 line'), 'malformed plan items refuse the whole plan before file use')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'malformed plan does not partially apply valid items')

writeApplyPlan({ ...applyItem, file: '../escape.py' })
const escapedPlan = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(escapedPlan.code === 1 && escapedPlan.err.includes('file path contains .. traversal'), 'apply refuses plan paths that escape rootDir')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'escaped plan does not write the in-root file')

for (const schemaFile of [
  'schema/model-eol.schema.json',
  'schema/model-eol.inventory.schema.json',
  'schema/model-eol.schedule.schema.json',
  'schema/model-eol.alert.schema.json',
  'schema/model-eol.plan.schema.json',
]) {
  JSON.parse(fs.readFileSync(path.join(root, schemaFile), 'utf8'))
  assert(true, `${schemaFile} parses as JSON`)
}

fs.rmSync(tempRoot, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)` : '\nall assertions passed')
process.exit(failures ? 1 : 0)
