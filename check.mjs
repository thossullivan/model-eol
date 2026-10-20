#!/usr/bin/env node
// model-eol reference CLI - zero dependencies.
//
// Default mode preserves the original CI gate:
//   node check.mjs [paths...] [--config FILE] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs] [--allow-incomplete]
//
// New inventory modes:
//   node check.mjs inventory [paths...] [--json|--format json|cyclonedx|text]
//   node check.mjs schedule [paths...] [--days N] [--json]
//   node check.mjs alert [paths...] [--format github|markdown|badge] [--json]
//   node check.mjs plan [paths...] [--days N] [--scope all|direct] [--via DISTRIBUTOR] [--feeds DIR]
//   node check.mjs apply --plan plan.json [--dry-run]
//   node check.mjs validate document.json [...] [--type feed|config|check|inventory|schedule|alert|plan|eval|feed-refresh-receipt|npm-release-result|verification]
//   node check.mjs verify RECEIPT [inputs] [--require-all] [--json]
//
// exit codes: check/alert 0 = clear, 1 = finding, 2 = usage error;
// apply 0 = all items applied, 1 = item refused, 2 = usage or plan error;
// validate 0 = every document valid, 2 = usage, parse, schema, or semantic error;
// verify 0 = verified or partial, 1 = mismatch (or partial with --require-all), 2 = usage, read, structural, or schema error.

import fs from 'node:fs'
import path from 'node:path'

import { applyPlan } from './lib/apply.mjs'
import { parseCliArgs } from './lib/cli.mjs'
import {
  CLI_DEFAULT_CONFIG,
  DEFAULT_CONFIG,
  configForRepoPath,
  configuredVias,
  loadConfig,
  mappedRoutesForRepoPath,
  normalizeConfig,
  routeForRepoReference,
} from './lib/config.mjs'
import { BUILTIN_CHANNELS, findingFromRef, isBad, loadFeeds } from './lib/feeds.mjs'
import { normalizeRepoPath } from './lib/glob.mjs'
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
import { BaseUnavailableError, inCheckScope, selectChangedFindings } from './lib/changed.mjs'
import { gitRootFor, incompleteScanNotes, scanTargets } from './lib/scanner.mjs'
import { DOCUMENT_TYPES, formatDocumentErrors, validateDocumentFile } from './lib/validate-document.mjs'
import { SUPPORTED_RECEIPT_SCHEMAS, VERIFY_INPUTS, VerifyError, formatVerification, printable, verifyReceipt } from './lib/verify.mjs'

const rootForTarget = target => {
  const absolute = path.resolve(target)
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch {
    return null
  }
  let resolved = absolute
  try {
    resolved = fs.realpathSync(absolute)
  } catch {
  }
  try {
    const gitRoot = gitRootFor(resolved)
    if (gitRoot) return gitRoot
  } catch {
  }
  return stat.isDirectory() ? resolved : path.dirname(resolved)
}

const configForTargets = ({ targets, explicit }) => {
  const roots = [...new Set(targets.map(rootForTarget).filter(Boolean))]
  if (explicit !== null) {
    if (!explicit) throw new Error('--config must be a non-empty path')
    return { file: path.resolve(explicit), roots }
  }

  const files = [...new Set(roots
    .map(root => path.join(root, '.model-eol.json'))
    .filter(file => fs.existsSync(file)))]
  if (files.length > 1) {
    throw new Error(`multiple .model-eol.json files found (${files.join(', ')}); use --config FILE to choose one`)
  }
  return { file: files[0] ?? null, roots }
}

const repoPathForFile = (file, roots) => {
  const absolute = path.resolve(file)
  const candidates = roots
    .map(root => ({ root, relative: path.relative(root, absolute) }))
    .filter(({ relative }) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    .sort((a, b) => b.root.length - a.root.length)
  return normalizeRepoPath(candidates[0]?.relative ?? absolute)
}

const policyError = (config, feedData, via) => {
  const allowedVias = new Set([...BUILTIN_CHANNELS, ...feedData.vias])
  const unknownVia = [via, ...configuredVias(config)]
    .find(value => value && !allowedVias.has(value))
  if (unknownVia) return `unknown lifecycle channel "${unknownVia}"; known values: ${[...allowedVias].sort().join(', ')}`
  const unresolvedRoute = config.routes.find(route => route.model && !feedData.entries.has(route.model))
  if (unresolvedRoute) return `configured route model "${unresolvedRoute.model}" is not present in loaded feeds`
  return null
}

const evaluateTargets = ({ targets, config, roots, ignoredFiles, feedData, overrides, includeDocs, noGit = false, classificationPathFor = null }) => {
  const policyCache = new Map()
  const policyForFile = file => {
    const absolute = path.resolve(file)
    if (!policyCache.has(absolute)) {
      const repoPath = repoPathForFile(absolute, roots)
      policyCache.set(absolute, { ...configForRepoPath(config, repoPath), repoPath })
    }
    return policyCache.get(absolute)
  }
  const routeForReference = ({ file, matched, id }) => {
    const policy = policyForFile(file)
    return routeForRepoReference(config, policy.repoPath, { matched, id })
  }
  const mappedRoutesForFile = file => {
    const policy = policyForFile(file)
    return mappedRoutesForRepoPath(config, policy.repoPath)
  }

  const scan = scanTargets({
    targets,
    entries: feedData.entries,
    keys: feedData.keys,
    includeDocs,
    ignoreRoots: roots,
    ignoredFiles,
    policyForFile,
    routeForReference,
    mappedRoutesForFile,
    noGit,
    classificationPathFor,
  })

  const findings = scan.modelRefs.map(ref => {
    const policy = policyForFile(ref.file)
    const route = routeForReference({ file: ref.file, matched: ref.matched, id: ref.id })
    const days = overrides.days ?? policy.days
    const scope = overrides.scope ?? policy.scope
    const via = overrides.via ?? (route?.via ?? policy.via)
    const finding = findingFromRef(ref, { days, via })
    finding.effective_scope = scope
    finding.requested_via = via
    if (policy.override_indexes.length || route) {
      finding.policy_provenance = {
        override_indexes: policy.override_indexes,
        route_index: route?.index ?? null,
      }
    }
    return finding
  })
  for (const candidate of scan.candidateRefs) {
    const policy = policyForFile(candidate.file)
    candidate.effective_scope = overrides.scope ?? policy.scope
    if (policy.override_indexes.length) {
      candidate.policy_provenance = { override_indexes: policy.override_indexes, route_index: null }
    }
  }
  return { scan, findings, checkFindings: findings.filter(inCheckScope) }
}

const main = () => {
const COMMANDS = new Set(['check', 'inventory', 'schedule', 'alert', 'plan', 'apply', 'validate', 'verify', 'help'])
const args = process.argv.slice(2)

if (args[0] === '--help' || args[0] === '-h') args[0] = 'help'
let command = COMMANDS.has(args[0]) ? args.shift() : 'check'
let parsed
try {
  parsed = parseCliArgs({
    args,
    options: {
      days: { type: 'string' },
      config: { type: 'string' },
      feeds: { type: 'string' },
      via: { type: 'string' },
      scope: { type: 'string' },
      format: { type: 'string' },
      plan: { type: 'string' },
      json: { type: 'boolean' },
      'include-docs': { type: 'boolean' },
      'allow-incomplete': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      changed: { type: 'string' },
      type: { type: 'string' },
      'feeds-dir': { type: 'string' },
      commit: { type: 'string' },
      'run-url': { type: 'string' },
      package: { type: 'string' },
      'source-commit': { type: 'string' },
      version: { type: 'string' },
      'require-all': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    help: 'node check.mjs --help',
  })
} catch (error) {
  console.error(printable(error.message))
  return 2
}

const { values, positionals } = parsed
if (values.help) command = 'help'

const FORMAT = values.format ?? null
const PLAN_FILE = values.plan ?? null
const AS_JSON = values.json ?? false
const INCLUDE_DOCS = values['include-docs'] ?? false
const ALLOW_INCOMPLETE = values['allow-incomplete'] ?? false
const DRY_RUN = values['dry-run'] ?? false
const CHANGED_BASE = values.changed ?? null
const targets = positionals.length ? positionals : ['.']

if (command === 'help') {
  console.log(`model-eol

Usage:
  node check.mjs [paths...] [--config FILE] [--days N] [--feeds DIR] [--via DISTRIBUTOR] [--scope all|direct] [--json] [--include-docs] [--allow-incomplete]
  node check.mjs check [paths...] [--config FILE] [--days N] [--scope all|direct] [--json] [--changed BASE_REF] [--allow-incomplete]
  node check.mjs inventory [paths...] [--config FILE] [--json] [--format json|cyclonedx|text]
  node check.mjs schedule [paths...] [--config FILE] [--days N] [--json]
  node check.mjs alert [paths...] [--config FILE] [--days N] [--scope all|direct] [--format github|markdown|badge] [--json]
  node check.mjs plan [paths...] [--config FILE] [--days N] [--scope all|direct] [--via DISTRIBUTOR] [--feeds DIR] [--allow-incomplete]
  node check.mjs apply --plan plan.json [--dry-run]
  node check.mjs validate document.json [...] [--type feed|config|check|inventory|schedule|alert|plan|eval|feed-refresh-receipt|npm-release-result|verification]
  node check.mjs verify RECEIPT [--feeds-dir DIR] [--commit SHA] [--run-url URL] [--package FILE.tgz]
                        [--source-commit SHA] [--version X.Y.Z] [--plan FILE] [--config FILE] [--require-all] [--json]

Commands:
  check       Fail when tracked model IDs are retired or retiring within --days.
              With --changed BASE_REF, report findings this change adds or makes newly
              actionable: every reference on an added line, and unchanged references that
              a config, feeds, rename, nearby-code, or untracked-file change made bad.
              References already bad at BASE_REF are not reported.
  inventory   List tracked model references plus direct/cloud/gateway integration hints.
              --format json is the machine-readable default; --format cyclonedx emits a CycloneDX 1.6 ML-BOM.
  schedule    Show the retirement schedule for tracked references in the target.
  alert       Emit GitHub Actions annotations, Markdown, or a Shields badge JSON and fail on errors.
  plan        Emit a JSON migration plan with only safely patchable direct API references.
  apply       Apply a plan with line-hash and occurrence checks; use --dry-run to preview.
  validate    Validate a feed, config, check, inventory, schedule, alert, or plan document,
              an eval, feed-refresh-receipt, or npm-release-result receipt, or a verify --json report.
              The type is inferred from its discriminator or .model-eol.json filename unless --type is set.
  verify      Check what a receipt claims against inputs you supply, offline. The receipt kind
              comes from its schema value:
                ${SUPPORTED_RECEIPT_SCHEMAS.join('\n                ')}
              Each claim is verified, mismatch, not-checked (its input was not supplied), or
              not-applicable (a no-release receipt; a release input given for one adds a mismatched
              released claim). Nothing is read from the current directory or git.
              The result is verified only when every applicable claim is; partial means nothing
              mismatched but some claim was not checked; mismatch means at least one claim failed.
              --json emits a model-eol/verification@0.1 document.
              Eval outcomes (status, exit_code, report) are never claims: verified means the
              manifest is bound to the supplied commit, plan, config, and feeds, not that evals passed.

Verify inputs:
  --feeds-dir DIR       Feeds directory itself (DIR/*.json, e.g. ./feeds), not a repository root.
                        Feed-refresh: every feeds/*.json digest; missing, extra, and changed files mismatch.
                        Eval: with --plan and --config, recomputes each result's feed_digest
                        (--plan and --config alone already fix the expected result set).
  --commit SHA          Feed-refresh refresh_commit, npm-release release_commit, or eval base_sha.
  --run-url URL         Feed-refresh refresh_run, compared after HTTPS URL normalization.
  --package FILE.tgz    npm-release registry_integrity: sha512 SRI of the tarball bytes. No registry lookup.
  --source-commit SHA   npm-release source_commit.
  --version X.Y.Z       npm-release version (the tag is bound to it as vX.Y.Z).
  --plan FILE           Eval plan_digest from a model-eol.plan/0.1 document; also needed for feed digests.
  --config FILE         Eval eval_config_digest and configured, from .model-eol.json (use a file holding {}
                        for a repository without one). MODEL_EOL_EVAL_COMMAND overrides eval.command as it
                        does for the bot, and the output says when it applied.
  --require-all         Exit 1 when the result is partial. A release gate passes --package, --version,
                        --commit, and --require-all: a no-release receipt then mismatches.
  SHA inputs are 40-64 hexadecimal characters; uppercase is lowercased.

Scopes:
  all        Check every tracked model ID found. This preserves the original behavior.
  direct     Check direct API and generic model references; leave cloud/gateway refs in inventory.

Configuration:
  .model-eol.json is loaded automatically from the target repository root.
  --config FILE selects an explicit config. Explicit CLI flags override config values.

Exit codes:
  0  Clean, or report generated successfully. verify: verified or partial (no claim mismatched).
  1  Findings, alert errors, or refused apply items. verify: a claim mismatched, or partial with --require-all.
  2  Usage, feed, scan, plan, or validation errors. verify: usage error, unreadable file, structurally
     invalid receipt, or unsupported receipt schema.
  3  Output stream failure other than EPIPE.
`)
  return 0
}

if (positionals.some(value => value.length === 0)) {
  console.error('positional paths must be non-empty')
  return 2
}
if (values.via === '') {
  console.error('--via must be a non-empty lifecycle channel')
  return 2
}

if (command === 'verify') {
  const allowedOptions = new Set([...VERIFY_INPUTS, 'require-all', 'json'])
  const unsupported = Object.keys(values).find(option => !allowedOptions.has(option))
  if (positionals.length !== 1 || unsupported) {
    const detail = unsupported ? `; --${unsupported} is not supported by verify` : ''
    console.error(`verify requires exactly one RECEIPT${detail}; run node check.mjs --help for usage`)
    return 2
  }
  let report
  try {
    report = verifyReceipt({
      file: positionals[0],
      inputs: Object.fromEntries(VERIFY_INPUTS.map(flag => [flag, values[flag]])),
      env: process.env,
    })
  } catch (error) {
    console.error(printable(error instanceof VerifyError
      ? `model-eol verify: ${error.message}`
      : `model-eol verify: unexpected error, nothing was checked: ${error?.message ?? error}`))
    return 2
  }
  console.log(AS_JSON ? JSON.stringify(report, null, 2) : formatVerification(report))
  if (report.result === 'mismatch') return 1
  return report.result === 'partial' && values['require-all'] ? 1 : 0
}
const verifyOnly = ['feeds-dir', 'commit', 'run-url', 'package', 'source-commit', 'version', 'require-all'].find(option => values[option] !== undefined)
if (verifyOnly) {
  console.error(`--${verifyOnly} is only supported by the verify command`)
  return 2
}

if (command === 'apply') {
  if (!PLAN_FILE || positionals.length) {
    console.error('apply requires --plan plan.json and accepts no target paths')
    return 2
  }
  try {
    const result = applyPlan({ planPath: PLAN_FILE, dryRun: DRY_RUN, rootDir: process.cwd() })
    return result.failed ? 1 : 0
  } catch (e) {
    console.error(`failed to apply plan ${PLAN_FILE}: ${e.message}`)
    return 2
  }
}

if (command === 'validate') {
  const allowedOptions = new Set(['type'])
  const unsupported = Object.keys(values).find(option => !allowedOptions.has(option))
  if (positionals.length === 0 || unsupported) {
    const detail = unsupported ? `; --${unsupported} is not supported by validate` : ''
    console.error(`validate requires one or more JSON documents${detail}`)
    return 2
  }
  if (values.type !== undefined && !DOCUMENT_TYPES.includes(values.type) && values.type !== 'bot-config' && values.type !== 'model-eol-config') {
    console.error(`unknown document type ${JSON.stringify(values.type)}; expected ${DOCUMENT_TYPES.join(', ')}`)
    return 2
  }
  let failed = false
  for (const file of positionals) {
    try {
      const result = validateDocumentFile(file, { type: values.type ?? null })
      if (result.errors.length) {
        for (const error of formatDocumentErrors(result.errors)) console.error(`${file}: ${error}`)
        failed = true
        continue
      }
      console.log(`${file}: valid ${result.type} document`)
    } catch (error) {
      console.error(`${file}: validation failed: ${error.message}`)
      failed = true
    }
  }
  return failed ? 2 : 0
}

if (values.type !== undefined) {
  console.error('--type is only supported by the validate command')
  return 2
}

let configLocation
let repositoryConfig
try {
  configLocation = configForTargets({ targets, explicit: values.config ?? null })
  repositoryConfig = configLocation.file
    ? loadConfig(configLocation.file, { defaults: DEFAULT_CONFIG, allowMissing: false })
    : normalizeConfig({}, { defaults: CLI_DEFAULT_CONFIG })
} catch (e) {
  console.error(`failed to load repository config: ${e.message}`)
  return 2
}

const DAYS = Number(values.days ?? repositoryConfig.days)
const FEEDS_DIR = values.feeds ?? path.join(import.meta.dirname, 'feeds')
const VIA = values.via ?? repositoryConfig.via // e.g. azure-ai-foundry, aws-bedrock
const SCOPE = values.scope ?? repositoryConfig.scope

if (!Number.isFinite(DAYS) || !Number.isInteger(DAYS) || DAYS < 0) {
  console.error('--days must be a finite non-negative integer')
  return 2
}
if (!['all', 'direct'].includes(SCOPE)) {
  console.error('--scope must be all or direct')
  return 2
}
if (CHANGED_BASE !== null && command !== 'check') {
  console.error('--changed is only supported by the check command')
  return 2
}
if (command === 'alert' && FORMAT !== null && !['github', 'markdown', 'badge', 'json'].includes(FORMAT)) {
  console.error('--format must be github, markdown, badge, or json for alert')
  return 2
}
if (command === 'inventory' && FORMAT !== null && !['json', 'cyclonedx', 'text'].includes(FORMAT)) {
  console.error('--format must be json, cyclonedx, or text for inventory')
  return 2
}

let feedData
try {
  feedData = loadFeeds(FEEDS_DIR)
} catch (e) {
  console.error(`failed to load feeds from ${FEEDS_DIR}: ${e.message}`)
  return 2
}
if (feedData.entries.size === 0) {
  console.error(`no feed entries loaded from ${FEEDS_DIR}`)
  return 2
}

const headPolicyError = policyError(repositoryConfig, feedData, values.via)
if (headPolicyError) {
  console.error(headPolicyError)
  return 2
}

const overrides = {
  days: values.days === undefined ? undefined : DAYS,
  scope: values.scope === undefined ? undefined : SCOPE,
  via: values.via === undefined ? undefined : VIA,
}
let scan
let findings
let checkFindings
try {
  ({ scan, findings, checkFindings } = evaluateTargets({
    targets,
    config: repositoryConfig,
    roots: configLocation.roots,
    ignoredFiles: configLocation.file ? [configLocation.file] : [],
    feedData,
    overrides,
    includeDocs: INCLUDE_DOCS,
  }))
} catch (e) {
  console.error(`scan failed: ${e.message}`)
  return 2
}

const incompleteNotes = incompleteScanNotes(scan.notes)
if (incompleteNotes.length && (command === 'check' || command === 'plan')) {
  const label = ALLOW_INCOMPLETE ? 'warning: incomplete scan allowed' : 'INCOMPLETE SCAN'
  console.error(`model-eol: ${label}; ${incompleteNotes.length} coverage-loss note(s) recorded`)
  for (const note of incompleteNotes) {
    const location = note.file ? ` (${note.file})` : ''
    console.error(`  ${note.reason}${location}${note.message ? `: ${note.message}` : ''}`)
  }
  if (!ALLOW_INCOMPLETE) return 2
}

const evaluateBase = ({ treeRoot, files, configFile, feedsDir, classificationPathFor }) => {
  let config = repositoryConfig
  let baseFeeds = feedData
  try {
    if (configFile === null) config = normalizeConfig({}, { defaults: CLI_DEFAULT_CONFIG })
    else if (configFile !== undefined) config = loadConfig(configFile, { defaults: DEFAULT_CONFIG, allowMissing: false })
  } catch (e) {
    throw new BaseUnavailableError(`failed to load base config: ${e.message}`)
  }
  if (feedsDir !== undefined) {
    try {
      baseFeeds = loadFeeds(feedsDir)
    } catch (e) {
      throw new BaseUnavailableError(`failed to load base feeds: ${e.message}`)
    }
    if (baseFeeds.entries.size === 0) throw new BaseUnavailableError('no feed entries loaded from base feeds')
  }
  const basePolicyError = policyError(config, baseFeeds, values.via)
  if (basePolicyError) throw new BaseUnavailableError(`base policy: ${basePolicyError}`)
  try {
    const base = evaluateTargets({
      targets: files,
      config,
      roots: [treeRoot],
      ignoredFiles: configFile ? [configFile] : [],
      feedData: baseFeeds,
      overrides,
      includeDocs: INCLUDE_DOCS,
      noGit: true,
      classificationPathFor,
    })
    return { findings: base.findings, notes: base.scan.notes }
  } catch (e) {
    throw new BaseUnavailableError(`base scan failed: ${e.message}`)
  }
}

let changedFindings = checkFindings
if (CHANGED_BASE !== null) {
  try {
    changedFindings = selectChangedFindings({
      targets,
      baseRef: CHANGED_BASE,
      findings,
      checkFindings,
      scannedFiles: scan.files,
      configFile: configLocation.file,
      feedsDir: FEEDS_DIR,
      evaluateBase,
    })
  } catch (e) {
    console.error(`--changed failed: ${e.message}`)
    return 2
  }
}
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
  return 0
}

if (command === 'check') {
  if (AS_JSON) {
    // capture stays out of the 0.1 document until the contract grows; the human line and the bot carry it
    console.log(JSON.stringify({ schema: 'model-eol/check@0.1', threshold_days: DAYS, distributor: VIA, scope: SCOPE, scan_notes: scan.notes, findings: changedFindings.map(({ capture, ...finding }) => finding) }, null, 2))
  } else {
    console.log(formatCheck({ findings: changedFindings, bad, scannedFiles: scan.files.length, days: DAYS, scope: SCOPE }))
  }
  return bad.length ? 1 : 0
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
  return 0
}

if (command === 'schedule') {
  const sched = schedule()
  if (AS_JSON) {
    console.log(JSON.stringify(sched, null, 2))
  } else {
    console.log(formatSchedule(sched, DAYS))
  }
  return 0
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
  return payload.errors.length ? 1 : 0
}

console.error(`unknown command: ${command}`)
return 2
}

const writeAndCapture = (stream, chunk) => new Promise(resolve => {
  let error = null
  let settling = false
  const settle = nextError => {
    if (nextError && !error) error = nextError
    if (settling) return
    settling = true
    setImmediate(() => {
      stream.off('error', onError)
      resolve(error)
    })
  }
  const onError = nextError => settle(nextError)
  stream.on('error', onError)
  try {
    stream.write(chunk, settle)
  } catch (writeError) {
    settle(writeError)
  }
})
const drainStream = stream => writeAndCapture(stream, '')

const exitCode = main()
const [stdoutError, stderrError] = await Promise.all([
  drainStream(process.stdout),
  drainStream(process.stderr),
])
const outputError = [stdoutError, stderrError].find(error => error && error.code !== 'EPIPE')
let finalExitCode = exitCode
if (exitCode === 0 && outputError) {
  finalExitCode = 3
  const diagnosticStream = stderrError ? (stdoutError ? null : process.stdout) : process.stderr
  const detail = String(outputError.code ?? outputError.message ?? 'unknown error').replace(/[\r\n]+/g, ' ')
  if (diagnosticStream) await writeAndCapture(diagnosticStream, `model-eol: output failed: ${detail}\n`)
}
process.exit(finalExitCode)
