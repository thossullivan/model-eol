#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  buildPullBody,
  runBot,
} from '../bot.mjs'
import { branchFor, parseMetadata, slugFor } from '../lib/common.mjs'
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
  }

  response(data, status = 200) {
    return { status, ok: status < 400, headers: { get: () => null }, json: async () => data }
  }

  async transport(url, options) {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : null
    this.calls.push({ method: options.method, path: parsed.pathname, query: parsed.search, body })
    const pathName = parsed.pathname
    if (options.method === 'GET' && pathName.endsWith('/pulls')) return this.response(this.pulls)
    if (options.method === 'GET' && pathName.endsWith('/issues')) return this.response(this.issues)
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
assert(metadata?.schema === 'model-eol.bot/0.1' && metadata.publisher === 'openai', 'PR has the machine-readable metadata block')
assert(firstDecision.body.includes('## What / when') && firstDecision.body.includes('## Replacement') && firstDecision.body.includes('## Sources') && firstDecision.body.includes('## Feed notes'), 'PR body has lifecycle, replacement, source, and note sections')
assert(firstDecision.body.includes('Treat as a snapshot in time, not a constant.'), 'PR body renders the snapshot caveat verbatim')
assert(firstDecision.body.includes('## Checklist') && firstDecision.body.includes('Review the diff'), 'PR body has the review checklist')
assert(firstDecision.body.includes('checks may be skipped') && firstDecision.body.includes('GITHUB_TOKEN'), 'github-token PR body carries the checks warning')
assert(bareBranchFile(repo, branch, 'direct.py').includes('gpt-5.6-sol'), 'create flow pushes the migration branch to the bare repo')
assert(!fs.readFileSync(path.join(repo.work, 'direct.py'), 'utf8').includes('gpt-5.6-sol'), 'caller checkout is not modified')
assert(firstDecision.body.includes('eval report with fence') && !firstDecision.body.includes('```fence```'), 'eval report is embedded fenced with backticks stripped')
assert(firstDecision.body.includes('Result: pass') && firstDecision.body.includes('exit code 0'), 'passing eval result is recorded')
assert(Array.isArray(first.config.eval.pass_env) && first.config.eval.pass_env.length === 0, 'eval config defaults to an empty pass_env allowlist')

const callsAfterCreate = github.calls.length
const unchanged = await run({ evalEnabled: true })
assert(unchanged.decisions.find(item => item.group.kind === 'model')?.action === 'skip-unchanged', 'unchanged feed digest does nothing')
assert(github.calls.length > callsAfterCreate && github.callsFor('PATCH', '/pulls').length === 0, 'unchanged state only performs discovery')

const changedFeeds = path.join(tempRoot, 'changed-feeds')
fs.cpSync(path.join(root, 'feeds'), changedFeeds, { recursive: true })
const changedOpenai = JSON.parse(fs.readFileSync(path.join(changedFeeds, 'openai.json'), 'utf8'))
changedOpenai.note = 'Changed feed note for lifecycle update'
fs.writeFileSync(path.join(changedFeeds, 'openai.json'), JSON.stringify(changedOpenai, null, 2))
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

const warnings = []
const fallback = await runBot({
  repo: 'example/app',
  targetDir: repo.work,
  dryRun: true,
  feedsUrls: ['https://feeds.invalid/a.json', 'https://feeds.invalid/b.json'],
  fetchImpl: async url => url.endsWith('b.json') ? { status: 500, ok: false } : { status: 200, ok: true, text: async () => JSON.stringify({ spec: 'model-eol/0.1', models: [] }) },
  vendoredFeeds: path.join(root, 'feeds'),
  warn: message => warnings.push(message),
})
assert(fallback.decisions.some(item => item.group.kind === 'model'), 'failed feed download falls back to vendored feeds')
assert(warnings.some(message => message.includes('using vendored feeds')), 'feed fallback emits a warning')

let feedTemp
const feedDownload = await downloadFeeds({
  urls: ['https://feeds.invalid/one.json', 'https://feeds.invalid/two.json'],
  vendoredDir: path.join(root, 'feeds'),
  fetchImpl: async url => ({ status: 200, ok: true, text: async () => JSON.stringify({ spec: 'model-eol/0.1', models: [{ id: url }] }) }),
})
feedTemp = feedDownload.dir
assert(fs.readdirSync(feedTemp).length === 2, 'all feed URLs download before the temporary feed directory is used')
feedDownload.cleanup()

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
  reportPath: path.join(evalDir, 'report.md'),
})
const passEval = runEval('node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "pass")\'')
assert(passEval.status === 'pass' && passEval.exit_code === 0 && passEval.report === 'pass', 'passing eval command reports pass and exit code')
const failEval = runEval('node -e "process.exit(7)"')
assert(failEval.status === 'fail' && failEval.exit_code === 7, 'failing eval command is recorded without throwing')
const timeoutEval = runEval('node -e "setTimeout(() => {}, 5000)"')
assert(timeoutEval.status === 'timeout', 'timed out eval is killed and reported')
const largeEval = runEval('node -e \'require("fs").writeFileSync(process.env.MODEL_EOL_REPORT, "x".repeat(200))\'', { maxReportBytes: 100 })
assert(largeEval.report.length <= 1000 && largeEval.report.includes('truncated'), 'oversized eval report is capped with a marker')

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
