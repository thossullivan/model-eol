#!/usr/bin/env node
// Smoke test for the reference checker. Time-stable assertions only:
// o3-deep-research's shutdown (2026-07-23) is in the past forever, and
// claude-opus-4-1's (2026-08-05) is either retiring or retired - both flag.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const run = args => {
  try {
    return { out: execFileSync('node', [path.join(root, 'check.mjs'), ...args], { encoding: 'utf8' }), code: 0 }
  } catch (e) {
    return { out: e.stdout ?? '', code: e.status }
  }
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

console.log(failures ? `\n${failures} failure(s)` : '\nall assertions passed')
process.exit(failures ? 1 : 0)
