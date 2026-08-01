#!/usr/bin/env node
// Smoke test for the reference checker. Time-stable assertions only:
// o3-deep-research's shutdown (2026-07-23) is in the past forever, and
// claude-opus-4-1's (2026-08-05) is either retiring or retired - both flag.
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { lifecycleFor } from '../lib/feeds.mjs'

const root = path.join(import.meta.dirname, '..')
const run = args => {
  const result = spawnSync('node', [path.join(root, 'check.mjs'), ...args], { encoding: 'utf8' })
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

// Default clocks: both bad models flag, exit 1.
const a = run([path.join(root, 'test/fixture'), '--days', '30', '--json'])
const aj = JSON.parse(a.out)
const byId = id => aj.findings.find(f => f.id === id)
assert(a.code === 1, 'exit 1 when findings exist')
assert(byId('o3-deep-research-2025-06-26')?.status === 'retired', 'o3-deep-research is retired')
assert(['retiring', 'retired'].includes(byId('claude-opus-4-1-20250805')?.status), 'opus 4.1 flags (retiring or retired)')
assert(byId('gpt-5.6-sol')?.status === 'ok', 'gpt-5.6-sol is clean')
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

// Inventory mode: keep the CI gate's findings, but also classify direct API
// usage separately from cloud/gateway references that need a resolver.
const c = run(['inventory', path.join(root, 'test/fixture'), '--days', '30', '--json'])
const cj = JSON.parse(c.out)
const ref = (file, matched) => cj.model_references.find(f => f.file.endsWith(file) && f.matched === matched)
const hint = provider => cj.integration_hints.find(h => h.provider === provider)
assert(c.code === 0, 'inventory exits 0')
assert(cj.schema === 'model-eol/inventory@0.1', 'inventory schema emitted')
assert(cj.candidate_model_references.some(f => f.matched === 'gpt-9-ultra-20990101'), 'unknown model-like candidate surfaced')
assert(cj.candidate_model_references.some(f => f.matched === 'anthropic.claude-3-7-sonnet-20250219-v1:0'), 'provider-prefixed unknown candidate surfaced')
assert(cj.model_references.some(f => f.file.endsWith('.env') && f.matched === 'o3-deep-research'), '.env dotfile is scanned')
assert(ref('direct.py', 'o3-deep-research')?.usage === 'direct-api', 'direct OpenAI usage classified')
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
assert(dj.items.some(f => f.id === 'gpt-4-0613'), 'scheduled model appears in schedule')
assert(dj.unresolved_integrations.some(h => h.provider === 'vertex-ai'), 'schedule carries unresolved Vertex hint')
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
assert(fj.errors.some(item => item.status === 'retired'), 'alert carries retired errors')
assert(fj.warnings.some(item => item.status === 'unknown'), 'alert carries unknown candidate warnings')
assert(fj.warnings.some(item => item.status === 'unresolved'), 'alert carries unresolved integration warnings')
const g = run(['alert', path.join(root, 'test/fixture'), '--days', '30', '--scope', 'direct'])
assert(g.code === 1, 'github alert exits 1 when errors exist')
assert(g.out.includes('::error file='), 'github alert emits error annotations')
assert(g.out.includes('::warning file='), 'github alert emits warning annotations')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-test-'))

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
  items: [item],
  issues: [],
}))
fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(applyItem)
const applied = run(['apply', '--plan', applyPlanFile])
assert(applied.code === 0 && fs.readFileSync(applyFile, 'utf8') === `${newLine}\n`, 'apply rewrites the fixture')
const rerun = run(['apply', '--plan', applyPlanFile])
assert(rerun.code === 0 && rerun.out.includes('already-applied'), 'apply is idempotent')

const mismatchItem = { ...applyItem, expected_line_sha256: hash('MODEL = "different-model"') }
fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(mismatchItem)
const mismatch = run(['apply', '--plan', applyPlanFile])
assert(mismatch.code === 1, 'apply exits 1 on hash mismatch')
assert(mismatch.err.includes('hash does not match'), 'apply reports hash mismatch on stderr')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'hash mismatch does not write the file')

fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(applyItem)
const dryRun = run(['apply', '--plan', applyPlanFile, '--dry-run'])
assert(dryRun.code === 0 && dryRun.out.includes('would change'), 'apply dry-run reports the proposed change')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'apply dry-run writes nothing')

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
