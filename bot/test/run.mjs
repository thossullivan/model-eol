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
  evaluatePlan,
  formatDecisions,
  main,
  runBot,
  runPlan,
} from '../bot.mjs'
import { branchFor, metadataLine, parseMetadata, slugFor } from '../lib/common.mjs'
import { loadConfig } from '../lib/config.mjs'
import { downloadFeeds } from '../lib/feeds.mjs'
import { reportForBody, runEvalHook } from '../lib/eval.mjs'
import { cloneRepository, deleteRemoteBranch, gitAuthentication, originFor } from '../lib/git.mjs'

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

const deprecatedInlineEval = spawnSync(process.execPath, [path.join(root, 'bot', 'bot.mjs'), '--eval', '--dry-run'], { encoding: 'utf8' })
assert(deprecatedInlineEval.status === 2 && deprecatedInlineEval.stderr.includes('inline --eval was removed') && deprecatedInlineEval.stderr.includes('MODEL_EOL_EVAL_RESULTS_FILE'), 'removed inline --eval fails with read-only evaluate migration guidance')

const deprecatedEvalArtifacts = spawnSync(process.execPath, [path.join(root, 'bot', 'bot.mjs'), '--dry-run'], {
  encoding: 'utf8',
  env: { ...process.env, MODEL_EOL_EVAL_REPORT_FILE: 'legacy-report.md' },
})
assert(deprecatedEvalArtifacts.status === 2 && deprecatedEvalArtifacts.stderr.includes('not commit-bound') && deprecatedEvalArtifacts.stderr.includes('MODEL_EOL_EVAL_RESULTS_FILE'), 'removed unbound eval report/status contract fails with a bound-manifest migration hint')

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

let boundArtifactSequence = 0
const evaluateForPublish = async ({
  targetDir,
  configPath = null,
  vendoredFeeds = path.join(root, 'feeds'),
  checkerPath,
  commandOverride = null,
  now = new Date('2026-08-01T00:00:00Z'),
} = {}) => {
  const selectedConfig = configPath ?? path.join(targetDir, '.model-eol.json')
  const config = loadConfig(selectedConfig)
  const planConfigPath = fs.existsSync(selectedConfig) ? selectedConfig : null
  const plan = runPlan({
    workDir: targetDir,
    config,
    configPath: planConfigPath,
    feedsDir: vendoredFeeds,
    checkerPath,
    warn: () => {},
  })
  const suffix = ++boundArtifactSequence
  const planFile = path.join(tempRoot, `bound-plan-${suffix}.json`)
  const evalResultsFile = path.join(tempRoot, `bound-eval-${suffix}.json`)
  write(planFile, JSON.stringify(plan, null, 2))
  const evaluation = await evaluatePlan({
    targetDir,
    configPath,
    planFile,
    outputFile: evalResultsFile,
    vendoredFeeds,
    checkerPath,
    commandOverride,
    now,
    warn: () => {},
  })
  return { plan, planFile, evalResultsFile, evaluation }
}

const bareBranchFile = (repo, branch, file) => git(repo.bare, ['show', `${branch}:${file}`])
const headOf = (repo, branch) => git(repo.bare, ['rev-parse', `refs/heads/${branch}`])

const stageDefaultBranchAdvance = (repo, name) => {
  write(path.join(repo.work, 'README.md'), `default branch advance for ${name}\n`)
  git(repo.work, ['add', 'README.md'])
  git(repo.work, ['commit', '-m', `stage ${name} default branch advance`])
  const head = git(repo.work, ['rev-parse', 'HEAD'])
  const ref = `refs/heads/model-eol-test-${name}`
  git(repo.work, ['push', 'origin', `HEAD:${ref}`])
  return { head, ref }
}

const advanceDefaultBranchAfterMigrationPush = (repo, branch, nextRef) => {
  const hook = path.join(repo.bare, 'hooks', 'post-receive')
  write(hook, [
    '#!/bin/sh',
    'while read -r _old _new ref',
    'do',
    `  if [ "$ref" = "refs/heads/${branch}" ]`,
    '  then',
    `    git update-ref refs/heads/main ${nextRef}`,
    '  fi',
    'done',
    '',
  ].join('\n'))
  fs.chmodSync(hook, 0o755)
}

const deleteLeaseRepo = makeRepo({ name: 'delete-exact-head-lease', files: { 'README.md': 'first branch head\n' } })
const deleteLeaseBranch = 'model-eol/test-delete-lease'
git(deleteLeaseRepo.work, ['push', 'origin', `HEAD:refs/heads/${deleteLeaseBranch}`])
const deleteLeaseExpectedHead = headOf(deleteLeaseRepo, deleteLeaseBranch)
write(path.join(deleteLeaseRepo.work, 'README.md'), 'second branch head\n')
git(deleteLeaseRepo.work, ['add', 'README.md'])
git(deleteLeaseRepo.work, ['commit', '-m', 'advance leased branch'])
git(deleteLeaseRepo.work, ['push', 'origin', `HEAD:refs/heads/${deleteLeaseBranch}`])
const deleteLeaseCurrentHead = headOf(deleteLeaseRepo, deleteLeaseBranch)
let deleteLeaseError = null
try {
  deleteRemoteBranch(deleteLeaseRepo.work, deleteLeaseBranch, deleteLeaseExpectedHead)
} catch (error) {
  deleteLeaseError = error
}
assert(deleteLeaseError && headOf(deleteLeaseRepo, deleteLeaseBranch) === deleteLeaseCurrentHead, 'remote branch deletion refuses a stale exact-head lease and preserves the newer head')
let malformedDeleteLeaseError = null
try {
  deleteRemoteBranch(deleteLeaseRepo.work, deleteLeaseBranch, 'a'.repeat(41))
} catch (error) {
  malformedDeleteLeaseError = error
}
assert(malformedDeleteLeaseError?.message.includes('exact expected commit') && headOf(deleteLeaseRepo, deleteLeaseBranch) === deleteLeaseCurrentHead, 'remote branch deletion rejects malformed commit lengths before touching the current head')
deleteRemoteBranch(deleteLeaseRepo.work, deleteLeaseBranch, deleteLeaseCurrentHead)
assert(!gitTry(deleteLeaseRepo.bare, ['show-ref', '--verify', `refs/heads/${deleteLeaseBranch}`]), 'remote branch deletion succeeds only with the exact current head')

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
    this.labelExists = false
    this.labelCreateStatus = 201
    this.pullCreateStatus = 201
    this.pullUpdateStatus = 200
    this.pullUpdateApplyBeforeFailure = false
    this.pullUpdateThrowAfterApply = false
  }

  response(data, status = 200) {
    return { status, ok: status < 400, headers: { get: () => null }, json: async () => data }
  }

  async transport(url, options) {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    this.calls.push({ method: options.method, path: parsed.pathname, query: parsed.search, body })
    const pathName = parsed.pathname
    if (options.method === 'GET' && pathName.endsWith('/labels/model-eol')) {
      return this.labelExists
        ? this.response({ name: 'model-eol', color: 'b60205' })
        : this.response({ message: 'Not Found' }, 404)
    }
    if (options.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(pathName)) {
      if (this.labelCreateStatus >= 400) return this.response({ message: 'label creation denied' }, this.labelCreateStatus)
      this.labelExists = true
      return this.response(body, 201)
    }
    if (options.method === 'GET' && pathName.endsWith('/pulls')) {
      this.listPullCount++
      this.beforeListPulls?.(this, this.listPullCount)
      return this.response(this.pulls)
    }
    if (options.method === 'GET' && /\/pulls\/\d+$/.test(pathName)) {
      const number = Number(pathName.split('/').at(-1))
      const pull = this.pulls.find(item => item.number === number)
      return pull ? this.response(pull) : this.response({ message: 'Not Found' }, 404)
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
      if (this.pullCreateStatus >= 400) return this.response({ message: 'pull creation failed' }, this.pullCreateStatus)
      const number = this.nextNumber++
      const created = {
        number,
        state: 'open',
        labels: [{ name: 'model-eol' }],
        body: body.body,
        title: body.title,
        head: { ref: body.head, sha: body.head_sha ?? null, repo: { full_name: parsed.pathname.split('/').slice(2, 4).join('/') } },
        base: { ref: body.base },
      }
      this.pulls.push(created)
      return this.response(created, 201)
    }
    if (options.method === 'POST' && pathName.includes('/issues/') && pathName.endsWith('/labels')) return this.response({ labels: ['model-eol'] })
    if (options.method === 'PATCH' && pathName.includes('/pulls/')) {
      const number = Number(pathName.split('/').at(-1))
      const pull = this.pulls.find(item => item.number === number)
      if (this.pullUpdateStatus >= 400 && !this.pullUpdateApplyBeforeFailure) {
        return this.response({ message: 'pull update failed' }, this.pullUpdateStatus)
      }
      Object.assign(pull, body)
      const metadata = parseMetadata(body.body)
      if (metadata && pull.head) pull.head.sha = metadata.head_sha
      if (this.pullUpdateStatus >= 400) {
        if (this.pullUpdateThrowAfterApply) throw new Error('simulated pull update transport failure after apply')
        return this.response({ message: 'pull update failed after apply' }, this.pullUpdateStatus)
      }
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
}
const lifecycleConfig = {
  ...config,
  eval: {
    command: 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "eval report with ```fence```")\'',
    timeout_ms: 1000,
    max_report_bytes: 65536,
    pass_env: [],
  },
}
const repo = makeRepo({ name: 'lifecycle', files: baseFiles, config: lifecycleConfig })
const github = new FakeGitHub()
const run = async (options = {}) => {
  const vendoredFeeds = options.vendoredFeeds ?? path.join(root, 'feeds')
  const artifacts = await evaluateForPublish({ targetDir: repo.work, vendoredFeeds })
  return runBot({
    repo: 'example/app',
    targetDir: repo.work,
    token: 'test-token',
    transport: github.transport.bind(github),
    vendoredFeeds,
    planFile: artifacts.planFile,
    evalResultsFile: artifacts.evalResultsFile,
    now: new Date('2026-08-01T00:00:00Z'),
    ...options,
  })
}

const first = await run({ tokenKind: 'github-token' })
const firstDecision = first.decisions.find(item => item.group.kind === 'model')
const branch = branchFor('openai', 'o3-deep-research-2025-06-26')
const createCall = github.callsFor('POST', '/pulls')[0]
const metadata = parseMetadata(firstDecision?.body)
const createdPull = github.pulls.find(item => item.number === firstDecision?.number)
if (createdPull) createdPull.head.sha = metadata?.head_sha
assert(firstDecision?.action === 'create', 'create-PR flow returns create decision')
assert(github.callsFor('POST', '/repos/example/app/labels').length === 1, 'first actionable run bootstraps the model-eol repository label')
assert(createCall?.body?.labels === undefined, 'pull create payload leaves label assignment to the label endpoint')
assert(github.calls.filter(call => call.method === 'POST' && call.path.includes('/issues/') && call.path.endsWith('/labels')).length === 1, 'created PR receives the model-eol label')
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

const tentativeBotFeeds = path.join(tempRoot, 'tentative-floor-feeds')
fs.mkdirSync(tentativeBotFeeds)
write(path.join(tentativeBotFeeds, 'anthropic.json'), JSON.stringify({
  spec: 'model-eol/0.1',
  publisher: 'anthropic',
  generated: '2026-09-03T00:00:00Z',
  source: 'https://example.invalid/anthropic',
  policy: { min_notice_days: 60, source: 'https://example.invalid/anthropic' },
  models: [{ id: 'tentative-floor-model', shutdown: '2026-09-29', date_precision: 'earliest' }],
}))
const tentativeBotRepo = makeRepo({
  name: 'tentative-floor',
  files: { 'app.py': 'MODEL = "tentative-floor-model"\n' },
})
const tentativeBotResult = await runBot({
  dryRun: true,
  targetDir: tentativeBotRepo.work,
  vendoredFeeds: tentativeBotFeeds,
  now: new Date('2026-09-03T00:00:00Z'),
})
assert(tentativeBotResult.plan.items.length === 0 && tentativeBotResult.decisions.length === 0, 'tentative-floor models produce no migration item or bot work')

const httpsAuth = gitAuthentication('https://github.com/example/private.git', 'private-token')
assert(httpsAuth?.key === 'http.https://github.com/.extraheader', 'GitHub HTTPS authentication is scoped to the remote host')
assert(httpsAuth?.value.startsWith('AUTHORIZATION: basic ') && !httpsAuth.value.includes('private-token'), 'GitHub token is passed to Git via an encoded header instead of a remote URL')
const gitAuthProbe = spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader', 'https://github.com/example/private.git'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: httpsAuth.key,
    GIT_CONFIG_VALUE_0: httpsAuth.value,
  },
})
assert(gitAuthProbe.status === 0 && gitAuthProbe.stdout.trim() === httpsAuth.value, 'Git accepts the host-scoped authorization header used by private-repository clones and pushes')
assert(gitAuthentication('git@github.com:example/private.git', 'private-token') === null, 'SSH remotes retain their existing authentication instead of receiving an HTTP header')
assert(gitAuthentication('http://github.example.test/example/private.git', 'private-token') === null, 'bot never sends a GitHub token over a plaintext HTTP remote')
assert(gitAuthentication('https://attacker.example/example/private.git', 'private-token') === null, 'bot never sends a GitHub token to a remote outside the configured GitHub API host')
assert(gitAuthentication('https://github.example.test/example/private.git', 'private-token', 'https://github.example.test/api/v3')?.key === 'http.https://github.example.test/.extraheader', 'GitHub Enterprise HTTPS remotes use their configured API host')

const cloneInjectionRepo = makeRepo({ name: 'clone-option-injection', files: { 'README.md': 'fixture\n' } })
const cloneInjectionMarker = path.join(tempRoot, 'clone-option-injection-ran')
const cloneInjectionHelper = path.join(tempRoot, 'clone-option-injection-helper')
write(cloneInjectionHelper, `#!/bin/sh\ntouch "${cloneInjectionMarker}"\nexec git-upload-pack "$@"\n`)
fs.chmodSync(cloneInjectionHelper, 0o755)
const cloneInjectionSource = `--upload-pack=${cloneInjectionHelper}`
git(cloneInjectionRepo.work, ['config', 'remote.origin.url', cloneInjectionSource])
assert(originFor(cloneInjectionRepo.work) === cloneInjectionSource, 'clone hardening covers a poisoned origin read back from repository config')
const cloneInjectionCwd = process.cwd()
let cloneInjectionRejected = false
try {
  process.chdir(tempRoot)
  cloneRepository(originFor(cloneInjectionRepo.work), cloneInjectionRepo.bare)
} catch {
  cloneInjectionRejected = true
} finally {
  process.chdir(cloneInjectionCwd)
}
assert(cloneInjectionRejected && !fs.existsSync(cloneInjectionMarker), 'clone source is separated from Git options so --upload-pack cannot execute a command')

const labelFallbackRepo = makeRepo({ name: 'label-fallback', files: baseFiles, config: { issues: { enabled: false } } })
const labelFallbackGithub = new FakeGitHub()
labelFallbackGithub.labelCreateStatus = 403
const labelWarnings = []
const labelFallbackResult = await runBot({
  repo: 'example/label-fallback',
  targetDir: labelFallbackRepo.work,
  token: 'test-token',
  transport: labelFallbackGithub.transport.bind(labelFallbackGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  warn: message => labelWarnings.push(message),
})
assert(labelFallbackResult.decisions.find(item => item.group.kind === 'model')?.action === 'label-unavailable', 'label bootstrap denial blocks untrusted migration PR creation')
assert(labelWarnings.some(message => message.includes('refusing to publish untrusted work')), 'label bootstrap denial emits a clear fail-closed warning')
assert(labelFallbackGithub.callsFor('POST', '/pulls').length === 0, 'bot performs no PR write when ownership label bootstrap is denied')

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
const unchanged = await run()
assert(unchanged.decisions.find(item => item.group.kind === 'model')?.action === 'skip-unchanged', 'unchanged feed digest does nothing')
assert(github.calls.length > callsAfterCreate && github.callsFor('PATCH', '/pulls').length === 0, 'unchanged state only performs discovery')

const baseFreshRepo = makeRepo({ name: 'base-freshness', files: baseFiles, config: { issues: { enabled: false } } })
const baseFreshGithub = new FakeGitHub()
const baseFreshRun = () => runBot({
  repo: 'example/base-freshness',
  targetDir: baseFreshRepo.work,
  token: 'test-token',
  transport: baseFreshGithub.transport.bind(baseFreshGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const baseFreshFirst = await baseFreshRun()
const baseFreshFirstDecision = baseFreshFirst.decisions.find(item => item.group.kind === 'model')
const baseFreshPull = baseFreshGithub.pulls.find(item => item.number === baseFreshFirstDecision?.number)
if (baseFreshPull) baseFreshPull.head.sha = parseMetadata(baseFreshFirstDecision?.body)?.head_sha
write(path.join(baseFreshRepo.work, 'README.md'), 'unrelated default-branch advance\n')
git(baseFreshRepo.work, ['add', 'README.md'])
git(baseFreshRepo.work, ['commit', '-m', 'advance default branch'])
git(baseFreshRepo.work, ['push', 'origin', 'main'])
const baseFreshSecond = await baseFreshRun()
const baseFreshSecondDecision = baseFreshSecond.decisions.find(item => item.group.kind === 'model')
assert(baseFreshSecondDecision?.action === 'update', 'unchanged finding is regenerated when its recorded default-branch base is stale')
assert(parseMetadata(baseFreshSecondDecision?.body)?.base_sha === headOf(baseFreshRepo, 'main'), 'refreshed PR metadata records the independently cloned default-branch head')

const publishWindowRepo = makeRepo({ name: 'publish-window-drift', files: baseFiles, config: { issues: { enabled: false } } })
const publishWindowGithub = new FakeGitHub()
publishWindowGithub.beforeListPulls = (_api, count) => {
  if (count !== 1) return
  write(path.join(publishWindowRepo.work, 'README.md'), 'default branch moved after the publisher captured its base\n')
  git(publishWindowRepo.work, ['add', 'README.md'])
  git(publishWindowRepo.work, ['commit', '-m', 'move base during publish'])
  git(publishWindowRepo.work, ['push', 'origin', 'main'])
}
let publishWindowError = null
try {
  await runBot({
    repo: 'example/publish-window-drift',
    targetDir: publishWindowRepo.work,
    token: 'test-token',
    transport: publishWindowGithub.transport.bind(publishWindowGithub),
    vendoredFeeds: path.join(root, 'feeds'),
    now: new Date('2026-08-01T00:00:00Z'),
  })
} catch (error) {
  publishWindowError = error
}
assert(publishWindowError?.message.includes('prepared base commit') && publishWindowError.message.includes('does not match evaluated base commit'), 'publisher refuses a patch checkout when the default branch moves after plan and eval verification')
assert(publishWindowGithub.callsFor('POST', '/pulls').length === 0 && !gitTry(publishWindowRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'publish-window base drift fails before patch branch push or pull-request creation')

const postPushCreateRepo = makeRepo({ name: 'post-push-create-base-drift', files: baseFiles, config: { issues: { enabled: false } } })
const postPushCreateGithub = new FakeGitHub()
const postPushCreateBase = headOf(postPushCreateRepo, 'main')
let postPushCreateHead = null
postPushCreateGithub.beforeListPulls = (_api, count) => {
  if (count !== 2) return
  write(path.join(postPushCreateRepo.work, 'README.md'), 'default branch moved after the migration branch push\n')
  git(postPushCreateRepo.work, ['add', 'README.md'])
  git(postPushCreateRepo.work, ['commit', '-m', 'move base after patch push'])
  git(postPushCreateRepo.work, ['push', 'origin', 'main'])
  postPushCreateHead = headOf(postPushCreateRepo, 'main')
}
const postPushCreateResult = await runBot({
  repo: 'example/post-push-create-base-drift',
  targetDir: postPushCreateRepo.work,
  token: 'test-token',
  transport: postPushCreateGithub.transport.bind(postPushCreateGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const postPushCreateDecision = postPushCreateResult.decisions.find(item => item.group.kind === 'model')
assert(
  postPushCreateDecision?.action === 'stand-down'
    && postPushCreateDecision.reason === 'default-branch-moved'
    && postPushCreateDecision.expectedBaseHead === postPushCreateBase
    && postPushCreateDecision.currentBaseHead === postPushCreateHead,
  'new-PR publication stands down when the default branch moves after the migration branch push',
)
assert(postPushCreateGithub.callsFor('POST', '/pulls').length === 0, 'post-push default-branch drift creates no pull request')
assert(!gitTry(postPushCreateRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'post-push refusal deletes the unpublished migration branch under its exact pushed-head lease')

const postPushCreateRecovery = await runBot({
  repo: 'example/post-push-create-base-drift',
  targetDir: postPushCreateRepo.work,
  token: 'test-token',
  transport: postPushCreateGithub.transport.bind(postPushCreateGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const postPushCreateRecoveryDecision = postPushCreateRecovery.decisions.find(item => item.group.kind === 'model')
const postPushCreateRecoveryMetadata = parseMetadata(postPushCreateRecoveryDecision?.body)
assert(postPushCreateRecoveryDecision?.action === 'create' && postPushCreateGithub.callsFor('POST', '/pulls').length === 1, 'a fresh run after new-PR drift creates safe work instead of conflicting with an orphan branch')
assert(postPushCreateRecoveryMetadata?.base_sha === postPushCreateHead && postPushCreateRecoveryMetadata?.head_sha === headOf(postPushCreateRepo, branch), 'new-PR drift recovery binds the receipt to the moved base and regenerated branch head')

const createFailureRepo = makeRepo({ name: 'pull-create-failure-cleanup', files: baseFiles, config: { issues: { enabled: false } } })
const createFailureGithub = new FakeGitHub()
createFailureGithub.pullCreateStatus = 503
const createFailureRun = () => runBot({
  repo: 'example/pull-create-failure-cleanup',
  targetDir: createFailureRepo.work,
  token: 'test-token',
  transport: createFailureGithub.transport.bind(createFailureGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
let createFailureError = null
try {
  await createFailureRun()
} catch (error) {
  createFailureError = error
}
assert(createFailureError?.message.includes('GitHub POST') && createFailureGithub.pulls.length === 0, 'pull-request creation failure is surfaced without publishing a pull request')
assert(!gitTry(createFailureRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'pull-request creation failure deletes its unpublished branch under the exact pushed-head lease')
createFailureGithub.pullCreateStatus = 201
const createFailureRecovery = await createFailureRun()
const createFailureRecoveryDecision = createFailureRecovery.decisions.find(item => item.group.kind === 'model')
assert(createFailureRecoveryDecision?.action === 'create' && parseMetadata(createFailureRecoveryDecision?.body)?.head_sha === headOf(createFailureRepo, branch), 'a retry after pull creation failure safely recreates the branch and pull request')

const latestUpdateFailureRepo = makeRepo({ name: 'latest-open-update-failure', files: baseFiles, config: { issues: { enabled: false } } })
const latestUpdateFailureGithub = new FakeGitHub()
let latestUpdateFailurePull = null
latestUpdateFailureGithub.pullUpdateStatus = 503
latestUpdateFailureGithub.beforeListPulls = (client, count) => {
  if (count !== 2) return
  const pushedHead = headOf(latestUpdateFailureRepo, branch)
  latestUpdateFailurePull = {
    number: 93,
    state: 'open',
    labels: [{ name: 'model-eol' }],
    body: metadataLine({
      schema: 'model-eol.bot/0.1',
      id: 'o3-deep-research-2025-06-26',
      publisher: 'openai',
      shutdown: '2026-07-23',
      via: null,
      replacement: 'gpt-5.6-sol',
      base_sha: headOf(latestUpdateFailureRepo, 'main'),
      head_sha: pushedHead,
      feed_digest: 'concurrent-update-failure',
    }),
    head: { ref: branch, sha: pushedHead, repo: { full_name: 'example/latest-open-update-failure' } },
    base: { ref: 'main' },
  }
  client.pulls.push(latestUpdateFailurePull)
}
let latestUpdateFailureError = null
try {
  await runBot({
    repo: 'example/latest-open-update-failure',
    targetDir: latestUpdateFailureRepo.work,
    token: 'test-token',
    transport: latestUpdateFailureGithub.transport.bind(latestUpdateFailureGithub),
    vendoredFeeds: path.join(root, 'feeds'),
    now: new Date('2026-08-01T00:00:00Z'),
  })
} catch (error) {
  latestUpdateFailureError = error
}
assert(latestUpdateFailureError?.message.includes('GitHub PATCH') && latestUpdateFailurePull?.state === 'open', 'concurrent latestOpen update failure surfaces instead of claiming publication')
assert(!gitTry(latestUpdateFailureRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'concurrent latestOpen without a trusted prior head exact-deletes the pushed branch and becomes unmergeable')

const postPushLatestRepo = makeRepo({ name: 'post-push-latest-open-base-drift', files: baseFiles, config: { issues: { enabled: false } } })
const postPushLatestGithub = new FakeGitHub()
const postPushLatestBase = headOf(postPushLatestRepo, 'main')
let postPushLatestPull = null
postPushLatestGithub.beforeListPulls = (client, count) => {
  if (count !== 2) return
  write(path.join(postPushLatestRepo.work, 'README.md'), 'default branch moved as a concurrent trusted PR appeared\n')
  git(postPushLatestRepo.work, ['add', 'README.md'])
  git(postPushLatestRepo.work, ['commit', '-m', 'move base during latest-open race'])
  git(postPushLatestRepo.work, ['push', 'origin', 'main'])
  const pushedHead = headOf(postPushLatestRepo, branch)
  postPushLatestPull = {
    number: 92,
    state: 'open',
    labels: [{ name: 'model-eol' }],
    body: metadataLine({
      schema: 'model-eol.bot/0.1',
      id: 'o3-deep-research-2025-06-26',
      publisher: 'openai',
      shutdown: '2026-07-23',
      via: null,
      replacement: 'gpt-5.6-sol',
      base_sha: postPushLatestBase,
      head_sha: pushedHead,
      feed_digest: 'concurrent-latest-open',
    }),
    head: { ref: branch, sha: pushedHead, repo: { full_name: 'example/post-push-latest-open-base-drift' } },
    base: { ref: 'main' },
  }
  client.pulls.push(postPushLatestPull)
}
const postPushLatestResult = await runBot({
  repo: 'example/post-push-latest-open-base-drift',
  targetDir: postPushLatestRepo.work,
  token: 'test-token',
  transport: postPushLatestGithub.transport.bind(postPushLatestGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const postPushLatestDecision = postPushLatestResult.decisions.find(item => item.group.kind === 'model')
const postPushLatestMetadata = parseMetadata(postPushLatestPull?.body)
assert(postPushLatestDecision?.action === 'stand-down' && postPushLatestDecision.reason === 'default-branch-moved', 'post-push drift stands down when a trusted latestOpen race appears')
assert(postPushLatestPull?.state === 'closed' && postPushLatestMetadata?.stale_closed === true && postPushLatestMetadata?.head_sha === headOf(postPushLatestRepo, branch), 'detected latestOpen race is closed with stale metadata bound to the pushed head')
assert(postPushLatestGithub.callsFor('POST', '/pulls').length === 0 && !postPushLatestGithub.pulls.some(item => item.state === 'open'), 'latestOpen drift leaves no open unsafe pull request')
assert(postPushLatestGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('default branch moved') && call.body.body?.includes('reevaluated')), 'latestOpen drift records a clear reevaluation comment')

const staleRepo = makeRepo({ name: 'stale-reconciliation', files: baseFiles, config: { issues: { enabled: false } } })
const staleGithub = new FakeGitHub()
const staleRun = () => runBot({
  repo: 'example/stale-reconciliation',
  targetDir: staleRepo.work,
  token: 'test-token',
  transport: staleGithub.transport.bind(staleGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const staleFirst = await staleRun()
const stalePull = staleGithub.pulls.find(item => item.number === staleFirst.decisions.find(record => record.group.kind === 'model')?.number)
write(path.join(staleRepo.work, 'direct.py'), fs.readFileSync(path.join(staleRepo.work, 'direct.py'), 'utf8').replaceAll('o3-deep-research', 'gpt-5.6-sol'))
git(staleRepo.work, ['add', 'direct.py'])
git(staleRepo.work, ['commit', '-m', 'remove retired reference'])
git(staleRepo.work, ['push', 'origin', 'main'])
const staleSecond = await staleRun()
assert(staleSecond.decisions.some(record => record.action === 'close-stale') && stalePull?.state === 'closed', 'vanished finding closes its trusted open bot PR')
assert(staleGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('no longer actionable')), 'stale PR reconciliation records an explanatory comment')
assert(parseMetadata(stalePull?.body)?.stale_closed === true, 'stale PR closure is distinguished from a human dismissal in trusted metadata')
write(path.join(staleRepo.work, 'direct.py'), baseFiles['direct.py'])
git(staleRepo.work, ['add', 'direct.py'])
git(staleRepo.work, ['commit', '-m', 'reintroduce retired reference'])
git(staleRepo.work, ['push', 'origin', 'main'])
const staleThird = await staleRun()
assert(staleThird.decisions.some(record => record.group.kind === 'model' && record.action === 'create'), 'a finding reappearing after automated stale PR closure creates fresh work')
assert(staleGithub.callsFor('POST', '/pulls').length === 2, 'automated stale PR closure never permanently suppresses recurrence')

const unrelatedMarkerRepo = makeRepo({ name: 'unrelated-marker', files: baseFiles, config: { issues: { enabled: false } } })
const unrelatedMarkerGithub = new FakeGitHub()
unrelatedMarkerGithub.pulls.push({
  number: 88,
  state: 'open',
  labels: [],
  body: '<!-- model-eol {malformed} -->',
  head: { ref: 'someone/elses-branch', sha: null, repo: { full_name: 'example/unrelated-marker' } },
  base: { ref: 'main' },
})
const unrelatedMarkerResult = await runBot({
  repo: 'example/unrelated-marker',
  targetDir: unrelatedMarkerRepo.work,
  token: 'test-token',
  transport: unrelatedMarkerGithub.transport.bind(unrelatedMarkerGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(unrelatedMarkerResult.decisions.some(record => record.action === 'create') && !unrelatedMarkerResult.decisions.some(record => record.action === 'conflict'), 'malformed marker on an unrelated branch neither conflicts nor suppresses trusted work')

const changedFeeds = path.join(tempRoot, 'changed-feeds')
fs.cpSync(path.join(root, 'feeds'), changedFeeds, { recursive: true })
const changedOpenai = JSON.parse(fs.readFileSync(path.join(changedFeeds, 'openai.json'), 'utf8'))
changedOpenai.note = 'Changed feed note for lifecycle update'
fs.writeFileSync(path.join(changedFeeds, 'openai.json'), JSON.stringify(changedOpenai, null, 2))

const updateFailureRepo = makeRepo({ name: 'existing-update-failure-rollback', files: baseFiles, config: { issues: { enabled: false } } })
const updateFailureGithub = new FakeGitHub()
const updateFailureRun = options => runBot({
  repo: 'example/existing-update-failure-rollback',
  targetDir: updateFailureRepo.work,
  token: 'test-token',
  transport: updateFailureGithub.transport.bind(updateFailureGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const updateFailureFirst = await updateFailureRun()
const updateFailureFirstDecision = updateFailureFirst.decisions.find(item => item.group.kind === 'model')
const updateFailurePull = updateFailureGithub.pulls.find(item => item.number === updateFailureFirstDecision?.number)
const updateFailureOldBody = updateFailurePull?.body
const updateFailureOldHead = headOf(updateFailureRepo, branch)
const updateFailureBase = headOf(updateFailureRepo, 'main')
if (updateFailurePull) updateFailurePull.head.sha = updateFailureOldHead
updateFailureGithub.pullUpdateStatus = 503
let updateFailureError = null
try {
  await updateFailureRun({ vendoredFeeds: changedFeeds })
} catch (error) {
  updateFailureError = error
}
assert(updateFailureError?.message.includes('GitHub PATCH'), 'existing pull-request body update failure is surfaced')
assert(headOf(updateFailureRepo, branch) === updateFailureOldHead && headOf(updateFailureRepo, 'main') === updateFailureBase, 'failed existing update exact-leases the branch back to its prior trusted head without moving the base')
assert(updateFailurePull?.state === 'open' && updateFailurePull.body === updateFailureOldBody && parseMetadata(updateFailurePull.body)?.head_sha === updateFailureOldHead, 'failed existing update leaves the old pull-request body and restored head aligned')
updateFailureGithub.pullUpdateStatus = 200
const updateFailureRecovery = await updateFailureRun({ vendoredFeeds: changedFeeds })
const updateFailureRecoveryDecision = updateFailureRecovery.decisions.find(item => item.group.kind === 'model')
assert(updateFailureRecoveryDecision?.action === 'update' && headOf(updateFailureRepo, branch) !== updateFailureOldHead, 'a retry after exact-head rollback successfully publishes the regenerated update')
assert(parseMetadata(updateFailurePull?.body)?.head_sha === headOf(updateFailureRepo, branch), 'successful retry realigns the pull-request receipt with the regenerated remote head')

const ambiguousUpdateFeeds = path.join(tempRoot, 'ambiguous-update-feeds')
fs.cpSync(changedFeeds, ambiguousUpdateFeeds, { recursive: true })
const ambiguousUpdateOpenai = JSON.parse(fs.readFileSync(path.join(ambiguousUpdateFeeds, 'openai.json'), 'utf8'))
ambiguousUpdateOpenai.note = 'Ambiguous update response after the body was applied'
fs.writeFileSync(path.join(ambiguousUpdateFeeds, 'openai.json'), JSON.stringify(ambiguousUpdateOpenai, null, 2))
const ambiguousUpdatePriorBody = updateFailurePull?.body
const ambiguousUpdatePriorHead = headOf(updateFailureRepo, branch)
updateFailureGithub.pullUpdateStatus = 503
updateFailureGithub.pullUpdateApplyBeforeFailure = true
let ambiguousUpdateError = null
try {
  await updateFailureRun({ vendoredFeeds: ambiguousUpdateFeeds })
} catch (error) {
  ambiguousUpdateError = error
}
const ambiguousUpdateMetadata = parseMetadata(updateFailurePull?.body)
assert(ambiguousUpdateError?.message.includes('GitHub PATCH') && updateFailurePull?.body !== ambiguousUpdatePriorBody, 'existing update detects a 503 response after GitHub applied the candidate body')
assert(ambiguousUpdateMetadata?.head_sha !== ambiguousUpdatePriorHead && !gitTry(updateFailureRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'ambiguous existing update never rolls a candidate receipt onto the old head; it deletes the candidate branch so the PR is unmergeable')
assert(updateFailureGithub.callsFor('GET', `/pulls/${updateFailurePull?.number}`).length >= 2, 'failed existing updates re-read pull-request state before choosing rollback or deletion')

const latestRollbackRepo = makeRepo({ name: 'latest-open-update-rollback', files: baseFiles, config: { issues: { enabled: false } } })
const latestRollbackGithub = new FakeGitHub()
const latestRollbackRun = options => runBot({
  repo: 'example/latest-open-update-rollback',
  targetDir: latestRollbackRepo.work,
  token: 'test-token',
  transport: latestRollbackGithub.transport.bind(latestRollbackGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const latestRollbackFirst = await latestRollbackRun()
const latestRollbackFirstDecision = latestRollbackFirst.decisions.find(item => item.group.kind === 'model')
const latestRollbackClosed = latestRollbackGithub.pulls.find(item => item.number === latestRollbackFirstDecision?.number)
const latestRollbackOldBody = latestRollbackClosed?.body
const latestRollbackOldHead = headOf(latestRollbackRepo, branch)
if (latestRollbackClosed) {
  const priorMetadata = parseMetadata(latestRollbackClosed.body)
  const lines = latestRollbackClosed.body.split(/\r?\n/)
  lines[0] = metadataLine({ ...priorMetadata, stale_closed: true })
  latestRollbackClosed.body = lines.join('\n')
  latestRollbackClosed.state = 'closed'
  latestRollbackClosed.head.sha = latestRollbackOldHead
}
let latestRollbackOpen = null
latestRollbackGithub.pullUpdateStatus = 503
latestRollbackGithub.beforeListPulls = (client, count) => {
  if (count !== 4) return
  const pushedHead = headOf(latestRollbackRepo, branch)
  latestRollbackOpen = {
    number: 94,
    state: 'open',
    labels: [{ name: 'model-eol' }],
    body: latestRollbackOldBody,
    head: { ref: branch, sha: pushedHead, repo: { full_name: 'example/latest-open-update-rollback' } },
    base: { ref: 'main' },
  }
  client.pulls.push(latestRollbackOpen)
}
let latestRollbackError = null
try {
  await latestRollbackRun({ vendoredFeeds: changedFeeds })
} catch (error) {
  latestRollbackError = error
}
assert(latestRollbackError?.message.includes('GitHub PATCH') && latestRollbackOpen?.body === latestRollbackOldBody, 'concurrent latestOpen update failure preserves its prior trusted body')
assert(headOf(latestRollbackRepo, branch) === latestRollbackOldHead, 'concurrent latestOpen with exact trusted prior metadata rolls the pushed branch back to the available prior head')

const latestAmbiguousRepo = makeRepo({ name: 'latest-open-ambiguous-update', files: baseFiles, config: { issues: { enabled: false } } })
const latestAmbiguousGithub = new FakeGitHub()
const latestAmbiguousRun = options => runBot({
  repo: 'example/latest-open-ambiguous-update',
  targetDir: latestAmbiguousRepo.work,
  token: 'test-token',
  transport: latestAmbiguousGithub.transport.bind(latestAmbiguousGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const latestAmbiguousFirst = await latestAmbiguousRun()
const latestAmbiguousFirstDecision = latestAmbiguousFirst.decisions.find(item => item.group.kind === 'model')
const latestAmbiguousClosed = latestAmbiguousGithub.pulls.find(item => item.number === latestAmbiguousFirstDecision?.number)
const latestAmbiguousOldBody = latestAmbiguousClosed?.body
const latestAmbiguousOldHead = headOf(latestAmbiguousRepo, branch)
if (latestAmbiguousClosed) {
  const priorMetadata = parseMetadata(latestAmbiguousClosed.body)
  const lines = latestAmbiguousClosed.body.split(/\r?\n/)
  lines[0] = metadataLine({ ...priorMetadata, stale_closed: true })
  latestAmbiguousClosed.body = lines.join('\n')
  latestAmbiguousClosed.state = 'closed'
  latestAmbiguousClosed.head.sha = latestAmbiguousOldHead
}
let latestAmbiguousOpen = null
latestAmbiguousGithub.pullUpdateStatus = 503
latestAmbiguousGithub.pullUpdateApplyBeforeFailure = true
latestAmbiguousGithub.pullUpdateThrowAfterApply = true
latestAmbiguousGithub.beforeListPulls = (client, count) => {
  if (count !== 4) return
  const pushedHead = headOf(latestAmbiguousRepo, branch)
  latestAmbiguousOpen = {
    number: 95,
    state: 'open',
    labels: [{ name: 'model-eol' }],
    body: latestAmbiguousOldBody,
    head: { ref: branch, sha: pushedHead, repo: { full_name: 'example/latest-open-ambiguous-update' } },
    base: { ref: 'main' },
  }
  client.pulls.push(latestAmbiguousOpen)
}
let latestAmbiguousError = null
try {
  await latestAmbiguousRun({ vendoredFeeds: changedFeeds })
} catch (error) {
  latestAmbiguousError = error
}
const latestAmbiguousMetadata = parseMetadata(latestAmbiguousOpen?.body)
assert(latestAmbiguousError?.message.includes('transport failure after apply') && latestAmbiguousOpen?.body !== latestAmbiguousOldBody, 'trusted latestOpen path detects a transport failure after the candidate body was applied')
assert(latestAmbiguousMetadata?.head_sha !== latestAmbiguousOldHead && !gitTry(latestAmbiguousRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'ambiguous trusted latestOpen never rolls a candidate receipt onto its old head; exact deletion makes it unmergeable')
assert(latestAmbiguousGithub.callsFor('GET', `/pulls/${latestAmbiguousOpen?.number}`).length === 1, 'failed trusted latestOpen update re-reads pull-request state before rejecting rollback')

const closeFailureRepo = makeRepo({ name: 'post-push-close-failure', files: baseFiles, config: { issues: { enabled: false } } })
const closeFailureGithub = new FakeGitHub()
const closeFailureRun = options => runBot({
  repo: 'example/post-push-close-failure',
  targetDir: closeFailureRepo.work,
  token: 'test-token',
  transport: closeFailureGithub.transport.bind(closeFailureGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const closeFailureFirst = await closeFailureRun()
const closeFailureFirstDecision = closeFailureFirst.decisions.find(item => item.group.kind === 'model')
const closeFailurePull = closeFailureGithub.pulls.find(item => item.number === closeFailureFirstDecision?.number)
if (closeFailurePull) closeFailurePull.head.sha = parseMetadata(closeFailureFirstDecision?.body)?.head_sha
const closeFailureAdvance = stageDefaultBranchAdvance(closeFailureRepo, 'close-failure')
advanceDefaultBranchAfterMigrationPush(closeFailureRepo, branch, closeFailureAdvance.ref)
closeFailureGithub.pullUpdateStatus = 503
let closeFailureError = null
try {
  await closeFailureRun({ vendoredFeeds: changedFeeds })
} catch (error) {
  closeFailureError = error
}
assert(closeFailureError?.message.includes('GitHub PATCH') && closeFailurePull?.state === 'open', 'failed drift closure surfaces the GitHub update error and may leave the pull request open')
assert(!gitTry(closeFailureRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'failed drift closure exact-leases away the newly pushed head so the open pull request is unmergeable')

const postPushUpdateRepo = makeRepo({ name: 'post-push-update-base-drift', files: baseFiles, config: { issues: { enabled: false } } })
const postPushUpdateGithub = new FakeGitHub()
const postPushUpdateRun = options => runBot({
  repo: 'example/post-push-update-base-drift',
  targetDir: postPushUpdateRepo.work,
  token: 'test-token',
  transport: postPushUpdateGithub.transport.bind(postPushUpdateGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
  ...options,
})
const postPushUpdateFirst = await postPushUpdateRun()
const postPushUpdateFirstDecision = postPushUpdateFirst.decisions.find(item => item.group.kind === 'model')
const postPushUpdatePull = postPushUpdateGithub.pulls.find(item => item.number === postPushUpdateFirstDecision?.number)
if (postPushUpdatePull) postPushUpdatePull.head.sha = parseMetadata(postPushUpdateFirstDecision?.body)?.head_sha
const postPushUpdateBase = headOf(postPushUpdateRepo, 'main')
const postPushUpdateBranchBefore = headOf(postPushUpdateRepo, branch)
const postPushUpdateAdvance = stageDefaultBranchAdvance(postPushUpdateRepo, 'update-base-drift')
advanceDefaultBranchAfterMigrationPush(postPushUpdateRepo, branch, postPushUpdateAdvance.ref)
const postPushUpdateResult = await postPushUpdateRun({ vendoredFeeds: changedFeeds })
const postPushUpdateDecision = postPushUpdateResult.decisions.find(item => item.group.kind === 'model')
const postPushUpdateHead = headOf(postPushUpdateRepo, branch)
const postPushUpdateMetadata = parseMetadata(postPushUpdatePull?.body)
assert(
  postPushUpdateDecision?.action === 'stand-down'
    && postPushUpdateDecision.reason === 'default-branch-moved'
    && postPushUpdateDecision.expectedBaseHead === postPushUpdateBase
    && postPushUpdateDecision.currentBaseHead === postPushUpdateAdvance.head,
  'existing-PR publication stands down when the default branch moves after its migration branch push',
)
assert(postPushUpdateGithub.calls.filter(call => call.method === 'PATCH' && call.path.includes('/pulls/')).length === 1 && postPushUpdateGithub.callsFor('POST', '/pulls').length === 1, 'post-push default-branch drift closes the existing pull request without creating another')
assert(postPushUpdatePull?.state === 'closed' && !postPushUpdateGithub.pulls.some(item => item.state === 'open'), 'detected post-push drift leaves no open unsafe pull request')
assert(postPushUpdateMetadata?.stale_closed === true && postPushUpdateMetadata?.head_sha === postPushUpdateHead && postPushUpdateMetadata.head_sha === postPushUpdateDecision?.headSha, 'drift closure records automated stale metadata bound to the newly pushed head')
assert(postPushUpdateHead !== postPushUpdateBranchBefore, 'existing-PR refusal leaves the newly evaluated migration branch available for the next reconciliation')
assert(postPushUpdateGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('default branch moved') && call.body.body?.includes('reevaluated')), 'existing-PR drift records a clear reevaluation comment')

const postPushUpdateRecovery = await postPushUpdateRun({ vendoredFeeds: changedFeeds })
const postPushUpdateRecoveryDecision = postPushUpdateRecovery.decisions.find(item => item.group.kind === 'model')
const postPushUpdateRecoveredPull = postPushUpdateGithub.pulls.find(item => item.number === postPushUpdateRecoveryDecision?.number)
const postPushUpdateRecoveredMetadata = parseMetadata(postPushUpdateRecoveryDecision?.body)
assert(postPushUpdateRecoveryDecision?.action === 'create' && postPushUpdateRecoveredPull?.state === 'open' && postPushUpdatePull?.state === 'closed', 'a fresh run after base refresh creates safe work without reopening the stale PR')
assert(postPushUpdateRecoveredMetadata?.base_sha === headOf(postPushUpdateRepo, 'main') && postPushUpdateRecoveredMetadata?.head_sha === headOf(postPushUpdateRepo, branch), 'recovery PR binds its receipt to the refreshed base and regenerated branch head')

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
const updated = await run({ vendoredFeeds: changedFeeds })
const updateDecision = updated.decisions.find(item => item.group.kind === 'model')
assert(updateDecision?.action === 'update', 'changed digest with intact bot head updates the PR')
assert(headOf(repo, branch) !== beforeUpdateHead, 'changed digest force-pushes a regenerated branch')
assert(github.calls.filter(call => call.method === 'PATCH' && call.path.includes('/pulls/')).length === 1, 'changed digest updates the PR body')
assert(createdPull?.state === 'open' && parseMetadata(createdPull?.body)?.stale_closed !== true, 'successful existing-PR regeneration remains open without stale closure churn')

const foreignHead = '1111111111111111111111111111111111111111'
const pull = github.pulls.find(item => item.number === firstDecision.number)
pull.head.sha = foreignHead
const beforeStandDownHead = headOf(repo, branch)
const changedAgain = path.join(tempRoot, 'changed-again-feeds')
fs.cpSync(changedFeeds, changedAgain, { recursive: true })
const changedAgainOpenai = JSON.parse(fs.readFileSync(path.join(changedAgain, 'openai.json'), 'utf8'))
changedAgainOpenai.note = 'A second changed feed note'
fs.writeFileSync(path.join(changedAgain, 'openai.json'), JSON.stringify(changedAgainOpenai, null, 2))
const spoofResistant = await run({ vendoredFeeds: changedAgain })
const spoofDecision = spoofResistant.decisions.find(item => item.group.kind === 'model')
assert(spoofDecision?.action === 'update', 'stale or forged API head data cannot override the independently verified Git lease')
assert(github.callsFor('POST', '/comments').length === 0, 'verified remote branch avoids a false stand-down comment')
assert(headOf(repo, branch) !== beforeStandDownHead, 'verified remote branch can still receive the lifecycle update')

pull.state = 'closed'
pull.head.sha = parseMetadata(spoofDecision?.body)?.head_sha
pull.body = spoofDecision.body
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

const reintroducedRepo = makeRepo({ name: 'merged-reintroduced', files: baseFiles, config: { issues: { enabled: false } } })
const reintroducedGithub = new FakeGitHub()
const reintroducedRun = () => runBot({
  repo: 'example/merged-reintroduced',
  targetDir: reintroducedRepo.work,
  token: 'test-token',
  transport: reintroducedGithub.transport.bind(reintroducedGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const reintroducedFirst = await reintroducedRun()
const reintroducedDecision = reintroducedFirst.decisions.find(item => item.group.kind === 'model')
const reintroducedBranch = branchFor('openai', 'o3-deep-research-2025-06-26')
const reintroducedPull = reintroducedGithub.pulls.find(item => item.number === reintroducedDecision?.number)
if (reintroducedPull) {
  reintroducedPull.state = 'closed'
  reintroducedPull.merged_at = '2026-08-02T00:00:00Z'
}
write(path.join(reintroducedRepo.work, 'direct.py'), bareBranchFile(reintroducedRepo, reintroducedBranch, 'direct.py'))
git(reintroducedRepo.work, ['add', 'direct.py'])
git(reintroducedRepo.work, ['commit', '-m', 'merge migration'])
git(reintroducedRepo.work, ['push', 'origin', 'main'])
git(reintroducedRepo.bare, ['update-ref', '-d', `refs/heads/${reintroducedBranch}`])
write(path.join(reintroducedRepo.work, 'direct.py'), baseFiles['direct.py'])
git(reintroducedRepo.work, ['add', 'direct.py'])
git(reintroducedRepo.work, ['commit', '-m', 'reintroduce retired model'])
git(reintroducedRepo.work, ['push', 'origin', 'main'])
const reintroducedSecond = await reintroducedRun()
assert(reintroducedSecond.decisions.some(item => item.action === 'create') && reintroducedGithub.callsFor('POST', '/pulls').length === 2, 'a retired model reintroduced after a merged migration creates fresh work')
assert(headOf(reintroducedRepo, reintroducedBranch), 'deleted merged branch is safely recreated for the reintroduced migration')

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
assert(disabled.decisions.some(item => item.group.kind === 'issue' && item.action === 'close-stale') && issueGithub.issues[0].state === 'closed', 'issues.enabled false closes the now-stale bot issue')
assert(issueGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('no longer actionable')), 'stale issue reconciliation explains why the issue was closed')
assert(parseMetadata(issueGithub.issues[0].body)?.stale_closed === true, 'stale issue closure is distinguished from a human dismissal in trusted metadata')
const recurringIssue = await issueRun()
assert(recurringIssue.decisions.some(item => item.group.kind === 'issue' && item.action === 'create'), 'a finding reappearing after automated stale issue closure creates fresh work')
assert(issueGithub.callsFor('POST', '/issues').length === 2, 'automated stale issue closure never permanently suppresses recurrence')

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

const externalConfigRepo = makeRepo({
  name: 'external-config',
  files: {
    'app.py': 'MODEL = "gpt-5.6-sol"\n',
    'ignored/oversized.json': 'x'.repeat(2 * 1024 * 1024 + 1),
  },
})
const externalConfigFile = path.join(tempRoot, 'external-model-eol.json')
write(externalConfigFile, JSON.stringify({ ignore: { paths: ['ignored/**'] }, issues: { enabled: false } }))
const externalConfigRun = await runBot({
  repo: 'example/external-config',
  targetDir: externalConfigRepo.work,
  configPath: externalConfigFile,
  dryRun: true,
  vendoredFeeds: path.join(root, 'feeds'),
})
assert(externalConfigRun.plan.scan_notes.length === 0 && externalConfigRun.decisions.length === 0, 'external --config path is forwarded to the plan subprocess before scan coverage checks')

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
const blockedSummaryFile = path.join(tempRoot, 'blocked-summary.md')
const blockedExit = await main([
  '--dry-run',
  '--target-dir', repo.work,
  '--config', fallbackConfig,
  '--feeds-url', 'https://127.0.0.1:1/feed.json',
], { ...process.env, GITHUB_STEP_SUMMARY: blockedSummaryFile })
const blockedSummary = fs.readFileSync(blockedSummaryFile, 'utf8')
assert(blockedExit === 1, 'report-only blocked decision produces an explicit non-success CLI exit')
assert(blockedSummary.includes('Outcome: **blocked**') && blockedSummary.includes('report-only'), 'blocked CLI outcome is written to the GitHub step summary')

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

const missingBoundRepo = makeRepo({
  name: 'missing-bound-eval',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node scripts/model-eol-eval.mjs' },
  },
})
const missingBoundGithub = new FakeGitHub()
let missingBoundError = null
try {
  await runBot({
    repo: 'example/missing-bound-eval',
    targetDir: missingBoundRepo.work,
    token: 'test-token',
    transport: missingBoundGithub.transport.bind(missingBoundGithub),
    vendoredFeeds: path.join(root, 'feeds'),
    now: new Date('2026-08-01T00:00:00Z'),
  })
} catch (error) {
  missingBoundError = error
}
assert(missingBoundError?.message.includes('configured eval requires MODEL_EOL_EVAL_RESULTS_FILE'), 'configured publication refuses to bypass the read-only evaluator')
assert(missingBoundGithub.calls.length === 0 && !gitTry(missingBoundRepo.bare, ['show-ref', '--verify', `refs/heads/${branch}`]), 'missing bound eval results fail before GitHub API calls or patch pushes')

const evalMissingRepo = makeRepo({
  name: 'eval-missing-report',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: { command: 'node -e "process.exit(0)"', timeout_ms: 1000, max_report_bytes: 128, pass_env: [] },
  },
})
const evalMissingGithub = new FakeGitHub()
const evalMissingArtifacts = await evaluateForPublish({ targetDir: evalMissingRepo.work })
const evalMissingResult = await runBot({
  repo: 'example/eval-missing-report',
  targetDir: evalMissingRepo.work,
  token: 'test-token',
  transport: evalMissingGithub.transport.bind(evalMissingGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  planFile: evalMissingArtifacts.planFile,
  evalResultsFile: evalMissingArtifacts.evalResultsFile,
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
const extraEvalArtifacts = await evaluateForPublish({ targetDir: extraEvalRepo.work })
const extraEvalResult = await runBot({
  repo: 'example/eval-extra-file',
  targetDir: extraEvalRepo.work,
  token: 'test-token',
  transport: extraEvalGithub.transport.bind(extraEvalGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  planFile: extraEvalArtifacts.planFile,
  evalResultsFile: extraEvalArtifacts.evalResultsFile,
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
const mutatedEvalArtifacts = await evaluateForPublish({ targetDir: mutatedEvalRepo.work })
const mutatedEvalResult = await runBot({
  repo: 'example/eval-mutated-plan-file',
  targetDir: mutatedEvalRepo.work,
  token: 'test-token',
  transport: mutatedEvalGithub.transport.bind(mutatedEvalGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  planFile: mutatedEvalArtifacts.planFile,
  evalResultsFile: mutatedEvalArtifacts.evalResultsFile,
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
const cleanRideArtifacts = await evaluateForPublish({ targetDir: cleanRideRepo.work })
const cleanRideResult = await runBot({
  repo: 'example/eval-clean-ride',
  targetDir: cleanRideRepo.work,
  token: 'test-token',
  transport: cleanRideGithub.transport.bind(cleanRideGithub),
  vendoredFeeds: path.join(root, 'feeds'),
  planFile: cleanRideArtifacts.planFile,
  evalResultsFile: cleanRideArtifacts.evalResultsFile,
  now: new Date('2026-08-01T00:00:00Z'),
})
const cleanRideDecision = cleanRideResult.decisions.find(item => item.group.kind === 'model')
const cleanRideMetadata = parseMetadata(cleanRideDecision?.body)
assert(cleanRideDecision?.action === 'create', 'bound passing eval result permits the write-only publisher to commit the patch')
assert(cleanRideDecision?.body.includes('Result: pass') && cleanRideDecision.body.includes('pass') && cleanRideMetadata?.eval_config_digest === cleanRideArtifacts.evaluation.artifact.eval_config_digest, 'published PR records the passing report and exact eval configuration digest')

const durableEvalRepo = makeRepo({ name: 'durable-eval-failure', files: baseFiles })
const durableEvalGithub = new FakeGitHub()
const durableEvalConfigFile = path.join(tempRoot, 'durable-eval-config.json')
const writeDurableEvalConfig = passing => write(durableEvalConfigFile, JSON.stringify({
  issues: { enabled: true },
  eval: {
    command: passing
      ? 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "durable eval passed")\''
      : 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "durable eval failed with ```untrusted``` output");process.exit(7)\'',
    timeout_ms: 1000,
    max_report_bytes: 1024,
    pass_env: [],
  },
}))
const durableEvalRun = async () => {
  const artifacts = await evaluateForPublish({
    targetDir: durableEvalRepo.work,
    configPath: durableEvalConfigFile,
  })
  return runBot({
    repo: 'example/durable-eval-failure',
    targetDir: durableEvalRepo.work,
    configPath: durableEvalConfigFile,
    token: 'test-token',
    transport: durableEvalGithub.transport.bind(durableEvalGithub),
    vendoredFeeds: path.join(root, 'feeds'),
    planFile: artifacts.planFile,
    evalResultsFile: artifacts.evalResultsFile,
    now: new Date('2026-08-01T00:00:00Z'),
  })
}
writeDurableEvalConfig(false)
const durableEvalFailed = await durableEvalRun()
const durableEvalFailedDecision = durableEvalFailed.decisions.find(item => item.group.kind === 'model')
const firstEvalIssue = durableEvalGithub.issues.find(item => item.state === 'open')
const firstEvalIssueMetadata = parseMetadata(firstEvalIssue?.body)
assert(durableEvalFailedDecision?.action === 'eval-failed' && durableEvalFailedDecision.issueAction === 'create', 'failed configured eval creates a durable issue decision')
assert(durableEvalGithub.callsFor('POST', '/pulls').length === 0 && durableEvalGithub.callsFor('POST', '/issues').length === 1, 'failed configured eval opens an issue and never a pull request')
assert(firstEvalIssue?.labels?.some(label => label === 'model-eol' || label.name === 'model-eol') && firstEvalIssueMetadata?.channel === 'configured-eval', 'eval failure issue is labelled and carries a distinct trusted metadata identity')
assert(firstEvalIssue?.body.includes('Result: fail') && firstEvalIssue.body.includes('durable eval failed') && !firstEvalIssue.body.includes('```untrusted```'), 'eval failure issue records a safely fenced bounded report')
const durableEvalStillFailed = await durableEvalRun()
assert(durableEvalStillFailed.decisions.find(item => item.group.kind === 'model')?.issueAction === 'skip-unchanged' && durableEvalGithub.callsFor('POST', '/issues').length === 1, 'persistent eval failure maintains one unchanged durable issue')

const durablePatchCallsBeforeLabelFailure = durableEvalGithub.calls.filter(call => call.method === 'PATCH').length
durableEvalGithub.labelExists = false
durableEvalGithub.labelCreateStatus = 403
const durableLabelUnavailable = await durableEvalRun()
assert(durableLabelUnavailable.decisions.some(item => item.action === 'label-unavailable'), 'transient label denial fails closed before processing configured eval work')
assert(firstEvalIssue?.state === 'open' && durableEvalGithub.calls.filter(call => call.method === 'PATCH').length === durablePatchCallsBeforeLabelFailure, 'label denial preserves an active configured-eval issue without stale reconciliation writes')
durableEvalGithub.labelExists = true
durableEvalGithub.labelCreateStatus = 201

writeDurableEvalConfig(true)
const durableEvalCleared = await durableEvalRun()
const durableEvalPull = durableEvalGithub.pulls.find(item => item.state === 'open')
assert(durableEvalCleared.decisions.some(item => item.group.kind === 'model' && item.action === 'create') && durableEvalPull, 'cleared eval opens the migration pull request')
assert(durableEvalCleared.decisions.some(item => item.group.kind === 'issue' && item.action === 'close-stale') && firstEvalIssue?.state === 'closed' && parseMetadata(firstEvalIssue?.body)?.stale_closed === true, 'cleared eval reconciles its durable issue as stale')

writeDurableEvalConfig(false)
const durableEvalReappeared = await durableEvalRun()
const secondEvalIssue = durableEvalGithub.issues.find(item => item.state === 'open')
assert(durableEvalReappeared.decisions.some(item => item.group.kind === 'model' && item.action === 'eval-failed') && secondEvalIssue?.number !== firstEvalIssue?.number, 'reappearing eval failure creates fresh durable work after automated closure')
assert(durableEvalGithub.callsFor('POST', '/pulls').length === 1 && durableEvalPull?.state === 'closed' && parseMetadata(durableEvalPull?.body)?.stale_closed === true, 'reappearing eval failure closes the trusted bot PR and never opens a failing replacement PR')

writeDurableEvalConfig(true)
const durableEvalClearedAgain = await durableEvalRun()
assert(durableEvalClearedAgain.decisions.some(item => item.group.kind === 'model' && item.action === 'create') && durableEvalGithub.callsFor('POST', '/pulls').length === 2, 'a second cleared eval safely regenerates a fresh migration PR')
assert(secondEvalIssue?.state === 'closed' && parseMetadata(secondEvalIssue?.body)?.stale_closed === true, 'the reappeared eval issue reconciles when the eval clears again')

const channelCollisionRepo = makeRepo({
  name: 'eval-issue-channel-collision',
  files: {
    ...baseFiles,
    'generic.py': 'MODEL = "o3-deep-research"\n',
  },
})
const channelCollisionGithub = new FakeGitHub()
const channelCollisionConfigFile = path.join(tempRoot, 'eval-issue-channel-collision.json')
const writeChannelCollisionConfig = passing => write(channelCollisionConfigFile, JSON.stringify({
  issues: { enabled: true },
  eval: {
    command: passing
      ? 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\''
      : 'node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "fail");process.exit(7)\'',
    timeout_ms: 1000,
    max_report_bytes: 1024,
    pass_env: [],
  },
}))
const channelCollisionRun = async () => {
  const artifacts = await evaluateForPublish({
    targetDir: channelCollisionRepo.work,
    configPath: channelCollisionConfigFile,
  })
  return runBot({
    repo: 'example/eval-issue-channel-collision',
    targetDir: channelCollisionRepo.work,
    configPath: channelCollisionConfigFile,
    token: 'test-token',
    transport: channelCollisionGithub.transport.bind(channelCollisionGithub),
    vendoredFeeds: path.join(root, 'feeds'),
    planFile: artifacts.planFile,
    evalResultsFile: artifacts.evalResultsFile,
    now: new Date('2026-08-01T00:00:00Z'),
  })
}
writeChannelCollisionConfig(false)
await channelCollisionRun()
const collisionEvalIssues = () => channelCollisionGithub.issues.filter(issue => parseMetadata(issue.body)?.channel === 'configured-eval')
const collisionOrdinaryIssues = () => channelCollisionGithub.issues.filter(issue => (parseMetadata(issue.body)?.channel ?? null) === null)
assert(collisionEvalIssues().length === 1 && collisionOrdinaryIssues().length === 1 && channelCollisionGithub.issues.every(issue => issue.state === 'open'), 'a failed eval and ordinary finding for the same model keep distinct issue identities')
await channelCollisionRun()
assert(channelCollisionGithub.issues.length === 2 && parseMetadata(collisionEvalIssues()[0].body)?.channel === 'configured-eval', 'persistent failure maintains both issue channels without overwriting metadata')
writeChannelCollisionConfig(true)
await channelCollisionRun()
assert(collisionEvalIssues()[0].state === 'closed' && collisionOrdinaryIssues()[0].state === 'open', 'clearing eval closes only configured-eval work and preserves the ordinary finding')
writeChannelCollisionConfig(false)
await channelCollisionRun()
assert(collisionEvalIssues().filter(issue => issue.state === 'open').length === 1 && collisionOrdinaryIssues().length === 1 && collisionOrdinaryIssues()[0].state === 'open', 'reappearing eval failure creates fresh eval work without duplicating or suppressing its ordinary sibling')

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
assert(unlabeledSecond.decisions.find(item => item.group.kind === 'model')?.action === 'conflict' && unlabeledGithub.callsFor('POST', '/pulls').length === 1, 'unlabeled work is never trusted or overwritten and its occupied expected branch is a localized conflict')

const conflictRepo = makeRepo({ name: 'metadata-conflict', files: baseFiles, config: { issues: { enabled: false } } })
const conflictGithub = new FakeGitHub()
const conflictBranch = branchFor('openai', 'o3-deep-research-2025-06-26')
conflictGithub.pulls.push({
  number: 90,
  state: 'open',
  labels: [{ name: 'model-eol' }],
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
assert(conflictResult.decisions.find(item => item.group.kind === 'model')?.action === 'conflict' && conflictGithub.callsFor('POST', '/pulls').length === 0, 'labeled malformed metadata on the expected branch produces a localized conflict')

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
assert(raceResult.decisions.find(item => item.group.kind === 'model')?.action === 'conflict' && raceGithub.callsFor('POST', '/pulls').length === 0 && raceGithub.calls.some(call => call.method === 'GET' && call.path.endsWith('/pulls') && call.query.includes('head=')), 'pre-create branch check catches untrusted injected work and avoids a race duplicate')

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
const dryArtifacts = await evaluateForPublish({ targetDir: repo.work })
const dry = await runBot({
  repo: 'example/app',
  targetDir: repo.work,
  dryRun: true,
  transport: async () => { throw new Error('dry-run must not call transport') },
  vendoredFeeds: path.join(root, 'feeds'),
  planFile: dryArtifacts.planFile,
  evalResultsFile: dryArtifacts.evalResultsFile,
})
assert(dry.decisions.some(item => item.action === 'create'), 'dry-run prints would-be create decisions')
assert(dry.decisions.find(item => item.group.kind === 'model')?.body.includes('Result: pass'), 'dry-run consumes the same bound eval result instead of bypassing configured evaluation')
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

const artifactRepo = makeRepo({ name: 'plan-artifact', files: baseFiles, config: { issues: { enabled: false } } })
const artifactConfig = loadConfig(path.join(artifactRepo.work, '.model-eol.json'))
const trustedArtifact = runPlan({
  workDir: artifactRepo.work,
  config: artifactConfig,
  feedsDir: path.join(root, 'feeds'),
  warn: () => {},
})
trustedArtifact.generated = '2000-01-01T00:00:00.000Z'
const artifactFile = path.join(tempRoot, 'trusted-plan-artifact.json')
write(artifactFile, JSON.stringify(trustedArtifact, null, 2))
const acceptedArtifact = await runBot({
  repo: 'example/plan-artifact',
  targetDir: artifactRepo.work,
  dryRun: true,
  planFile: artifactFile,
  vendoredFeeds: path.join(root, 'feeds'),
})
assert(acceptedArtifact.decisions.some(item => item.group.kind === 'model'), 'plan artifact comparison ignores only the volatile generated timestamp')

const tamperedArtifact = {
  ...trustedArtifact,
  items: trustedArtifact.items.map((item, index) => index === 0
    ? { ...item, id: `${item.id}-tampered`, file: 'different.py', replacement: 'attacker-model' }
    : item),
}
const tamperedArtifactFile = path.join(tempRoot, 'tampered-plan-artifact.json')
write(tamperedArtifactFile, JSON.stringify(tamperedArtifact, null, 2))
const artifactGithub = new FakeGitHub()
let tamperedArtifactError = null
try {
  await runBot({
    repo: 'example/plan-artifact',
    targetDir: artifactRepo.work,
    token: 'test-token',
    transport: artifactGithub.transport.bind(artifactGithub),
    planFile: tamperedArtifactFile,
    vendoredFeeds: path.join(root, 'feeds'),
  })
} catch (error) {
  tamperedArtifactError = error
}
assert(tamperedArtifactError?.message.includes('does not match the independently regenerated plan'), 'shape-valid plan artifact mutations to ID, path, or replacement fail closed')
assert(artifactGithub.calls.length === 0, 'tampered plan artifact is rejected before any GitHub reads or writes')

const policyArgsChecker = path.join(tempRoot, 'policy-args-checker.mjs')
write(policyArgsChecker, `const forbidden = process.argv.slice(2).filter(value => ["--days", "--scope", "--via"].includes(value)); if (forbidden.length) { console.error("config masked by " + forbidden.join(",")); process.exit(9) } console.log(JSON.stringify({plan_schema:"model-eol.plan/0.1",generated:new Date().toISOString(),threshold_days:90,via:null,scan_notes:[{reason:"config-only-policy"}],items:[],issues:[]}))\n`)
const policyArgsRepo = makeRepo({
  name: 'policy-args',
  files: baseFiles,
  config: {
    overrides: [{ paths: ['routed/**'], days: 200 }],
    routes: [{ paths: ['routed/**'], via: 'azure-ai-foundry' }],
  },
})
const policyArgsResult = await runBot({
  repo: 'example/policy-args',
  targetDir: policyArgsRepo.work,
  dryRun: true,
  checkerPath: policyArgsChecker,
  vendoredFeeds: path.join(root, 'feeds'),
})
assert(policyArgsResult.plan.scan_notes.some(note => note.reason === 'config-only-policy'), 'bot forwards config without top-level days/scope/via flags that would mask path routes and overrides')

const nullViaRepo = makeRepo({
  name: 'null-via',
  files: { 'direct/direct.py': baseFiles['direct.py'] },
  config: {
    via: 'azure-ai-foundry',
    issues: { enabled: false },
    overrides: [{ paths: ['direct/**'], via: null }],
  },
})
const nullViaResult = await runBot({
  repo: 'example/null-via',
  targetDir: nullViaRepo.work,
  dryRun: true,
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
const nullViaDecision = nullViaResult.decisions.find(item => item.group.kind === 'model')
assert(nullViaResult.plan.items[0]?.requested_via === null && nullViaDecision?.group.via === null, 'bot preserves a path override that resets the repository distributor to the publisher clock')
assert(nullViaDecision?.group.branch === branchFor('openai', 'o3-deep-research-2025-06-26'), 'publisher-clock reset uses the direct migration branch identity')

const partitionCommand = 'node -e \'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.env.MODEL_EOL_PLAN,"utf8"));const file=p.items[0].file;const fail=process.env.MODEL_EOL_OLD_ID.includes("o4-mini");const patched=fs.readFileSync(file,"utf8").includes("gpt-5.6-sol");const text=[patched,process.env.MODEL_EOL_ALLOWED,String(process.env.MODEL_EOL_HIDDEN),p.items.length].join("|")+(fail?"|"+"x".repeat(512):"");fs.writeFileSync(process.env.MODEL_EOL_REPORT,text);process.exit(fail?7:0)\''
const partitionRepo = makeRepo({
  name: 'partition-eval',
  files: {
    'public/direct.py': baseFiles['direct.py'],
    'fail/direct.py': baseFiles['direct.py'].replace('o3-deep-research', 'o4-mini-deep-research'),
  },
  config: {
    days: 90,
    scope: 'direct',
    issues: { enabled: false },
    eval: {
      command: partitionCommand,
      timeout_ms: 1000,
      max_report_bytes: 128,
      pass_env: ['MODEL_EOL_ALLOWED'],
    },
  },
})
const partitionConfigFile = path.join(partitionRepo.work, '.model-eol.json')
const partitionConfig = loadConfig(partitionConfigFile)
const partitionPlan = runPlan({
  workDir: partitionRepo.work,
  config: partitionConfig,
  configPath: partitionConfigFile,
  feedsDir: path.join(root, 'feeds'),
  warn: () => {},
})
assert(partitionPlan.items.length === 2 && new Set(partitionPlan.items.map(item => item.id)).size === 2, 'eval partition fixture contains two independently patchable model groups')
const partitionPlanFile = path.join(tempRoot, 'partition-plan.json')
const partitionEvalFile = path.join(tempRoot, 'partition-eval.json')
write(partitionPlanFile, JSON.stringify(partitionPlan, null, 2))
const savedAllowed = process.env.MODEL_EOL_ALLOWED
const savedHidden = process.env.MODEL_EOL_HIDDEN
process.env.MODEL_EOL_ALLOWED = 'explicit-pass-env'
process.env.MODEL_EOL_HIDDEN = 'must-not-leak'
const partitionEvaluation = await evaluatePlan({
  targetDir: partitionRepo.work,
  configPath: partitionConfigFile,
  planFile: partitionPlanFile,
  outputFile: partitionEvalFile,
  vendoredFeeds: path.join(root, 'feeds'),
  commandOverride: null,
  now: new Date('2026-08-01T00:00:00Z'),
})
if (savedAllowed === undefined) delete process.env.MODEL_EOL_ALLOWED
else process.env.MODEL_EOL_ALLOWED = savedAllowed
if (savedHidden === undefined) delete process.env.MODEL_EOL_HIDDEN
else process.env.MODEL_EOL_HIDDEN = savedHidden
const partitionPass = partitionEvaluation.artifact.results.find(item => item.status === 'pass')
const partitionFail = partitionEvaluation.artifact.results.find(item => item.status === 'fail')
assert(partitionEvaluation.artifact.results.length === 2 && partitionPass && partitionFail, 'isolated evaluator records an independent pass/fail result for every migration group')
assert(partitionEvaluation.artifact.base_sha === headOf(partitionRepo, 'main'), 'eval manifest records the exact evaluated default-branch commit')
assert(partitionPass.report.includes('true|explicit-pass-env|undefined|1'), 'per-group eval sees the patched migration, selected one-item plan, and explicit pass_env only')
assert(Buffer.byteLength(partitionFail.report) <= 128 && partitionFail.report.includes('truncated'), 'per-group eval report honors the configured byte cap')

const movingSourceCommand = 'node -e \'const fs=require("fs");const {spawnSync}=require("child_process");fs.writeFileSync(process.env.MODEL_EOL_REPORT,"pass");const r=spawnSync("git",["-C",process.env.MODEL_EOL_TEST_SOURCE,"commit","--allow-empty","-m","move source during eval"],{stdio:"ignore"});process.exit(r.status??1)\''
const movingSourceRepo = makeRepo({
  name: 'moving-eval-source',
  files: baseFiles,
  config: {
    issues: { enabled: false },
    eval: {
      command: movingSourceCommand,
      timeout_ms: 1000,
      max_report_bytes: 128,
      pass_env: ['MODEL_EOL_TEST_SOURCE'],
    },
  },
})
const movingSourceConfigFile = path.join(movingSourceRepo.work, '.model-eol.json')
const movingSourcePlan = runPlan({
  workDir: movingSourceRepo.work,
  config: loadConfig(movingSourceConfigFile),
  configPath: movingSourceConfigFile,
  feedsDir: path.join(root, 'feeds'),
  warn: () => {},
})
const movingSourcePlanFile = path.join(tempRoot, 'moving-source-plan.json')
const movingSourceEvalFile = path.join(tempRoot, 'moving-source-eval.json')
write(movingSourcePlanFile, JSON.stringify(movingSourcePlan, null, 2))
const savedEvalSource = process.env.MODEL_EOL_TEST_SOURCE
process.env.MODEL_EOL_TEST_SOURCE = movingSourceRepo.work
let movingSourceError = null
try {
  await evaluatePlan({
    targetDir: movingSourceRepo.work,
    configPath: movingSourceConfigFile,
    planFile: movingSourcePlanFile,
    outputFile: movingSourceEvalFile,
    vendoredFeeds: path.join(root, 'feeds'),
    commandOverride: null,
  })
} catch (error) {
  movingSourceError = error
} finally {
  if (savedEvalSource === undefined) delete process.env.MODEL_EOL_TEST_SOURCE
  else process.env.MODEL_EOL_TEST_SOURCE = savedEvalSource
}
assert(movingSourceError?.message.includes('target commit changed during migration evaluation') && !fs.existsSync(movingSourceEvalFile), 'evaluator never labels earlier results with a base commit that moved during evaluation')

const timeoutEvalFile = path.join(tempRoot, 'partition-timeout-eval.json')
const timeoutEvaluation = await evaluatePlan({
  targetDir: partitionRepo.work,
  configPath: partitionConfigFile,
  planFile: partitionPlanFile,
  outputFile: timeoutEvalFile,
  vendoredFeeds: path.join(root, 'feeds'),
  commandOverride: 'node -e \'setTimeout(()=>{},10000)\'',
})
assert(timeoutEvaluation.artifact.results.every(item => item.status === 'timeout'), 'isolated evaluator applies eval.timeout_ms to each migration')

const partitionGithub = new FakeGitHub()
const partitionPublished = await runBot({
  repo: 'example/partition-eval',
  targetDir: partitionRepo.work,
  token: 'test-token',
  transport: partitionGithub.transport.bind(partitionGithub),
  planFile: partitionPlanFile,
  evalResultsFile: partitionEvalFile,
  vendoredFeeds: path.join(root, 'feeds'),
  now: new Date('2026-08-01T00:00:00Z'),
})
assert(partitionPublished.decisions.filter(item => item.action === 'create').length === 1 && partitionPublished.decisions.filter(item => item.action === 'eval-failed').length === 1, 'publish partitions eval outcomes so passing work is created while its failing peer is blocked')
assert(partitionGithub.callsFor('POST', '/pulls').length === 1, 'per-group eval failure cannot suppress a different passing migration or publish itself')

const digestTamper = JSON.parse(fs.readFileSync(partitionEvalFile, 'utf8'))
digestTamper.plan_digest = '0'.repeat(64)
const digestTamperFile = path.join(tempRoot, 'partition-eval-tampered.json')
write(digestTamperFile, JSON.stringify(digestTamper, null, 2))
const digestTamperGithub = new FakeGitHub()
let digestTamperError = null
try {
  await runBot({
    repo: 'example/partition-eval',
    targetDir: partitionRepo.work,
    token: 'test-token',
    transport: digestTamperGithub.transport.bind(digestTamperGithub),
    planFile: partitionPlanFile,
    evalResultsFile: digestTamperFile,
    vendoredFeeds: path.join(root, 'feeds'),
  })
} catch (error) {
  digestTamperError = error
}
assert(digestTamperError?.message.includes('plan digest') && digestTamperGithub.calls.length === 0, 'tampered eval digest is rejected before any GitHub read or write')

write(path.join(partitionRepo.work, 'README.md'), 'default branch advanced after evaluation\n')
git(partitionRepo.work, ['add', 'README.md'])
git(partitionRepo.work, ['commit', '-m', 'advance runtime after evaluation'])
git(partitionRepo.work, ['push', 'origin', 'main'])
const baseDriftGithub = new FakeGitHub()
let baseDriftError = null
try {
  await runBot({
    repo: 'example/partition-eval',
    targetDir: partitionRepo.work,
    token: 'test-token',
    transport: baseDriftGithub.transport.bind(baseDriftGithub),
    planFile: partitionPlanFile,
    evalResultsFile: partitionEvalFile,
    vendoredFeeds: path.join(root, 'feeds'),
  })
} catch (error) {
  baseDriftError = error
}
assert(baseDriftError?.message.includes('evaluated base commit') && baseDriftError.message.includes('does not match current default-branch head'), 'publish refuses eval results produced against an older default-branch commit')
assert(baseDriftGithub.calls.length === 0, 'evaluated-base drift is rejected before any GitHub read or write')

const unavailableChecker = path.join(tempRoot, 'shutdown-unavailable-checker.mjs')
write(unavailableChecker, `console.log(JSON.stringify({plan_schema:"model-eol.plan/0.1",generated:new Date().toISOString(),threshold_days:90,via:null,scan_notes:[],items:[],issues:[{file:"direct.py",line:1,matched:"retired-without-date",id:"retired-without-date",publisher:"google",usage:"direct-api",confidence:"high",status:"retired",shutdown:null,via:"vertex-ai",requested_via:"vertex-ai",reason:"shutdown-date-unavailable",sources:[],notes:null}]}))\n`)
const unavailableRepo = makeRepo({ name: 'shutdown-unavailable', files: baseFiles })
const unavailableResult = await runBot({
  repo: 'example/shutdown-unavailable',
  targetDir: unavailableRepo.work,
  dryRun: true,
  checkerPath: unavailableChecker,
  vendoredFeeds: path.join(root, 'feeds'),
})
assert(unavailableResult.decisions.some(item => item.group.kind === 'issue' && item.body.includes('shutdown-date-unavailable')), 'retired distributor finding without a shutdown date becomes an actionable bot issue')

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
const identityStandDown = await leaseRun()
assert(identityStandDown.decisions.find(item => item.group.kind === 'model')?.action === 'stand-down', 'unchanged open PR still validates freshness and stands down on a committer identity mismatch')
assert(headOf(leaseRepo, leaseBranch) === leaseHeadBefore, 'committer identity mismatch does not push')
assert(leaseGithub.callsFor('POST', '/comments').some(call => call.body.body?.includes('forge the configured identity')), 'lease stand-down comment records the residual identity-forgery risk')

const malformedChecker = path.join(tempRoot, 'malformed-plan-checker.mjs')
write(malformedChecker, 'console.log(JSON.stringify({ plan_schema: "model-eol.plan/0.1", generated: new Date().toISOString(), threshold_days: 90, via: null, items: [{ file: "direct.py", line: 0, occurrence: 0, matched: "old", replacement: "new", expected_line_sha256: "' + '0'.repeat(64) + '", id: "old", publisher: "openai", shutdown: "2026-07-01", days: -31, status: "retired", sources: [], notes: null }], issues: [], scan_notes: [] }))\n')
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
