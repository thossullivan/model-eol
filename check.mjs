#!/usr/bin/env node
// model-eol reference CLI - zero dependencies.
//
// Default mode preserves the original CI gate:
//   node check.mjs [paths...] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs]
//
// New inventory modes:
//   node check.mjs inventory [paths...] [--json|--format json|cyclonedx|text]
//   node check.mjs schedule [paths...] [--days N] [--json]
//   node check.mjs alert [paths...] [--format github|markdown|badge] [--json]
//   node check.mjs plan [paths...] [--days N] [--scope all|direct] [--via DISTRIBUTOR] [--feeds DIR]
//   node check.mjs apply --plan plan.json [--dry-run]
//
// exit codes: check/alert 0 = clear, 1 = finding, 2 = usage error;
// apply 0 = all items applied, 1 = item refused, 2 = usage or plan error.

import path from 'node:path'

import { applyPlan } from './lib/apply.mjs'
import { findingFromRef, isBad, loadFeeds } from './lib/feeds.mjs'
import { buildPlan } from './lib/plan.mjs'
import {
  buildAlert,
  buildInventory,
  buildSchedule,
  formatAlertGithub,
  formatAlertBadge,
  formatAlertMarkdown,
  formatCheck,
  formatInventory,
  formatInventoryCycloneDX,
  formatSchedule,
} from './lib/reports.mjs'
import { addedLinesForTargets, filterFindingsToChanged, scanTargets } from './lib/scanner.mjs'

const COMMANDS = new Set(['check', 'inventory', 'schedule', 'alert', 'plan', 'apply', 'help'])
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
const FORMAT = flag('format', null)
const PLAN_FILE = flag('plan', null)
const AS_JSON = has('json')
const INCLUDE_DOCS = has('include-docs')
const DRY_RUN = has('dry-run')
const CHANGED_BASE = flag('changed', null)
const targets = args.length ? args : ['.']

if (command === 'help') {
  console.log(`model-eol

Usage:
  node check.mjs [paths...] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs]
  node check.mjs check [paths...] [--days N] [--scope all|direct] [--json] [--changed BASE_REF]
  node check.mjs inventory [paths...] [--json] [--format json|cyclonedx|text]
  node check.mjs schedule [paths...] [--days N] [--json]
  node check.mjs alert [paths...] [--days N] [--scope all|direct] [--format github|markdown|badge] [--json]
  node check.mjs plan [paths...] [--days N] [--scope all|direct] [--via DISTRIBUTOR] [--feeds DIR]
  node check.mjs apply --plan plan.json [--dry-run]

Commands:
  check       Fail when tracked model IDs are retired or retiring within --days.
              With --changed BASE_REF, answer the PR CI question: "this PR ADDS a
              dependency on a model that already has a death date".
  inventory   List tracked model references plus direct/cloud/gateway integration hints.
              --format json is the machine-readable default; --format cyclonedx emits a CycloneDX 1.6 ML-BOM.
  schedule    Show the retirement schedule for tracked references in the target.
  alert       Emit GitHub Actions annotations, Markdown, or a Shields badge JSON and fail on errors.
  plan        Emit a JSON migration plan with only safely patchable direct API references.
  apply       Apply a plan with line-hash and occurrence checks; use --dry-run to preview.

Scopes:
  all        Check every tracked model ID found. This preserves the original behavior.
  direct     Check direct API and generic model references; leave cloud/gateway refs in inventory.
`)
  process.exit(0)
}

if (command === 'apply') {
  if (!PLAN_FILE || args.length) {
    console.error('apply requires --plan plan.json and accepts no target paths')
    process.exit(2)
  }
  try {
    const result = applyPlan({ planPath: PLAN_FILE, dryRun: DRY_RUN })
    process.exit(result.failed ? 1 : 0)
  } catch (e) {
    console.error(`failed to apply plan ${PLAN_FILE}: ${e.message}`)
    process.exit(2)
  }
}

if (Number.isNaN(DAYS)) {
  console.error('--days must be a number')
  process.exit(2)
}
if (!['all', 'direct'].includes(SCOPE)) {
  console.error('--scope must be all or direct')
  process.exit(2)
}
if (CHANGED_BASE !== null && command !== 'check') {
  console.error('--changed is only supported by the check command')
  process.exit(2)
}
if (command === 'alert' && FORMAT !== null && !['github', 'markdown', 'badge', 'json'].includes(FORMAT)) {
  console.error('--format must be github, markdown, badge, or json for alert')
  process.exit(2)
}
if (command === 'inventory' && FORMAT !== null && !['json', 'cyclonedx', 'text'].includes(FORMAT)) {
  console.error('--format must be json, cyclonedx, or text for inventory')
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
const changedFindings = CHANGED_BASE === null
  ? checkFindings
  : (() => {
      try {
        return filterFindingsToChanged(checkFindings, addedLinesForTargets(targets, CHANGED_BASE))
      } catch (e) {
        console.error(`--changed failed: ${e.message}`)
        process.exit(2)
      }
    })()
const bad = changedFindings.filter(isBad)
const inventory = () => buildInventory({ scan, findings, days: DAYS, via: VIA, scope: SCOPE, targets })
const schedule = () => buildSchedule(inventory())
const alert = () => buildAlert(schedule())

if (command === 'plan') {
  console.log(JSON.stringify(buildPlan({
    scan,
    findings,
    entries: feedData.entries,
    days: DAYS,
    via: VIA,
    scope: SCOPE,
  }), null, 2))
  process.exit(0)
}

if (command === 'check') {
  if (AS_JSON) {
    console.log(JSON.stringify({ threshold_days: DAYS, distributor: VIA, scope: SCOPE, findings: changedFindings }, null, 2))
  } else {
    console.log(formatCheck({ findings: changedFindings, bad, scannedFiles: scan.files.length, days: DAYS, scope: SCOPE }))
  }
  process.exit(bad.length ? 1 : 0)
}

if (command === 'inventory') {
  const inv = inventory()
  const inventoryFormat = FORMAT ?? 'json'
  if (inventoryFormat === 'cyclonedx') {
    console.log(JSON.stringify(formatInventoryCycloneDX(inv), null, 2))
  } else if (AS_JSON || inventoryFormat === 'json') {
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

if (command === 'alert') {
  const payload = alert()
  if (AS_JSON || FORMAT === 'json') {
    console.log(JSON.stringify(payload, null, 2))
  } else if (FORMAT === 'badge') {
    console.log(JSON.stringify(formatAlertBadge(payload), null, 2))
  } else if (FORMAT === 'markdown') {
    console.log(formatAlertMarkdown(payload, DAYS))
  } else {
    console.log(formatAlertGithub(payload, DAYS))
  }
  process.exit(payload.errors.length ? 1 : 0)
}

console.error(`unknown command: ${command}`)
process.exit(2)
