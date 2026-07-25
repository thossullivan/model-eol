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

// Distributor clock: on Azure, o3-deep-research is scheduled (Dec 2026), not retired,
// until that date passes; assert it is never MORE severe than the publisher clock.
const b = run([path.join(root, 'test/fixture'), '--days', '30', '--via', 'azure-ai-foundry', '--json'])
const bj = JSON.parse(b.out)
const azure = bj.findings.find(f => f.id === 'o3-deep-research-2025-06-26')
assert(azure?.via === 'azure-ai-foundry', 'azure distribution clock applied')
assert(azure?.shutdown === '2026-12-26', 'azure shutdown date used')

console.log(failures ? `\n${failures} failure(s)` : '\nall assertions passed')
process.exit(failures ? 1 : 0)
