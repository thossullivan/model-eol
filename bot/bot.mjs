#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  branchFor,
  daysRemaining,
  itemDigest,
  matchesAnyGlob,
  metadataLine,
  parseMetadata,
  repoPath,
} from './lib/common.mjs'
import { parseCliArgs } from '../lib/cli.mjs'
import { loadConfig } from './lib/config.mjs'
import { downloadFeeds } from './lib/feeds.mjs'
import { runEvalHook, reportForBody } from './lib/eval.mjs'
import { GitHubClient, hasModelEolLabel } from './lib/github.mjs'
import {
  cloneRepository,
  commitAll,
  configureIdentity,
  defaultBranch,
  originFor,
  prepareBranch,
  pushBranch,
} from './lib/git.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECKER = path.join(ROOT, 'check.mjs')
const VENDORED_FEEDS = path.join(ROOT, 'feeds')
const PLAN_SCHEMA = 'model-eol.plan/0.1'
const BOT_SCHEMA = 'model-eol.bot/0.1'
const ISSUE_REASONS = new Set([
  'not-direct-api',
  'no-replacement',
  'replacement-unresolved',
  'replacement-retiring',
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

export const helpText = () => `model-eol bot

Usage:
  node bot/bot.mjs [--repo owner/name] [--target-dir PATH] [--config PATH] [--dry-run] [--eval] [--feeds-url URL[,URL...]]

Environment:
  GITHUB_TOKEN            Required unless --dry-run.
  GITHUB_API_URL          GitHub API root, default https://api.github.com.
  MODEL_EOL_TOKEN_KIND    Set to github-token to add the checks warning to PRs.
`

const validateRepo = repo => {
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('--repo must be owner/name')
  return repo
}

const spawnPlan = ({ workDir, config, feedsDir, checkerPath = CHECKER, warn = console.error }) => {
  const args = [checkerPath, 'plan', '.', '--days', String(config.days), '--scope', config.scope]
  if (config.via) args.push('--via', config.via)
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

const readEvalArtifact = (file, maxBytes, statusFile = null) => {
  if (!file || !fs.existsSync(file)) return null
  const bytes = fs.readFileSync(file)
  let exitCode = 0
  if (statusFile && fs.existsSync(statusFile)) {
    const parsed = Number.parseInt(fs.readFileSync(statusFile, 'utf8').trim(), 10)
    if (Number.isInteger(parsed)) exitCode = parsed
  }
  if (bytes.length === 0 && exitCode === 0) return null
  const report = bytes.length === 0 ? null : bytes.length > maxBytes
    ? Buffer.concat([bytes.subarray(0, Math.max(0, maxBytes - 31)), Buffer.from('\n[model-eol: report truncated]')]).subarray(0, maxBytes).toString('utf8')
    : bytes.toString('utf8')
  return { status: exitCode === 0 ? 'pass' : 'fail', exit_code: exitCode, report }
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

const contextFor = (records, publisher, id, via) => {
  const record = records.get(`${publisher}\0${id}`)
  if (!record) return { announced: null, notes: [], entry: null }
  const distribution = via ? (record.entry.distributions ?? []).find(item => item.via === via) : null
  return {
    announced: distribution?.announced ?? record.entry.announced ?? null,
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
    const key = `${item.publisher}\0${item.id}`
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'model',
        id: item.id,
        publisher: item.publisher,
        items: [],
        via: plan.via,
        branch: branchFor(item.publisher, item.id),
        context: contextFor(records, item.publisher, item.id, plan.via),
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
    const key = `${issue.publisher || ''}\0${subject}\0${issue.shutdown ?? ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        kind: 'issue',
        id: issue.id || null,
        subject,
        channel,
        publisher: issue.publisher || 'unknown',
        shutdown: issue.shutdown ?? null,
        via: issue.via ?? plan.via,
        issues: [],
        root,
        context: issue.id ? contextFor(records, issue.publisher, issue.id, issue.via ?? plan.via) : { announced: null, notes: [], entry: null },
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
    ? sources.map(source => `- [${source}](${source})`).join('\n')
    : '- No source URL was included in the plan.'
}

const notesSection = group => {
  const notes = notesFor(group)
  return notes.length ? notes.map(note => `- ${note}`).join('\n') : '- No additional feed notes.'
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

export const buildPullBody = ({ group, headSha, now = new Date(), tokenKind = null, evalResult = null }) => {
  const item = group.items[0]
  const announced = group.context?.announced ?? 'not specified'
  const days = daysRemaining(item.shutdown, now)
  const metadata = {
    schema: BOT_SCHEMA,
    id: group.id,
    publisher: group.publisher,
    shutdown: item.shutdown,
    via: group.via ?? null,
    head_sha: headSha,
    feed_digest: group.feedDigest,
  }
  const sections = [
    metadataLine(metadata),
    '',
    '## What / when',
    `- Announced: ${announced}`,
    `- Shutdown: ${item.shutdown}`,
    `- Days remaining: ${days}`,
    '',
    '## Replacement',
    `replacement per feed as of ${now.toISOString().slice(0, 10)}: \`${item.replacement}\`. Treat as a snapshot in time, not a constant.`,
    '',
    '## Sources',
    sourceSection(group),
    '',
    '## Feed notes',
    notesSection(group),
  ]
  if (group.via) {
    sections.push('', '## Distributor clock', `This migration uses the \`${group.via}\` distributor clock; the shutdown date above is the date for that channel.`)
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
  const metadata = {
    schema: BOT_SCHEMA,
    id: group.id || group.subject,
    publisher: group.publisher,
    shutdown: group.shutdown,
    via: group.via ?? null,
    head_sha: null,
    feed_digest: group.feedDigest,
    ...(group.channel ? { channel: group.channel } : {}),
  }
  const evidence = group.issues
    .map(issue => `- ${repoPath(issue.file, group.root || '.')}:${issue.line} - ${issue.reason}${issue.matched ? ` (${issue.matched})` : ''}`)
    .join('\n')
  return [
    metadataLine(metadata),
    '',
    '## Finding',
    `- Subject: \`${group.subject}\``,
    `- Reason: ${group.issues[0].reason}`,
    `- Status: ${group.issues[0].status ?? 'unresolved'}`,
    `- Shutdown: ${group.shutdown ?? 'not scheduled'}`,
    ...(group.issues[0].replacement
      ? [`- Replacement per feed as of ${now.toISOString().slice(0, 10)}: \`${group.issues[0].replacement}\`. Treat as a snapshot in time, not a constant.`]
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

const matchingPulls = (pulls, group) => pulls
  .filter(item => !item.labels || hasModelEolLabel(item))
  .map(item => ({ item, metadata: parseMetadata(item.body) }))
  .filter(record => record.metadata?.id === group.id && record.metadata?.publisher === group.publisher)

const matchingIssues = (issues, group) => issues
  .filter(item => !item.labels || hasModelEolLabel(item))
  .map(item => ({ item, metadata: parseMetadata(item.body) }))
  .filter(record => {
    if (!record.metadata) return false
    if (record.metadata.id !== (group.id || group.subject)) return false
    if (record.metadata.publisher !== group.publisher) return false
    return !group.channel || record.metadata.channel === group.channel || (record.metadata.id === group.channel && !record.metadata.channel)
  })

const currentHeadFor = async (api, pull, group) => {
  if (pull.head?.sha) return pull.head.sha
  const branch = pull.head?.ref || group.branch
  const encoded = branch.split('/').map(part => encodeURIComponent(part)).join('/')
  const { data } = await api.request('GET', `/repos/${api.repo}/git/ref/heads/${encoded}`)
  return data?.object?.sha ?? null
}

const standingDownComment = (group, metadata, currentHead) =>
  `model-eol is standing down for this branch. The branch head (${currentHead || 'unknown'}) no longer matches the bot metadata head (${metadata?.head_sha || 'unknown'}), so a human change will not be overwritten. Please update or close this PR manually.`

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2))

const makePatch = ({ source, base, branch, expectedHead, group, plan, config, checkerPath, evalEnabled, root, warn }) => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-work-'))
  const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-plan-'))
  const clone = path.join(workRoot, 'repo')
  const fullPlanPath = path.join(planRoot, 'plan.json')
  const selectedPlanPath = path.join(planRoot, 'selected-plan.json')
  const reportPath = path.join(planRoot, 'eval-report.md')
  writeJson(fullPlanPath, plan)
  writeJson(selectedPlanPath, { ...plan, items: group.items, issues: [] })
  try {
    cloneRepository(source, clone)
    prepareBranch(clone, branch, base)
    const applied = spawnSync(process.execPath, [checkerPath, 'apply', '--plan', selectedPlanPath], {
      cwd: clone,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (applied.status !== 0 || applied.error) {
      throw new Error(`apply subprocess failed: ${applied.error?.message || applied.stderr?.trim() || `exit ${applied.status}`}`)
    }

    let evalResult = null
    if (evalEnabled && config.eval.command) {
      try {
        evalResult = runEvalHook({
          command: config.eval.command,
          timeoutMs: config.eval.timeout_ms,
          maxReportBytes: config.eval.max_report_bytes,
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

    configureIdentity(clone)
    const files = group.items.map(item => repoPath(item.file, clone))
    const message = `model-eol: migrate ${group.id} to ${group.items[0].replacement} (${group.feedDigest.slice(0, 8)})`
    const headSha = commitAll(clone, files, message)
    pushBranch(clone, branch, expectedHead)
    return { headSha, evalResult }
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
    fs.rmSync(planRoot, { recursive: true, force: true })
  }
}

const decision = (group, action, extra = {}) => ({ group, action, ...extra })

const processModel = async ({ api, pulls, group, source, base, plan, config, checkerPath, evalEnabled, externalEval, root, now, tokenKind, warn }) => {
  const matches = matchingPulls(pulls, group)
  const open = matches.find(record => isOpen(record.item))
  const currentDigest = group.feedDigest
  if (open) {
    if (open.metadata.feed_digest === currentDigest) return decision(group, 'skip-unchanged', { number: open.item.number })
    const currentHead = await currentHeadFor(api, open.item, group)
    if (!currentHead || currentHead !== open.metadata.head_sha) {
      await api.comment(open.item.number, standingDownComment(group, open.metadata, currentHead))
      return decision(group, 'stand-down', { number: open.item.number })
    }
    const patch = makePatch({
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
    })
    if (!patch.evalResult && externalEval) patch.evalResult = externalEval
    const body = buildPullBody({ group, headSha: patch.headSha, now, tokenKind, evalResult: patch.evalResult })
    await api.updatePull(open.item.number, { title: pullTitle(group), body })
    return decision(group, 'update', { number: open.item.number, body, headSha: patch.headSha })
  }

  const merged = matches.find(record => !isOpen(record.item) && isMerged(record.item) && record.metadata.shutdown === group.items[0].shutdown)
  if (merged) return decision(group, 'skip-merged', { number: merged.item.number })
  const dismissed = matches.find(record => !isOpen(record.item) && !isMerged(record.item) && record.metadata.shutdown === group.items[0].shutdown)
  if (dismissed) return decision(group, 'skip-dismissed', { number: dismissed.item.number })

  const previousBotHead = matches.find(record => record.metadata?.head_sha)?.metadata.head_sha ?? null
  const patch = makePatch({
    source,
    base,
    branch: group.branch,
    expectedHead: previousBotHead,
    group,
    plan,
    config,
    checkerPath,
    evalEnabled,
    root,
    warn,
  })
  if (!patch.evalResult && externalEval) patch.evalResult = externalEval
  const body = buildPullBody({ group, headSha: patch.headSha, now, tokenKind, evalResult: patch.evalResult })
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
  const open = matches.find(record => isOpen(record.item))
  const body = buildIssueBody({ group, now })
  if (open) {
    if (open.metadata.feed_digest === group.feedDigest) return decision(group, 'skip-unchanged', { number: open.item.number, body })
    await api.updateIssue(open.item.number, { title: issueTitle(group), body })
    return decision(group, 'update', { number: open.item.number, body })
  }
  const dismissed = matches.find(record => !isOpen(record.item) && record.metadata.shutdown === group.shutdown)
  if (dismissed) return decision(group, 'skip-dismissed', { number: dismissed.item.number })
  const created = await api.createIssue({ title: issueTitle(group), body, labels: ['model-eol'] })
  return decision(group, 'create', { number: created.number, body })
}

const dryDecision = (group, now, tokenKind) => group.kind === 'model'
  ? decision(group, 'create', {
    body: buildPullBody({ group, headSha: 'dry-run', now, tokenKind }),
    branch: group.branch,
  })
  : decision(group, 'create', { body: buildIssueBody({ group, now }) })

const prepareScan = ({ targetDir, source, dryRun }) => {
  if (!dryRun || !String(targetDir).startsWith('file://')) return { path: targetDir, cleanup: () => {} }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-scan-'))
  const clone = path.join(root, 'repo')
  cloneRepository(source, clone)
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

export const formatDecisions = decisions => {
  const lines = ['model-eol decision table']
  for (const record of decisions) {
    const group = record.group
    const label = group.kind === 'model' ? `${group.publisher}/${group.id}` : `${group.publisher}/${group.subject}`
    lines.push(`- ${record.action} ${label}`)
    if (record.branch) lines.push(`  branch: ${record.branch}`)
    if (record.body) lines.push('  body:', record.body.split('\n').map(line => `    ${line}`).join('\n'))
  }
  return lines.join('\n')
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
  const feedSet = await downloadFeeds({ urls: feedsUrls, fetchImpl, vendoredDir: vendoredFeeds, warn })
  let scan = null
  let baseClone = null
  let ownedBaseRoot = null
  try {
    if (dryRun) {
      scan = prepareScan({ targetDir: targetPath, source, dryRun })
      const configFile = configFileFor({ targetDir, configPath, scanPath: scan.path })
      if (configPath && !fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
      const config = loadConfig(configFile)
      const generatedPlan = runPlan({ workDir: scan.path, config, feedsDir: feedSet.dir, checkerPath, warn })
      const plan = planFile ? readPlanFile(asAbsolute(planFile)) : generatedPlan
      const records = feedContext(feedSet.dir)
      const models = buildModelGroups(plan, config, scan.path, records)
      const issues = config.issues.enabled ? buildIssueGroups(plan, config, scan.path, records) : []
      const decisions = [...models.map(group => dryDecision(group, now, tokenKind)), ...issues.map(group => dryDecision(group, now, tokenKind))]
      return { plan, config, decisions, feedsDir: feedSet.dir }
    }

    ownedBaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-base-'))
    baseClone = path.join(ownedBaseRoot, 'repo')
    cloneRepository(source, baseClone)
    const base = defaultBranch(baseClone)
    const configFile = configFileFor({ targetDir, configPath, scanPath: baseClone })
    if (configPath && !fs.existsSync(configFile)) throw new Error(`config file not found: ${configFile}`)
    const config = loadConfig(configFile)
    const generatedPlan = runPlan({ workDir: baseClone, config, feedsDir: feedSet.dir, checkerPath, warn })
    const plan = planFile ? readPlanFile(asAbsolute(planFile)) : generatedPlan
    const records = feedContext(feedSet.dir)
    const models = buildModelGroups(plan, config, baseClone, records)
    const issues = config.issues.enabled ? buildIssueGroups(plan, config, baseClone, records) : []
    const externalEval = readEvalArtifact(
      evalReportFile ? asAbsolute(evalReportFile) : null,
      config.eval.max_report_bytes,
      evalStatusFile ? asAbsolute(evalStatusFile) : null,
    )
    const api = new GitHubClient({ repo, apiUrl, token, transport })
    const pulls = models.length ? await api.listPulls() : []
    const issueRecords = issues.length ? await api.listIssues() : []
    const decisions = []
    for (const group of models) {
      decisions.push(await processModel({
        api,
        pulls,
        group,
        source,
        base,
        plan,
        config,
        checkerPath,
        evalEnabled,
        externalEval,
        root: baseClone,
        now,
        tokenKind,
        warn,
      }))
    }
    for (const group of issues) decisions.push(await processIssue({ api, issues: issueRecords, group, now }))
    return { plan, config, decisions, feedsDir: feedSet.dir }
  } finally {
    scan?.cleanup()
    if (ownedBaseRoot) fs.rmSync(ownedBaseRoot, { recursive: true, force: true })
    feedSet.cleanup()
  }
}

export const main = async (argv = process.argv.slice(2), env = process.env) => {
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
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
    tokenKind: env.MODEL_EOL_TOKEN_KIND || null,
  })
  if (options.dryRun) console.log(formatDecisions(result.decisions))
  else for (const item of result.decisions) console.log(`${item.action} ${item.group.publisher}/${item.group.kind === 'model' ? item.group.id : item.group.subject}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(`model-eol bot: ${error.message}`)
    process.exit(2)
  })
}
