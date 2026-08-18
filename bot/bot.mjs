#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import {
  branchFor,
  daysRemaining,
  hasMetadataMarker,
  itemDigest,
  markdownCode,
  markdownLink,
  markdownText,
  matchesAnyGlob,
  metadataLine,
  parseMetadata,
  repoPath,
  sha256,
  stableJson,
} from './lib/common.mjs'
import { validatePlanItems } from '../lib/apply.mjs'
import { parseCliArgs } from '../lib/cli.mjs'
import { loadConfig } from './lib/config.mjs'
import { downloadFeeds } from './lib/feeds.mjs'
import { capReport, readReportCapped, runEvalHook, reportForBody } from './lib/eval.mjs'
import { GitHubClient, hasModelEolLabel } from './lib/github.mjs'
import {
  cloneRepository,
  commitAll,
  configureIdentity,
  defaultBranch,
  gitAuthentication,
  originFor,
  prepareBranch,
  pushBranch,
  verifyBotBranch,
} from './lib/git.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(ROOT, 'check.mjs')
const VENDORED_FEEDS = path.join(ROOT, 'feeds')
const PLAN_SCHEMA = 'model-eol.plan/0.1'
const BOT_SCHEMA = 'model-eol.bot/0.1'
const EVAL_SCHEMA = 'model-eol.eval/0.1'
const EVAL_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
const ISSUE_REASONS = new Set([
  'not-direct-api',
  'no-replacement',
  'replacement-choice',
  'replacement-unresolved',
  'replacement-retiring',
  'shutdown-date-unavailable',
  'publisher-fallback',
  'unresolved-channel',
])
const ACTIONABLE_STATUSES = new Set(['retired', 'retiring'])

const asAbsolute = value => path.resolve(process.cwd(), value)

export const parseArgs = argv => {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'target-dir': { type: 'string' },
      config: { type: 'string' },
      'dry-run': { type: 'boolean' },
      eval: { type: 'boolean' },
      'feeds-url': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'node bot/bot.mjs --help',
  })
  const options = {
    repo: values.repo ?? null,
    targetDir: values['target-dir'] ?? process.cwd(),
    configPath: values.config ?? null,
    dryRun: values['dry-run'] ?? false,
    evalEnabled: values.eval ?? false,
    feedsUrls: [],
    help: values.help ?? false,
  }
  for (const value of values['feeds-url'] ?? []) {
    options.feedsUrls.push(...value.split(',').map(item => item.trim()).filter(Boolean))
  }
  return options
}

export const parseEvaluateArgs = argv => {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      'target-dir': { type: 'string' },
      config: { type: 'string' },
      'plan-file': { type: 'string' },
      'output-file': { type: 'string' },
      'feeds-url': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'model-eol-bot evaluate --help',
  })
  const feedsUrls = []
  for (const value of values['feeds-url'] ?? []) {
    feedsUrls.push(...value.split(',').map(item => item.trim()).filter(Boolean))
  }
  return {
    targetDir: values['target-dir'] ?? process.cwd(),
    configPath: values.config ?? null,
    planFile: values['plan-file'] ?? null,
    outputFile: values['output-file'] ?? null,
    feedsUrls,
    help: values.help ?? false,
  }
}

export const helpText = () => `model-eol bot

Usage:
  node bot/bot.mjs [--repo owner/name] [--target-dir PATH] [--config PATH] [--dry-run] [--eval] [--feeds-url URL[,URL...]]
  node bot/bot.mjs evaluate --target-dir PATH --plan-file PATH --output-file PATH [--config PATH] [--feeds-url URL[,URL...]]

Environment:
  GITHUB_TOKEN            Required unless --dry-run; authenticates the API and HTTPS Git remotes.
  GITHUB_API_URL          GitHub API root, default https://api.github.com.
  MODEL_EOL_TOKEN_KIND    Set to github-token to add the checks warning to PRs.
  MODEL_EOL_EVAL_COMMAND  Optional command override used by both evaluate and publish.
`

const validateRepo = repo => {
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('--repo must be owner/name')
  return repo
}

const spawnPlan = ({ workDir, config, configPath = null, feedsDir, checkerPath = CHECKER, warn = console.error }) => {
  const args = [checkerPath, 'plan', '.']
  if (configPath) args.push('--config', configPath)
  else {
    args.push('--days', String(config.days), '--scope', config.scope)
    if (config.via) args.push('--via', config.via)
  }
  if (feedsDir) args.push('--feeds', feedsDir)
  const result = spawnSync(process.execPath, args, {
    cwd: workDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.stderr?.trim()) warn(result.stderr.trim())
  if (result.error || result.status !== 0) {
    throw new Error(`plan subprocess failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  }
  let plan
  try {
    plan = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`plan subprocess did not emit JSON: ${error.message}`)
  }
  return validatePlan(plan)
}

export const runPlan = spawnPlan

const validatePlan = plan => {
  if (plan?.plan_schema !== PLAN_SCHEMA) {
    throw new Error(`refusing plan schema ${plan?.plan_schema ?? 'missing'}; expected ${PLAN_SCHEMA}`)
  }
  if (!Array.isArray(plan.items) || !Array.isArray(plan.issues)) {
    throw new Error('refusing malformed plan document: items and issues arrays are required')
  }
  try {
    validatePlanItems(plan.items)
  } catch (error) {
    throw new Error(`refusing malformed plan document: ${error.message}`)
  }
  return plan
}

const readPlanFile = file => {
  let plan
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`could not read plan artifact ${file}: ${error.message}`)
  }
  return validatePlan(plan)
}

const verifiedPlanArtifact = (file, generatedPlan) => {
  if (!file) return generatedPlan
  const artifact = readPlanFile(asAbsolute(file))
  const { generated: artifactGenerated, ...artifactStable } = artifact
  const { generated: regeneratedGenerated, ...regeneratedStable } = generatedPlan
  if (!isDeepStrictEqual(artifactStable, regeneratedStable)) {
    throw new Error('refusing plan artifact: it does not match the independently regenerated plan')
  }
  return artifact
}

const readEvalArtifact = (file, maxBytes, statusFile = null) => {
  if (!file && !statusFile) return null
  let exitCode = null
  let statusError = null
  if (!statusFile) {
    statusError = 'eval status artifact is missing'
  } else {
    try {
      const statusArtifact = readReportCapped(statusFile, 1024)
      if (statusArtifact.missing) statusError = 'eval status artifact is missing'
      else {
        const statusText = statusArtifact.report.trim()
        if (!/^-?\d+$/.test(statusText)) statusError = 'eval status artifact is malformed'
        else {
          const parsed = Number(statusText)
          if (!Number.isSafeInteger(parsed)) statusError = 'eval status artifact is outside the safe integer range'
          else exitCode = parsed
        }
      }
    } catch (error) {
      statusError = `eval status artifact is unreadable: ${error.message}`
    }
  }
  let artifact
  try {
    artifact = file ? readReportCapped(file, maxBytes) : { missing: true, report: null }
  } catch (error) {
    return {
      status: 'fail',
      exit_code: exitCode,
      report: `eval report artifact is unreadable: ${error.message}`,
    }
  }
  if (statusError) {
    return {
      status: 'fail',
      exit_code: exitCode,
      report: artifact.report ? `${statusError}; report: ${artifact.report}` : statusError,
    }
  }
  if (artifact.missing) {
    return {
      status: 'fail',
      exit_code: exitCode,
      report: exitCode === 0 ? 'eval report artifact is missing' : null,
    }
  }
  if (artifact.report === '' && exitCode === 0) return null
  return { status: exitCode === 0 ? 'pass' : 'fail', exit_code: exitCode, report: artifact.report || null }
}

const withoutGenerated = plan => {
  const { generated, ...stable } = plan
  return stable
}

const planDigest = plan => sha256(stableJson(withoutGenerated(plan)))

const effectiveEval = (config, commandOverride = null) => ({
  ...config.eval,
  command: typeof commandOverride === 'string' && commandOverride.trim() ? commandOverride : config.eval.command,
})

const evalConfigDigest = settings => sha256(stableJson({
  command: settings.command ?? null,
  timeout_ms: settings.timeout_ms,
  max_report_bytes: settings.max_report_bytes,
  pass_env: settings.pass_env,
}))

const evalIdentity = (publisher, id, via) => `${publisher}\0${id}\0${via ?? ''}`

const readJsonArtifact = (file, maxBytes, label) => {
  const absolute = asAbsolute(file)
  const artifact = readReportCapped(absolute, maxBytes + 1)
  if (artifact.missing) throw new Error(`${label} is missing`)
  if (Buffer.byteLength(artifact.report) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
  try {
    return JSON.parse(artifact.report)
  } catch (error) {
    throw new Error(`${label} is malformed JSON: ${error.message}`)
  }
}

const readEvalResults = ({ file, config, commandOverride, plan, groups, baseHead }) => {
  const settings = effectiveEval(config, commandOverride)
  const maxBytes = Math.min(EVAL_ARTIFACT_MAX_BYTES, Math.max(1024 * 1024, groups.length * (settings.max_report_bytes + 2048)))
  const artifact = readJsonArtifact(file, maxBytes, 'eval results artifact')
  if (artifact?.schema !== EVAL_SCHEMA) throw new Error(`refusing eval results schema ${artifact?.schema ?? 'missing'}; expected ${EVAL_SCHEMA}`)
  if (artifact.plan_digest !== planDigest(plan)) throw new Error('refusing eval results artifact: plan digest does not match the independently verified plan')
  if (artifact.eval_config_digest !== evalConfigDigest(settings)) throw new Error('refusing eval results artifact: eval configuration digest does not match')
  if (typeof artifact.base_sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(artifact.base_sha)) throw new Error('refusing eval results artifact: evaluated base commit is malformed or missing')
  if (artifact.base_sha !== baseHead) throw new Error(`refusing eval results artifact: evaluated base commit ${artifact.base_sha} does not match current default-branch head ${baseHead}`)
  const configured = Boolean(settings.command)
  if (artifact.configured !== configured) throw new Error('refusing eval results artifact: configured state does not match eval.command')
  if (!Array.isArray(artifact.results)) throw new Error('refusing eval results artifact: results must be an array')
  if (artifact.results.length !== (configured ? groups.length : 0)) {
    throw new Error('refusing eval results artifact: expected exactly one result for every planned migration')
  }
  const expected = new Map(groups.map(group => [evalIdentity(group.publisher, group.id, group.via), group]))
  const results = new Map()
  for (const result of artifact.results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('refusing eval results artifact: result must be an object')
    if (typeof result.publisher !== 'string' || !result.publisher || typeof result.id !== 'string' || !result.id) throw new Error('refusing eval results artifact: result identity is malformed')
    if (result.via !== null && typeof result.via !== 'string') throw new Error('refusing eval results artifact: result clock is malformed')
    const key = evalIdentity(result.publisher, result.id, result.via)
    const group = expected.get(key)
    if (!group || results.has(key)) throw new Error('refusing eval results artifact: result identity is unexpected or duplicated')
    if (result.feed_digest !== group.feedDigest) throw new Error(`refusing eval results artifact: feed digest mismatch for ${group.publisher}/${group.id}`)
    if (!['pass', 'fail', 'timeout'].includes(result.status)) throw new Error(`refusing eval results artifact: invalid status for ${group.publisher}/${group.id}`)
    if (result.exit_code !== null && !Number.isSafeInteger(result.exit_code)) throw new Error(`refusing eval results artifact: invalid exit code for ${group.publisher}/${group.id}`)
    if (result.status === 'pass' && result.exit_code !== 0) throw new Error(`refusing eval results artifact: passing result has a non-zero exit code for ${group.publisher}/${group.id}`)
    if (result.report !== null && typeof result.report !== 'string') throw new Error(`refusing eval results artifact: invalid report for ${group.publisher}/${group.id}`)
    if (result.report !== null && Buffer.byteLength(result.report) > settings.max_report_bytes) throw new Error(`refusing eval results artifact: report exceeds configured cap for ${group.publisher}/${group.id}`)
    results.set(key, { status: result.status, exit_code: result.exit_code, report: result.report })
  }
  return results
}

const feedContext = feedsDir => {
  const records = new Map()
  let files = []
  try {
    files = fs.readdirSync(feedsDir).filter(file => file.endsWith('.json')).sort()
  } catch {
    return records
  }
  for (const file of files) {
    let feed
    try {
      feed = JSON.parse(fs.readFileSync(path.join(feedsDir, file), 'utf8'))
    } catch {
      continue
    }
    if (feed?.spec !== 'model-eol/0.1' || !Array.isArray(feed.models)) continue
    for (const entry of feed.models) {
      for (const key of [entry.id, ...(entry.aliases ?? [])]) {
        if (typeof key === 'string') records.set(`${feed.publisher}\0${key}`, { feed, entry })
      }
    }
  }
  return records
}

export const contextFor = (records, publisher, id, via) => {
  const record = records.get(`${publisher}\0${id}`)
  if (!record) return { announced: null, notes: [], entry: null }
  const distribution = via ? (record.entry.distributions ?? []).find(item => item.via === via) : null
  return {
    announced: distribution ? distribution.announced ?? null : record.entry.announced ?? null,
    notes: [record.feed.note, record.entry.notes].filter(Boolean),
    entry: record.entry,
  }
}

const ignoredModelIds = (plan, config) => {
  const ignored = new Set(config.ignore.models)
  const ids = new Set()
  for (const item of [...plan.items, ...plan.issues]) {
    if (item.id && (ignored.has(item.id) || ignored.has(item.matched))) ids.add(item.id)
  }
  return ids
}

const isIgnored = (entry, root, config, ignoredIds) => {
  if (entry.id && ignoredIds.has(entry.id)) return true
  if (entry.id && config.ignore.models.includes(entry.id)) return true
  if (entry.matched && config.ignore.models.includes(entry.matched)) return true
  return matchesAnyGlob(repoPath(entry.file, root), config.ignore.paths)
}

const buildModelGroups = (plan, config, root, records) => {
  const ignoredIds = ignoredModelIds(plan, config)
  const groups = new Map()
  for (const item of plan.items) {
    if (isIgnored(item, root, config, ignoredIds)) continue
    const via = Object.hasOwn(item, 'requested_via') ? item.requested_via : plan.via
    const key = `${item.publisher}\0${item.id}\0${via ?? ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'model',
        id: item.id,
        publisher: item.publisher,
        items: [],
        via,
        branch: branchFor(item.publisher, item.id, via),
        context: contextFor(records, item.publisher, item.id, via),
      })
    }
    groups.get(key).items.push(item)
  }
  for (const group of groups.values()) {
    group.items.sort((a, b) => `${a.file}:${a.line}:${a.occurrence}`.localeCompare(`${b.file}:${b.line}:${b.occurrence}`))
    group.feedDigest = itemDigest(group.items)
  }
  return [...groups.values()].sort((a, b) => `${a.publisher}/${a.id}`.localeCompare(`${b.publisher}/${b.id}`))
}

const buildIssueGroups = (plan, config, root, records) => {
  const ignoredIds = ignoredModelIds(plan, config)
  const groups = new Map()
  for (const issue of plan.issues) {
    if (!ISSUE_REASONS.has(issue.reason)) continue
    if (issue.reason !== 'unresolved-channel' && !ACTIONABLE_STATUSES.has(issue.status)) continue
    if (isIgnored(issue, root, config, ignoredIds)) continue
    const channel = issue.reason === 'unresolved-channel' ? (issue.provider || issue.matched || 'unresolved-channel') : null
    const subject = issue.id || channel || issue.matched || 'unresolved-model'
    const via = Object.hasOwn(issue, 'requested_via') ? issue.requested_via : (issue.via ?? plan.via)
    const key = `${issue.publisher || ''}\0${subject}\0${issue.shutdown ?? ''}\0${via ?? ''}\0${channel ?? ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'issue',
        id: issue.id || null,
        subject,
        channel,
        publisher: issue.publisher || 'unknown',
        shutdown: issue.shutdown ?? null,
        via,
        issues: [],
        root,
        context: issue.id ? contextFor(records, issue.publisher, issue.id, via) : { announced: null, notes: [], entry: null },
      })
    }
    groups.get(key).issues.push(issue)
  }
  for (const group of groups.values()) {
    group.issues.sort((a, b) => `${a.file}:${a.line}:${a.reason}`.localeCompare(`${b.file}:${b.line}:${b.reason}`))
    group.feedDigest = itemDigest(group.issues)
  }
  return [...groups.values()].sort((a, b) => `${a.publisher}/${a.subject}/${a.shutdown ?? ''}`.localeCompare(`${b.publisher}/${b.subject}/${b.shutdown ?? ''}`))
}

const sourcesFor = group => {
  const values = group.kind === 'model'
    ? group.items.flatMap(item => item.sources ?? [])
    : group.issues.flatMap(issue => issue.sources ?? [])
  return [...new Set(values.filter(Boolean))]
}

const notesFor = group => {
  const planNotes = group.kind === 'model' ? group.items.map(item => item.notes) : group.issues.map(issue => issue.notes)
  const values = [
    ...(planNotes.some(Boolean) ? planNotes : (group.context?.notes ?? [])),
  ]
  return [...new Set(values.filter(Boolean))]
}

const sourceSection = group => {
  const sources = sourcesFor(group)
  return sources.length
    ? sources.map(source => `- ${markdownLink(source, source)}`).join('\n')
    : '- No source URL was included in the plan.'
}

const notesSection = group => {
  const notes = notesFor(group)
  return notes.length ? notes.map(note => `- ${markdownText(note)}`).join('\n') : '- No additional feed notes.'
}

const evalSection = result => {
  if (!result) return ''
  const exit = result.exit_code === null ? 'no exit code' : `exit code ${result.exit_code}`
  const lines = [`## Eval`, `- Result: ${result.status} (${exit}).`]
  if (result.report !== null) lines.push('', '```text', reportForBody(result.report), '```')
  return lines.join('\n')
}

const tokenWarning = tokenKind => tokenKind === 'github-token'
  ? '\n\n> Warning: checks may be skipped because PRs created with `GITHUB_TOKEN` do not trigger `pull_request` workflows. Use a fine-grained PAT or GitHub App token when checks must run.'
  : ''

const replacementOptionsText = options => options.map(markdownCode).join(' | ')

const replacementSection = (item, now) => [
  ...(item.replacement
    ? [`replacement per feed as of ${now.toISOString().slice(0, 10)}: ${markdownCode(item.replacement)}. Treat as a snapshot in time, not a constant.`]
    : []),
  ...(item.replacement_options?.length
    ? [`replacement options per feed as of ${now.toISOString().slice(0, 10)}: ${replacementOptionsText(item.replacement_options)}.`]
    : []),
  ...(item.replacement_note
    ? [`replacement note: ${markdownText(item.replacement_note)}`]
    : []),
]

export const buildPullBody = ({ group, headSha, baseSha = null, now = new Date(), tokenKind = null, evalResult = null }) => {
  const item = group.items[0]
  const announced = markdownText(group.context?.announced ?? 'not specified')
  const days = daysRemaining(item.shutdown, now)
  const metadata = {
    schema: BOT_SCHEMA,
    id: group.id,
    publisher: group.publisher,
    shutdown: item.shutdown,
    via: group.via ?? null,
    replacement: item.replacement,
    replacement_options: item.replacement_options,
    replacement_note: item.replacement_note,
    base_sha: baseSha,
    head_sha: headSha,
    feed_digest: group.feedDigest,
  }
  const sections = [
    metadataLine(metadata),
    '',
    '## What / when',
    `- Announced: ${announced}`,
    `- Shutdown: ${markdownText(item.shutdown)}`,
    `- Days remaining: ${days}`,
    '',
    '## Replacement',
    ...replacementSection(item, now),
    '',
    '## Sources',
    sourceSection(group),
    '',
    '## Feed notes',
    notesSection(group),
  ]
  if (group.via) {
    sections.push('', '## Distributor clock', `This migration uses the ${markdownCode(group.via)} distributor clock; the shutdown date above is the date for that channel.`)
  }
  const evaluation = evalSection(evalResult)
  if (evaluation) sections.push('', evaluation)
  sections.push(
    '',
    '## Checklist',
    '- [ ] Review the diff',
    '- [ ] Run evals',
    '- [ ] Verify params/behavior',
  )
  return sections.join('\n') + tokenWarning(tokenKind)
}

export const buildIssueBody = ({ group, now = new Date() }) => {
  const issue = group.issues[0]
  const metadata = {
    schema: BOT_SCHEMA,
    id: group.id || group.subject,
    publisher: group.publisher,
    shutdown: group.shutdown,
    via: group.via ?? null,
    replacement: issue.replacement ?? null,
    replacement_options: issue.replacement_options,
    replacement_note: issue.replacement_note,
    head_sha: null,
    feed_digest: group.feedDigest,
    ...(group.channel ? { channel: group.channel } : {}),
  }
  const evidence = group.issues
    .map(issue => `- ${markdownText(`${repoPath(issue.file, group.root || '.')}:${issue.line} - ${issue.reason}${issue.matched ? ` (${issue.matched})` : ''}`)}`)
    .join('\n')
  return [
    metadataLine(metadata),
    '',
    '## Finding',
    `- Subject: ${markdownCode(group.subject)}`,
    `- Reason: ${markdownText(group.issues[0].reason)}`,
    `- Status: ${markdownText(group.issues[0].status ?? 'unresolved')}`,
    `- Shutdown: ${markdownText(group.shutdown ?? 'not scheduled')}`,
    ...(issue.replacement
      ? [`- Replacement per feed as of ${now.toISOString().slice(0, 10)}: ${markdownCode(issue.replacement)}. Treat as a snapshot in time, not a constant.`]
      : []),
    ...(issue.replacement_options?.length
      ? [`- Replacement options per feed as of ${now.toISOString().slice(0, 10)}: ${replacementOptionsText(issue.replacement_options)}.`]
      : []),
    ...(issue.replacement_note
      ? [`- Replacement note: ${markdownText(issue.replacement_note)}`]
      : []),
    `- Recorded on: ${now.toISOString().slice(0, 10)}`,
    '',
    '## Evidence',
    evidence,
    '',
    '## Sources',
    sourceSection(group),
    '',
    '## Feed notes',
    notesSection(group),
  ].join('\n')
}

const pullTitle = group => `model-eol: migrate ${group.id} before ${group.items[0].shutdown}`
const issueTitle = group => `model-eol: investigate ${group.subject}${group.shutdown ? ` before ${group.shutdown}` : ''}`

const isOpen = item => item.state === 'open'
const isMerged = item => Boolean(item.merged_at || item.pull_request?.merged_at || item.merged === true)

const pullFromTargetRepo = (item, repo) => !item.head?.repo?.full_name || item.head.repo.full_name === repo

const pullOnExpectedBranch = (item, group, repo) => item.head?.ref === group.branch && pullFromTargetRepo(item, repo)

const matchingPulls = (pulls, group, repo) => pulls
  .filter(item => hasModelEolLabel(item) && pullOnExpectedBranch(item, group, repo))
  .map(item => {
    const metadata = parseMetadata(item.body)
    return {
      item,
      metadata,
      conflict: hasMetadataMarker(item.body) && (!metadata || typeof metadata.head_sha !== 'string' || !metadata.head_sha),
    }
  })
  .filter(record => record.conflict || (
    record.metadata?.id === group.id
    && record.metadata?.publisher === group.publisher
    && (record.metadata.via ?? null) === (group.via ?? null)
  ))

const matchingIssues = (issues, group) => issues
  .filter(item => hasModelEolLabel(item))
  .map(item => {
    const metadata = parseMetadata(item.body)
    return { item, metadata, conflict: false }
  })
  .filter(record => {
    if (!record.metadata) return false
    if (record.metadata.id !== (group.id || group.subject)) return false
    if (record.metadata.publisher !== group.publisher) return false
    if ((record.metadata.via ?? null) !== (group.via ?? null)) return false
    return !group.channel || record.metadata.channel === group.channel || (record.metadata.id === group.channel && !record.metadata.channel)
  })

const modelIdentity = (publisher, id, via) => `${publisher}\0${id}\0${via ?? ''}`
const issueIdentity = (publisher, id, via, channel = null) => `${publisher}\0${id}\0${via ?? ''}\0${channel ?? ''}`

const ownedPullRecords = (pulls, repo) => pulls
  .filter(item => hasModelEolLabel(item) && pullFromTargetRepo(item, repo))
  .map(item => ({ item, metadata: parseMetadata(item.body) }))
  .filter(({ item, metadata }) => metadata
    && typeof metadata.head_sha === 'string'
    && metadata.head_sha
    && item.head?.ref === branchFor(metadata.publisher, metadata.id, metadata.via ?? null))

const ownedIssueRecords = issues => issues
  .filter(item => hasModelEolLabel(item))
  .map(item => ({ item, metadata: parseMetadata(item.body) }))
  .filter(record => record.metadata)

const staleWorkComment = kind => `model-eol is closing this bot-owned ${kind} because its finding is no longer actionable on the repository's current default branch. The reference may have been removed, ignored, retracted by the feed, moved to another clock, or disabled by repository configuration.`

const staleClosedBody = (body, metadata) => {
  const lines = String(body ?? '').split(/\r?\n/)
  lines[0] = metadataLine({ ...metadata, stale_closed: true })
  return lines.join('\n')
}

const groupFromMetadata = (kind, metadata) => ({
  kind,
  id: metadata.id,
  subject: metadata.id,
  publisher: metadata.publisher,
  via: metadata.via ?? null,
  branch: kind === 'model' ? branchFor(metadata.publisher, metadata.id, metadata.via ?? null) : undefined,
})

const reconcileStaleWork = async ({ api, pulls, issues, models, issueGroups }) => {
  const activeModels = new Set(models.map(group => modelIdentity(group.publisher, group.id, group.via)))
  const activeIssues = new Set(issueGroups.flatMap(group => [
    issueIdentity(group.publisher, group.id || group.subject, group.via, group.channel),
    issueIdentity(group.publisher, group.id || group.subject, group.via, null),
  ]))
  const decisions = []
  for (const record of ownedPullRecords(pulls, api.repo)) {
    if (!isOpen(record.item)) continue
    const key = modelIdentity(record.metadata.publisher, record.metadata.id, record.metadata.via)
    if (activeModels.has(key)) continue
    await api.comment(record.item.number, staleWorkComment('pull request'))
    await api.updatePull(record.item.number, {
      state: 'closed',
      body: staleClosedBody(record.item.body, record.metadata),
    })
    decisions.push(decision(groupFromMetadata('model', record.metadata), 'close-stale', { number: record.item.number }))
  }
  for (const record of ownedIssueRecords(issues)) {
    if (!isOpen(record.item)) continue
    const key = issueIdentity(record.metadata.publisher, record.metadata.id, record.metadata.via, record.metadata.channel)
    const legacyKey = issueIdentity(record.metadata.publisher, record.metadata.id, record.metadata.via, null)
    if (activeIssues.has(key) || activeIssues.has(legacyKey)) continue
    await api.comment(record.item.number, staleWorkComment('issue'))
    await api.updateIssue(record.item.number, {
      state: 'closed',
      body: staleClosedBody(record.item.body, record.metadata),
    })
    decisions.push(decision(groupFromMetadata('issue', record.metadata), 'close-stale', { number: record.item.number }))
  }
  return decisions
}

const standingDownComment = (group, metadata, currentHead) =>
  `model-eol is standing down for this branch. The branch head (${markdownCode(currentHead || 'unknown')}) no longer satisfies the bot lease checks for metadata head (${markdownCode(metadata?.head_sha || 'unknown')}), so a human change will not be overwritten. Please update or close this PR manually. An actor with push access can forge the configured identity.`

const staleBaseComment = (metadata, base) =>
  `model-eol is standing down because this bot-owned PR no longer targets the expected default branch. Expected ${markdownCode(base)}, but the PR targets ${markdownCode(metadata || 'unknown')}. Please retarget or close this PR manually.`

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2))

const gitStatusPaths = cwd => {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect eval workspace: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.slice(3).trim())
    .filter(Boolean)
}

const gitHead = cwd => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) throw new Error(`could not inspect eval commit: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  return result.stdout.trim()
}

const hashFiles = (root, files) => new Map(files.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]))

const evalWorkspaceDrift = (root, planFiles, expectedHashes, expectedHead) => {
  if (gitHead(root) !== expectedHead) return 'eval changed repository history'
  for (const file of planFiles) {
    let actual
    try {
      actual = sha256(fs.readFileSync(path.join(root, file)))
    } catch (error) {
      return `eval changed planned file ${file}: it is unreadable after evaluation (${error.message})`
    }
    if (actual !== expectedHashes.get(file)) return `eval changed planned file ${file}`
  }
  const unexpected = gitStatusPaths(root).filter(file => !planFiles.includes(file))
  if (unexpected.length) return `eval changed unexpected repository file ${unexpected[0]}`
  return null
}

const writeJsonAtomic = (file, value) => {
  const absolute = asAbsolute(file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.${sha256(`${Date.now()}-${absolute}`).slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, absolute)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export const evaluatePlan = async ({
  targetDir = process.cwd(),
  configPath = null,
  planFile,
  outputFile,
  feedsUrls = [],
  commandOverride = process.env.MODEL_EOL_EVAL_COMMAND || null,
  fetchImpl = globalThis.fetch,
  checkerPath = CHECKER,
  vendoredFeeds = VENDORED_FEEDS,
  warn = message => console.error(message),
  now = new Date(),
} = {}) => {
  if (!planFile) throw new Error('--plan-file is required for evaluate')
  if (!outputFile) throw new Error('--output-file is required for evaluate')
  const targetPath = path.resolve(targetDir)
  const configFile = configFileFor({ targetDir: targetPath, configPath, scanPath: targetPath })
  if (configPath && !fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
  const config = loadConfig(configFile)
  const settings = effectiveEval(config, commandOverride)
  const planConfigPath = fs.existsSync(configFile) ? configFile : null
  const feedSet = await downloadFeeds({
    urls: feedsUrls,
    fetchImpl,
    vendoredDir: vendoredFeeds,
    allowVendoredFallback: config.feeds.allow_vendored_fallback,
    warn,
  })
  try {
    const generatedPlan = runPlan({ workDir: targetPath, config, configPath: planConfigPath, feedsDir: feedSet.dir, checkerPath, warn })
    const plan = verifiedPlanArtifact(planFile, generatedPlan)
    const groups = buildModelGroups(plan, config, targetPath, feedContext(feedSet.dir))
    const results = []
    if (settings.command) {
      for (const group of groups) {
        const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-evaluate-'))
        const clone = path.join(workRoot, 'repo')
        const selectedPlanPath = path.join(workRoot, 'selected-plan.json')
        const reportPath = path.join(workRoot, 'eval-report.md')
        writeJson(selectedPlanPath, { ...plan, items: group.items, issues: [] })
        const selectedPlanHash = sha256(fs.readFileSync(selectedPlanPath))
        let result
        try {
          cloneRepository(targetPath, clone)
          const applied = spawnSync(process.execPath, [checkerPath, 'apply', '--plan', selectedPlanPath], {
            cwd: clone,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          if (applied.status !== 0 || applied.error) {
            throw new Error(`apply subprocess failed for ${group.publisher}/${group.id}: ${applied.error?.message || applied.stderr?.trim() || `exit ${applied.status}`}`)
          }
          const planFiles = [...new Set(group.items.map(item => repoPath(item.file, clone)))]
          const postApplyHashes = hashFiles(clone, planFiles)
          const postApplyHead = gitHead(clone)
          try {
            result = runEvalHook({
              command: settings.command,
              timeoutMs: settings.timeout_ms,
              maxReportBytes: settings.max_report_bytes,
              passEnv: settings.pass_env,
              cwd: clone,
              oldId: group.id,
              newId: group.items[0].replacement,
              planPath: selectedPlanPath,
              reportPath,
            })
          } catch (error) {
            result = { status: 'fail', exit_code: null, report: `eval runner error: ${error.message}` }
          }
          const drift = evalWorkspaceDrift(clone, planFiles, postApplyHashes, postApplyHead)
          let planDrift = null
          try {
            if (sha256(fs.readFileSync(selectedPlanPath)) !== selectedPlanHash) planDrift = 'eval changed its selected plan artifact'
          } catch (error) {
            planDrift = `eval made its selected plan artifact unreadable (${error.message})`
          }
          if (drift || planDrift) {
            result = {
              ...result,
              status: 'fail',
              report: capReport([result.report, drift, planDrift].filter(Boolean).join('\n'), settings.max_report_bytes),
            }
          }
        } finally {
          fs.rmSync(workRoot, { recursive: true, force: true })
        }
        results.push({
          publisher: group.publisher,
          id: group.id,
          via: group.via ?? null,
          feed_digest: group.feedDigest,
          status: result.status,
          exit_code: result.exit_code,
          report: capReport(result.report, settings.max_report_bytes),
        })
      }
    }
    const artifact = {
      schema: EVAL_SCHEMA,
      generated: now.toISOString(),
      base_sha: gitHead(targetPath),
      plan_digest: planDigest(plan),
      eval_config_digest: evalConfigDigest(settings),
      configured: Boolean(settings.command),
      results,
    }
    writeJsonAtomic(outputFile, artifact)
    return { artifact, plan, config: { ...config, eval: settings }, degraded: Boolean(feedSet.degraded) }
  } finally {
    feedSet.cleanup()
  }
}

const makePatch = ({ source, base, branch, expectedHead, allowMissingBranch = false, group, plan, config, checkerPath, evalEnabled, root, warn, gitAuth }) => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-work-'))
  const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-plan-'))
  const clone = path.join(workRoot, 'repo')
  const fullPlanPath = path.join(planRoot, 'plan.json')
  const selectedPlanPath = path.join(planRoot, 'selected-plan.json')
  const reportPath = path.join(planRoot, 'eval-report.md')
  writeJson(fullPlanPath, plan)
  writeJson(selectedPlanPath, { ...plan, items: group.items, issues: [] })
  try {
    cloneRepository(source, clone, gitAuth)
    prepareBranch(clone, branch, base, gitAuth)
    const applied = spawnSync(process.execPath, [checkerPath, 'apply', '--plan', selectedPlanPath], {
      cwd: clone,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (applied.status !== 0 || applied.error) {
      throw new Error(`apply subprocess failed: ${applied.error?.message || applied.stderr?.trim() || `exit ${applied.status}`}`)
    }
    const planFiles = [...new Set(group.items.map(item => repoPath(item.file, clone)))]
    const postApplyHashes = hashFiles(clone, planFiles)
    const postApplyHead = gitHead(clone)

    let evalResult = null
    if (evalEnabled && config.eval.command) {
      try {
        evalResult = runEvalHook({
          command: config.eval.command,
          timeoutMs: config.eval.timeout_ms,
          maxReportBytes: config.eval.max_report_bytes,
          passEnv: config.eval.pass_env,
          cwd: clone,
          oldId: group.id,
          newId: group.items[0].replacement,
          planPath: fullPlanPath,
          reportPath,
        })
      } catch (error) {
        warn(`model-eol: warning: eval runner failed for ${group.id}: ${error.message}`)
        evalResult = { status: 'fail', exit_code: null, report: `eval runner error: ${error.message}` }
      }
    }
    if (evalResult) {
      const drift = evalWorkspaceDrift(clone, planFiles, postApplyHashes, postApplyHead)
      if (drift) {
        evalResult = {
          ...evalResult,
          status: 'fail',
          report: capReport([evalResult.report, drift].filter(Boolean).join('\n'), config.eval.max_report_bytes),
        }
      }
    }
    if (evalResult && evalResult.status !== 'pass') {
      const error = new Error(`eval hook did not pass: ${evalResult.status}`)
      error.code = 'MODEL_EOL_EVAL_FAILED'
      error.evalResult = evalResult
      throw error
    }

    configureIdentity(clone)
    const files = planFiles
    const message = `model-eol: migrate ${group.id} to ${group.items[0].replacement} (${group.feedDigest.slice(0, 8)})`
    const headSha = commitAll(clone, files, message)
    pushBranch(clone, branch, expectedHead, gitAuth, { allowMissing: allowMissingBranch })
    return { headSha, evalResult }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
    fs.rmSync(planRoot, { recursive: true, force: true })
  }
}

const decision = (group, action, extra = {}) => ({ group, action, ...extra })

const processModel = async ({ api, pulls, group, source, base, baseHead, plan, config, checkerPath, evalEnabled, externalEval, root, now, tokenKind, warn, gitAuth }) => {
  const matches = matchingPulls(pulls, group, api.repo)
  const conflict = matches.find(record => record.conflict)
  if (conflict) return decision(group, 'conflict', { number: conflict.item.number })
  const open = matches.find(record => isOpen(record.item))
  const currentDigest = group.feedDigest
  if (open) {
    if (open.item.base?.ref && open.item.base.ref !== base) {
      await api.comment(open.item.number, staleBaseComment(open.item.base.ref, base))
      return decision(group, 'stand-down', { number: open.item.number })
    }
    const lease = verifyBotBranch(root, open.item.head?.ref || group.branch, open.metadata.head_sha, gitAuth)
    if (!lease.safe) {
      await api.comment(open.item.number, standingDownComment(group, open.metadata, lease.head))
      return decision(group, 'stand-down', { number: open.item.number })
    }
    if (externalEval && externalEval.status !== 'pass') {
      return decision(group, 'eval-failed', { number: open.item.number, evalResult: externalEval })
    }
    if (open.metadata.feed_digest === currentDigest && open.metadata.base_sha === baseHead) {
      return decision(group, 'skip-unchanged', { number: open.item.number })
    }
    let patch
    try {
      patch = makePatch({
        source,
        base,
        branch: open.item.head?.ref || group.branch,
        expectedHead: open.metadata.head_sha,
        group,
        plan,
        config,
        checkerPath,
        evalEnabled,
        root,
        warn,
        gitAuth,
      })
    } catch (error) {
      if (error.code === 'MODEL_EOL_EVAL_FAILED') {
        return decision(group, 'eval-failed', { number: open.item.number, evalResult: error.evalResult })
      }
      if (error.code !== 'MODEL_EOL_BRANCH_STAND_DOWN') throw error
      await api.comment(open.item.number, standingDownComment(group, open.metadata, error.currentHead))
      return decision(group, 'stand-down', { number: open.item.number })
    }
    if (patch.evalResult && patch.evalResult.status !== 'pass') {
      return decision(group, 'eval-failed', { number: open.item.number, evalResult: patch.evalResult })
    }
    if (!patch.evalResult && externalEval) patch.evalResult = externalEval
    const body = buildPullBody({ group, headSha: patch.headSha, baseSha: baseHead, now, tokenKind, evalResult: patch.evalResult })
    await api.updatePull(open.item.number, { title: pullTitle(group), body })
    return decision(group, 'update', { number: open.item.number, body, headSha: patch.headSha })
  }

  if (externalEval && externalEval.status !== 'pass') {
    return decision(group, 'eval-failed', { evalResult: externalEval })
  }

  const replacement = group.items[0].replacement
  const dismissed = matches.find(record => !isOpen(record.item) && !isMerged(record.item) && record.metadata.stale_closed !== true && record.metadata.shutdown === group.items[0].shutdown && (record.metadata.replacement === undefined || record.metadata.replacement === replacement))
  if (dismissed) return decision(group, 'skip-dismissed', { number: dismissed.item.number })

  const previous = matches.find(record => record.metadata?.head_sha) ?? null
  const previousBotHead = previous?.metadata.head_sha ?? null
  if (!previousBotHead) {
    const occupied = verifyBotBranch(root, group.branch, null, gitAuth)
    if (occupied.error) throw new Error(occupied.error)
    if (occupied.head) {
      const occupant = pulls.find(item => pullOnExpectedBranch(item, group, api.repo))
      return decision(group, 'conflict', { number: occupant?.number })
    }
  }
  let patch
  try {
    patch = makePatch({
      source,
      base,
      branch: group.branch,
      expectedHead: previousBotHead,
      allowMissingBranch: Boolean(previousBotHead && !isOpen(previous.item)),
      group,
      plan,
      config,
      checkerPath,
      evalEnabled,
      root,
      warn,
      gitAuth,
    })
  } catch (error) {
    if (error.code === 'MODEL_EOL_EVAL_FAILED') {
      return decision(group, 'eval-failed', { evalResult: error.evalResult })
    }
    if (error.code !== 'MODEL_EOL_BRANCH_STAND_DOWN') throw error
    const prior = matches.find(record => record.metadata?.head_sha === previousBotHead)
    if (prior) await api.comment(prior.item.number, standingDownComment(group, prior.metadata, error.currentHead))
    return decision(group, 'stand-down', { number: prior?.item.number })
  }
  if (patch.evalResult && patch.evalResult.status !== 'pass') {
    return decision(group, 'eval-failed', { evalResult: patch.evalResult })
  }
  if (!patch.evalResult && externalEval) patch.evalResult = externalEval
  const body = buildPullBody({ group, headSha: patch.headSha, baseSha: baseHead, now, tokenKind, evalResult: patch.evalResult })
  const latestPulls = await api.listPullsByHead(group.branch)
  const latestMatches = matchingPulls(latestPulls, group, api.repo)
  const latestConflict = latestMatches.find(record => record.conflict)
  if (latestConflict) return decision(group, 'conflict', { number: latestConflict.item.number })
  const latestOpen = latestMatches.find(record => isOpen(record.item))
  if (latestOpen) {
    await api.updatePull(latestOpen.item.number, { title: pullTitle(group), body })
    return decision(group, 'update', { number: latestOpen.item.number, body, headSha: patch.headSha })
  }
  const latestUntrusted = latestPulls.find(item => pullOnExpectedBranch(item, group, api.repo) && !latestMatches.some(record => record.item.number === item.number))
  if (latestUntrusted) return decision(group, 'conflict', { number: latestUntrusted.number })
  const latestSuppressed = latestMatches.find(record => !isOpen(record.item) && !isMerged(record.item) && record.metadata.stale_closed !== true && record.metadata.shutdown === group.items[0].shutdown && (record.metadata.replacement === undefined || record.metadata.replacement === replacement))
  if (latestSuppressed) return decision(group, 'skip-dismissed', { number: latestSuppressed.item.number })
  const created = await api.createPull({
    title: pullTitle(group),
    head: group.branch,
    base,
    body,
  })
  return decision(group, 'create', { number: created.number, body, headSha: patch.headSha })
}

const processIssue = async ({ api, issues, group, now }) => {
  const matches = matchingIssues(issues, group)
  const conflict = matches.find(record => record.conflict)
  if (conflict) return decision(group, 'conflict', { number: conflict.item.number })
  const open = matches.find(record => isOpen(record.item))
  const body = buildIssueBody({ group, now })
  if (open) {
    if (open.metadata.feed_digest === group.feedDigest) return decision(group, 'skip-unchanged', { number: open.item.number, body })
    await api.updateIssue(open.item.number, { title: issueTitle(group), body })
    return decision(group, 'update', { number: open.item.number, body })
  }
  const replacement = group.issues[0].replacement ?? null
  const dismissed = matches.find(record => !isOpen(record.item) && record.metadata.stale_closed !== true && record.metadata.shutdown === group.shutdown && (record.metadata.replacement === undefined || record.metadata.replacement === replacement))
  if (dismissed) return decision(group, 'skip-dismissed', { number: dismissed.item.number })
  const latestMatches = matchingIssues(await api.listIssues(), group)
  const latestConflict = latestMatches.find(record => record.conflict)
  if (latestConflict) return decision(group, 'conflict', { number: latestConflict.item.number })
  const latestOpen = latestMatches.find(record => isOpen(record.item))
  if (latestOpen) {
    await api.updateIssue(latestOpen.item.number, { title: issueTitle(group), body })
    return decision(group, 'update', { number: latestOpen.item.number, body })
  }
  const latestDismissed = latestMatches.find(record => !isOpen(record.item) && record.metadata.stale_closed !== true && record.metadata.shutdown === group.shutdown && (record.metadata.replacement === undefined || record.metadata.replacement === replacement))
  if (latestDismissed) return decision(group, 'skip-dismissed', { number: latestDismissed.item.number })
  const created = await api.createIssue({ title: issueTitle(group), body, labels: ['model-eol'] })
  return decision(group, 'create', { number: created.number, body })
}

const dryDecision = (group, now, tokenKind) => group.kind === 'model'
  ? decision(group, 'create', {
    body: buildPullBody({ group, headSha: 'dry-run', now, tokenKind }),
    branch: group.branch,
  })
  : decision(group, 'create', { body: buildIssueBody({ group, now }) })

const reportOnlyDecision = (group, now, tokenKind) => {
  const result = dryDecision(group, now, tokenKind)
  return { ...result, action: 'report-only' }
}

const prepareScan = ({ targetDir, source, dryRun, gitAuth }) => {
  if (!dryRun || !String(targetDir).startsWith('file://')) return { path: targetDir, cleanup: () => {} }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-scan-'))
  const clone = path.join(root, 'repo')
  cloneRepository(source, clone, gitAuth)
  return { path: clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

const configFileFor = ({ targetDir, configPath, scanPath }) => {
  if (configPath) return asAbsolute(configPath)
  if (!String(targetDir).startsWith('file://')) {
    const targetConfig = path.join(path.resolve(targetDir), '.model-eol.json')
    if (fs.existsSync(targetConfig)) return targetConfig
  }
  const candidate = path.join(scanPath, '.model-eol.json')
  return candidate
}

export const formatDecisions = (decisions, { degraded = false } = {}) => {
  const lines = ['model-eol decision table']
  if (degraded) lines.push('model-eol status: degraded - vendored feed fallback enabled; no GitHub writes')
  for (const record of decisions) {
    const group = record.group
    const label = group.kind === 'model' ? `${group.publisher}/${group.id}` : `${group.publisher}/${group.subject}`
    lines.push(`- ${record.action} ${label}`)
    if (record.branch) lines.push(`  branch: ${record.branch}`)
    if (record.body) lines.push('  body:', record.body.split('\n').map(line => `    ${line}`).join('\n'))
  }
  return lines.join('\n')
}

const BLOCKED_ACTIONS = new Set(['conflict', 'eval-failed', 'label-unavailable', 'report-only', 'stand-down'])

const appendDecisionSummary = (file, decisions, { degraded = false } = {}) => {
  if (!file) return
  const blocked = degraded || decisions.some(record => BLOCKED_ACTIONS.has(record.action))
  const lines = [
    '## model-eol bot',
    '',
    `Outcome: **${blocked ? 'blocked' : 'success'}**${degraded ? ' (vendored feed fallback; no writes)' : ''}`,
    '',
    '| Action | Finding |',
    '| --- | --- |',
  ]
  for (const record of decisions) {
    const group = record.group
    const label = group.kind === 'model' ? `${group.publisher}/${group.id}` : `${group.publisher}/${group.subject}`
    lines.push(`| ${markdownText(record.action)} | ${markdownText(label)} |`)
  }
  if (!decisions.length) lines.push('| none | No actionable findings |')
  fs.appendFileSync(file, `${lines.join('\n')}\n`)
}

const appendEvalSummary = (file, artifact) => {
  if (!file) return
  const lines = [
    '## model-eol migration evals',
    '',
    artifact.configured ? 'Each migration was applied and evaluated in an isolated checkout.' : 'No eval command is configured.',
    '',
    '| Result | Migration |',
    '| --- | --- |',
  ]
  for (const result of artifact.results) lines.push(`| ${markdownText(result.status)} | ${markdownText(`${result.publisher}/${result.id}`)} |`)
  if (!artifact.results.length) lines.push('| not run | No configured migration evals |')
  fs.appendFileSync(file, `${lines.join('\n')}\n`)
}

export const runBot = async ({
  repo,
  targetDir = process.cwd(),
  configPath = null,
  dryRun = false,
  evalEnabled = false,
  feedsUrls = [],
  token = process.env.GITHUB_TOKEN,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  tokenKind = process.env.MODEL_EOL_TOKEN_KIND || null,
  transport = globalThis.fetch,
  fetchImpl = globalThis.fetch,
  checkerPath = CHECKER,
  vendoredFeeds = VENDORED_FEEDS,
  planFile = null,
  evalReportFile = null,
  evalStatusFile = null,
  evalResultsFile = null,
  evalCommandOverride = null,
  now = new Date(),
  warn = message => console.error(message),
} = {}) => {
  if (!dryRun) {
    validateRepo(repo)
    if (!token) throw new Error('GITHUB_TOKEN is required unless --dry-run is used')
  }
  const targetIsUrl = String(targetDir).startsWith('file://')
  const targetPath = targetIsUrl ? targetDir : path.resolve(targetDir)
  const source = targetIsUrl ? targetDir : originFor(targetPath)
  const gitAuth = gitAuthentication(source, token, apiUrl)
  let scan = null
  let baseClone = null
  let ownedBaseRoot = null
  let feedSet = null
  try {
    if (dryRun) {
      scan = prepareScan({ targetDir: targetPath, source, dryRun, gitAuth })
      const configFile = configFileFor({ targetDir, configPath, scanPath: scan.path })
      if (configPath && !fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
      const config = loadConfig(configFile)
      const planConfigPath = fs.existsSync(configFile) ? configFile : null
      feedSet = await downloadFeeds({
        urls: feedsUrls,
        fetchImpl,
        vendoredDir: vendoredFeeds,
        allowVendoredFallback: config.feeds.allow_vendored_fallback,
        warn,
      })
      const generatedPlan = runPlan({ workDir: scan.path, config, configPath: planConfigPath, feedsDir: feedSet.dir, checkerPath, warn })
      const plan = verifiedPlanArtifact(planFile, generatedPlan)
      const records = feedContext(feedSet.dir)
      const models = buildModelGroups(plan, config, scan.path, records)
      const issues = config.issues.enabled ? buildIssueGroups(plan, config, scan.path, records) : []
      const report = group => feedSet.degraded ? reportOnlyDecision(group, now, tokenKind) : dryDecision(group, now, tokenKind)
      const decisions = [...models.map(report), ...issues.map(report)]
      return { plan, config, decisions, feedsDir: feedSet.dir, degraded: Boolean(feedSet.degraded) }
    }

    ownedBaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-base-'))
    baseClone = path.join(ownedBaseRoot, 'repo')
    cloneRepository(source, baseClone, gitAuth)
    const base = defaultBranch(baseClone, gitAuth)
    const baseHead = gitHead(baseClone)
    const configFile = configFileFor({ targetDir, configPath, scanPath: baseClone })
    if (configPath && !fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
    const config = loadConfig(configFile)
    const planConfigPath = fs.existsSync(configFile) ? configFile : null
    feedSet = await downloadFeeds({
      urls: feedsUrls,
      fetchImpl,
      vendoredDir: vendoredFeeds,
      allowVendoredFallback: config.feeds.allow_vendored_fallback,
      warn,
    })
    const generatedPlan = runPlan({ workDir: baseClone, config, configPath: planConfigPath, feedsDir: feedSet.dir, checkerPath, warn })
    const plan = verifiedPlanArtifact(planFile, generatedPlan)
    const records = feedContext(feedSet.dir)
    const models = buildModelGroups(plan, config, baseClone, records)
    const issues = config.issues.enabled ? buildIssueGroups(plan, config, baseClone, records) : []
    if (feedSet.degraded) {
      const report = group => reportOnlyDecision(group, now, tokenKind)
      const decisions = [...models.map(report), ...issues.map(report)]
      return { plan, config, decisions, feedsDir: feedSet.dir, degraded: true }
    }
    const externalEvalResults = evalResultsFile
      ? readEvalResults({ file: evalResultsFile, config, commandOverride: evalCommandOverride, plan, groups: models, baseHead })
      : null
    const legacyExternalEval = externalEvalResults ? null : readEvalArtifact(
      evalReportFile ? asAbsolute(evalReportFile) : null,
      config.eval.max_report_bytes,
      evalStatusFile ? asAbsolute(evalStatusFile) : null,
    )
    const api = new GitHubClient({ repo, apiUrl, token, transport, warn })
    const labelReady = models.length || issues.length ? await api.ensureModelEolLabel() : true
    const pulls = await api.listPulls()
    const issueRecords = await api.listIssues()
    const decisions = []
    if (!labelReady) {
      for (const group of [...models, ...issues]) decisions.push(decision(group, 'label-unavailable'))
    } else {
      for (const group of models) {
        const externalEval = externalEvalResults?.get(evalIdentity(group.publisher, group.id, group.via)) ?? legacyExternalEval
        decisions.push(await processModel({
          api,
          pulls,
          group,
          source,
          base,
          baseHead,
          plan,
          config,
          checkerPath,
          evalEnabled,
          externalEval,
          root: baseClone,
          now,
          tokenKind,
          warn,
          gitAuth,
        }))
      }
      for (const group of issues) decisions.push(await processIssue({ api, issues: issueRecords, group, now }))
    }
    decisions.push(...await reconcileStaleWork({ api, pulls, issues: issueRecords, models, issueGroups: issues }))
    return { plan, config, decisions, feedsDir: feedSet.dir, degraded: false }
  } finally {
    scan?.cleanup()
    if (ownedBaseRoot) fs.rmSync(ownedBaseRoot, { recursive: true, force: true })
    feedSet?.cleanup()
  }
}

export const main = async (argv = process.argv.slice(2), env = process.env) => {
  if (argv[0] === 'evaluate') {
    const options = parseEvaluateArgs(argv.slice(1))
    if (options.help) {
      console.log(helpText())
      return 0
    }
    const result = await evaluatePlan({
      targetDir: options.targetDir,
      configPath: options.configPath,
      planFile: options.planFile,
      outputFile: options.outputFile,
      feedsUrls: options.feedsUrls,
      commandOverride: env.MODEL_EOL_EVAL_COMMAND || null,
    })
    appendEvalSummary(env.GITHUB_STEP_SUMMARY, result.artifact)
    for (const item of result.artifact.results) console.log(`${item.status} ${item.publisher}/${item.id}`)
    return 0
  }
  const options = parseArgs(argv)
  if (options.help) {
    console.log(helpText())
    return 0
  }
  const result = await runBot({
    repo: options.repo || env.GITHUB_REPOSITORY,
    targetDir: options.targetDir,
    configPath: options.configPath,
    dryRun: options.dryRun,
    evalEnabled: options.evalEnabled,
    feedsUrls: options.feedsUrls,
    planFile: env.MODEL_EOL_PLAN_FILE || null,
    evalReportFile: env.MODEL_EOL_EVAL_REPORT_FILE || null,
    evalStatusFile: env.MODEL_EOL_EVAL_STATUS_FILE || null,
    evalResultsFile: env.MODEL_EOL_EVAL_RESULTS_FILE || null,
    evalCommandOverride: env.MODEL_EOL_EVAL_COMMAND || null,
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    tokenKind: env.MODEL_EOL_TOKEN_KIND || null,
  })
  if (options.dryRun) console.log(formatDecisions(result.decisions, { degraded: result.degraded }))
  else {
    if (result.degraded) console.log('model-eol status: degraded - vendored feed fallback enabled; no GitHub writes')
    for (const item of result.decisions) console.log(`${item.action} ${item.group.publisher}/${item.group.kind === 'model' ? item.group.id : item.group.subject}`)
  }
  appendDecisionSummary(env.GITHUB_STEP_SUMMARY, result.decisions, { degraded: result.degraded })
  return result.degraded || result.decisions.some(item => BLOCKED_ACTIONS.has(item.action)) ? 1 : 0
}

const invokedFile = (() => {
  if (!process.argv[1]) return null
  try {
    return fs.realpathSync(process.argv[1])
  } catch {
    return path.resolve(process.argv[1])
  }
})()

if (invokedFile === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(`model-eol bot: ${error.message}`)
    process.exit(2)
  })
}
