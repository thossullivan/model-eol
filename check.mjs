#!/usr/bin/env node
// model-eol reference CLI - zero dependencies.
//
// Default mode preserves the original CI gate:
//   node check.mjs [paths...] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs]
//
// New inventory modes:
//   node check.mjs inventory [paths...] [--json]
//   node check.mjs schedule [paths...] [--days N] [--json]
//
// exit codes: 0 = clear · 1 = retired or retiring within threshold · 2 = usage error

import path from 'node:path'

import { findingFromRef, isBad, loadFeeds } from './lib/feeds.mjs'
import { buildInventory, buildSchedule, formatCheck, formatInventory, formatSchedule } from './lib/reports.mjs'
import { scanTargets } from './lib/scanner.mjs'

const COMMANDS = new Set(['check', 'inventory', 'schedule', 'help'])
const args = process.argv.slice(2)

if (args[0] === '--help' || args[0] === '-h') args[0] = 'help'
const command = COMMANDS.has(args[0]) ? args.shift() : 'check'

const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const has = name => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return false
  args.splice(i, 1)
  return true
}

const DAYS = Number(flag('days', '90'))
const FEEDS_DIR = flag('feeds', path.join(import.meta.dirname, 'feeds'))
const VIA = flag('via', null) // e.g. azure-ai-foundry, aws-bedrock
const SCOPE = flag('scope', 'all')
const AS_JSON = has('json')
const INCLUDE_DOCS = has('include-docs')
const targets = args.length ? args : ['.']

if (command === 'help') {
  console.log(`model-eol

Usage:
  node check.mjs [paths...] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs]
  node check.mjs check [paths...] [--days N] [--scope all|direct] [--json]
  node check.mjs inventory [paths...] [--json]
  node check.mjs schedule [paths...] [--days N] [--json]

Commands:
  check       Fail when tracked model IDs are retired or retiring within --days.
  inventory   List tracked model references plus direct/cloud/gateway integration hints.
  schedule    Show the retirement schedule for tracked references in the target.

Scopes:
  all        Check every tracked model ID found. This preserves the original behavior.
  direct     Check direct API and generic model references; leave cloud/gateway refs in inventory.
`)
  process.exit(0)
}

if (Number.isNaN(DAYS)) {
  console.error('--days must be a number')
  process.exit(2)
}
if (!['all', 'direct'].includes(SCOPE)) {
  console.error('--scope must be all or direct')
  process.exit(2)
}

let feedData
try {
  feedData = loadFeeds(FEEDS_DIR)
} catch (e) {
  console.error(`failed to load feeds from ${FEEDS_DIR}: ${e.message}`)
  process.exit(2)
}
if (feedData.entries.size === 0) {
  console.error(`no feed entries loaded from ${FEEDS_DIR}`)
  process.exit(2)
}

let scan
try {
  scan = scanTargets({
    targets,
    entries: feedData.entries,
    keys: feedData.keys,
    includeDocs: INCLUDE_DOCS,
  })
} catch (e) {
  console.error(`scan failed: ${e.message}`)
  process.exit(2)
}

const findings = scan.modelRefs.map(ref => findingFromRef(ref, { days: DAYS, via: VIA }))
const checkFindings = SCOPE === 'direct'
  ? findings.filter(f => f.usage === 'direct-api' || f.usage === 'model-reference')
  : findings
const bad = checkFindings.filter(isBad)
const inventory = () => buildInventory({ scan, findings, days: DAYS, via: VIA, scope: SCOPE, targets })
const schedule = () => buildSchedule(inventory())

if (command === 'check') {
  if (AS_JSON) {
    console.log(JSON.stringify({ threshold_days: DAYS, distributor: VIA, scope: SCOPE, findings: checkFindings }, null, 2))
  } else {
    console.log(formatCheck({ findings: checkFindings, bad, scannedFiles: scan.files.length, days: DAYS, scope: SCOPE }))
  }
  process.exit(bad.length ? 1 : 0)
}

if (command === 'inventory') {
  const inv = inventory()
  if (AS_JSON) {
    console.log(JSON.stringify(inv, null, 2))
  } else {
    console.log(formatInventory(inv, DAYS))
  }
  process.exit(0)
}

if (command === 'schedule') {
  const sched = schedule()
  if (AS_JSON) {
    console.log(JSON.stringify(sched, null, 2))
  } else {
    console.log(formatSchedule(sched, DAYS))
  }
  process.exit(0)
}

console.error(`unknown command: ${command}`)
process.exit(2)
