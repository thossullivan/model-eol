#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  buildIssueBody,
  buildPullBody,
  contextFor,
  formatDecisions,
  runBot,
} from '../bot.mjs'
import { branchFor, metadataLine, parseMetadata, slugFor } from '../lib/common.mjs'
import { loadConfig } from '../lib/config.mjs'
import { downloadFeeds } from '../lib/feeds.mjs'
import { reportForBody, runEvalHook } from '../lib/eval.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-bot-test-'))
let failures = 0

const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failures++
  } else {
    console.log(`ok: ${message}`)
  }
}

const unknownFlag = spawnSync(process.execPath, [path.join(root, 'bot', 'bot.mjs'), '--dyas', '90'], { encoding: 'utf8' })
assert(unknownFlag.status === 2 && unknownFlag.stderr.includes('--dyas') && unknownFlag.stderr.includes('--help'), 'unknown bot flags exit 2 with the bad flag and help hint')

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

const gitTry = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

const makeRepo = ({ name = 'repo', files = {}, config = null } = {}) => {
  const bare = path.join(tempRoot, `${name}.git`)
  const work = path.join(tempRoot, `${name}-work`)
  fs.mkdirSync(work, { recursive: true })
  git(work, ['init', '-b', 'main'])
  git(work, ['config', 'user.name', 'fixture'])
  git(work, ['config', 'user.email', 'fixture@example.invalid'])
  git(work, ['init', '--bare', bare])
  git(work, ['remote', 'add', 'origin', `file://${bare}`])
  for (const [file, contents] of Object.entries(files)) write(path.join(work, file), contents)
  if (config) write(path.join(work, '.model-eol.json'), JSON.stringify(config, null, 2))
  git(work, ['add', '--', '.'])
  git(work, ['commit', '-m', 'fixture'])
  git(work, ['push', '-u', 'origin', 'main'])
  git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  return { bare, work }
}

const bareBranchFile = (repo, branch, file) => git(repo.bare, ['show', `${branch}:${file}`])
const headOf = (repo, branch) => git(repo.bare, ['rev-parse', `refs/heads/${branch}`])

class FakeGitHub {
  constructor() {
    this.calls = []
    this.pulls = []
    this.issues = []
    this.nextNumber = 1
    this.listPullCount = 0
    this.listIssueCount = 0
    this.beforeListPulls = null
    this.beforeListIssues = null
  }

  response(data, status = 200) {
    return { status, ok: status < 400, headers: { get: () => null }, json: async () => data }
  }

  async transport(url, options) {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    this.calls.push({ method: options.method, path: parsed.pathname, query: parsed.search, body })
    const pathName = parsed.pathname
    if (options.method === 'GET' && pathName.endsWith('/pulls')) {
      this.listPullCount++
      this.beforeListPulls?.(this, this.listPullCount)
      return this.response(this.pulls)
    }
    if (options.method === 'GET' && pathName.endsWith('/issues')) {
      this.listIssueCount++
      this.beforeListIssues?.(this, this.listIssueCount)
      return this.response(this.issues)
    }
    if (options.method === 'GET' && pathName.includes('/git/ref/heads/')) {
      const branch = decodeURIComponent(pathName.split('/git/ref/heads/')[1])
      const pull = this.pulls.find(item => item.head?.ref === branch)
      return this.response({ object: { sha: pull?.head?.sha ?? null } })
    }
    if (options.method === 'POST' && pathName.endsWith('/pulls')) {
      const number = this.nextNumber++
      const created = {
        number,
        state: 'open',
        labels: [{ name: 'model-eol' }],
        body: body.body,
        title: body.title,
        head: { ref: body.head, sha: body.head_sha ?? null },
      }
      this.pulls.push(created)
      return this.response(created, 201)
    }
    if (options.method === 'POST' && pathName.includes('/issues/') && pathName.endsWith('/labels')) return this.response({ labels: ['model-eol'] })
    if (options.method === 'PATCH' && pathName.includes('/pulls/')) {
      const number = Number(pathName.split('/').at(-1))
      const pull = this.pulls.find(item => item.number === number)
      Object.assign(pull, body)
      const metadata = parseMetadata(body.body)
      if (metadata && pull.head) pull.head.sha = metadata.head_sha
      return this.response(pull)
    }
    if (options.method === 'POST' && pathName.includes('/comments')) return this.response({ id: this.nextNumber++, body: body.body }, 201)
    if (options.method === 'POST' && pathName.endsWith('/issues')) {
      const number = this.nextNumber++
      const issue = { number, state: 'open', labels: [{ name: 'model-eol' }], ...body }
      this.issues.push(issue)
      return this.response(issue, 201)
    }
    if (options.method === 'PATCH' && pathName.includes('/issues/')) {
      const number = Number(pathName.split('/').at(-1))
      const issue = this.issues.find(item => item.number === number)
      Object.assign(issue, body)
      return this.response(issue)
    }
    return this.response({}, 404)
  }

  callsFor(method, suffix) {
    return this.calls.filter(call => call.method === method && call.path.endsWith(suffix))
  }
}

const baseFiles = {
  'direct.py': fs.readFileSync(path.join(import.meta.dirname, 'fixture/direct.py'), 'utf8'),
}
const config = {
  days: 90,
  scope: 'direct',
  issues: { enabled: false },
  eval: {
    command: 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "eval report with ```fence```")\'',
    timeout_ms: 1000,
    max_report_bytes: 65536,
    pass_env: [],
  },
}
const repo = makeRepo({ name: 'lifecycle', files: baseFiles, config })
const github = new FakeGitHub()
const run = options => runBot({
  repo: 'example/app',
  targetDir: repo.work,
  token: 'test-token',
  transport: github.transport.bind(github),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})

const first = await run({ evalEnabled: true, tokenKind: 'github-token' })
const firstDecision = first.decisions.find(item => item.group.kind === 'model')
const branch = branchFor('openai', 'o3-deep-research-2025-06-26')
const createCall = github.callsFor('POST', '/pulls')[0]
const metadata = parseMetadata(firstDecision?.body)
const createdPull = github.pulls.find(item => item.number === firstDecision?.number)
if (createdPull) createdPull.head.sha = metadata?.head_sha
assert(firstDecision?.action === 'create', 'create-PR flow returns create decision')
assert(createCall?.body?.labels === undefined, 'pull create payload leaves label assignment to the label endpoint')
assert(github.callsFor('POST', '/labels').length === 1, 'created PR receives the model-eol label')
assert(createCall?.body?.title === 'model-eol: migrate o3-deep-research-2025-06-26 before 2026-07-23', 'PR title includes canonical ID and shutdown')
assert(metadata?.schema === 'model-eol.bot/0.1' && metadata.publisher === 'openai' && metadata.replacement === 'gpt-5.6-sol', 'PR has the machine-readable metadata block including replacement')
assert(firstDecision.body.includes('## What / when') && firstDecision.body.includes('## Replacement') && firstDecision.body.includes('## Sources') && firstDecision.body.includes('## Feed notes'), 'PR body has lifecycle, replacement, source, and note sections')
assert(firstDecision.body.includes('Treat as a snapshot in time, not a constant.'), 'PR body renders the snapshot caveat verbatim')
assert(firstDecision.body.includes('## Checklist') && firstDecision.body.includes('Review the diff'), 'PR body has the review checklist')
assert(firstDecision.body.includes('checks may be skipped') && firstDecision.body.includes('GITHUB_TOKEN'), 'github-token PR body carries the checks warning')
assert(bareBranchFile(repo, branch, 'direct.py').includes('gpt-5.6-sol'), 'create flow pushes the migration branch to the bare repo')
assert(!fs.readFileSync(path.join(repo.work, 'direct.py'), 'utf8').includes('gpt-5.6-sol'), 'caller checkout is not modified')
assert(firstDecision.body.includes('eval report with fence') && !firstDecision.body.includes('```fence```'), 'eval report is embedded fenced with backticks stripped')
assert(firstDecision.body.includes('Result: pass') && firstDecision.body.includes('exit code 0'), 'passing eval result is recorded')
assert(Array.isArray(first.config.eval.pass_env) && first.config.eval.pass_env.length === 0, 'eval config defaults to an empty pass_env allowlist')
assert(!github.calls.find(call => call.method === 'GET' && call.path.endsWith('/pulls'))?.query.includes('labels='), 'pull discovery is not label-filtered')
const contextRecords = new Map([
  ['openai\0clocked-model', {
    feed: { note: null },
    entry: { announced: '2026-01-01', distributions: [{ via: 'azure-ai-foundry' }] },
  }],
])
assert(contextFor(contextRecords, 'openai', 'clocked-model', 'azure-ai-foundry').announced === null, 'explicit distribution without announced date does not use publisher announcement')

const clockRepo = makeRepo({ name: 'clock-matching', files: baseFiles, config })
const clockGithub = new FakeGitHub()
const clockRun = options => runBot({
  repo: 'example/clock-matching',
  targetDir: clockRepo.work,
  token: 'test-token',
  transport: clockGithub.transport.bind(clockGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const clockPublisher = await clockRun()
const clockPublisherDecision = clockPublisher.decisions.find(item => item.group.kind === 'model')
const clockPublisherPull = clockGithub.pulls.find(item => item.number === clockPublisherDecision?.number)
if (clockPublisherPull) clockPublisherPull.head.sha = parseMetadata(clockPublisherDecision?.body)?.head_sha
const distributorConfig = path.join(tempRoot, 'distributor-clock.json')
write(distributorConfig, JSON.stringify({ days: 200, via: 'azure-ai-foundry', issues: { enabled: false } }))
const clockDistributor = await clockRun({ configPath: distributorConfig })
const clockDistributorDecision = clockDistributor.decisions.find(item => item.group.kind === 'model')
assert(clockPublisherDecision?.action === 'create' && clockDistributorDecision?.action === 'create', 'publisher and distributor clocks create separate PR decisions')
assert(clockGithub.callsFor('POST', '/pulls').length === 2 && clockGithub.pulls[0].head.ref !== clockGithub.pulls[1].head.ref, 'clock-specific PR matching does not reuse the publisher-clock PR')

const callsAfterCreate = github.calls.length
const unchanged = await run({ evalEnabled: true })
assert(unchanged.decisions.find(item => item.group.kind === 'model')?.action === 'skip-unchanged', 'unchanged feed digest does nothing')
assert(github.calls.length > callsAfterCreate && github.callsFor('PATCH', '/pulls').length === 0, 'unchanged state only performs discovery')

const changedFeeds = path.join(tempRoot, 'changed-feeds')
fs.cpSync(path.join(root, 'feeds'), changedFeeds, { recursive: true })
const changedOpenai = JSON.parse(fs.readFileSync(path.join(changedFeeds, 'openai.json'), 'utf8'))
changedOpenai.note = 'Changed feed note for lifecycle update'
fs.writeFileSync(path.join(changedFeeds, 'openai.json'), JSON.stringify(changedOpenai, null, 2))

const replacementRepo = makeRepo({ name: 'replacement-suppression', files: baseFiles, config })
const replacementGithub = new FakeGitHub()
const replacementRun = options => runBot({
  repo: 'example/replacement-suppression',
  targetDir: replacementRepo.work,
  token: 'test-token',
  transport: replacementGithub.transport.bind(replacementGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const replacementFirst = await replacementRun({ vendoredFeeds: changedFeeds })
const replacementPull = replacementGithub.pulls.find(item => item.number === replacementFirst.decisions.find(item => item.group.kind === 'model')?.number)
if (replacementPull) {
  replacementPull.state = 'closed'
  replacementPull.head.sha = parseMetadata(replacementFirst.decisions.find(item => item.group.kind === 'model')?.body)?.head_sha
}
const sameReplacement = await replacementRun({ vendoredFeeds: changedFeeds })
assert(sameReplacement.decisions.find(item => item.group.kind === 'model')?.action === 'skip-dismissed', 'dismissed PR stays suppressed when shutdown and replacement still match')
const legacyMetadata = parseMetadata(replacementFirst.decisions.find(item => item.group.kind === 'model')?.body)
const legacyBody = `${metadataLine(Object.fromEntries(Object.entries(legacyMetadata).filter(([key]) => key !== 'replacement')))}${replacementFirst.decisions.find(item => item.group.kind === 'model')?.body.split('\n').slice(1).join('\n')}`
if (replacementPull) replacementPull.body = legacyBody
const legacyReplacement = await replacementRun({ vendoredFeeds: changedFeeds })
assert(legacyReplacement.decisions.find(item => item.group.kind === 'model')?.action === 'skip-dismissed', 'pre-upgrade metadata without replacement keeps shutdown suppression')
if (replacementPull) replacementPull.body = replacementFirst.decisions.find(item => item.group.kind === 'model')?.body
const replacementYFeeds = path.join(tempRoot, 'replacement-y-feeds')
fs.cpSync(changedFeeds, replacementYFeeds, { recursive: true })
const replacementYOpenai = JSON.parse(fs.readFileSync(path.join(replacementYFeeds, 'openai.json'), 'utf8'))
replacementYOpenai.models.find(item => item.id === 'o3-deep-research-2025-06-26').replacement = 'gpt-5.6-terra'
fs.writeFileSync(path.join(replacementYFeeds, 'openai.json'), JSON.stringify(replacementYOpenai, null, 2))
const replacementChanged = await replacementRun({ vendoredFeeds: replacementYFeeds })
assert(replacementChanged.decisions.find(item => item.group.kind === 'model')?.action === 'create' && replacementGithub.callsFor('POST', '/pulls').length === 2, 'changed replacement creates a fresh PR instead of reusing dismissal')

const beforeUpdateHead = headOf(repo, branch)
const updated = await run({ evalEnabled: true, vendoredFeeds: changedFeeds })
const updateDecision = updated.decisions.find(item => item.group.kind === 'model')
assert(updateDecision?.action === 'update', 'changed digest with intact bot head updates the PR')
assert(headOf(repo, branch) !== beforeUpdateHead, 'changed digest force-pushes a regenerated branch')
assert(github.calls.filter(call => call.method === 'PATCH' && call.path.includes('/pulls/')).length === 1, 'changed digest updates the PR body')

const foreignHead = '1111111111111111111111111111111111111111'
const pull = github.pulls.find(item => item.number === firstDecision.number)
pull.head.sha = foreignHead
const beforeStandDownHead = headOf(repo, branch)
const changedAgain = path.join(tempRoot, 'changed-again-feeds')
fs.cpSync(changedFeeds, changedAgain, { recursive: true })
const changedAgainOpenai = JSON.parse(fs.readFileSync(path.join(changedAgain, 'openai.json'), 'utf8'))
changedAgainOpenai.note = 'A second changed feed note'
fs.writeFileSync(path.join(changedAgain, 'openai.json'), JSON.stringify(changedAgainOpenai, null, 2))
const standDown = await run({ vendoredFeeds: changedAgain })
assert(standDown.decisions.find(item => item.group.kind === 'model')?.action === 'stand-down', 'foreign branch head causes stand-down')
assert(github.callsFor('POST', '/comments').length === 1, 'stand-down comments on the PR')
assert(headOf(repo, branch) === beforeStandDownHead, 'stand-down does not push')

pull.state = 'closed'
pull.head.sha = metadata.head_sha
pull.body = updateDecision.body
const dismissed = await run({ vendoredFeeds: changedFeeds })
assert(dismissed.decisions.find(item => item.group.kind === 'model')?.action === 'skip-dismissed', 'closed unmerged PR with same shutdown is dismissed')

const movedFeeds = path.join(tempRoot, 'moved-feeds')
fs.cpSync(changedFeeds, movedFeeds, { recursive: true })
const movedOpenai = JSON.parse(fs.readFileSync(path.join(movedFeeds, 'openai.json'), 'utf8'))
movedOpenai.models.find(item => item.id === 'o3-deep-research-2025-06-26').shutdown = '2026-08-23'
fs.writeFileSync(path.join(movedFeeds, 'openai.json'), JSON.stringify(movedOpenai, null, 2))
const fresh = await run({ vendoredFeeds: movedFeeds })
assert(fresh.decisions.find(item => item.group.kind === 'model')?.action === 'create', 'closed PR with changed shutdown creates a fresh PR')
assert(github.callsFor('POST', '/pulls').length === 2, 'changed shutdown opens another pull request')

const issueRepo = makeRepo({
  name: 'issues',
  files: { 'cloud.ts': 'const client = new AzureOpenAI({ endpoint: process.env.AZURE_OPENAI_ENDPOINT })\n' },
})
const issueGithub = new FakeGitHub()
const issueRun = options => runBot({
  repo: 'example/issues',
  targetDir: issueRepo.work,
  token: 'test-token',
  transport: issueGithub.transport.bind(issueGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const issueResult = await issueRun()
assert(issueResult.decisions.some(item => item.group.kind === 'issue' && item.action === 'create'), 'unresolved-channel finding creates an issue')
assert(issueGithub.callsFor('POST', '/issues').some(call => call.body.labels?.includes('model-eol')), 'issue creation includes the model-eol label')
const disabledIssueConfig = path.join(tempRoot, 'issues-disabled.json')
fs.writeFileSync(disabledIssueConfig, JSON.stringify({ issues: { enabled: false } }))
const disabled = await issueRun({ configPath: disabledIssueConfig })
assert(!disabled.decisions.some(item => item.group.kind === 'issue') && issueGithub.callsFor('POST', '/issues').length === 1, 'issues.enabled false suppresses issue maintenance')

const referenceRepo = makeRepo({
  name: 'model-reference',
  files: { 'prompts/evals.yaml': 'providers:\n  - anthropic:messages:claude-sonnet-4-20250514\n' },
})
const referenceGithub = new FakeGitHub()
const referenceResult = await runBot({
  repo: 'example/model-reference',
  targetDir: referenceRepo.work,
  token: 'test-token',
  transport: referenceGithub.transport.bind(referenceGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const referenceIssue = referenceResult.decisions.find(item => item.group.kind === 'issue' && item.action === 'create')
assert(referenceIssue, 'retired model-reference without a direct API signal creates an issue')
assert(referenceIssue.body.includes('not-direct-api'), 'model-reference issue carries the not-direct-api reason')
assert(referenceIssue.body.includes('`claude-sonnet-4-6`'), 'model-reference issue surfaces the feed replacement')
assert(!referenceResult.decisions.some(item => item.group.kind === 'pr'), 'retired model-reference never creates a PR')
const structuredIssueBody = buildIssueBody({
  group: {
    kind: 'issue',
    id: 'structured-model',
    subject: 'structured-model',
    publisher: 'openai',
    shutdown: '2026-07-01',
    via: null,
    feedDigest: 'structured-digest',
    root: '.',
    context: { announced: null, notes: [], entry: null },
    issues: [{
      file: 'app.py',
      line: 1,
      reason: 'replacement-choice',
      status: 'retired',
      matched: 'structured-model',
      replacement: null,
      replacement_options: ['first_choice', 'second-choice'],
      replacement_note: 'Use `reasoning.mode: pro` <when needed>.',
      sources: [],
      notes: null,
    }],
  },
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(structuredIssueBody.includes('Replacement options') && structuredIssueBody.includes('first&#95;choice') && structuredIssueBody.includes('second-choice'), 'issue body renders escaped replacement options')
const structuredNoteLine = structuredIssueBody.split('\n').find(line => line.startsWith('- Replacement note:'))
assert(structuredNoteLine?.includes('reasoning.mode: pro') && structuredNoteLine.includes('&lt;when needed&gt;') && structuredNoteLine.includes('&#96;'), 'issue body renders escaped replacement notes')

const ignoreRepo = makeRepo({
  name: 'ignores',
  files: {
    'src/ignored.py': 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "o3-deep-research"\n',
    'src/kept.py': 'from openai import OpenAI\nclient = OpenAI()\nMODEL = "o3-deep-research"\n',
  },
  config: { ignore: { models: ['o3-deep-research-2025-06-26'], paths: ['src/ignored.py'] }, issues: { enabled: false } },
})
const ignoreRun = await runBot({
  repo: 'example/ignores',
  targetDir: ignoreRepo.work,
  dryRun: true,
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(ignoreRun.decisions.length === 0, 'canonical model and path ignores suppress all matching aliases and paths')

assert(slugFor('A very/unsafe ID!!! with a long tail that should be trimmed') .length <= 40, 'slug generation trims unsafe long IDs to 40 characters')
assert(branchFor('openai', 'model/with?unsafe') !== branchFor('openai', 'model-with-unsafe'), 'hash suffix keeps collision-prone slugs distinct')

const feedFailureGithub = new FakeGitHub()
let feedFailure
try {
  await runBot({
    repo: 'example/app',
    targetDir: repo.work,
    token: 'test-token',
    transport: feedFailureGithub.transport.bind(feedFailureGithub),
    feedsUrls: ['https://feeds.invalid/a.json', 'https://feeds.invalid/b.json'],
    fetchImpl: async url => url.endsWith('b.json') ? { status: 500, ok: false } : { status: 200, ok: true, text: async () => JSON.stringify({ spec: 'model-eol/0.1', publisher: 'remote', generated: '2026-08-01T00:00:00Z', source: url, models: [] }) },
    vendoredFeeds: path.join(root, 'feeds'),
  })
} catch (error) {
  feedFailure = error
}
assert(feedFailure?.message.includes('feed download failed') && feedFailureGithub.calls.length === 0, 'remote feed failure fails the run before GitHub mutation')

const fallbackConfig = path.join(tempRoot, 'fallback-config.json')
write(fallbackConfig, JSON.stringify({ feeds: { allow_vendored_fallback: true }, issues: { enabled: false } }))
const warnings = []
const fallback = await runBot({
  repo: 'example/app',
  targetDir: repo.work,
  token: 'test-token',
  transport: feedFailureGithub.transport.bind(feedFailureGithub),
  configPath: fallbackConfig,
  feedsUrls: ['https://feeds.invalid/a.json', 'https://feeds.invalid/b.json'],
  fetchImpl: async url => url.endsWith('b.json') ? { status: 500, ok: false } : { status: 200, ok: true, text: async () => JSON.stringify({ spec: 'model-eol/0.1', publisher: 'remote', generated: '2026-08-01T00:00:00Z', source: url, models: [] }) },
  vendoredFeeds: path.join(root, 'feeds'),
  warn: message => warnings.push(message),
})
assert(fallback.degraded === true && fallback.decisions.some(item => item.group.kind === 'model' && item.action === 'report-only'), 'opt-in feed fallback returns degraded report-only decisions')
assert(feedFailureGithub.calls.length === 0, 'degraded vendored fallback makes zero GitHub calls')
assert(warnings.some(message => message.includes('using vendored feeds') && message.includes('degraded')), 'feed fallback emits a degraded warning')
assert(formatDecisions(fallback.decisions, { degraded: fallback.degraded }).includes('status: degraded'), 'degraded fallback state is visible in formatted output')

let feedTemp
const feedDownload = await downloadFeeds({
  urls: ['https://feeds.invalid/one.json', 'https://feeds.invalid/two.json'],
  vendoredDir: path.join(root, 'feeds'),
  fetchImpl: async url => ({ status: 200, ok: true, text: async () => JSON.stringify({ spec: 'model-eol/0.1', publisher: 'remote', generated: '2026-08-01T00:00:00Z', source: url, models: [{ id: url.endsWith('one.json') ? 'remote-one' : 'remote-two' }] }) }),
})
feedTemp = feedDownload.dir
assert(fs.readdirSync(feedTemp).length === 2, 'all feed URLs download before the temporary feed directory is used')
feedDownload.cleanup()
let controlFeedDownloadError = null
try {
  await downloadFeeds({
    urls: ['https://feeds.invalid/control.json'],
    vendoredDir: path.join(root, 'feeds'),
    fetchImpl: async url => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        spec: 'model-eol/0.1',
        publisher: 'remote',
        generated: '2026-08-01T00:00:00Z',
        source: url,
        models: [{ id: 'old-model', replacement: 'new-model\n' }, { id: 'new-model' }],
      }),
    }),
  })
} catch (error) {
  controlFeedDownloadError = error
}
assert(controlFeedDownloadError?.message.includes('replacement') && controlFeedDownloadError.message.includes('control characters'), 'downloadFeeds rejects control characters and names the feed field')

const evalDir = fs.mkdtempSync(path.join(tempRoot, 'eval-'))
const evalPlan = path.join(evalDir, 'plan.json')
write(evalPlan, '{}')
const runEval = (command, overrides = {}) => runEvalHook({
  command,
  timeoutMs: overrides.timeoutMs ?? 1000,
  maxReportBytes: overrides.maxReportBytes ?? 65536,
  passEnv: overrides.passEnv ?? [],
  cwd: evalDir,
  oldId: 'old-model',
  newId: 'new-model',
  planPath: evalPlan,
  reportPath: overrides.reportPath ?? path.join(evalDir, 'report.md'),
})
const passEval = runEval('node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\'')
assert(passEval.status === 'pass' && passEval.exit_code === 0 && passEval.report === 'pass', 'passing eval command reports pass and exit code')
const failEval = runEval('node -e "process.exit(7)"')
assert(failEval.status === 'fail' && failEval.exit_code === 7, 'failing eval command is recorded without throwing')
const missingEval = runEval('node -e "process.exit(0)"')
assert(missingEval.status === 'fail' && missingEval.report.includes('missing'), 'exit-zero eval with missing report fails closed')
const timeoutEval = runEval('node -e "setTimeout(() => {}, 5000)"')
assert(timeoutEval.status === 'timeout', 'timed out eval is killed and reported')
const largeEval = runEval('node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "x".repeat(5 * 1024 * 1024))\'', { maxReportBytes: 128 })
assert(Buffer.byteLength(largeEval.report) <= 128 && largeEval.report.includes('truncated'), 'multi-megabyte eval report is read through the configured byte cap')
const childPidFile = path.join(evalDir, 'eval-child.pid')
const childScript = path.join(evalDir, 'spawn-child.mjs')
write(childScript, `import fs from 'node:fs'
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
setTimeout(() => {}, 10000)
`)
const timeoutWithChild = runEval(`node ${childScript}`, { timeoutMs: 200 })
await new Promise(resolve => setTimeout(resolve, 100))
let childGone = true
if (fs.existsSync(childPidFile)) {
  const childPid = Number.parseInt(fs.readFileSync(childPidFile, 'utf8'), 10)
  try {
    process.kill(childPid, 0)
    childGone = false
  } catch (error) {
    childGone = error.code === 'ESRCH'
  }
}
assert(timeoutWithChild.status === 'timeout' && childGone, 'eval timeout kills the detached process group and its child')

const fifoPath = path.join(evalDir, 'report.fifo')
const fifoProbe = spawnSync('mkfifo', [path.join(evalDir, 'probe.fifo')], { encoding: 'utf8' })
const fifoAvailable = fifoProbe.status === 0
if (fifoAvailable) {
  fs.rmSync(path.join(evalDir, 'probe.fifo'), { force: true })
  const fifoEval = runEval('node -e \'require("child_process").spawnSync("mkfifo", [process.env.MODEL_EOL_REPORT])\'', { reportPath: fifoPath })
  assert(fifoEval.status === 'fail' && fifoEval.report.includes('regular non-symlink'), 'FIFO eval reports an unreadable artifact without blocking')
  fs.rmSync(fifoPath, { force: true })
} else {
  assert(true, 'FIFO eval test skipped because mkfifo is unavailable')
}

const externalEvalRepo = makeRepo({ name: 'external-eval-status', files: baseFiles, config: { issues: { enabled: false } } })
const externalEvalGithub = new FakeGitHub()
const externalReport = path.join(tempRoot, 'external-eval-report.md')
const externalStatus = path.join(tempRoot, 'external-eval-status.txt')
const externalRun = () => runBot({
  repo: 'example/external-eval-status',
  targetDir: externalEvalRepo.work,
  token: 'test-token',
  transport: externalEvalGithub.transport.bind(externalEvalGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  evalReportFile: externalReport,
  evalStatusFile: externalStatus,
  now: new Date('2026-08-01T00:00:00Z'),
})
write(externalReport, 'external report')
write(externalStatus, '0garbage')
const malformedExternal = await externalRun()
assert(malformedExternal.decisions.find(item => item.group.kind === 'model')?.action === 'eval-failed', 'malformed external eval status fails closed')
fs.rmSync(externalStatus, { force: true })
const missingExternal = await externalRun()
assert(missingExternal.decisions.find(item => item.group.kind === 'model')?.action === 'eval-failed', 'missing external eval status fails even with a report')
write(externalStatus, '0')
const cleanExternal = await externalRun()
assert(cleanExternal.decisions.find(item => item.group.kind === 'model')?.action === 'create' && externalEvalGithub.callsFor('POST', '/pulls').length === 1, 'strict zero external eval status permits the patch')

const evalMissingRepo = makeRepo({
  name: 'eval-missing-report',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node -e "process.exit(0)"', timeout_ms: 1000, max_report_bytes: 128, pass_env: [] },
  },
})
const evalMissingGithub = new FakeGitHub()
const evalMissingResult = await runBot({
  repo: 'example/eval-missing-report',
  targetDir: evalMissingRepo.work,
  token: 'test-token',
  transport: evalMissingGithub.transport.bind(evalMissingGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  evalEnabled: true,
  now: new Date('2026-08-01T00:00:00Z'),
})
const evalMissingDecision = evalMissingResult.decisions.find(item => item.group.kind === 'model')
assert(evalMissingDecision?.action === 'eval-failed' && evalMissingGithub.callsFor('POST', '/pulls').length === 0, 'missing eval artifact blocks patch PR creation')
assert(!gitTry(evalMissingRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'failed eval does not push a patch branch')

const extraEvalRepo = makeRepo({
  name: 'eval-extra-file',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node -e \'require("fs").writeFileSync("eval-extra.txt", "extra"); require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\'', timeout_ms: 1000, max_report_bytes: 128, pass_env: [] },
  },
})
const extraEvalGithub = new FakeGitHub()
const extraEvalResult = await runBot({
  repo: 'example/eval-extra-file',
  targetDir: extraEvalRepo.work,
  token: 'test-token',
  transport: extraEvalGithub.transport.bind(extraEvalGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  evalEnabled: true,
  now: new Date('2026-08-01T00:00:00Z'),
})
const extraEvalDecision = extraEvalResult.decisions.find(item => item.group.kind === 'model')
assert(extraEvalDecision?.action === 'eval-failed' && extraEvalDecision.evalResult?.report.includes('unexpected repository file') && extraEvalGithub.callsFor('POST', '/pulls').length === 0, 'eval-created extra files fail the group before commit')
assert(!gitTry(extraEvalRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'extra-file eval failure makes zero commits')

const mutatedEvalRepo = makeRepo({
  name: 'eval-mutated-plan-file',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node -e \'require("fs").appendFileSync("direct.py", "drift"); require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\'', timeout_ms: 1000, max_report_bytes: 128, pass_env: [] },
  },
})
const mutatedEvalGithub = new FakeGitHub()
const mutatedEvalResult = await runBot({
  repo: 'example/eval-mutated-plan-file',
  targetDir: mutatedEvalRepo.work,
  token: 'test-token',
  transport: mutatedEvalGithub.transport.bind(mutatedEvalGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  evalEnabled: true,
  now: new Date('2026-08-01T00:00:00Z'),
})
const mutatedEvalDecision = mutatedEvalResult.decisions.find(item => item.group.kind === 'model')
assert(mutatedEvalDecision?.action === 'eval-failed' && mutatedEvalDecision.evalResult?.report.includes('changed planned file') && mutatedEvalGithub.callsFor('POST', '/pulls').length === 0, 'eval-mutated plan files fail the group before commit')

const cleanRideRepo = makeRepo({
  name: 'eval-clean-ride',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\'', timeout_ms: 1000, max_report_bytes: 128, pass_env: [] },
  },
})
const cleanRideGithub = new FakeGitHub()
const cleanRideResult = await runBot({
  repo: 'example/eval-clean-ride',
  targetDir: cleanRideRepo.work,
  token: 'test-token',
  transport: cleanRideGithub.transport.bind(cleanRideGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  evalEnabled: true,
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(cleanRideResult.decisions.find(item => item.group.kind === 'model')?.action === 'create', 'clean eval ride-along still commits the patch')

const maliciousFeeds = path.join(tempRoot, 'malicious-feeds')
fs.cpSync(path.join(root, 'feeds'), maliciousFeeds, { recursive: true })
const maliciousOpenai = JSON.parse(fs.readFileSync(path.join(maliciousFeeds, 'openai.json'), 'utf8'))
maliciousOpenai.note = '``` # injected heading [x](javascript:alert(1))'
fs.writeFileSync(path.join(maliciousFeeds, 'openai.json'), JSON.stringify(maliciousOpenai, null, 2))
const markdownRepo = makeRepo({ name: 'markdown-sanitization', files: baseFiles, config: { issues: { enabled: false } } })
const markdownGithub = new FakeGitHub()
const markdownResult = await runBot({
  repo: 'example/markdown-sanitization',
  targetDir: markdownRepo.work,
  token: 'test-token',
  transport: markdownGithub.transport.bind(markdownGithub),
  vendoredFeeds: maliciousFeeds,
  now: new Date('2026-08-01T00:00:00Z'),
})
const markdownBody = markdownResult.decisions.find(item => item.group.kind === 'model')?.body || ''
assert(!markdownBody.includes('```') && !markdownBody.includes('# injected heading') && !markdownBody.includes('](javascript:'), 'feed notes cannot break Markdown fences, headings, or links')
assert(markdownBody.includes('[https://developers.openai.com/api/docs/deprecations](https://developers.openai.com/api/docs/deprecations)'), 'HTTPS source URLs remain real Markdown links')

const unlabeledRepo = makeRepo({ name: 'unlabeled-branch', files: baseFiles, config })
const unlabeledGithub = new FakeGitHub()
const unlabeledRun = options => runBot({
  repo: 'example/unlabeled-branch',
  targetDir: unlabeledRepo.work,
  token: 'test-token',
  transport: unlabeledGithub.transport.bind(unlabeledGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const unlabeledFirst = await unlabeledRun()
const unlabeledDecision = unlabeledFirst.decisions.find(item => item.group.kind === 'model')
const unlabeledPull = unlabeledGithub.pulls.find(item => item.number === unlabeledDecision?.number)
if (unlabeledPull) {
  unlabeledPull.labels = []
  unlabeledPull.head.sha = parseMetadata(unlabeledDecision?.body)?.head_sha
}
const unlabeledSecond = await unlabeledRun({ vendoredFeeds: changedFeeds })
assert(unlabeledSecond.decisions.find(item => item.group.kind === 'model')?.action === 'update' && unlabeledGithub.callsFor('POST', '/pulls').length === 1, 'unlabeled bot PR on the expected branch is reused without duplicate creation')

const conflictRepo = makeRepo({ name: 'metadata-conflict', files: baseFiles, config: { issues: { enabled: false } } })
const conflictGithub = new FakeGitHub()
const conflictBranch = branchFor('openai', 'o3-deep-research-2025-06-26')
conflictGithub.pulls.push({
  number: 90,
  state: 'open',
  labels: [],
  body: '<!-- model-eol {"schema":"model-eol.bot/0.1","id":"o3-deep-research-2025-06-26"} -->',
  head: { ref: conflictBranch, sha: null },
})
const conflictResult = await runBot({
  repo: 'example/metadata-conflict',
  targetDir: conflictRepo.work,
  token: 'test-token',
  transport: conflictGithub.transport.bind(conflictGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(conflictResult.decisions.find(item => item.group.kind === 'model')?.action === 'conflict' && conflictGithub.callsFor('POST', '/pulls').length === 0, 'marked malformed metadata produces a visible conflict instead of a duplicate PR')

const raceRepo = makeRepo({ name: 'precreate-race', files: baseFiles, config: { issues: { enabled: false } } })
const raceGithub = new FakeGitHub()
const raceBranch = branchFor('openai', 'o3-deep-research-2025-06-26')
raceGithub.beforeListPulls = (client, count) => {
  if (count !== 2) return
  client.pulls.push({
    number: 91,
    state: 'open',
    labels: [],
    body: metadataLine({
      schema: 'model-eol.bot/0.1',
      id: 'o3-deep-research-2025-06-26',
      publisher: 'openai',
      shutdown: '2026-07-23',
      via: null,
      replacement: 'gpt-5.6-sol',
      head_sha: null,
      feed_digest: 'race',
    }),
    head: { ref: raceBranch, sha: null },
  })
}
const raceResult = await runBot({
  repo: 'example/precreate-race',
  targetDir: raceRepo.work,
  token: 'test-token',
  transport: raceGithub.transport.bind(raceGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(raceResult.decisions.find(item => item.group.kind === 'model')?.action === 'update' && raceGithub.callsFor('POST', '/pulls').length === 0 && raceGithub.calls.some(call => call.method === 'GET' && call.path.endsWith('/pulls') && call.query.includes('head=')), 'pre-create branch check catches an injected PR and avoids a race duplicate')

const probeEnv = 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, JSON.stringify({ path: process.env.PATH, implicitToken: process.env.GITHUB_TOKEN, providerKey: process.env.OPENAI_API_KEY, modelSecret: process.env.MODEL_EOL_SECRET, explicit: process.env.MODEL_EOL_EXPLICIT }))\''
const envNames = ['GITHUB_TOKEN', 'OPENAI_API_KEY', 'MODEL_EOL_SECRET', 'MODEL_EOL_EXPLICIT']
const savedEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
process.env.GITHUB_TOKEN = 'implicit-github-token'
process.env.OPENAI_API_KEY = 'implicit-provider-key'
process.env.MODEL_EOL_SECRET = 'implicit-model-secret'
process.env.MODEL_EOL_EXPLICIT = 'explicit-value'
const scrubbedEnv = JSON.parse(runEval(probeEnv).report)
const passedEnv = JSON.parse(runEval(probeEnv, { passEnv: ['MODEL_EOL_EXPLICIT'] }).report)
assert(scrubbedEnv.path && scrubbedEnv.implicitToken === undefined && scrubbedEnv.providerKey === undefined && scrubbedEnv.modelSecret === undefined, 'eval hook inherits only the base environment allowlist and contract variables')
assert(passedEnv.explicit === 'explicit-value', 'eval hook passes explicitly declared environment names')
for (const name of envNames) {
  if (savedEnv[name] === undefined) delete process.env[name]
  else process.env[name] = savedEnv[name]
}
assert(reportForBody('```untrusted```') === 'untrusted', 'report embedding strips backticks')

const transportCallsBeforeDry = github.calls.length
const dry = await runBot({
  repo: 'example/app',
  targetDir: repo.work,
  dryRun: true,
  transport: async () => { throw new Error('dry-run must not call transport') },
  vendoredFeeds: path.join(root, 'feeds'),
})
assert(dry.decisions.some(item => item.action === 'create'), 'dry-run prints would-be create decisions')
assert(github.calls.length === transportCallsBeforeDry, 'dry-run makes zero GitHub transport calls')
assert(!gitTry(repo.bare, ['show-ref', '--verify', `refs/heads/${branch}-dry-run`]), 'dry-run makes no push')

const mismatchChecker = path.join(tempRoot, 'mismatch-checker.mjs')
write(mismatchChecker, 'console.log(JSON.stringify({ plan_schema: "model-eol.plan/9.9", items: [], issues: [] }))\n')
let mismatchRefused = false
try {
  await runBot({ repo: 'example/app', targetDir: repo.work, dryRun: true, checkerPath: mismatchChecker, vendoredFeeds: path.join(root, 'feeds') })
} catch (error) {
  mismatchRefused = error.message.includes('refusing plan schema')
}
assert(mismatchRefused, 'plan schema mismatch is refused before decisions')

const passEnvConfigFile = path.join(tempRoot, 'pass-env-config.json')
write(passEnvConfigFile, JSON.stringify({ eval: { pass_env: ['CUSTOM_EVAL_KEY'] } }))
assert(loadConfig(passEnvConfigFile).eval.pass_env[0] === 'CUSTOM_EVAL_KEY', 'config accepts explicit eval pass_env names')
const providerPassEnvConfigFile = path.join(tempRoot, 'provider-pass-env-config.json')
write(providerPassEnvConfigFile, JSON.stringify({ eval: { pass_env: ['OPENAI_API_KEY'] } }))
assert(loadConfig(providerPassEnvConfigFile).eval.pass_env[0] === 'OPENAI_API_KEY', 'config permits provider API key pass-through')
const credentialPassEnvConfigFile = path.join(tempRoot, 'credential-pass-env-config.json')
write(credentialPassEnvConfigFile, JSON.stringify({ eval: { pass_env: ['GITHUB_TOKEN'] } }))
let credentialPassEnvError = null
try {
  loadConfig(credentialPassEnvConfigFile)
} catch (error) {
  credentialPassEnvError = error
}
assert(credentialPassEnvError?.message.includes('GITHUB_TOKEN'), 'config rejects credential-like eval pass_env variables by name')

const invalidConfigCases = [
  ['unknown root config key', { day: 30 }, 'day'],
  ['unknown ignore config key', { ignore: { ignores: {} } }, 'ignore.ignores'],
  ['unknown issues config key', { issues: { enabled: true, notify: true } }, 'issues.notify'],
  ['unknown eval config key', { eval: { command: null, shell: 'bash' } }, 'eval.shell'],
  ['unknown feeds config key', { feeds: { allow_vendored_fallback: true, source: 'remote' } }, 'feeds.source'],
]
for (const [label, value, key] of invalidConfigCases) {
  const invalidConfigFile = path.join(tempRoot, label.replaceAll(' ', '-') + '.json')
  write(invalidConfigFile, JSON.stringify(value))
  let error = null
  try {
    loadConfig(invalidConfigFile)
  } catch (caught) {
    error = caught
  }
  assert(error?.message.includes(key), label + ' is rejected with the offending key named')
}

const boundedConfigCases = [
  [{ eval: { max_report_bytes: 0 } }, 'eval.max_report_bytes', 'positive'],
  [{ eval: { max_report_bytes: 8 * 1024 * 1024 + 1 } }, 'eval.max_report_bytes', '8388608'],
  [{ eval: { timeout_ms: 999 } }, 'eval.timeout_ms', '1000'],
  [{ eval: { timeout_ms: 3600001 } }, 'eval.timeout_ms', '3600000'],
]
for (const [value, key, bound] of boundedConfigCases) {
  const boundedFile = path.join(tempRoot, `bounded-${key.replaceAll('.', '-')}-${bound}.json`)
  write(boundedFile, JSON.stringify(value))
  let error = null
  try {
    loadConfig(boundedFile)
  } catch (caught) {
    error = caught
  }
  assert(error?.message.includes(key) && error.message.includes(bound), `${key} rejects values outside its safe bound ${bound}`)
}

const completeConfigFile = path.join(tempRoot, 'complete-config.json')
write(completeConfigFile, JSON.stringify({
  days: 30,
  scope: 'all',
  via: 'aws-bedrock',
  feeds: { allow_vendored_fallback: true },
  ignore: { models: ['old-model'], paths: ['src/generated.py'] },
  issues: { enabled: false },
  eval: { command: 'npm run verify', timeout_ms: 5000, max_report_bytes: 1024, pass_env: ['CI'] },
}))
const completeConfig = loadConfig(completeConfigFile)
assert(completeConfig.feeds.allow_vendored_fallback === true && completeConfig.eval.pass_env[0] === 'CI', 'fully specified config loads through one normalized validation path')

const actionSource = fs.readFileSync(path.join(root, 'action.yml'), 'utf8')
const splitterStart = actionSource.indexOf('        split_model_eol_paths() {\n')
const splitterEnd = actionSource.indexOf('        split_model_eol_paths\n', splitterStart)
const splitterSource = splitterStart >= 0 && splitterEnd > splitterStart
  ? actionSource.slice(splitterStart, splitterEnd).split('\n').map(line => line.startsWith('        ') ? line.slice(8) : line).join('\n')
  : null
const splitActionPaths = value => {
  if (!splitterSource) return null
  const script = splitterSource
    + '\nsplit_model_eol_paths\nprintf \'%s\\0\' "$' + '{PATH_ARGS[@]}"\n'
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, MODEL_EOL_PATHS: value },
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return result.stdout ? result.stdout.split('\0').slice(0, -1) : []
}
assert(splitterSource !== null, 'action exposes its path splitter as a testable shell fragment')
assert(JSON.stringify(splitActionPaths('src\npath with spaces\n\nlib')) === JSON.stringify(['src', 'path with spaces', 'lib']), 'newline-separated action paths preserve spaces and skip empty lines')
assert(JSON.stringify(splitActionPaths('src lib')) === JSON.stringify(['src', 'lib']), 'single-line action paths retain whitespace-split compatibility')

const leaseRepo = makeRepo({
  name: 'identity-lease',
  files: { 'direct.py': fs.readFileSync(path.join(import.meta.dirname, 'fixture/direct.py'), 'utf8') },
})
const leaseGithub = new FakeGitHub()
const leaseRun = options => runBot({
  repo: 'example/identity-lease',
  targetDir: leaseRepo.work,
  token: 'test-token',
  transport: leaseGithub.transport.bind(leaseGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const leaseFirst = await leaseRun()
const leaseDecision = leaseFirst.decisions.find(item => item.group.kind === 'model')
const leaseBranch = branchFor('openai', 'o3-deep-research-2025-06-26')
const leasePull = leaseGithub.pulls.find(item => item.number === leaseDecision?.number)
const leaseMetadata = parseMetadata(leaseDecision?.body)
if (leasePull) leasePull.head.sha = leaseMetadata?.head_sha
const leaseWork = path.join(tempRoot, 'identity-lease-human-work')
fs.mkdirSync(leaseWork)
git(leaseWork, ['clone', `file://${leaseRepo.bare}`, '.'])
git(leaseWork, ['fetch', 'origin', leaseBranch])
git(leaseWork, ['checkout', '-B', leaseBranch, `origin/${leaseBranch}`])
git(leaseWork, ['config', 'user.name', 'fixture'])
git(leaseWork, ['config', 'user.email', 'fixture@example.invalid'])
write(path.join(leaseWork, 'human-change.txt'), 'human change\n')
git(leaseWork, ['add', 'human-change.txt'])
git(leaseWork, ['commit', '-m', 'human change'])
git(leaseWork, ['push', 'origin', `HEAD:refs/heads/${leaseBranch}`])
const leaseHeadBefore = headOf(leaseRepo, leaseBranch)
const identityStandDown = await leaseRun({ vendoredFeeds: changedFeeds })
assert(identityStandDown.decisions.find(item => item.group.kind === 'model')?.action === 'stand-down', 'committer identity mismatch causes stand-down before force-push')
assert(headOf(leaseRepo, leaseBranch) === leaseHeadBefore, 'committer identity mismatch does not push')
assert(leaseGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('forge the configured identity')), 'lease stand-down comment records the residual identity-forgery risk')

const malformedChecker = path.join(tempRoot, 'malformed-plan-checker.mjs')
write(malformedChecker, 'console.log(JSON.stringify({ plan_schema: "model-eol.plan/0.1", items: [{ file: "direct.py", line: 0, occurrence: 0, matched: "old", replacement: "new", expected_line_sha256: "' + '0'.repeat(64) + '" }], issues: [], scan_notes: [] }))\n')
let malformedPlanRefused = false
try {
  await runBot({ repo: 'example/app', targetDir: repo.work, dryRun: true, checkerPath: malformedChecker, vendoredFeeds: path.join(root, 'feeds') })
} catch (error) {
  malformedPlanRefused = error.message.includes('refusing malformed plan document') && error.message.includes('line must be an integer')
}
assert(malformedPlanRefused, 'bot refuses malformed plan items before grouping or applying')

JSON.parse(fs.readFileSync(path.join(root, 'schema/model-eol.bot-config.schema.json'), 'utf8'))
assert(true, 'bot config schema parses as JSON')

fs.rmSync(tempRoot, { recursive: true, force: true })
console.log(failures ? `\n${failures} failure(s)` : '\nall assertions passed')
process.exit(failures ? 1 : 0)
