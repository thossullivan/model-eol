#!/usr/bin/env node
// Smoke test for the reference checker. Time-stable assertions only:
// o3-deep-research's shutdown (2026-07-23) is in the past forever, and
// claude-opus-4-1's (2026-08-05) is either retiring or retired - both flag.
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyPlan } from '../lib/apply.mjs'
import { color, colorEnabled } from '../lib/color.mjs'
import { assertIsoDate, buildModelPattern, findingFromRef, lifecycleFor, loadFeeds } from '../lib/feeds.mjs'
import { buildPlan } from '../lib/plan.mjs'
import { formatCheck, formatSchedule } from '../lib/reports.mjs'
import { parseDiffPath } from '../lib/scanner.mjs'

const root = path.join(import.meta.dirname, '..')
const run = (args, options = {}) => {
  const result = spawnSync('node', [path.join(root, 'check.mjs'), ...args], { encoding: 'utf8', ...options })
  return { out: result.stdout ?? '', err: result.stderr ?? '', code: result.status }
}
const runPiped = (args, { closeStdoutAfterData = false, env = process.env, timeout = 5000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn('node', [path.join(root, 'check.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let timedOut = false
  let stdoutClosed = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeout)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    out += chunk
    if (closeStdoutAfterData && !stdoutClosed) {
      stdoutClosed = true
      child.stdout.destroy()
    }
  })
  child.stderr.on('data', chunk => { err += chunk })
  child.once('error', error => {
    clearTimeout(timer)
    reject(error)
  })
  child.once('close', code => {
    clearTimeout(timer)
    resolve({ out, err, code, timedOut })
  })
})

let failures = 0
const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failures++
  } else {
    console.log(`ok: ${msg}`)
  }
}

const help = run(['--help'])
assert(help.code === 0 && help.out.includes('3  Output stream failure other than EPIPE.'), 'help documents exit 3 for non-EPIPE output failures')

const unknownFlag = run([path.join(root, 'test/fixture'), '--dyas', '90'])
assert(unknownFlag.code === 2 && unknownFlag.err.includes('--dyas') && unknownFlag.err.includes('--help'), 'unknown check flags exit 2 with the bad flag and help hint')

const emptyTarget = run(['inventory', '', '--json'])
assert(emptyTarget.code === 2 && emptyTarget.out === '' && emptyTarget.err.includes('paths must be non-empty'), 'empty positional targets fail before emitting a schema-invalid report')
const emptyVia = run(['inventory', path.join(root, 'test/fixture'), '--via=', '--json'])
assert(emptyVia.code === 2 && emptyVia.out === '' && emptyVia.err.includes('--via must be a non-empty'), 'an explicitly empty lifecycle channel fails before emitting a schema-invalid report')

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
assert(aj.scope === 'all' && aj.threshold_days === 30 && aj.distributor === null, 'CLI flags retain precedence and no-config defaults retain all scope')
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
assert(
  cyclonedx.components.length === new Set(cj.model_references.map(item => JSON.stringify([item.publisher, item.id, item.requested_via]))).size,
  'CycloneDX has one component per unique publisher, canonical model, and requested lifecycle channel',
)
assert(property(cyclonedxComponent, 'model-eol:status') === 'retired', 'CycloneDX carries model-eol status property')
assert(cyclonedxComponent?.evidence?.occurrences.some(item => item.location.endsWith('direct.py#8')), 'CycloneDX carries model reference occurrences')
assert(!cyclonedx.components.some(item => item.name === 'gpt-9-ultra-20990101'), 'CycloneDX omits candidate model references')
assert(cyclonedx.metadata?.properties?.some(item => item.name === 'model-eol:generator' && item.value === 'model-eol/inventory-cyclonedx@0.1'), 'CycloneDX records explicit model-eol generator provenance')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-test-'))

const artifactDir = path.join(tempRoot, 'generated-artifacts')
fs.mkdirSync(path.join(artifactDir, 'baml_src'), { recursive: true })
fs.mkdirSync(path.join(artifactDir, 'baml_client'), { recursive: true })
fs.writeFileSync(path.join(artifactDir, 'app.py'), 'from openai import OpenAI\nmodel = "o3-deep-research"\n')
fs.writeFileSync(path.join(artifactDir, 'baml_src', 'client.baml'), 'client<llm> OpenAIClient {\n  provider "openai"\n  options { model "o3-deep-research" }\n}\n')
fs.writeFileSync(path.join(artifactDir, 'baml_client', 'client.py'), '# This file was generated by BAML. DO NOT EDIT.\nMODEL = "o3-deep-research"\n')
fs.writeFileSync(path.join(artifactDir, 'baml_client', 'client.ts'), '// @generated\nexport const model = "o3-deep-research";\n')
fs.writeFileSync(path.join(artifactDir, 'inventory.json'), JSON.stringify(cj))
fs.writeFileSync(path.join(artifactDir, 'schedule.json'), JSON.stringify(dj))
fs.writeFileSync(path.join(artifactDir, 'alert.json'), JSON.stringify(fj))
fs.writeFileSync(path.join(artifactDir, 'plan.json'), JSON.stringify({ plan_schema: 'model-eol.plan/0.1', items: [{ matched: 'o3-deep-research' }] }))
fs.writeFileSync(path.join(artifactDir, 'model-eol.cdx.json'), JSON.stringify(cyclonedx))
fs.writeFileSync(path.join(artifactDir, 'third-party.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: 'o3-deep-research' }] }))
const artifactInventoryRun = run(['inventory', artifactDir, '--json'])
const artifactInventory = JSON.parse(artifactInventoryRun.out)
assert(artifactInventoryRun.code === 0, 'generated-artifact inventory exits cleanly')
assert(artifactInventory.model_references.some(item => item.file.endsWith('baml_src/client.baml')), '.baml source is included in scans')
assert(artifactInventory.model_references.find(item => item.file.endsWith('baml_src/client.baml'))?.confidence === 'high', 'BAML provider syntax makes a publisher-compatible source reference high-confidence direct usage')
assert(!artifactInventory.model_references.some(item => item.file.includes('baml_client')), 'generated BAML clients are not treated as usage or patch targets')
assert(artifactInventory.model_references.some(item => item.file.endsWith('third-party.cdx.json')), 'unmarked third-party CycloneDX remains scannable')
assert(!artifactInventory.model_references.some(item => /(?:inventory|schedule|alert|plan|model-eol\.cdx)\.json$/.test(item.file)), 'model-eol JSON outputs are not self-ingested')
assert(artifactInventory.scan_notes.some(note => note.reason === 'generated-artifact-skipped') && artifactInventory.scan_notes.some(note => note.reason === 'model-eol-document-skipped'), 'generated and model-eol document skips retain non-coverage-loss diagnostics')
const artifactText = run(['inventory', artifactDir, '--format', 'text'])
assert(!artifactText.out.includes('WARNING: scan incomplete'), 'intentional generated/product artifact skips do not render as incomplete coverage')
const artifactPlan = JSON.parse(run(['plan', artifactDir]).out)
assert(artifactPlan.items.some(item => item.file.endsWith('baml_src/client.baml')), 'BAML source is the patch target when provider and publisher agree')
assert(!artifactPlan.items.some(item => item.file.includes('baml_client')), 'generated BAML clients never become patch items')
fs.writeFileSync(path.join(artifactDir, 'inventory-rerun.json'), artifactInventoryRun.out)
const artifactRerun = JSON.parse(run(['inventory', artifactDir, '--json']).out)
const artifactReferenceKey = item => `${path.basename(item.file)}:${item.line}:${item.matched}`
assert(JSON.stringify(artifactRerun.model_references.map(artifactReferenceKey).sort()) === JSON.stringify(artifactInventory.model_references.map(artifactReferenceKey).sort()), 'inventory output is invariant when its prior output is inside the scan target')

const candidateNoiseDir = path.join(tempRoot, 'candidate-noise')
fs.mkdirSync(candidateNoiseDir)
fs.writeFileSync(path.join(candidateNoiseDir, 'config.py'), [
  'MODEL = "CLAUDE_CODE_OAUTH_TOKEN"',
  'MODEL = "CLAUDE.local.md"',
  'MODEL = "command_execution"',
  'MODEL = "commands_to_execute"',
  'MODEL = "claude_code.token.usage"',
  'MODEL = "claude-future-plausible"',
  '',
].join('\n'))
const candidateNoise = JSON.parse(run(['inventory', candidateNoiseDir, '--json']).out)
assert(JSON.stringify(candidateNoise.candidate_model_references.map(item => item.matched)) === JSON.stringify(['claude-future-plausible']), 'obvious env/file/telemetry candidates are suppressed without hiding a plausible unknown model id')

const repositoryConfigDir = path.join(tempRoot, 'repository-config')
const repositoryConfigSrc = path.join(repositoryConfigDir, 'src')
const repositoryConfigIgnored = path.join(repositoryConfigSrc, 'ignored')
fs.mkdirSync(repositoryConfigIgnored, { recursive: true })
fs.writeFileSync(path.join(repositoryConfigDir, '.model-eol.json'), JSON.stringify({
  days: 0,
  scope: 'direct',
  via: 'azure-ai-foundry',
  feeds: { allow_vendored_fallback: false },
  ignore: {
    models: ['o3-deep-research', 'gpt-9-config-ignore'],
    paths: ['src/ignored/**'],
  },
  issues: { enabled: false },
  eval: { command: null },
}, null, 2))
fs.writeFileSync(path.join(repositoryConfigSrc, 'app.py'), [
  'from openai import OpenAI',
  'client = OpenAI()',
  'CANONICAL = "o3-deep-research-2025-06-26"',
  'ALIAS = "o3-deep-research"',
  'CURRENT = "gpt-5.6-sol"',
  'UNKNOWN = "gpt-9-config-ignore"',
  '',
].join('\n'))
fs.writeFileSync(path.join(repositoryConfigIgnored, 'large.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
assert(spawnSync('git', ['init', '-q'], { cwd: repositoryConfigDir }).status === 0, 'repository-config fixture initializes a git root')

const automaticConfig = run(['inventory', repositoryConfigDir, '--json'])
const automaticConfigJson = JSON.parse(automaticConfig.out)
assert(automaticConfig.code === 0, 'repository-local config loads automatically')
assert(automaticConfigJson.threshold_days === 0 && automaticConfigJson.scope === 'direct' && automaticConfigJson.distributor === 'azure-ai-foundry', 'repository config supplies days, scope, and via defaults')
assert(automaticConfigJson.model_references.length === 1 && automaticConfigJson.model_references[0].id === 'gpt-5.6-sol', 'ignored alias suppresses its canonical ID and every feed alias')
assert(!automaticConfigJson.candidate_model_references.some(item => item.matched === 'gpt-9-config-ignore'), 'ignored unknown model strings are removed from candidates')
assert(automaticConfigJson.scanned_files === 1 && automaticConfigJson.scan_notes.length === 0, 'config and ignored paths are excluded before scan coverage accounting')

const configuredPlan = run(['plan', repositoryConfigSrc])
const configuredPlanJson = JSON.parse(configuredPlan.out)
assert(configuredPlan.code === 0 && configuredPlanJson.scan_notes.length === 0, 'git-root config is discovered for a subdirectory target and ignored large files do not block plan')
assert(configuredPlanJson.items.length === 0 && configuredPlanJson.issues.length === 0, 'model ignores apply consistently to migration plans')

const explicitConfigFile = path.join(tempRoot, 'explicit-model-eol.json')
fs.writeFileSync(explicitConfigFile, JSON.stringify({
  days: 12,
  scope: 'all',
  via: 'aws-bedrock',
  ignore: { models: ['gpt-5.6-sol'], paths: ['src/ignored/**'] },
}))
const explicitConfig = run(['inventory', repositoryConfigDir, '--config', explicitConfigFile, '--json'])
const explicitConfigJson = JSON.parse(explicitConfig.out)
assert(explicitConfig.code === 0 && explicitConfigJson.threshold_days === 12 && explicitConfigJson.scope === 'all' && explicitConfigJson.distributor === 'aws-bedrock', '--config selects an explicit repository policy instead of the auto-discovered file')
assert(explicitConfigJson.model_references.length === 2 && explicitConfigJson.model_references.every(item => item.id === 'o3-deep-research-2025-06-26'), 'explicit config model ignores replace auto-discovered ignores and still resolve aliases canonically')

const emptyConfigFile = path.join(tempRoot, 'empty-model-eol.json')
fs.writeFileSync(emptyConfigFile, '{}')
const emptyConfig = JSON.parse(run(['inventory', repositoryConfigDir, '--config', emptyConfigFile, '--json']).out)
assert(emptyConfig.threshold_days === 90 && emptyConfig.scope === 'direct' && emptyConfig.distributor === null, 'a present empty config uses the shared CLI/Action/bot defaults')

const configOverrides = run(['inventory', repositoryConfigDir, '--config', explicitConfigFile, '--days', '7', '--scope', 'direct', '--via', 'azure-ai-foundry', '--json'])
const configOverridesJson = JSON.parse(configOverrides.out)
assert(configOverridesJson.threshold_days === 7 && configOverridesJson.scope === 'direct' && configOverridesJson.distributor === 'azure-ai-foundry', 'explicit CLI flags override explicit config values')

const missingConfig = run(['inventory', repositoryConfigDir, '--config', path.join(tempRoot, 'missing-config.json'), '--json'])
assert(missingConfig.code === 2 && missingConfig.err.includes('file not found'), 'an explicitly selected missing config fails closed')
const invalidSharedConfig = path.join(tempRoot, 'invalid-shared-config.json')
fs.writeFileSync(invalidSharedConfig, JSON.stringify({ ignore: { path: ['src/**'] } }))
const invalidSharedConfigRun = run(['inventory', repositoryConfigDir, '--config', invalidSharedConfig, '--json'])
assert(invalidSharedConfigRun.code === 2 && invalidSharedConfigRun.err.includes('ignore.path'), 'CLI preserves strict unknown-key validation for shared config')
const invalidUtf8Config = path.join(tempRoot, 'invalid-utf8-config.json')
fs.writeFileSync(invalidUtf8Config, Buffer.concat([
  Buffer.from('{"ignore":{"paths":["noise-'),
  Buffer.from([0xff]),
  Buffer.from('"]}}\n'),
]))
const invalidUtf8ConfigRun = run(['inventory', repositoryConfigDir, '--config', invalidUtf8Config, '--json'])
assert(
  invalidUtf8ConfigRun.code === 2 &&
    invalidUtf8ConfigRun.err.includes('invalid UTF-8') &&
    invalidUtf8ConfigRun.err.includes(path.basename(invalidUtf8Config)),
  'operational config loading rejects invalid UTF-8 with the selected filename',
)

const partialGlobDir = path.join(tempRoot, 'partial-glob')
fs.mkdirSync(path.join(partialGlobDir, 'partial', 'nested'), { recursive: true })
fs.mkdirSync(path.join(partialGlobDir, 'literal'), { recursive: true })
fs.writeFileSync(path.join(partialGlobDir, 'partial', 'direct.py'), 'MODEL = "o3-deep-research"\n')
fs.writeFileSync(path.join(partialGlobDir, 'partial', 'nested', 'visible.py'), 'MODEL = "gpt-5.6-sol"\n')
fs.writeFileSync(path.join(partialGlobDir, 'literal', 'hidden.py'), 'MODEL = "o3-deep-research"\n')
assert(spawnSync('git', ['init', '-q'], { cwd: partialGlobDir }).status === 0, 'path-ignore fixture initializes a git root')
const partialGlobConfig = path.join(tempRoot, 'partial-glob-config.json')
fs.writeFileSync(partialGlobConfig, JSON.stringify({ ignore: { paths: ['partial/*', 'literal'] } }))
const partialGlob = JSON.parse(run(['inventory', partialGlobDir, '--config', partialGlobConfig, '--json']).out)
assert(partialGlob.model_references.length === 1 && partialGlob.model_references[0].id === 'gpt-5.6-sol', 'literal directories work with git listings while single-star paths do not over-prune deeper descendants')

const mixedRepo = path.join(tempRoot, 'mixed-repo')
fs.mkdirSync(path.join(mixedRepo, 'apps', 'direct'), { recursive: true })
fs.mkdirSync(path.join(mixedRepo, 'apps', 'mismatch'), { recursive: true })
fs.mkdirSync(path.join(mixedRepo, 'services', 'bedrock', 'ignored'), { recursive: true })
fs.mkdirSync(path.join(mixedRepo, 'services', 'vertex'), { recursive: true })
fs.mkdirSync(path.join(mixedRepo, 'services', 'ignored-model'), { recursive: true })
fs.writeFileSync(path.join(mixedRepo, 'apps', 'direct', 'app.py'), 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "o3-deep-research"\nUNKNOWN = "gpt-9-root-ignore"\n')
fs.writeFileSync(path.join(mixedRepo, 'apps', 'mismatch', 'app.py'), 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "claude-opus-4-1-20250805"\n')
fs.writeFileSync(path.join(mixedRepo, 'services', 'bedrock', 'service.py'), 'BEDROCK_MODEL_ID = "bedrock-prod"\n')
fs.writeFileSync(path.join(mixedRepo, 'services', 'bedrock', 'ignored', 'generated.py'), 'BEDROCK_MODEL_ID = "claude-3-7-sonnet-20250219"\n')
fs.writeFileSync(path.join(mixedRepo, 'services', 'vertex', 'service.py'), 'VERTEX_AI = true\nMODEL = "gemini-2.0-flash"\n')
fs.writeFileSync(path.join(mixedRepo, 'services', 'ignored-model', 'service.py'), 'MODEL = "o3-deep-research"\n')
fs.writeFileSync(path.join(mixedRepo, '.model-eol.json'), JSON.stringify({
  days: 0,
  scope: 'direct',
  ignore: { models: ['gpt-9-root-ignore'] },
  overrides: [
    { paths: ['services/**'], days: 30, scope: 'all' },
    { paths: ['services/bedrock/**'], days: 365, via: 'azure-ai-foundry', ignore: { paths: ['services/bedrock/ignored/**'] } },
    { paths: ['services/bedrock/**'], days: 900, via: 'aws-bedrock' },
    { paths: ['services/ignored-model/**'], ignore: { models: ['o3-deep-research-2025-06-26'] } },
  ],
  routes: [
    { paths: ['services/**'], via: 'azure-ai-foundry' },
    { paths: ['services/vertex/**'], via: 'vertex-ai' },
    { paths: ['services/bedrock/**'], via: 'aws-bedrock' },
    { paths: ['services/bedrock/**'], match: 'bedrock-prod', model: 'claude-3-7-sonnet-20250219', via: 'aws-bedrock' },
  ],
}, null, 2))
assert(spawnSync('git', ['init', '-q'], { cwd: mixedRepo }).status === 0, 'mixed-repo fixture initializes a git root')
const mixedInventoryRun = run(['inventory', mixedRepo, '--json'])
const mixedInventory = JSON.parse(mixedInventoryRun.out)
const mixedRef = suffix => mixedInventory.model_references.find(item => item.file.endsWith(suffix))
const bedrockRef = mixedRef('services/bedrock/service.py')
const vertexRef = mixedRef('services/vertex/service.py')
const mismatchRef = mixedRef('apps/mismatch/app.py')
const directRef = mixedRef('apps/direct/app.py')
assert(mixedInventoryRun.code === 0 && mixedInventory.threshold_days === 0 && mixedInventory.scope === 'direct', 'mixed repo retains repository-level defaults in report metadata')
assert(bedrockRef?.id === 'claude-3-7-sonnet-20250219' && bedrockRef.matched === 'bedrock-prod' && bedrockRef.mapped_from === 'bedrock-prod', 'exact route resolves a repository deployment alias to a canonical feed model')
assert(bedrockRef?.usage === 'cloud-provider' && bedrockRef.requested_via === 'aws-bedrock' && bedrockRef.via === 'aws-bedrock', 'Bedrock reference uses its per-reference distribution clock')
assert(bedrockRef?.threshold_days === 900 && bedrockRef.effective_scope === 'all' && JSON.stringify(bedrockRef.policy_provenance) === JSON.stringify({ override_indexes: [0, 1, 2], route_index: 3 }), 'later path policies win deterministically and report effective policy provenance')
assert(vertexRef?.requested_via === 'vertex-ai' && vertexRef.usage === 'cloud-provider' && vertexRef.policy_provenance?.route_index === 1, 'a Vertex subtree uses an independent per-reference route')
assert(directRef?.requested_via === null && directRef.via === 'publisher' && directRef.threshold_days === 0, 'an unrouted direct reference keeps the repository publisher clock')
assert(!mixedInventory.model_references.some(item => item.file.includes('/ignored/')) && !mixedInventory.model_references.some(item => item.file.includes('ignored-model')), 'path-scoped ignores suppress only their matching monorepo subtrees')
assert(!mixedInventory.candidate_model_references.some(item => item.matched === 'gpt-9-root-ignore'), 'root and path-scoped model ignores remain additive')
assert(!mixedInventory.candidate_model_references.some(item => item.matched === 'bedrock-prod'), 'an exact static route removes its resolved deployment alias from candidates')
assert(!mixedInventory.integration_hints.some(item => item.file.endsWith('services/bedrock/service.py') && item.provider === 'aws-bedrock'), 'an exact static route removes its provider from unresolved integration hints')
assert(mismatchRef?.usage === 'direct-api' && mismatchRef.confidence === 'medium' && mismatchRef.evidence.includes('differs from model publisher'), 'provider/publisher mismatch can never be high-confidence direct usage')
const mixedPlan = JSON.parse(run(['plan', mixedRepo]).out)
assert(!mixedPlan.items.some(item => item.file.endsWith('apps/mismatch/app.py')) && mixedPlan.issues.some(item => item.file.endsWith('apps/mismatch/app.py') && item.reason === 'not-direct-api'), 'provider/publisher mismatch is never patchable')
assert(mixedPlan.issues.some(item => item.mapped_from === 'bedrock-prod' && item.policy_provenance?.route_index === 3 && item.threshold_days === 900), 'mixed-channel plan issues preserve route and effective threshold provenance')
assert(!mixedPlan.issues.some(item => item.file.endsWith('services/bedrock/service.py') && item.reason === 'unresolved-channel'), 'resolved exact routes do not create contradictory unresolved-channel plan issues')
const mixedCliOverride = JSON.parse(run(['inventory', mixedRepo, '--days', '7', '--scope', 'direct', '--via', 'vertex-ai', '--json']).out)
assert(mixedCliOverride.model_references.every(item => item.threshold_days === 7 && item.effective_scope === 'direct' && item.requested_via === 'vertex-ai'), 'explicit CLI flags override every path policy and route lifecycle clock')

const nullViaRepo = path.join(tempRoot, 'null-via-repo')
fs.mkdirSync(path.join(nullViaRepo, 'direct'), { recursive: true })
fs.writeFileSync(path.join(nullViaRepo, 'direct', 'app.py'), 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "o3-deep-research"\n')
fs.writeFileSync(path.join(nullViaRepo, '.model-eol.json'), JSON.stringify({
  via: 'azure-ai-foundry',
  issues: { enabled: false },
  overrides: [{ paths: ['direct/**'], via: null }],
}, null, 2))
assert(spawnSync('git', ['init', '-q'], { cwd: nullViaRepo }).status === 0, 'publisher-clock reset fixture initializes a git root')
const nullViaInventory = JSON.parse(run(['inventory', nullViaRepo, '--json']).out)
const nullViaPlan = JSON.parse(run(['plan', nullViaRepo]).out)
assert(nullViaInventory.model_references[0]?.requested_via === null && nullViaInventory.model_references[0]?.via === 'publisher', 'path override can explicitly reset a repository distributor to the publisher clock')
assert(nullViaPlan.items[0]?.requested_via === null && nullViaPlan.items[0]?.publisher === 'openai', 'plan preserves an explicit null clock instead of falling back to the repository distributor')

const invalidRoutePairConfig = path.join(tempRoot, 'invalid-route-pair.json')
fs.writeFileSync(invalidRoutePairConfig, JSON.stringify({ routes: [{ paths: ['**'], via: 'aws-bedrock', match: 'deployment-only' }] }))
const invalidRoutePair = run(['inventory', mixedRepo, '--config', invalidRoutePairConfig, '--json'])
assert(invalidRoutePair.code === 2 && invalidRoutePair.err.includes('match and routes[0].model must be provided together'), 'static routes require an exact match/model pair')
const unknownRouteModelConfig = path.join(tempRoot, 'unknown-route-model.json')
fs.writeFileSync(unknownRouteModelConfig, JSON.stringify({ routes: [{ paths: ['**'], via: 'aws-bedrock', match: 'deployment', model: 'not-in-feed' }] }))
const unknownRouteModel = run(['inventory', mixedRepo, '--config', unknownRouteModelConfig, '--json'])
assert(unknownRouteModel.code === 2 && unknownRouteModel.err.includes('not present in loaded feeds'), 'static route targets must resolve in the loaded feeds')
const unknownRouteViaConfig = path.join(tempRoot, 'unknown-route-via.json')
fs.writeFileSync(unknownRouteViaConfig, JSON.stringify({ routes: [{ paths: ['**'], via: 'private-mystery-channel' }] }))
const unknownRouteVia = run(['inventory', mixedRepo, '--config', unknownRouteViaConfig, '--json'])
assert(unknownRouteVia.code === 2 && unknownRouteVia.err.includes('unknown lifecycle channel'), 'configured routes reject unknown lifecycle channels')

const badgeDir = path.join(tempRoot, 'badge')
const badgeFeeds = path.join(badgeDir, 'feeds')
fs.mkdirSync(badgeFeeds, { recursive: true })
fs.writeFileSync(path.join(badgeDir, 'models.py'), 'RETIRED = "badge-retired-model"\nRETIRING = "badge-retiring-model"\n')
fs.writeFileSync(path.join(badgeFeeds, 'badge.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/badge',
  models: [
    { id: 'badge-retired-model', shutdown: '2000-01-01' },
    { id: 'badge-retiring-model', shutdown: '9999-12-31' },
  ],
}))
const badgeThresholdDays = '4000000'
const badgeRun = run(['alert', badgeDir, '--feeds', badgeFeeds, '--days', badgeThresholdDays, '--format', 'badge'])
const badge = JSON.parse(badgeRun.out)
assert(badgeRun.code === 1, 'badge alert keeps existing alert exit semantics')
assert(badge.schemaVersion === 1 && badge.label === 'model-eol', 'badge emits Shields endpoint keys')
assert(badge.color === 'red' && badge.message.includes('retired') && badge.message.includes('retiring'), 'badge counts retired and retiring errors')

const largePipeDir = path.join(tempRoot, 'large-pipe-output')
fs.mkdirSync(largePipeDir)
const largePipeFindingCount = 512
fs.writeFileSync(path.join(largePipeDir, 'models.py'), Array.from(
  { length: largePipeFindingCount },
  (_, index) => `MODEL_${index} = "o3-deep-research"`,
).join('\n'))
const largePipeRun = await runPiped(['check', largePipeDir, '--days', '90', '--scope', 'all', '--json'])
let largePipeJson = null
try {
  largePipeJson = JSON.parse(largePipeRun.out)
} catch {}
assert(largePipeRun.out.length > 64 * 1024 && largePipeJson?.findings.length === largePipeFindingCount, 'piped check JSON over 64KiB is complete and parseable')
assert(largePipeRun.code === 1, 'large piped check keeps finding exit semantics')

const preloadDir = path.join(tempRoot, 'preloads')
fs.mkdirSync(preloadDir)
const intervalPreload = path.join(preloadDir, 'interval.cjs')
const beforeExitPreload = path.join(preloadDir, 'before-exit.cjs')
const endedStderrPreload = path.join(preloadDir, 'ended-stderr.cjs')
const badStdoutPreload = path.join(preloadDir, 'bad-stdout.cjs')
fs.writeFileSync(intervalPreload, 'setInterval(() => {}, 1000)\n')
fs.writeFileSync(beforeExitPreload, 'process.on("beforeExit", () => { process.exitCode = 7 })\n')
fs.writeFileSync(endedStderrPreload, 'process.stderr.end()\n')
fs.writeFileSync(badStdoutPreload, 'process.stdout.write = (_chunk, encoding, callback) => { const done = typeof encoding === "function" ? encoding : callback; process.nextTick(() => done?.(Object.assign(new Error("bad file descriptor"), { code: "EBADF" }))); return false }\n')
const preloadEnv = preload => ({
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
})
const intervalRun = await runPiped(
  ['check', largePipeDir, '--days', '90', '--scope', 'all', '--json'],
  { env: preloadEnv(intervalPreload) },
)
let intervalJson = null
try {
  intervalJson = JSON.parse(intervalRun.out)
} catch {}
assert(!intervalRun.timedOut && intervalJson?.findings.length === largePipeFindingCount, 'CLI drains complete output and exits despite a preloaded interval')
assert(intervalRun.code === 1, 'preloaded interval does not change the check exit code')
const beforeExitRun = await runPiped(['--help'], { env: preloadEnv(beforeExitPreload) })
assert(!beforeExitRun.timedOut && beforeExitRun.code === 0, 'beforeExit hooks cannot rewrite the CLI exit code')
const closedCheckRun = await runPiped(
  ['check', largePipeDir, '--days', '90', '--scope', 'all', '--json'],
  { closeStdoutAfterData: true },
)
assert(!closedCheckRun.timedOut && closedCheckRun.code === 1, 'early-closed stdout keeps the intended nonzero exit code')
const closedInventoryRun = await runPiped(
  ['inventory', largePipeDir, '--json'],
  { closeStdoutAfterData: true },
)
assert(!closedInventoryRun.timedOut && closedInventoryRun.code === 0, 'EPIPE keeps a successful command exit code')
const endedStderrRun = await runPiped(['--invalid-review-flag'], { env: preloadEnv(endedStderrPreload) })
assert(!endedStderrRun.timedOut && endedStderrRun.code === 2 && !endedStderrRun.err.includes('Unhandled'), 'ended stderr cannot replace a usage exit with an unhandled error')
const badStdoutRun = await runPiped(['--help'], { env: preloadEnv(badStdoutPreload) })
assert(!badStdoutRun.timedOut && badStdoutRun.code === 3 && badStdoutRun.err.includes('model-eol: output failed: EBADF'), 'non-EPIPE output failure exits 3 with a best-effort diagnostic')

const largeStderrFeeds = path.join(tempRoot, 'large-stderr-feeds')
fs.mkdirSync(largeStderrFeeds)
const largeStderrErrorCount = 512
fs.writeFileSync(path.join(largeStderrFeeds, 'invalid.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  models: Array.from({ length: largeStderrErrorCount }, (_, index) => ({
    id: `invalid-stderr-model-${index}`,
    shutdown: '2000-01-01',
  })),
}))
const largeStderrRun = await runPiped(['check', largePipeDir, '--feeds', largeStderrFeeds, '--json'])
assert(largeStderrRun.err.length > 64 * 1024 && largeStderrRun.err.includes(`model invalid-stderr-model-${largeStderrErrorCount - 1}`), 'piped stderr over 64KiB arrives complete')
assert(largeStderrRun.code === 2, 'large piped feed errors keep usage/feed exit semantics')

const extensionCoverageDir = path.join(tempRoot, 'extension-coverage')
const extensionCoverageFeeds = path.join(tempRoot, 'extension-coverage-feeds')
fs.mkdirSync(extensionCoverageDir)
fs.mkdirSync(extensionCoverageFeeds)
fs.writeFileSync(path.join(extensionCoverageFeeds, 'coverage.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/extension-coverage',
  models: [{ id: 'retired-extension-model', shutdown: '2026-07-01' }],
}))
fs.writeFileSync(path.join(extensionCoverageDir, 'main.rs'), 'const MODEL: &str = "retired-extension-model";\n')
fs.writeFileSync(path.join(extensionCoverageDir, 'variables.tf'), 'model_id = "retired-extension-model"\n')
fs.writeFileSync(path.join(extensionCoverageDir, 'queries.sql'), "SELECT 'retired-extension-model' AS model_id;\n")
fs.writeFileSync(path.join(extensionCoverageDir, 'notes.xyz'), 'model_id = "retired-extension-model"\n')
const extensionCoverageInventory = JSON.parse(run([
  'inventory', extensionCoverageDir, '--feeds', extensionCoverageFeeds, '--json',
]).out)
const extensionCoverageRef = file => extensionCoverageInventory.model_references.find(ref => ref.file.endsWith(file))
assert(extensionCoverageRef('main.rs')?.status === 'retired', 'retired model in Rust source is found')
assert(extensionCoverageRef('variables.tf')?.status === 'retired', 'retired model in Terraform source is found')
assert(extensionCoverageRef('queries.sql')?.status === 'retired', 'retired model in SQL source is found')
assert(!extensionCoverageRef('notes.xyz'), 'unsupported extension produces no finding')

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

const invalidUtf8Dir = path.join(tempRoot, 'invalid-utf8-scan')
fs.mkdirSync(invalidUtf8Dir)
fs.writeFileSync(path.join(invalidUtf8Dir, 'app.py'), Buffer.concat([
  Buffer.from('MODEL = "o3-deep-research"\n'),
  Buffer.from([0xff, 0x0a]),
]))
const invalidUtf8Check = run([invalidUtf8Dir, '--json'])
assert(invalidUtf8Check.code === 2 && invalidUtf8Check.err.includes('invalid-utf8'), 'invalid UTF-8 is coverage loss instead of being scanned through replacement characters')
const invalidUtf8Allowed = run([invalidUtf8Dir, '--allow-incomplete', '--json'])
const invalidUtf8AllowedJson = JSON.parse(invalidUtf8Allowed.out)
assert(invalidUtf8Allowed.code === 0 && invalidUtf8AllowedJson.findings.length === 0 && invalidUtf8AllowedJson.scan_notes.some(note => note.reason === 'invalid-utf8'), 'allow-incomplete records invalid UTF-8 without emitting findings from lossy text')

const symlinkTarget = path.join(tempRoot, 'symlink-outside.py')
const explicitSymlink = path.join(tempRoot, 'explicit-link.py')
fs.writeFileSync(symlinkTarget, 'MODEL = "o3-deep-research"\n')
fs.symlinkSync(symlinkTarget, explicitSymlink)
const explicitSymlinkCheck = run([explicitSymlink, '--json'])
assert(explicitSymlinkCheck.code === 2 && explicitSymlinkCheck.err.includes('symlink-skipped'), 'an explicit symlink-only target fails check as incomplete coverage')
const explicitSymlinkAllowed = run([explicitSymlink, '--allow-incomplete', '--json'])
const explicitSymlinkAllowedJson = JSON.parse(explicitSymlinkAllowed.out)
assert(explicitSymlinkAllowed.code === 0 && explicitSymlinkAllowedJson.findings.length === 0 && explicitSymlinkAllowedJson.scan_notes.some(note => note.reason === 'symlink-skipped'), 'allow-incomplete records an explicit symlink without following its target')
const explicitSymlinkPlan = run(['plan', explicitSymlink])
assert(explicitSymlinkPlan.code === 2 && explicitSymlinkPlan.err.includes('symlink-skipped'), 'an explicit symlink-only target fails plan as incomplete coverage')

const trackedSymlinkRepo = path.join(tempRoot, 'tracked-symlink-repo')
fs.mkdirSync(trackedSymlinkRepo)
const trackedSymlinkGit = args => spawnSync('git', args, { cwd: trackedSymlinkRepo, encoding: 'utf8' })
assert(trackedSymlinkGit(['init', '-q']).status === 0, 'tracked-symlink fixture initializes a git root')
assert(trackedSymlinkGit(['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'tracked-symlink fixture configures git email')
assert(trackedSymlinkGit(['config', 'user.name', 'model-eol test']).status === 0, 'tracked-symlink fixture configures git name')
fs.symlinkSync(symlinkTarget, path.join(trackedSymlinkRepo, 'tracked-link.py'))
assert(trackedSymlinkGit(['add', 'tracked-link.py']).status === 0 && trackedSymlinkGit(['commit', '-qm', 'track symlink']).status === 0, 'tracked-symlink fixture commits the link itself')
const trackedSymlinkCheck = run([trackedSymlinkRepo, '--json'])
assert(trackedSymlinkCheck.code === 2 && trackedSymlinkCheck.err.includes('symlink-skipped'), 'a tracked symlink fails check as incomplete coverage')
const trackedSymlinkAllowed = run([trackedSymlinkRepo, '--allow-incomplete', '--json'])
const trackedSymlinkAllowedJson = JSON.parse(trackedSymlinkAllowed.out)
assert(trackedSymlinkAllowed.code === 0 && trackedSymlinkAllowedJson.findings.length === 0 && trackedSymlinkAllowedJson.scan_notes.some(note => note.reason === 'symlink-skipped' && note.file.endsWith('tracked-link.py')), 'tracked symlink coverage loss is explicit and its outside target is never scanned')
fs.writeFileSync(path.join(trackedSymlinkRepo, '.model-eol.json'), '{"ignore":{"paths":["tracked-link.py"]}}\n')
assert(trackedSymlinkGit(['add', '.model-eol.json']).status === 0 && trackedSymlinkGit(['commit', '-qm', 'ignore intentional symlink']).status === 0, 'tracked-symlink fixture commits an explicit path policy')
const ignoredTrackedSymlink = run([trackedSymlinkRepo, '--json'])
assert(ignoredTrackedSymlink.code === 0 && JSON.parse(ignoredTrackedSymlink.out).scan_notes.every(note => note.reason !== 'symlink-skipped'), 'repository path policy can explicitly accept an intentional tracked symlink')

const untrackedNestedRepo = path.join(tempRoot, 'untracked-nested-repo')
const untrackedNestedPath = path.join(untrackedNestedRepo, 'nested')
fs.mkdirSync(untrackedNestedPath, { recursive: true })
const untrackedNestedGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
assert(untrackedNestedGit(untrackedNestedRepo, ['init', '-q']).status === 0, 'untracked-nested fixture initializes the parent repository')
assert(untrackedNestedGit(untrackedNestedPath, ['init', '-q']).status === 0, 'untracked-nested fixture initializes the embedded repository')
fs.writeFileSync(path.join(untrackedNestedPath, 'app.py'), 'MODEL = "o3-deep-research"\n')
const untrackedNestedCheck = run([untrackedNestedRepo, '--json'])
assert(untrackedNestedCheck.code === 2 && untrackedNestedCheck.err.includes('nested-repository-skipped'), 'an untracked nested Git repository fails check as incomplete coverage')
const untrackedNestedPlan = run(['plan', untrackedNestedRepo])
assert(untrackedNestedPlan.code === 2 && untrackedNestedPlan.err.includes('nested-repository-skipped'), 'an untracked nested Git repository fails plan as incomplete coverage')
const allowedUntrackedNested = run([untrackedNestedRepo, '--allow-incomplete', '--json'])
const allowedUntrackedNestedJson = JSON.parse(allowedUntrackedNested.out)
assert(
  allowedUntrackedNested.code === 0 &&
    allowedUntrackedNestedJson.findings.length === 0 &&
    allowedUntrackedNestedJson.scan_notes.some(note => note.reason === 'nested-repository-skipped' && note.file.endsWith('/nested')),
  'allow-incomplete records an untracked nested repository without recursively scanning its retired reference',
)
const untrackedNestedConfig = path.join(untrackedNestedRepo, '.model-eol.json')
fs.writeFileSync(untrackedNestedConfig, '{"ignore":{"paths":["nested"]}}\n')
const ignoredUntrackedNested = run([untrackedNestedRepo, '--json'])
assert(
  ignoredUntrackedNested.code === 0 &&
    JSON.parse(ignoredUntrackedNested.out).scan_notes.every(note => note.reason !== 'nested-repository-skipped'),
  'repository path policy can explicitly accept an intentional untracked nested repository',
)

const trackedSubmoduleRepo = path.join(tempRoot, 'tracked-submodule-repo')
const trackedSubmodulePath = path.join(trackedSubmoduleRepo, 'sub')
fs.mkdirSync(trackedSubmodulePath, { recursive: true })
const trackedSubmoduleGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
assert(trackedSubmoduleGit(trackedSubmodulePath, ['init', '-q']).status === 0, 'tracked-submodule fixture initializes the nested repository')
assert(trackedSubmoduleGit(trackedSubmodulePath, ['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'tracked-submodule fixture configures nested git email')
assert(trackedSubmoduleGit(trackedSubmodulePath, ['config', 'user.name', 'model-eol test']).status === 0, 'tracked-submodule fixture configures nested git name')
fs.writeFileSync(path.join(trackedSubmodulePath, 'app.py'), 'MODEL = "o3-deep-research"\n')
assert(trackedSubmoduleGit(trackedSubmodulePath, ['add', 'app.py']).status === 0 && trackedSubmoduleGit(trackedSubmodulePath, ['commit', '-qm', 'submodule fixture']).status === 0, 'tracked-submodule fixture commits a retired reference in the nested repository')
assert(trackedSubmoduleGit(trackedSubmoduleRepo, ['init', '-q']).status === 0, 'tracked-submodule fixture initializes the parent repository')
assert(trackedSubmoduleGit(trackedSubmoduleRepo, ['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'tracked-submodule fixture configures parent git email')
assert(trackedSubmoduleGit(trackedSubmoduleRepo, ['config', 'user.name', 'model-eol test']).status === 0, 'tracked-submodule fixture configures parent git name')
assert(trackedSubmoduleGit(trackedSubmoduleRepo, ['add', 'sub']).status === 0 && trackedSubmoduleGit(trackedSubmoduleRepo, ['commit', '-qm', 'track submodule']).status === 0, 'tracked-submodule fixture commits the nested repository as a gitlink')

const initializedSubmoduleCheck = run([trackedSubmoduleRepo, '--json'])
assert(initializedSubmoduleCheck.code === 2 && initializedSubmoduleCheck.err.includes('submodule-skipped'), 'a checked-out tracked submodule fails check as incomplete coverage')
const initializedSubmodulePlan = run(['plan', trackedSubmoduleRepo])
assert(initializedSubmodulePlan.code === 2 && initializedSubmodulePlan.err.includes('submodule-skipped'), 'a checked-out tracked submodule fails plan as incomplete coverage')
const allowedInitializedSubmodule = run([trackedSubmoduleRepo, '--allow-incomplete', '--json'])
const allowedInitializedSubmoduleJson = JSON.parse(allowedInitializedSubmodule.out)
assert(
  allowedInitializedSubmodule.code === 0 &&
    allowedInitializedSubmoduleJson.findings.length === 0 &&
    allowedInitializedSubmoduleJson.scan_notes.some(note => note.reason === 'submodule-skipped' && note.file.endsWith('/sub')),
  'allow-incomplete records a checked-out submodule without recursively scanning its retired reference',
)
const allowedInitializedSubmodulePlan = run(['plan', trackedSubmoduleRepo, '--allow-incomplete'])
const allowedInitializedSubmodulePlanJson = JSON.parse(allowedInitializedSubmodulePlan.out)
assert(
  allowedInitializedSubmodulePlan.code === 0 &&
    allowedInitializedSubmodulePlanJson.items.length === 0 &&
    allowedInitializedSubmodulePlanJson.scan_notes.some(note => note.reason === 'submodule-skipped'),
  'allow-incomplete emits a plan receipt for a checked-out submodule without recursing into it',
)

const trackedSubmoduleConfig = path.join(trackedSubmoduleRepo, '.model-eol.json')
fs.writeFileSync(trackedSubmoduleConfig, '{"ignore":{"paths":["sub"]}}\n')
const ignoredTrackedSubmodule = run([trackedSubmoduleRepo, '--json'])
assert(ignoredTrackedSubmodule.code === 0 && JSON.parse(ignoredTrackedSubmodule.out).scan_notes.every(note => note.reason !== 'submodule-skipped'), 'repository path policy can explicitly accept an intentional tracked submodule')
const ignoredTrackedSubmodulePlan = run(['plan', trackedSubmoduleRepo])
assert(ignoredTrackedSubmodulePlan.code === 0 && JSON.parse(ignoredTrackedSubmodulePlan.out).scan_notes.every(note => note.reason !== 'submodule-skipped'), 'an explicitly ignored tracked submodule does not block plan generation')
fs.rmSync(trackedSubmoduleConfig)

fs.rmSync(trackedSubmodulePath, { recursive: true, force: true })
const uninitializedSubmoduleCheck = run([trackedSubmoduleRepo, '--json'])
assert(uninitializedSubmoduleCheck.code === 2 && uninitializedSubmoduleCheck.err.includes('submodule-skipped') && !uninitializedSubmoduleCheck.err.includes('unreadable-file'), 'an uninitialized tracked submodule fails check with a precise incomplete-coverage reason')
const uninitializedSubmodulePlan = run(['plan', trackedSubmoduleRepo])
assert(uninitializedSubmodulePlan.code === 2 && uninitializedSubmodulePlan.err.includes('submodule-skipped'), 'an uninitialized tracked submodule fails plan as incomplete coverage')
const allowedUninitializedSubmodule = run([trackedSubmoduleRepo, '--allow-incomplete', '--json'])
const allowedUninitializedSubmoduleJson = JSON.parse(allowedUninitializedSubmodule.out)
assert(allowedUninitializedSubmodule.code === 0 && allowedUninitializedSubmoduleJson.scan_notes.some(note => note.reason === 'submodule-skipped'), 'allow-incomplete records an uninitialized tracked submodule')

const orangeBadgeDir = path.join(tempRoot, 'orange-badge')
fs.mkdirSync(orangeBadgeDir)
fs.writeFileSync(path.join(orangeBadgeDir, 'app.py'), 'MODEL = "badge-retiring-model"\n')
const orangeBadge = JSON.parse(run(['alert', orangeBadgeDir, '--feeds', badgeFeeds, '--days', badgeThresholdDays, '--format', 'badge']).out)
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
const invalidControlFeeds = path.join(tempRoot, 'invalid-control-feeds')
fs.mkdirSync(invalidControlFeeds)
fs.writeFileSync(path.join(invalidControlFeeds, 'invalid-control.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'test',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/control',
  models: [{ id: 'old-model', replacement: 'new-model\n' }, { id: 'new-model' }],
}))
let invalidControlMessage = ''
try {
  loadFeeds(invalidControlFeeds)
} catch (error) {
  invalidControlMessage = error.message
}
assert(invalidControlMessage.includes('invalid-control.json') && invalidControlMessage.includes('replacement') && invalidControlMessage.includes('control characters'), 'loadFeeds rejects control characters in replacement fields')
const invalidUtf8Feeds = path.join(tempRoot, 'invalid-utf8-feeds')
const invalidUtf8Feed = path.join(invalidUtf8Feeds, 'invalid-utf8.json')
fs.mkdirSync(invalidUtf8Feeds)
fs.writeFileSync(invalidUtf8Feed, Buffer.concat([
  Buffer.from('{"spec":"model-eol/0.1","publisher":"test","generated":"2026-08-01T00:00:00Z","source":"https://example.invalid/utf8","note":"bad-'),
  Buffer.from([0xff]),
  Buffer.from('","models":[{"id":"utf8-test-model"}]}\n'),
]))
let invalidUtf8FeedMessage = ''
try {
  loadFeeds(invalidUtf8Feeds)
} catch (error) {
  invalidUtf8FeedMessage = error.message
}
assert(invalidUtf8FeedMessage.includes('invalid-utf8.json') && invalidUtf8FeedMessage.includes('invalid UTF-8'), 'operational feed loading rejects invalid UTF-8 with the feed filename')
const invalidUtf8FeedRun = run(['check', path.join(root, 'test/fixture'), '--feeds', invalidUtf8Feeds, '--json'])
assert(invalidUtf8FeedRun.code === 2 && invalidUtf8FeedRun.err.includes('invalid-utf8.json') && invalidUtf8FeedRun.err.includes('invalid UTF-8'), 'check exits 2 instead of loading a replacement-decoded feed')

const federationDir = path.join(tempRoot, 'federation')
const federationFeeds = path.join(federationDir, 'feeds')
fs.mkdirSync(federationFeeds, { recursive: true })
const federationSource = 'https://example.invalid/federation'
fs.writeFileSync(path.join(federationDir, 'app.py'), 'from openai import OpenAI\nclient = OpenAI()\nmodel = "old-openai"\n')
fs.writeFileSync(path.join(federationFeeds, 'openai.json'), JSON.stringify({
  spec: 'model-eol/0.1', publisher: 'openai', generated: '2026-08-01T00:00:00Z', source: federationSource,
  models: [{ id: 'old-openai', shutdown: '2026-07-01' }, { id: 'same-target' }],
}))
fs.writeFileSync(path.join(federationFeeds, 'anthropic.json'), JSON.stringify({
  spec: 'model-eol/0.1', publisher: 'anthropic', generated: '2026-08-01T00:00:00Z', source: federationSource,
  models: [{ id: 'claude-x' }],
}))
const federation = loadFeeds(federationFeeds)
const federationScan = {
  modelRefs: [{
    file: path.join(federationDir, 'app.py'), line: 3, matched: 'old-openai', id: 'old-openai', publisher: 'openai',
    entry: { id: 'old-openai' }, usage: 'direct-api', confidence: 'high', source: federationSource, feedNote: null, policy: null, generated: '2026-08-01T00:00:00Z',
  }],
  candidateRefs: [], integrationHints: [], notes: [],
}
const federationFinding = replacement => ({
  status: 'retired', shutdown: '2026-07-01', days: -31, via: 'publisher', publisher: 'openai', replacement,
  replacement_options: null, replacement_note: null,
})
const crossFeedPlan = buildPlan({ scan: federationScan, findings: [federationFinding('claude-x')], entries: federation.entries, days: 90, via: null, scope: 'all' })
const sameFeedPlan = buildPlan({ scan: federationScan, findings: [federationFinding('same-target')], entries: federation.entries, days: 90, via: null, scope: 'all' })
assert(crossFeedPlan.items.length === 0 && crossFeedPlan.issues[0]?.reason === 'replacement-unresolved', 'cross-publisher replacement matches remain issue-only')
assert(sameFeedPlan.items.length === 1 && sameFeedPlan.issues.length === 0, 'same-publisher replacement resolution remains patchable')
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
const anthropicFloor = new Date(new Date(anthropicFeed.generated).getTime() + anthropicFeed.policy.min_notice_days * 86400000).toISOString().slice(0, 10)
assert(cleanAnthropic.status === 'ok' && cleanAnthropic.safe_until === anthropicFloor, 'clean Anthropic model gets policy-floor safe_until')

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
assert(git(['config', 'diff.mnemonicPrefix', 'true']).status === 0, 'diff test enables hostile mnemonic prefixes')
assert(git(['config', 'diff.noprefix', 'true']).status === 0, 'diff test enables hostile no-prefix output')
assert(git(['config', 'color.diff', 'always']).status === 0, 'diff test enables hostile forced color output')
fs.writeFileSync(changedFile, 'MODEL = "o3-deep-research"\n')
assert(git(['add', 'app.py']).status === 0 && git(['commit', '-qm', 'base']).status === 0, 'diff test creates the base commit')
fs.writeFileSync(changedFile, 'MODEL = "o3-deep-research"\nNEW_MODEL = "claude-opus-4-1-20250805"\n')
const changedRun = run(['check', changedRepo, '--days', '30', '--changed', 'HEAD', '--json'])
assert(changedRun.out.trim().startsWith('{'), `--changed emits JSON (stderr: ${changedRun.err.trim()})`)
const changedJson = JSON.parse(changedRun.out)
assert(changedRun.code === 1, '--changed fails for an added bad model')
assert(changedJson.findings.length === 1 && changedJson.findings[0].id === 'claude-opus-4-1-20250805', '--changed pins parseable prefixes and color despite hostile Git config')
const changedExpressionRun = run(['check', changedRepo, '--days', '30', '--changed', 'HEAD~0', '--json'])
assert(changedExpressionRun.code === 1 && JSON.parse(changedExpressionRun.out).findings.length === 1, '--changed resolves ordinary revision expressions to a commit')
const injectedDiffOutput = path.join(changedRepo, 'injected.diff')
const injectedChanged = run(['check', changedRepo, '--days', '30', `--changed=--output=${injectedDiffOutput}`, '--json'])
assert(
  injectedChanged.code === 2 &&
    injectedChanged.err.includes('base ref must not begin') &&
    !fs.existsSync(injectedDiffOutput),
  '--changed rejects leading-option input without allowing Git to create an output file',
)
const missingChangedBase = run(['check', changedRepo, '--days', '30', '--changed', 'definitely-not-a-ref', '--json'])
assert(missingChangedBase.code === 2 && missingChangedBase.err.includes('could not resolve base ref'), '--changed fails closed when its revision does not resolve to a commit')
assert(parseDiffPath('"b/path with spaces.py"') === 'path with spaces.py', 'Git diff path parsing preserves ordinary quoted paths with spaces')
assert(parseDiffPath('"b/\\303\\251.py"') === 'é.py', 'Git diff path parsing decodes octal UTF-8 bytes')
let malformedDiffPathFailed = false
try {
  parseDiffPath('"b/unsupported\\q.py"')
} catch {
  malformedDiffPathFailed = true
}
assert(malformedDiffPathFailed, 'Git diff path parsing fails closed on unsupported quoted escapes')

const noFinalNewlineRepo = path.join(tempRoot, 'changed-no-final-newline-repo')
fs.mkdirSync(noFinalNewlineRepo)
const noFinalNewlineGit = args => spawnSync('git', args, { cwd: noFinalNewlineRepo, encoding: 'utf8' })
assert(noFinalNewlineGit(['init', '-q']).status === 0, 'no-final-newline diff test initializes a git repository')
assert(noFinalNewlineGit(['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'no-final-newline diff test configures git email')
assert(noFinalNewlineGit(['config', 'user.name', 'model-eol test']).status === 0, 'no-final-newline diff test configures git name')
const removedMarkerFile = path.join(noFinalNewlineRepo, 'removed-marker.py')
const addedMarkerFile = path.join(noFinalNewlineRepo, 'added-marker.py')
fs.writeFileSync(removedMarkerFile, 'MODEL = "gpt-5.6-sol"')
fs.writeFileSync(addedMarkerFile, 'MODEL = "gpt-5.6-sol"\n')
assert(noFinalNewlineGit(['add', '.']).status === 0 && noFinalNewlineGit(['commit', '-qm', 'base']).status === 0, 'no-final-newline diff test creates the base commit')
fs.writeFileSync(removedMarkerFile, 'MODEL = "o3-deep-research"\n')
fs.writeFileSync(addedMarkerFile, 'MODEL = "o3-deep-research"')
const noFinalNewlineChanged = run(['check', noFinalNewlineRepo, '--days', '30', '--changed', 'HEAD', '--json'])
const noFinalNewlineChangedJson = JSON.parse(noFinalNewlineChanged.out)
const noFinalNewlineFindingFiles = new Set(noFinalNewlineChangedJson.findings.map(finding => path.basename(finding.file)))
assert(noFinalNewlineChanged.code === 1, '--changed fails when no-final-newline metadata surrounds added retired models')
assert(noFinalNewlineFindingFiles.has('removed-marker.py'), '--changed ignores a no-final-newline marker after the removed line')
assert(noFinalNewlineFindingFiles.has('added-marker.py'), '--changed ignores a no-final-newline marker after the added line')

const unicodeChangedRepo = path.join(tempRoot, 'changed-unicode-path-repo')
fs.mkdirSync(unicodeChangedRepo)
const unicodeChangedGit = args => spawnSync('git', args, { cwd: unicodeChangedRepo, encoding: 'utf8' })
assert(unicodeChangedGit(['init', '-q']).status === 0, 'Unicode-path diff test initializes a git repository')
assert(unicodeChangedGit(['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'Unicode-path diff test configures git email')
assert(unicodeChangedGit(['config', 'user.name', 'model-eol test']).status === 0, 'Unicode-path diff test configures git name')
const unicodeChangedFile = path.join(unicodeChangedRepo, 'é.py')
fs.writeFileSync(unicodeChangedFile, 'MODEL = "gpt-5.6-sol"\n')
assert(unicodeChangedGit(['add', '.']).status === 0 && unicodeChangedGit(['commit', '-qm', 'base']).status === 0, 'Unicode-path diff test creates the base commit')
fs.writeFileSync(unicodeChangedFile, 'MODEL = "o3-deep-research"\n')
const unicodeChanged = run(['check', unicodeChangedRepo, '--days', '30', '--changed', 'HEAD', '--json'])
const unicodeChangedJson = JSON.parse(unicodeChanged.out)
assert(unicodeChanged.code === 1 && unicodeChangedJson.findings.some(finding => finding.file.endsWith('é.py')), '--changed maps Git octal UTF-8 paths back to scanned filenames')

const disabledDiffRepo = path.join(tempRoot, 'changed-disabled-diff-repo')
fs.mkdirSync(disabledDiffRepo)
const disabledDiffGit = args => spawnSync('git', args, { cwd: disabledDiffRepo, encoding: 'utf8' })
assert(disabledDiffGit(['init', '-q']).status === 0, 'disabled-diff test initializes a git repository')
assert(disabledDiffGit(['config', 'user.email', 'model-eol-test@example.invalid']).status === 0, 'disabled-diff test configures git email')
assert(disabledDiffGit(['config', 'user.name', 'model-eol test']).status === 0, 'disabled-diff test configures git name')
const disabledDiffFile = path.join(disabledDiffRepo, 'app.py')
fs.writeFileSync(disabledDiffFile, 'MODEL = "gpt-5.6-sol"\n')
assert(disabledDiffGit(['add', '.']).status === 0 && disabledDiffGit(['commit', '-qm', 'base']).status === 0, 'disabled-diff test creates the base commit')
fs.writeFileSync(path.join(disabledDiffRepo, '.gitattributes'), '*.py -diff\n')
fs.writeFileSync(disabledDiffFile, 'MODEL = "o3-deep-research"\n')
const disabledDiffChanged = run(['check', disabledDiffRepo, '--days', '30', '--changed', 'HEAD', '--json'])
const disabledDiffChangedJson = JSON.parse(disabledDiffChanged.out)
assert(disabledDiffChanged.code === 1 && disabledDiffChangedJson.findings.some(finding => finding.file.endsWith('app.py')), '--changed forces scannable files to text despite a PR-controlled -diff attribute')
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

const statusOnlyDir = path.join(tempRoot, 'status-only-retired')
const statusOnlyFeeds = path.join(statusOnlyDir, 'feeds')
fs.mkdirSync(statusOnlyFeeds, { recursive: true })
fs.writeFileSync(path.join(statusOnlyDir, 'app.py'), 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "status-only-retired-model"\n')
fs.writeFileSync(path.join(statusOnlyFeeds, 'openai.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'openai',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/status-only-feed',
  models: [
    { id: 'status-only-retired-model', replacement: 'status-only-current-model', distributions: [{ via: 'custom-hub', status: 'retired' }] },
    { id: 'status-only-current-model', distributions: [{ via: 'custom-hub', status: 'active' }] },
  ],
}))
const statusOnlyInventoryRun = run(['inventory', statusOnlyDir, '--feeds', statusOnlyFeeds, '--via', 'custom-hub', '--json'])
const statusOnlyInventory = JSON.parse(statusOnlyInventoryRun.out)
const statusOnlyRef = statusOnlyInventory.model_references.find(item => item.id === 'status-only-retired-model')
assert(statusOnlyInventoryRun.code === 0 && statusOnlyRef?.status === 'retired' && statusOnlyRef.distribution_status === 'retired', 'status-only retired distribution is actionable on a feed-defined channel')
assert(statusOnlyRef?.shutdown === null && statusOnlyRef.days === null && statusOnlyRef.requested_via === 'custom-hub', 'status-only retirement reports an unavailable date without inventing one')
const statusOnlyHuman = run(['check', statusOnlyDir, '--feeds', statusOnlyFeeds, '--via', 'custom-hub'])
assert(statusOnlyHuman.code === 1 && statusOnlyHuman.out.includes('RETIRED (shutdown date unavailable)'), 'human check renders status-only retirement without invalid date arithmetic')
const statusOnlyPlan = JSON.parse(run(['plan', statusOnlyDir, '--feeds', statusOnlyFeeds, '--via', 'custom-hub']).out)
assert(statusOnlyPlan.items.length === 0 && statusOnlyPlan.issues.some(issue => issue.reason === 'shutdown-date-unavailable'), 'status-only retirement remains non-patchable until a shutdown date is known')

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
const optionsCheck = formatCheck({ findings: [{ ...earliestFinding, replacement: null, replacement_options: ['first-choice', 'second-choice'] }], bad: [earliestFinding], scannedFiles: 1, days: 30, scope: 'all' })
assert(optionsCheck.includes('options: first-choice | second-choice'), 'human check output renders replacement options compactly')
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

const duplicateDistributionFeeds = path.join(tempRoot, 'duplicate-distribution-feeds')
fs.mkdirSync(duplicateDistributionFeeds)
fs.writeFileSync(path.join(duplicateDistributionFeeds, 'duplicate-distribution.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'duplicate-distribution',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/duplicate-distribution',
  models: [{
    id: 'duplicate-distribution-model',
    distributions: [
      { via: 'aws-bedrock', shutdown: '2026-09-01' },
      { via: 'aws-bedrock', shutdown: '2027-09-01' },
    ],
  }],
}))
let duplicateDistributionLoadError = ''
try {
  loadFeeds(duplicateDistributionFeeds)
} catch (error) {
  duplicateDistributionLoadError = error.message
}
assert(duplicateDistributionLoadError.includes('duplicate distributor via "aws-bedrock"'), 'feed loading rejects duplicate lifecycle records for one distributor clock')

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

const fallbackPlanRun = run(['plan', path.join(root, 'test/fixture'), '--days', '90', '--via', 'vertex-ai'])
const fallbackPlan = JSON.parse(fallbackPlanRun.out)
assert(fallbackPlan.issues.some(issue => issue.file.endsWith('direct.py') && issue.reason === 'publisher-fallback'), 'publisher-fallback findings are not patchable')
const unknownViaRun = run(['plan', path.join(root, 'test/fixture'), '--via', 'missing-channel'])
assert(unknownViaRun.code === 2 && unknownViaRun.err.includes('unknown lifecycle channel "missing-channel"'), 'CLI rejects unknown lifecycle channels before scanning')

const gateDir = path.join(tempRoot, 'plan-gates')
const gateFeeds = path.join(gateDir, 'feeds')
fs.mkdirSync(gateFeeds, { recursive: true })
fs.writeFileSync(path.join(gateDir, 'direct.py'), 'from openai import OpenAI\nclient = OpenAI()\nmodel = "retired-without-replacement"\n')
fs.writeFileSync(path.join(gateFeeds, 'gate.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'openai',
  generated: '2026-08-01T00:00:00Z',
  source: 'https://example.invalid/feed',
  models: [{ id: 'retired-without-replacement', shutdown: '2026-07-01' }],
}))
const missingReplacementPlan = run(['plan', gateDir, '--feeds', gateFeeds, '--days', '90'])
const missingReplacementJson = JSON.parse(missingReplacementPlan.out)
assert(!missingReplacementJson.items.length && missingReplacementJson.issues.some(issue => issue.reason === 'no-replacement'), 'missing replacement is not patchable')
fs.writeFileSync(path.join(gateDir, 'options.py'), 'from openai import OpenAI\nclient = OpenAI()\nmodel = "retired-with-options"\n')
const gateFeedWithOptions = JSON.parse(fs.readFileSync(path.join(gateFeeds, 'gate.json'), 'utf8'))
gateFeedWithOptions.models.push({
  id: 'retired-with-options',
  shutdown: '2026-07-01',
  replacement_options: ['first-choice', 'second-choice'],
  replacement_note: 'verify the parameter profile',
})
fs.writeFileSync(path.join(gateFeeds, 'gate.json'), JSON.stringify(gateFeedWithOptions))
const choicePlanRun = run(['plan', gateDir, '--feeds', gateFeeds, '--days', '90'])
const choicePlan = JSON.parse(choicePlanRun.out)
const choiceIssue = choicePlan.issues.find(issue => issue.id === 'retired-with-options')
assert(choiceIssue?.reason === 'replacement-choice' && JSON.stringify(choiceIssue.replacement_options) === JSON.stringify(['first-choice', 'second-choice']) && choiceIssue.replacement_note === 'verify the parameter profile', 'plan emits replacement-choice issues with options and notes')
const choiceInventory = JSON.parse(run(['inventory', gateDir, '--feeds', gateFeeds, '--json']).out)
const choiceInventoryRef = choiceInventory.model_references.find(item => item.id === 'retired-with-options')
assert(JSON.stringify(choiceInventoryRef?.replacement_options) === JSON.stringify(['first-choice', 'second-choice']) && choiceInventoryRef?.replacement_note === 'verify the parameter profile', 'inventory preserves structured replacement options and notes')
const choiceSchedule = JSON.parse(run(['schedule', gateDir, '--feeds', gateFeeds, '--json']).out)
const choiceScheduleRef = choiceSchedule.items.find(item => item.id === 'retired-with-options')
assert(JSON.stringify(choiceScheduleRef?.replacement_options) === JSON.stringify(['first-choice', 'second-choice']) && choiceScheduleRef?.replacement_note === 'verify the parameter profile', 'schedule preserves structured replacement options and notes')
const choiceAlert = JSON.parse(run(['alert', gateDir, '--feeds', gateFeeds, '--json']).out)
const choiceAlertRef = choiceAlert.errors.find(item => item.id === 'retired-with-options')
assert(JSON.stringify(choiceAlertRef?.replacement_options) === JSON.stringify(['first-choice', 'second-choice']) && choiceAlertRef?.replacement_note === 'verify the parameter profile', 'alert preserves structured replacement options and notes')
const choiceCycloneDx = JSON.parse(run(['inventory', gateDir, '--feeds', gateFeeds, '--format', 'cyclonedx']).out)
const choiceCycloneDxComponent = choiceCycloneDx.components.find(item => item.name === 'retired-with-options')
assert(property(choiceCycloneDxComponent, 'model-eol:replacement_options') === JSON.stringify(['first-choice', 'second-choice']), 'CycloneDX preserves ordered replacement options as JSON')
assert(property(choiceCycloneDxComponent, 'model-eol:replacement_note') === 'verify the parameter profile', 'CycloneDX preserves replacement guidance notes')

const ar6Dir = path.join(tempRoot, 'ar6-proximity')
const ar6Feeds = path.join(tempRoot, 'ar6-feeds')
fs.mkdirSync(ar6Dir)
fs.mkdirSync(ar6Feeds)
fs.writeFileSync(path.join(ar6Dir, 'cloud-mixed.ts'), 'import OpenAI from "openai";\nconst model = "ar6-cloud-mixed";\n\n\nconst azureDeployment = new AzureOpenAI({ deployment: "chat-prod" });\n')
fs.writeFileSync(path.join(ar6Dir, 'direct-call.py'), 'from openai import OpenAI\nclient = OpenAI()\nclient.chat.completions.create(model="ar6-direct-call")\n')
fs.writeFileSync(path.join(ar6Dir, 'gateway.py'), 'OPENROUTER_API_KEY = "test-key"\nMODEL = "ar6-gateway"\n')
fs.writeFileSync(path.join(ar6Feeds, 'ar6.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'openai',
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
  scan_notes: [],
  items: Array.isArray(item) ? item : [item],
  issues: [],
}))
fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan(applyItem)
const applied = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(applied.code === 0 && fs.readFileSync(applyFile, 'utf8') === `${newLine}\n`, 'apply rewrites the fixture')
const rerun = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(rerun.code === 0 && rerun.out.includes('already-applied'), 'apply is idempotent')

const sharedOldLine = 'FIRST = "old-one"; SECOND = "old-two"'
const sharedNewLine = 'FIRST = "new-one"; SECOND = "new-two"'
const sharedItems = [
  { ...applyItem, matched: 'old-one', replacement: 'new-one', expected_line_sha256: hash(sharedOldLine) },
  { ...applyItem, matched: 'old-two', replacement: 'new-two', expected_line_sha256: hash(sharedOldLine) },
]
fs.writeFileSync(applyFile, `${sharedOldLine}\n`)
writeApplyPlan(sharedItems)
const sharedApplied = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(sharedApplied.code === 0 && fs.readFileSync(applyFile, 'utf8') === `${sharedNewLine}\n` && (sharedApplied.out.match(/applied /g) ?? []).length === 2, 'apply groups multiple replacements on one line')
const sharedRerun = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(sharedRerun.code === 0 && sharedRerun.err === '' && (sharedRerun.out.match(/already-applied /g) ?? []).length === 2 && !sharedRerun.out.includes('failed'), 'grouped apply is idempotent for every item')

const overlappingLine = 'abc'
const overlappingItems = [
  { ...applyItem, matched: 'abc', replacement: 'first', expected_line_sha256: hash(overlappingLine) },
  { ...applyItem, matched: 'bc', replacement: 'second', expected_line_sha256: hash(overlappingLine) },
]
fs.writeFileSync(applyFile, `${overlappingLine}\n`)
writeApplyPlan(overlappingItems)
const overlappingApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  overlappingApply.code === 1 &&
    overlappingApply.err.includes('replacement span overlaps another plan item') &&
    fs.readFileSync(applyFile, 'utf8') === `${overlappingLine}\n`,
  'overlapping same-line replacement spans refuse the whole plan without losing an item',
)

const mixedLine = 'FIRST = "new-one"; SECOND = "old-two"'
fs.writeFileSync(applyFile, `${mixedLine}\n`)
writeApplyPlan(sharedItems)
const mixedApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(mixedApply.code === 1 && (mixedApply.err.match(/line hash does not match expected_line_sha256/g) ?? []).length === 2 && fs.readFileSync(applyFile, 'utf8') === `${mixedLine}\n`, 'mixed grouped apply fails every item without half-applying')

fs.writeFileSync(applyFile, `${sharedOldLine}\n`)
writeApplyPlan(sharedItems)
const atomicApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
const temporaryApplyFiles = fs.readdirSync(applyDir).filter(name => name.startsWith('.model-eol-'))
assert(atomicApply.code === 0 && fs.readFileSync(applyFile, 'utf8') === `${sharedNewLine}\n`, 'atomic apply writes the complete final content')
assert(temporaryApplyFiles.length === 0, 'atomic apply leaves no temporary file')

const transactionFileA = path.join(applyDir, 'transaction-a.py')
const transactionFileB = path.join(applyDir, 'transaction-b.py')
const transactionOldA = 'MODEL = "old-a"'
const transactionOldB = 'MODEL = "old-b"'
const transactionNewA = 'MODEL = "new-a"'
const transactionNewB = 'MODEL = "new-b"'
const transactionItemA = {
  ...applyItem,
  file: transactionFileA,
  matched: 'old-a',
  replacement: 'new-a',
  expected_line_sha256: hash(transactionOldA),
}
const transactionItemB = {
  ...applyItem,
  file: transactionFileB,
  matched: 'old-b',
  replacement: 'new-b',
  expected_line_sha256: hash(transactionOldB),
}
const mismatchedTransactionItemB = {
  ...transactionItemB,
  expected_line_sha256: hash('MODEL = "not-old-b"'),
}
for (const [label, items] of [
  ['good-then-bad', [transactionItemA, mismatchedTransactionItemB]],
  ['bad-then-good', [mismatchedTransactionItemB, transactionItemA]],
]) {
  fs.writeFileSync(transactionFileA, `${transactionOldA}\n`)
  fs.writeFileSync(transactionFileB, `${transactionOldB}\n`)
  writeApplyPlan(items)
  const result = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
  assert(
    result.code === 1 &&
      fs.readFileSync(transactionFileA, 'utf8') === `${transactionOldA}\n` &&
      fs.readFileSync(transactionFileB, 'utf8') === `${transactionOldB}\n`,
    `plan-wide preflight writes neither file for ${label}`,
  )
}

fs.writeFileSync(transactionFileA, `${transactionOldA}\n`)
writeApplyPlan([{ ...transactionItemB, file: '../escape.py' }, transactionItemA])
const badPathTransaction = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  badPathTransaction.code === 1 && fs.readFileSync(transactionFileA, 'utf8') === `${transactionOldA}\n`,
  'a bad plan path prevents a valid file from being written',
)

fs.writeFileSync(transactionFileA, `${transactionOldA}\n`)
fs.writeFileSync(transactionFileB, `${transactionOldB}\n`)
writeApplyPlan([transactionItemA, transactionItemB])
const twoFileApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  twoFileApply.code === 0 &&
    fs.readFileSync(transactionFileA, 'utf8') === `${transactionNewA}\n` &&
    fs.readFileSync(transactionFileB, 'utf8') === `${transactionNewB}\n` &&
    (twoFileApply.out.match(/applied /g) ?? []).length === 2,
  'a valid two-file plan commits both staged outputs',
)
const twoFileRerun = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  twoFileRerun.code === 0 &&
    (twoFileRerun.out.match(/already-applied /g) ?? []).length === 2 &&
    fs.readFileSync(transactionFileA, 'utf8') === `${transactionNewA}\n` &&
    fs.readFileSync(transactionFileB, 'utf8') === `${transactionNewB}\n`,
  'a committed two-file plan is idempotent',
)

fs.writeFileSync(transactionFileA, `${transactionOldA}\n`)
fs.writeFileSync(transactionFileB, `${transactionOldB}\n`)
writeApplyPlan([transactionItemA, transactionItemB])
let injectedCommitCount = 0
const rollbackResult = applyPlan({
  planPath: applyPlanFile,
  rootDir: applyDir,
  _test: {
    renameSync: (source, target, context) => {
      if (context.phase === 'commit') {
        injectedCommitCount++
        if (injectedCommitCount === 2) throw new Error('injected second commit failure')
      }
      fs.renameSync(source, target)
    },
  },
})
const rollbackTemporaryFiles = fs.readdirSync(applyDir).filter(name => name.startsWith('.model-eol-'))
assert(
  rollbackResult.failed > 0 &&
    injectedCommitCount === 2 &&
    fs.readFileSync(transactionFileA, 'utf8') === `${transactionOldA}\n` &&
    fs.readFileSync(transactionFileB, 'utf8') === `${transactionOldB}\n` &&
    rollbackTemporaryFiles.length === 0,
  'a later commit rename failure rolls back earlier file commits and cleans its stages',
)

fs.writeFileSync(transactionFileA, `${transactionOldA}\n`)
writeApplyPlan(transactionItemA)
const cleanupErrors = []
const originalConsoleError = console.error
let cleanupResult
try {
  console.error = (...values) => cleanupErrors.push(values.join(' '))
  cleanupResult = applyPlan({
    planPath: applyPlanFile,
    rootDir: applyDir,
    _test: {
      unlinkSync: temporaryFile => {
        if (temporaryFile.includes('-backup-')) throw new Error('injected cleanup failure')
        fs.unlinkSync(temporaryFile)
      },
    },
  })
} finally {
  console.error = originalConsoleError
}
const retainedCleanupFiles = fs.readdirSync(applyDir).filter(name => name.startsWith('.model-eol-'))
assert(
  cleanupResult.failed > 0 &&
    cleanupResult.applied === 1 &&
    fs.readFileSync(transactionFileA, 'utf8') === `${transactionNewA}\n` &&
    retainedCleanupFiles.length === 1 &&
    cleanupErrors.some(message => message.includes('apply cleanup failed') && message.includes('injected cleanup failure')),
  'a committed apply with an unlink failure reports non-success and names its retained temporary backup',
)
for (const temporaryFile of retainedCleanupFiles) fs.unlinkSync(path.join(applyDir, temporaryFile))

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

const invalidUtf8 = Buffer.concat([Buffer.from(`${oldLine}\n`), Buffer.from([0xff, 0x0a])])
fs.writeFileSync(applyFile, invalidUtf8)
writeApplyPlan(applyItem)
const invalidUtf8Apply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  invalidUtf8Apply.code === 1 &&
    invalidUtf8Apply.err.includes('target is not valid UTF-8') &&
    fs.readFileSync(applyFile).equals(invalidUtf8),
  'apply refuses invalid UTF-8 without re-encoding unrelated bytes',
)

fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan({ ...applyItem, replacement: applyItem.matched })
const noOpApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  noOpApply.code === 2 &&
    noOpApply.err.includes('replacement must differ from matched') &&
    fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`,
  'apply rejects a semantic no-op plan instead of reporting it applied forever',
)

writeApplyPlan(applyItem)
const invalidUtf8Plan = fs.readFileSync(applyPlanFile)
const publisherMarker = invalidUtf8Plan.indexOf(Buffer.from('"publisher":"test"'))
assert(publisherMarker >= 0, 'apply fixture contains its publisher marker')
invalidUtf8Plan[publisherMarker + Buffer.byteLength('"publisher":"te')] = 0xff
fs.writeFileSync(applyPlanFile, invalidUtf8Plan)
const invalidUtf8PlanApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  invalidUtf8PlanApply.code === 2 &&
    invalidUtf8PlanApply.err.includes('invalid UTF-8') &&
    fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`,
  'apply rejects an invalid UTF-8 plan before file use',
)

writeApplyPlan(applyItem)
const invalidSchemaPlan = JSON.parse(fs.readFileSync(applyPlanFile, 'utf8'))
invalidSchemaPlan.plan_schema = 'model-eol.plan/9.9'
fs.writeFileSync(applyPlanFile, JSON.stringify(invalidSchemaPlan))
const invalidSchemaApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(invalidSchemaApply.code === 2 && invalidSchemaApply.err.includes('plan_schema'), 'apply refuses an unsupported plan_schema before file use')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'plan schema refusal writes nothing')

writeApplyPlan(applyItem)
const incompleteDocumentPlan = JSON.parse(fs.readFileSync(applyPlanFile, 'utf8'))
delete incompleteDocumentPlan.scan_notes
fs.writeFileSync(applyPlanFile, JSON.stringify(incompleteDocumentPlan))
const incompleteDocumentApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(incompleteDocumentApply.code === 2 && incompleteDocumentApply.err.includes('scan_notes'), 'apply validates the full plan document against the public schema')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'full-document schema refusal writes nothing')

fs.writeFileSync(applyFile, `${oldLine}\n`)
writeApplyPlan([applyItem, { ...applyItem, line: 0 }])
const malformedPlan = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(malformedPlan.code === 2 && malformedPlan.err.includes('plan item 1 line'), 'malformed plan items refuse the whole plan before file use')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'malformed plan does not partially apply valid items')

writeApplyPlan({ ...applyItem, file: '../escape.py' })
const escapedPlan = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(escapedPlan.code === 1 && escapedPlan.err.includes('file path contains .. traversal'), 'apply refuses plan paths that escape rootDir')
assert(fs.readFileSync(applyFile, 'utf8') === `${oldLine}\n`, 'escaped plan does not write the in-root file')

const applySymlinkTarget = path.join(applyDir, 'apply-symlink-target.py')
const applyFinalSymlink = path.join(applyDir, 'apply-final-link.py')
fs.writeFileSync(applySymlinkTarget, `${oldLine}\n`)
fs.symlinkSync(applySymlinkTarget, applyFinalSymlink)
writeApplyPlan({ ...applyItem, file: applyFinalSymlink })
const finalSymlinkApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  finalSymlinkApply.code === 1 &&
    finalSymlinkApply.err.includes('symlink') &&
    fs.lstatSync(applyFinalSymlink).isSymbolicLink() &&
    fs.readFileSync(applySymlinkTarget, 'utf8') === `${oldLine}\n`,
  'apply rejects a final symlink without replacing the link or changing its target',
)

const applyParentTarget = path.join(applyDir, 'apply-parent-target')
const applyParentSymlink = path.join(applyDir, 'apply-parent-link')
const applyParentTargetFile = path.join(applyParentTarget, 'fixture.py')
fs.mkdirSync(applyParentTarget)
fs.writeFileSync(applyParentTargetFile, `${oldLine}\n`)
fs.symlinkSync(applyParentTarget, applyParentSymlink)
writeApplyPlan({ ...applyItem, file: path.join(applyParentSymlink, 'fixture.py') })
const parentSymlinkApply = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(
  parentSymlinkApply.code === 1 &&
    parentSymlinkApply.err.includes('symlink') &&
    fs.lstatSync(applyParentSymlink).isSymbolicLink() &&
    fs.readFileSync(applyParentTargetFile, 'utf8') === `${oldLine}\n`,
  'apply rejects a symlinked parent without replacing the link or changing its target',
)

const manyRestoreOriginal = Array.from({ length: 17 }, (_, index) => `old-${index}`).join(' ')
const manyRestorePost = Array.from({ length: 17 }, (_, index) => `new-${index}`).join(' ')
const manyRestoreItems = Array.from({ length: 17 }, (_, index) => ({
  ...applyItem,
  matched: `old-${index}`,
  replacement: `new-${index}`,
  expected_line_sha256: hash(manyRestoreOriginal),
}))
fs.writeFileSync(applyFile, `${manyRestorePost}\n`)
writeApplyPlan(manyRestoreItems)
const manyRestore = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
assert(manyRestore.code === 1 && (manyRestore.err.match(/line hash does not match expected_line_sha256/g) ?? []).length === 17, 'restore groups over sixteen items fail as bounded hash mismatches')
assert(fs.readFileSync(applyFile, 'utf8') === `${manyRestorePost}\n`, 'oversized restore groups do not write')

const boundedRestoreOriginal = Array.from({ length: 16 }, (_, index) => `old-${15 - index}`).join(' ')
const boundedRestorePost = Array.from({ length: 16 }, () => 'new').join(' ')
const boundedRestoreItems = Array.from({ length: 16 }, (_, index) => ({
  ...applyItem,
  matched: `old-${index}`,
  replacement: 'new',
  expected_line_sha256: hash(boundedRestoreOriginal),
}))
fs.writeFileSync(applyFile, `${boundedRestorePost}\n`)
writeApplyPlan(boundedRestoreItems)
const restoreStarted = Date.now()
const boundedRestore = run(['apply', '--plan', applyPlanFile], { cwd: applyDir })
const restoreElapsed = Date.now() - restoreStarted
assert(boundedRestore.code === 1 && restoreElapsed < 5000 && (boundedRestore.err.match(/line hash does not match expected_line_sha256/g) ?? []).length === 16, 'restore search stops at its visited-state cap')
assert(fs.readFileSync(applyFile, 'utf8') === `${boundedRestorePost}\n`, 'visited-state cap leaves the post-image unchanged')

for (const schemaFile of [
  'schema/model-eol.schema.json',
  'schema/model-eol.bot-config.schema.json',
  'schema/model-eol.check.schema.json',
  'schema/model-eol.inventory.schema.json',
  'schema/model-eol.schedule.schema.json',
  'schema/model-eol.alert.schema.json',
  'schema/model-eol.plan.schema.json',
]) {
  JSON.parse(fs.readFileSync(path.join(root, schemaFile), 'utf8'))
  assert(true, `${schemaFile} parses as JSON`)
}

const inventorySchema = JSON.parse(fs.readFileSync(path.join(root, 'schema/model-eol.inventory.schema.json'), 'utf8'))
const inventoryReferenceKeys = new Set(Object.keys(inventorySchema.definitions.modelReference.properties))
assert(bedrockRef && Object.keys(bedrockRef).every(key => inventoryReferenceKeys.has(key)), 'inventory schema recognizes every emitted routed-reference field')
assert(inventorySchema.definitions.modelReference.additionalProperties === false && inventorySchema.definitions.candidateReference.additionalProperties === false && inventorySchema.definitions.integrationHint.additionalProperties === false, 'inventory schema makes every emitted nested reference shape strict')
assert(Array.isArray(bedrockRef?.policy_provenance?.override_indexes) && Number.isInteger(bedrockRef?.policy_provenance?.route_index), 'emitted inventory policy provenance has the schema-defined shape')
const planSchema = JSON.parse(fs.readFileSync(path.join(root, 'schema/model-eol.plan.schema.json'), 'utf8'))
const routedPlanIssue = mixedPlan.issues.find(item => item.mapped_from === 'bedrock-prod')
assert(routedPlanIssue && Object.keys(routedPlanIssue).every(key => Object.hasOwn(planSchema.definitions.issue.properties, key)), 'plan schema recognizes every emitted routed-issue field')
assert(Object.hasOwn(planSchema.definitions.item.properties, 'policy_provenance') && Object.hasOwn(planSchema.definitions.item.properties, 'threshold_days'), 'plan schema exposes optional effective policy fields for patch items')

fs.rmSync(tempRoot, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)` : '\nall assertions passed')
process.exit(failures ? 1 : 0)
