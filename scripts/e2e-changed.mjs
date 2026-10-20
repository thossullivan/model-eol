#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { parseCliArgs } from '../lib/cli.mjs'

const usage = 'Usage: node scripts/e2e-changed.mjs --checker PATH/check.mjs --repo DIR [--repo DIR ...] [--commits N] [--synthetic] [--mutations a,b,...] [--policy broad|config] [--feeds-source DIR] [--timeout-seconds N] [--out FILE] [--keep]'
// broad pins every finding into view; config lets each tree's .model-eol.json decide days and scope.
const POLICY_FLAGS = { broad: ['--json', '--days', '90', '--scope', 'all'], config: ['--json'] }
const MUTATIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']
// Config days and scope only reach the checker when the command line does not pin them; routed references are cloud or gateway, which only scope all checks.
const MUTATION_POLICY = { a: 'config', i: 'config', j: 'broad' }
const CODE_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rb', '.java', '.kt', '.rs', '.php', '.cs', '.swift', '.scala'])
const BEDROCK_LINE = 'bedrock = boto3.client("bedrock-runtime")'
const IN_REPO_FEEDS = 'e2e-feeds'
const UNTRACKED_FILE = 'e2e_untracked.py'
const SLOW_FACTOR = 3
const SLOW_GRACE_MS = 2000
const DEFAULT_TIMEOUT_SECONDS = 600
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

const settings = { timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000 }
const liveTempRoots = new Set()
const running = new Map()
let stopping = null

class InterruptedError extends Error {
  constructor(signal) {
    super(`interrupted by ${signal}`)
    this.signal = signal
  }
}

const usageError = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  return error
}

const cleanEnv = () => {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_DIFF_OPTS', 'GIT_EXTERNAL_DIFF']) delete env[name]
  return env
}

// The harness's own git runs ignore user and system config so blame and commits are reproducible.
const gitEnv = () => ({ ...cleanEnv(), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })

const GIT_IDENTITY = ['-c', 'user.name=model-eol e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`]

const killGroup = child => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
  }
}

// Each child leads its own process group, so a timeout or a signal to the harness kills its grandchildren too.
const run = (command, args, { cwd, env }) => new Promise((resolve, reject) => {
  if (stopping) {
    reject(new InterruptedError(stopping))
    return
  }
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const stdout = []
  const stderr = []
  let timedOut = false
  let spawnError = null
  const timer = setTimeout(() => {
    timedOut = true
    killGroup(child)
  }, settings.timeoutMs)
  const closed = new Promise(done => child.on('close', done))
  running.set(child, closed)
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.on('error', error => {
    spawnError = error
  })
  child.on('exit', () => {
    if (timedOut || stopping) {
      child.stdout.destroy()
      child.stderr.destroy()
    }
  })
  closed.then(status => {
    clearTimeout(timer)
    running.delete(child)
    if (stopping) {
      reject(new InterruptedError(stopping))
      return
    }
    resolve({
      status: spawnError || timedOut ? null : status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      error: spawnError,
      timedOut,
    })
  })
})

const git = async (cwd, args, { allowFail = false } = {}) => {
  const result = await run('git', [...GIT_IDENTITY, ...args], { cwd, env: gitEnv() })
  if (!allowFail && (result.error || result.timedOut || result.status !== 0)) {
    const detail = result.timedOut ? `timed out after ${settings.timeoutMs / 1000}s` : result.error?.message || result.stderr.trim() || `exit ${result.status}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

export const isBad = finding =>
  (finding.status === 'retired' || finding.status === 'retiring') && finding.waiver?.active !== true

const repoPath = file => {
  const value = String(file)
  return (path.sep === '\\' ? value.replaceAll('\\', '/') : value).replace(/^\.\//, '')
}

const keyOf = (file, line, id, matched) => JSON.stringify([repoPath(file), line, id, matched])

const unquoteC = value => {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const bytes = []
  const escapes = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, '"': 34 }
  const body = Buffer.from(value.slice(1, -1), 'utf8')
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== 92) {
      bytes.push(body[index])
      continue
    }
    const next = String.fromCharCode(body[++index])
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.subarray(index, index + 3).toString('latin1'), 8))
      index += 2
    } else {
      bytes.push(escapes[next] ?? body[index])
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// Maps each head line of FILE to { base: true, file, line } when git blame attributes it to BASE itself, else { base: false }.
// --first-parent keeps lines a merge brings from its side branch on the merge, not on that branch's boundary.
export const blameLineMap = async (cwd, base, head, file) => {
  const result = await git(cwd, [
    '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true', '-c', 'core.quotePath=false',
    'blame', '--line-porcelain', '--first-parent', `${base}..${head}`, '--', file,
  ])
  const lines = new Map()
  let current = null
  for (const line of result.stdout.split('\n')) {
    if (current === null) {
      const header = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/)
      if (header) current = { sha: header[1], origLine: Number(header[2]), finalLine: Number(header[3]), filename: null, boundary: false }
      continue
    }
    if (line === 'boundary') {
      current.boundary = true
      continue
    }
    if (line.startsWith('filename ')) {
      current.filename = unquoteC(line.slice('filename '.length))
      continue
    }
    if (line.startsWith('\t')) {
      lines.set(current.finalLine, current.sha === base
        ? { base: true, file: current.filename, line: current.origLine }
        : current.boundary ? { base: false, boundary: current.sha } : { base: false })
      current = null
    }
  }
  return lines
}

const diffPath = (value, prefix) => {
  const name = unquoteC(value.replace(/\t$/, ''))
  return name === '/dev/null' ? null : name.startsWith(prefix) ? name.slice(prefix.length) : name
}

// Parses git diff -U0 BASE HEAD (or BASE against the working tree when HEAD is null) into per-head-file records, independent of lib/scanner.mjs.
export const diffFileRecords = async (cwd, base, head = null) => {
  const result = await git(cwd, [
    '-c', 'core.quotePath=false', '-c', 'diff.relative=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text',
    '--find-renames', '--diff-algorithm=myers', '--indent-heuristic', '--inter-hunk-context=0', '--unified=0',
    '--src-prefix=a/', '--dst-prefix=b/', base, ...(head ? [head] : []),
  ])
  const records = new Map()
  let header = null
  const finish = () => {
    if (!header) return
    const headPath = header.plus ?? header.renameTo
    if (headPath) records.set(headPath, { basePath: header.renameFrom ?? (header.sawMinus ? header.minus : headPath), hunks: header.hunks })
  }
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish()
      header = { minus: null, sawMinus: false, plus: null, renameFrom: null, renameTo: null, hunks: [], inHunk: false }
      continue
    }
    if (!header) continue
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      header.inHunk = true
      header.hunks.push({ oldStart: Number(hunk[1]), oldCount: hunk[2] === undefined ? 1 : Number(hunk[2]), newStart: Number(hunk[3]), newCount: hunk[4] === undefined ? 1 : Number(hunk[4]) })
      continue
    }
    if (header.inHunk) continue
    if (line.startsWith('rename from ')) header.renameFrom = unquoteC(line.slice('rename from '.length))
    else if (line.startsWith('rename to ')) header.renameTo = unquoteC(line.slice('rename to '.length))
    else if (line.startsWith('--- ')) {
      header.minus = diffPath(line.slice(4), 'a/')
      header.sawMinus = true
    } else if (line.startsWith('+++ ')) header.plus = diffPath(line.slice(4), 'b/')
  }
  finish()
  return records
}

export const diffLineMap = (records, file, line) => {
  const record = records.get(file)
  if (!record) return { base: true, file, line }
  if (record.basePath === null) return { base: false }
  let offset = 0
  for (const hunk of record.hunks) {
    if (hunk.newCount > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return { base: false }
    const newEnd = hunk.newCount === 0 ? hunk.newStart : hunk.newStart + hunk.newCount - 1
    if (newEnd < line) offset += hunk.newCount - hunk.oldCount
  }
  return { base: true, file: record.basePath, line: line - offset }
}

const runChecker = async ({ checker, cwd, target = '.', args, env }) => {
  const started = performance.now()
  const result = await run(process.execPath, [checker, 'check', target, ...args], { cwd, env })
  const ms = Math.round(performance.now() - started)
  let doc = null
  try {
    doc = JSON.parse(result.stdout)
  } catch {
  }
  const code = result.status
  const usable = (code === 0 || code === 1) && Array.isArray(doc?.findings)
  const stderr = String(result.error?.message ?? result.stderr ?? '').trim()
  const error = usable ? null : result.timedOut
    ? `timed out after ${settings.timeoutMs / 1000}s`
    : (stderr.split('\n').slice(0, 5).join(' | ') || `exit ${code} without a check document`)
  return { code, ms, findings: usable ? doc.findings : null, error, timedOut: result.timedOut, incomplete: code === 2 && /INCOMPLETE SCAN/.test(stderr) }
}

const withOccurrences = findings => {
  const seen = new Map()
  return findings.map(finding => {
    const key = keyOf(finding.file, finding.line, finding.id, finding.matched)
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    return { finding, key, occurrence }
  })
}

const summarize = finding => ({ file: repoPath(finding.file), line: finding.line, id: finding.id, matched: finding.matched, status: finding.status })

const median = values => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const today = () => new Date().toISOString().slice(0, 10)

const feedModels = feedsDir => fs.readdirSync(feedsDir).filter(name => name.endsWith('.json')).sort().flatMap(name => {
  try {
    const feed = JSON.parse(fs.readFileSync(path.join(feedsDir, name), 'utf8'))
    return (feed.models ?? []).map(model => ({ name, model }))
  } catch {
    return []
  }
})

// A model the publisher clock retires today; withoutVia also requires that VIA falls back to that clock.
const retiredModel = (feedsDir, withoutVia = null) => feedModels(feedsDir)
  .map(({ model }) => model)
  .filter(model => model.shutdown && model.shutdown < today() && model.date_precision !== 'tentative')
  .filter(model => !withoutVia || !(model.distributions ?? []).some(distribution => distribution.via === withoutVia))
  .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null

// The checker's bundled feeds when it has them (bins resolve through their symlink), else --feeds-source, else this repository's feeds.
const resolveFeedsSource = (checker, explicit) => {
  if (explicit) return path.resolve(explicit)
  let real = checker
  try {
    real = fs.realpathSync(checker)
  } catch {
  }
  const bundled = path.join(path.dirname(real), 'feeds')
  return fs.existsSync(bundled) ? bundled : path.join(import.meta.dirname, '..', 'feeds')
}

class RepoSession {
  constructor({ source, tempRoot, checker, policy, feedsSource }) {
    this.source = source
    this.tempRoot = tempRoot
    this.checker = checker
    this.policy = policy
    this.feedsDir = feedsSource
    this.clone = path.join(tempRoot, 'clone')
    // The checker's own temp trees live under the harness root, so a killed checker never leaves them behind.
    this.checkerTmp = path.join(tempRoot, 'tmp')
    fs.mkdirSync(this.checkerTmp)
    this.worktrees = new Map()
    this.checks = new Map()
    this.counter = 0
  }

  checkerEnv(extra = {}) {
    return { ...cleanEnv(), TMPDIR: this.checkerTmp, TMP: this.checkerTmp, TEMP: this.checkerTmp, ...extra }
  }

  async prepare() {
    const cloned = await git(this.tempRoot, ['clone', '-q', '--no-hardlinks', '--no-checkout', '--', this.source, this.clone], { allowFail: true })
    if (cloned.error || cloned.status !== 0) return { failed: `clone failed: ${cloned.error?.message || cloned.stderr.trim()}` }
    const sourceHead = (await git(this.source, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true })).stdout.trim()
    const cloneHead = (await git(this.clone, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true })).stdout.trim()
    const present = sourceHead && (await git(this.clone, ['cat-file', '-e', `${sourceHead}^{commit}`], { allowFail: true })).status === 0
    this.head = present ? sourceHead : cloneHead
    if (!this.head) return { skipped: 'no commits' }
    this.headNote = present ? null : `source HEAD ${sourceHead} is not reachable from a branch; using the clone's HEAD`
    return {}
  }

  async worktree(commit) {
    if (!this.worktrees.has(commit)) {
      const directory = path.join(this.tempRoot, `wt-${this.counter++}`)
      this.worktrees.set(commit, git(this.clone, ['worktree', 'add', '-q', '--detach', directory, commit]).then(() => directory))
    }
    return this.worktrees.get(commit)
  }

  check(directory, flags) {
    const key = JSON.stringify([directory, flags])
    if (!this.checks.has(key)) this.checks.set(key, runChecker({ checker: this.checker, cwd: directory, args: flags, env: this.checkerEnv() }))
    return this.checks.get(key)
  }

  async changed(directory, base, flags, target = '.') {
    const statsFile = path.join(this.tempRoot, `stats-${this.counter++}.json`)
    const result = await runChecker({ checker: this.checker, cwd: directory, target, args: ['--changed', base, ...flags], env: this.checkerEnv({ MODEL_EOL_CHANGED_STATS: statsFile }) })
    if (fs.existsSync(statsFile)) {
      const text = fs.readFileSync(statsFile, 'utf8')
      try {
        result.stats = JSON.parse(text)
      } catch {
        result.stats = { raw: text }
      }
    }
    return result
  }

  async historyPairs(count) {
    const listed = (await git(this.clone, ['rev-list', '--first-parent', '--parents', `--max-count=${count + 1}`, this.head])).stdout
    return listed.split('\n').filter(Boolean)
      .map(line => line.split(' '))
      .filter(parts => parts.length > 1)
      .slice(0, count)
      .map(([head, base], index) => ({ base, head, probeSubdir: index === 0 }))
  }

  readConfig(directory) {
    const file = path.join(directory, '.model-eol.json')
    if (!fs.existsSync(file)) return { config: {}, bytes: null }
    const bytes = fs.readFileSync(file)
    try {
      const config = JSON.parse(bytes.toString('utf8'))
      return config && typeof config === 'object' && !Array.isArray(config) ? { config, bytes } : { error: 'config is not a JSON object' }
    } catch (error) {
      return { error: `config is not valid JSON: ${error.message}` }
    }
  }

  // Returns the pair specs for one synthetic mutation on top of HEAD, or { skipped } when the repository has no target for it.
  async mutate(mutation) {
    const policy = MUTATION_POLICY[mutation] ?? this.policy
    const headTree = await this.worktree(this.head)
    let headCheck = await this.check(headTree, POLICY_FLAGS[policy])
    if (headCheck.incomplete) headCheck = await this.check(headTree, [...POLICY_FLAGS[policy], '--allow-incomplete'])
    if (!headCheck.findings) return { skipped: `full check at HEAD is unusable: ${headCheck.error}` }
    const directory = path.join(this.tempRoot, `mut-${mutation}`)
    await git(this.clone, ['worktree', 'add', '-q', '--detach', directory, this.head])
    const present = headCheck.findings
      .filter(finding => repoPath(finding.file) !== '.model-eol.json' && fs.existsSync(path.join(directory, repoPath(finding.file))))
      .sort((a, b) => repoPath(a.file).localeCompare(repoPath(b.file)) || a.line - b.line)
    const notBad = present.filter(finding => !isBad(finding))
    const bad = present.filter(isBad)
    const linesIn = file => new Set(present.filter(finding => repoPath(finding.file) === file).map(finding => finding.line))
    const writeConfig = config => fs.writeFileSync(path.join(directory, '.model-eol.json'), `${JSON.stringify(config, null, 2)}\n`)
    const insertLines = (file, index, added) => {
      const absolute = path.join(directory, file)
      const lines = fs.readFileSync(absolute, 'utf8').split('\n')
      lines.splice(Math.max(0, Math.min(index, lines.length)), 0, ...added)
      fs.writeFileSync(absolute, lines.join('\n'))
    }
    const commit = async message => {
      await git(directory, ['add', '-A'])
      if ((await git(directory, ['diff', '--cached', '--quiet'], { allowFail: true })).status === 0) return null
      await git(directory, ['commit', '-q', '--no-verify', '-m', `e2e mutation ${mutation}: ${message}`])
      return (await git(directory, ['rev-parse', 'HEAD'])).stdout.trim()
    }
    const workingTree = description => ({ pairs: [{ base: this.head, head: this.head, headDir: directory, policy, mutation, description }] })
    // Each step edits the mutation worktree and commits; consecutive commits form the pairs, the first against HEAD.
    const steps = []
    const step = (message, edit) => steps.push({ message, edit })
    let feeds = null
    let pairSteps = 'last'
    const { config, bytes, error: configError } = this.readConfig(directory)
    if (['a', 'b', 'f', 'h', 'i', 'j', 'm'].includes(mutation) && configError) return { skipped: configError }
    const toggleVia = () => {
      if (config.via === 'aws-bedrock') {
        const { via, ...rest } = config
        return { message: 'drop config via aws-bedrock for the publisher clock', config: rest }
      }
      return { message: 'config via aws-bedrock', config: { ...config, via: 'aws-bedrock' } }
    }
    const removeIgnore = () => {
      const ignore = config.ignore && typeof config.ignore === 'object' ? config.ignore : {}
      const field = ['paths', 'models'].find(name => Array.isArray(ignore[name]) && ignore[name].length)
      return field ? { message: `remove ignore.${field} ${JSON.stringify(ignore[field][0])}`, config: { ...config, ignore: { ...ignore, [field]: ignore[field].slice(1) } } } : null
    }

    if (mutation === 'a') {
      // Only a firm future shutdown date turns retiring under a larger days threshold.
      const target = notBad.find(finding => finding.status === 'scheduled' && finding.shutdown && finding.date_precision !== 'tentative') ?? notBad[0]
      if (!target) return { skipped: 'no reference that is not bad' }
      const dir = path.posix.dirname(repoPath(target.file))
      const pattern = dir === '.' ? '**' : `${dir}/**`
      step(`override days 3650 for ${pattern}`, () => writeConfig({ ...config, overrides: [...(Array.isArray(config.overrides) ? config.overrides : []), { paths: [pattern], days: 3650 }] }))
    } else if (mutation === 'b') {
      const change = toggleVia()
      step(change.message, () => writeConfig(change.config))
    } else if (mutation === 'c') {
      const target = notBad[0]
      if (!target) return { skipped: 'no reference that is not bad' }
      const file = repoPath(target.file)
      const moved = `e2e-moved/${file}`
      step(`git mv ${file} ${moved}`, async () => {
        fs.mkdirSync(path.dirname(path.join(directory, moved)), { recursive: true })
        await git(directory, ['mv', '--', file, moved])
      })
    } else if (mutation === 'd') {
      const target = notBad.find(finding => linesIn(repoPath(finding.file)).size > 1)
      if (!target) return { skipped: 'no reference that is not bad in a file with references on two lines' }
      const file = repoPath(target.file)
      step(`insert 5 lines above ${file}:${target.line}`, () => insertLines(file, target.line - 1, ['', '', '', '', '']))
    } else if (mutation === 'e') {
      const target = notBad.find(finding => CODE_EXTENSIONS.has(path.posix.extname(repoPath(finding.file)))) ?? notBad[0]
      if (!target) return { skipped: 'no reference that is not bad' }
      const file = repoPath(target.file)
      step(`add a Bedrock signal two lines above ${file}:${target.line}`, () => insertLines(file, target.line - 2, [BEDROCK_LINE]))
    } else if (mutation === 'f') {
      const change = removeIgnore()
      if (!change) return { skipped: 'config ignores no path or model' }
      step(change.message, () => writeConfig(change.config))
    } else if (mutation === 'g') {
      if (!fs.existsSync(this.feedsDir)) return { skipped: `no feeds directory at ${this.feedsDir}` }
      const ids = new Set(feedModels(this.feedsDir).map(({ model }) => model.id))
      const target = notBad.find(finding => ids.has(finding.id))
      if (!target) return { skipped: 'no reference that is not bad resolves to a feed entry' }
      const inRepo = path.join(directory, IN_REPO_FEEDS)
      step(`copy the feeds into ${IN_REPO_FEEDS}`, () => fs.cpSync(this.feedsDir, inRepo, { recursive: true }))
      step(`retire ${target.id} in ${IN_REPO_FEEDS}`, () => {
        const { name } = feedModels(inRepo).find(({ model }) => model.id === target.id)
        const feed = JSON.parse(fs.readFileSync(path.join(inRepo, name), 'utf8'))
        const model = feed.models.find(entry => entry.id === target.id)
        Object.assign(model, { announced: '2020-01-01', shutdown: '2020-01-02' })
        delete model.date_precision
        delete model.distributions
        fs.writeFileSync(path.join(inRepo, name), `${JSON.stringify(feed, null, 2)}\n`)
      })
      feeds = IN_REPO_FEEDS
      pairSteps = 'all'
    } else if (mutation === 'h') {
      if (Array.isArray(config.waivers) && config.waivers.length) {
        step(`remove waiver for ${config.waivers[0].model}`, () => writeConfig({ ...config, waivers: config.waivers.slice(1) }))
      } else {
        const target = bad[0]
        if (!target) return { skipped: 'no bad reference to waive' }
        const waiver = { model: target.id, reason: 'model-eol e2e', owner: 'model-eol e2e', expires: '2099-12-31' }
        step(`waive ${target.id}`, () => writeConfig({ ...config, waivers: [waiver] }))
        step(`remove the waiver for ${target.id}`, () => writeConfig({ ...config, waivers: [] }))
      }
    } else if (mutation === 'i') {
      if (config.scope !== 'direct') step('config scope direct', () => writeConfig({ ...config, scope: 'direct' }))
      step('config scope all', () => writeConfig({ ...config, scope: 'all' }))
    } else if (mutation === 'j') {
      const target = notBad[0]
      const retired = fs.existsSync(this.feedsDir) ? retiredModel(this.feedsDir, 'aws-bedrock') : null
      if (!target || !retired) return { skipped: target ? 'no retired feed model for a route' : 'no reference that is not bad' }
      const route = { paths: [repoPath(target.file)], match: target.matched, model: retired.id, via: 'aws-bedrock' }
      step(`route ${target.matched} in ${route.paths[0]} to ${retired.id}`, () => writeConfig({ ...config, routes: [...(Array.isArray(config.routes) ? config.routes : []), route] }))
    } else if (mutation === 'k') {
      const retired = fs.existsSync(this.feedsDir) ? retiredModel(this.feedsDir) : null
      if (!retired) return { skipped: 'no retired feed model' }
      fs.writeFileSync(path.join(directory, UNTRACKED_FILE), `MODEL = "${retired.id}"\n`)
      return workingTree(`untracked ${UNTRACKED_FILE} referencing ${retired.id}`)
    } else if (mutation === 'l') {
      step('make the config invalid JSON', () => fs.writeFileSync(path.join(directory, '.model-eol.json'), '{ "days": \n'))
      step('restore a valid config', () => fs.writeFileSync(path.join(directory, '.model-eol.json'), bytes && !configError ? bytes : '{}\n'))
    } else if (mutation === 'm') {
      const change = removeIgnore() ?? toggleVia()
      writeConfig(change.config)
      return workingTree(`uncommitted config edit: ${change.message}`)
    } else if (mutation === 'n') {
      const retired = fs.existsSync(this.feedsDir) ? retiredModel(this.feedsDir) : null
      const tracked = new Set((await git(directory, ['ls-files', '-z'])).stdout.split('\0'))
      const candidates = [...new Set(present.map(finding => repoPath(finding.file)))].filter(file => tracked.has(file))
      const file = candidates.find(candidate => CODE_EXTENSIONS.has(path.posix.extname(candidate))) ?? candidates[0]
      if (!retired || !file) return { skipped: retired ? 'no tracked file holds a reference' : 'no retired feed model' }
      const absolute = path.join(directory, file)
      const text = fs.readFileSync(absolute, 'utf8')
      fs.writeFileSync(absolute, `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}E2E_DIRTY = "${retired.id}"\n`)
      return workingTree(`uncommitted edit adds ${retired.id} to ${file}`)
    } else {
      return { skipped: `unknown mutation ${mutation}` }
    }

    const commits = [this.head]
    for (const { message, edit } of steps) {
      await edit()
      const sha = await commit(message)
      if (!sha) return { skipped: `step "${message}" changed nothing` }
      commits.push(sha)
    }
    this.worktrees.set(commits.at(-1), Promise.resolve(directory))
    const description = steps.map(({ message }) => message).join('; ')
    const spec = (base, head, label, text) => ({ base, head, policy, feeds, mutation: label, description: text })
    if (pairSteps === 'all') return { pairs: commits.slice(1).map((head, index) => spec(commits[index], head, index === commits.length - 2 ? mutation : `${mutation}${index}`, steps[index].message)) }
    return { pairs: [spec(commits.length > 2 ? commits.at(-2) : this.head, commits.at(-1), mutation, description)] }
  }

  async evaluatePair({ base, head, headDir = null, mutation = null, description = null, policy = this.policy, feeds = null, probeSubdir = false }) {
    const flags = [...POLICY_FLAGS[policy], ...(feeds ? ['--feeds', feeds] : [])]
    const pair = {
      repo: this.source,
      base,
      head,
      working_tree: headDir !== null,
      mutation,
      mutation_description: description,
      policy,
      flags,
      result: 'pass',
      reasons: [],
      notes: [],
      exit: { changed: null, base: null, head: null },
      allow_incomplete: { base: false, head: false },
      base_unavailable: false,
      counts: null,
      changed_reasons: {},
      required: [],
      missing: [],
      extra: [],
      oracle_errors: [],
      line_map_fallbacks: [],
      subdir_check: null,
      inert: null,
      timings: null,
      stats: null,
    }
    const fail = reason => {
      pair.result = 'fail'
      pair.reasons.push(reason)
    }
    const baseDir = await this.worktree(base)
    const headTree = headDir ?? await this.worktree(head)
    let baseCheck = await this.check(baseDir, flags)
    let headCheck = await this.check(headTree, flags)
    let changedRun = await this.changed(headTree, base, flags)
    pair.exit = { changed: changedRun.code, base: baseCheck.code, head: headCheck.code }
    for (const [label, result] of [['full base', baseCheck], ['full head', headCheck], ['--changed', changedRun]]) {
      if (result.timedOut) fail(`crash: ${label} check timed out after ${settings.timeoutMs / 1000}s`)
    }
    if (!headCheck.findings && !headCheck.timedOut && !changedRun.timedOut) {
      if (headCheck.code === 2 && changedRun.code !== 2) {
        fail(headCheck.incomplete
          ? `incomplete head coverage produced a --changed gate result (exit ${changedRun.code})`
          : `full head check exited 2 but --changed exited ${changedRun.code}`)
      } else if (headCheck.code !== 2 && changedRun.code === 0) {
        fail(`full head check failed (exit ${headCheck.code}: ${headCheck.error}) but --changed exited 0`)
      }
    }
    const allowFlags = [...flags, '--allow-incomplete']
    if (headCheck.incomplete) {
      pair.allow_incomplete.head = true
      headCheck = await this.check(headTree, allowFlags)
      changedRun = await this.changed(headTree, base, allowFlags)
      pair.exit.head_allow_incomplete = headCheck.code
      pair.exit.changed_allow_incomplete = changedRun.code
    }
    if (baseCheck.incomplete) {
      pair.allow_incomplete.base = true
      baseCheck = await this.check(baseDir, allowFlags)
      pair.exit.base_allow_incomplete = baseCheck.code
    }
    pair.stats = changedRun.stats ?? null
    if (pair.result === 'fail' && pair.reasons.some(reason => reason.startsWith('crash'))) return pair
    if (!headCheck.findings) {
      if (pair.result !== 'fail') pair.result = 'incomplete'
      pair.reasons.push(`full head check: ${headCheck.error}`)
      return pair
    }
    const ratio = headCheck.ms > 0 ? changedRun.ms / headCheck.ms : null
    pair.timings = {
      changed_ms: changedRun.ms,
      full_head_ms: headCheck.ms,
      ratio: ratio === null ? null : Number(ratio.toFixed(3)),
      slow: changedRun.ms > SLOW_FACTOR * headCheck.ms + SLOW_GRACE_MS,
    }
    if (!changedRun.findings) {
      fail(`crash: --changed ${changedRun.error}`)
      return pair
    }
    const changedBadFindings = changedRun.findings.filter(isBad)
    const expectedExit = changedBadFindings.length ? 1 : 0
    if (changedRun.code !== expectedExit) fail(`exit mismatch: --changed exited ${changedRun.code} with ${changedBadFindings.length} bad finding(s)`)
    for (const finding of changedBadFindings) {
      const reason = finding.changed?.reason ?? 'none'
      pair.changed_reasons[reason] = (pair.changed_reasons[reason] ?? 0) + 1
    }
    if (!baseCheck.findings) {
      // Nothing at base can be proven old debt, so every bad head finding is required.
      pair.base_unavailable = true
      pair.notes.push(`base unavailable: ${baseCheck.error}`)
    }

    const baseIndex = new Map()
    for (const entry of withOccurrences(baseCheck.findings ?? [])) baseIndex.set(`${entry.key}#${entry.occurrence}`, entry.finding)
    const untracked = headDir === null ? new Set() : new Set((await git(headTree, ['ls-files', '-z', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean))
    // A working-tree head has no commit to blame, so its lines map through this harness's own diff of BASE against the working tree.
    const workingDiff = headDir === null ? null : await diffFileRecords(headTree, base)
    const lineMaps = new Map()
    let diffRecords = null
    const prepareFile = async file => {
      if (lineMaps.has(file) || untracked.has(file) || workingDiff) return
      try {
        const map = await blameLineMap(this.clone, base, head, file)
        const foreign = [...map.values()].filter(entry => entry.boundary).length
        if (foreign) {
          // A line blamed to a boundary other than BASE is not proof of a change; map this file from the diff instead.
          diffRecords ??= await diffFileRecords(this.clone, base, head)
          pair.line_map_fallbacks.push({ file, foreign_boundary_lines: foreign })
          lineMaps.set(file, { fallback: true })
        } else {
          lineMaps.set(file, map)
        }
      } catch (error) {
        lineMaps.set(file, error)
      }
    }
    const mapLine = (file, line) => {
      if (untracked.has(file)) return { base: false }
      if (workingDiff) return diffLineMap(workingDiff, file, line)
      const map = lineMaps.get(file)
      if (map instanceof Error) throw map
      if (map.fallback) return diffLineMap(diffRecords, file, line)
      const mapped = map.get(line)
      if (!mapped) throw new Error(`git blame has no line ${line} for ${file}`)
      return mapped
    }
    for (const file of new Set(headCheck.findings.map(finding => repoPath(finding.file)))) await prepareFile(file)
    const required = new Map()
    const oldDebt = new Map()
    let requiredChanged = 0
    let requiredUnchanged = 0
    let headBad = 0
    for (const { finding, key, occurrence } of withOccurrences(headCheck.findings).filter(entry => isBad(entry.finding))) {
      headBad++
      let mapped
      try {
        mapped = mapLine(repoPath(finding.file), finding.line)
      } catch (error) {
        pair.oracle_errors.push({ ...summarize(finding), error: error.message })
        continue
      }
      const push = (map, value) => map.set(key, [...map.get(key) ?? [], value])
      if (!mapped.base) {
        requiredChanged++
        push(required, { ...summarize(finding), reason: 'changed-line', base: null })
        continue
      }
      const match = pair.base_unavailable ? undefined : baseIndex.get(`${keyOf(mapped.file, mapped.line, finding.id, finding.matched)}#${occurrence}`)
      if (match && isBad(match)) {
        push(oldDebt, { ...summarize(finding), base: summarize(match) })
        continue
      }
      requiredUnchanged++
      push(required, {
        ...summarize(finding),
        reason: pair.base_unavailable ? 'base-unavailable' : 'newly-actionable',
        base: match ? summarize(match) : { file: mapped.file, line: mapped.line, finding: null },
      })
    }
    if (pair.oracle_errors.length) {
      pair.result = 'fail'
      pair.reasons.push(`oracle: could not map ${pair.oracle_errors.length} bad finding(s) to base: ${pair.oracle_errors[0].error}`)
    }

    let statusChanges = 0
    for (const { finding, occurrence } of withOccurrences(headCheck.findings)) {
      let mapped
      try {
        mapped = mapLine(repoPath(finding.file), finding.line)
      } catch {
        continue
      }
      const match = mapped.base ? baseIndex.get(`${keyOf(mapped.file, mapped.line, finding.id, finding.matched)}#${occurrence}`) : undefined
      if (match ? match.status !== finding.status || isBad(match) !== isBad(finding) : isBad(finding)) statusChanges++
    }

    const missingFrom = (findings, requiredFindings) => {
      const present = new Map()
      for (const finding of findings.filter(isBad)) {
        const key = keyOf(finding.file, finding.line, finding.id, finding.matched)
        present.set(key, (present.get(key) ?? 0) + 1)
      }
      return [...requiredFindings].flatMap(([key, expected]) => expected.slice(present.get(key) ?? 0))
    }
    const reported = new Map()
    let changedBad = 0
    for (const finding of changedRun.findings.filter(isBad)) {
      changedBad++
      const key = keyOf(finding.file, finding.line, finding.id, finding.matched)
      reported.set(key, [...reported.get(key) ?? [], finding])
    }
    pair.required = [...required.values()].flat()
    for (const [key, findings] of required) {
      const present = reported.get(key)?.length ?? 0
      pair.missing.push(...findings.slice(present))
    }
    for (const [key, findings] of reported) {
      const surplus = findings.slice(required.get(key)?.length ?? 0)
      const debt = oldDebt.get(key) ?? []
      for (const [index, finding] of surplus.entries()) {
        pair.extra.push({ ...summarize(finding), changed: finding.changed ?? null, oracle: index < debt.length ? 'old-debt' : 'not-bad-in-full-head-check' })
      }
    }
    pair.counts = {
      head_bad: headBad,
      required: requiredChanged + requiredUnchanged,
      required_changed_line: requiredChanged,
      required_unchanged_line: requiredUnchanged,
      old_debt: [...oldDebt.values()].flat().length,
      changed_bad: changedBad,
      missing: pair.missing.length,
      extra: pair.extra.length,
      oracle_errors: pair.oracle_errors.length,
      status_changes: pair.base_unavailable ? null : statusChanges,
    }
    if (mutation) pair.inert = pair.base_unavailable ? false : statusChanges === 0
    if (pair.missing.length) {
      pair.result = 'fail'
      pair.reasons.push(`missing ${pair.missing.length} oracle-required finding(s)`)
      if (changedRun.code === 0) pair.reasons.push('false clean: --changed exited 0')
    }

    if (probeSubdir) {
      // One run per repository with a subdirectory target and a symbolic base ref, judged by the same oracle restricted to that directory.
      const parent = (await git(headTree, ['rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}'], { allowFail: true })).stdout.trim()
      const subdir = [...pair.required, ...headCheck.findings.map(summarize)]
        .map(finding => finding.file.split('/'))
        .find(parts => parts.length > 1)?.[0]
      if (parent !== base || !subdir) {
        pair.notes.push(parent !== base ? 'subdirectory check skipped: HEAD~1 is not the base' : 'subdirectory check skipped: no subdirectory holds a finding')
      } else {
        const subRun = await this.changed(headTree, 'HEAD~1', pair.allow_incomplete.head ? allowFlags : flags, subdir)
        const inSubdir = new Map([...required].map(([key, findings]) => [key, findings.filter(finding => finding.file.startsWith(`${subdir}/`))]).filter(([, findings]) => findings.length))
        pair.subdir_check = { target: subdir, base_ref: 'HEAD~1', exit: subRun.code, required: [...inSubdir.values()].flat().length, missing: [] }
        if (!subRun.findings) {
          fail(`subdirectory check: --changed ${subRun.error}`)
        } else {
          const lost = missingFrom(subRun.findings, inSubdir)
          pair.subdir_check.missing = lost
          const subBad = subRun.findings.filter(isBad).length
          if (subRun.code !== (subBad ? 1 : 0)) fail(`subdirectory check: exit mismatch: --changed exited ${subRun.code} with ${subBad} bad finding(s)`)
          if (lost.length) fail(`subdirectory check: missing ${lost.length} oracle-required finding(s) under ${subdir}/`)
        }
      }
    }
    return pair
  }
}

const removeTempRoots = () => {
  for (const root of liveTempRoots) fs.rmSync(root, { recursive: true, force: true })
  liveTempRoots.clear()
}

// Kills every running child group, waits briefly for them to exit, then removes the temp roots.
export const stopForSignal = async signal => {
  if (stopping) return
  stopping = signal
  const closing = [...running.values()]
  for (const child of running.keys()) killGroup(child)
  await Promise.race([Promise.all(closing), new Promise(resolve => setTimeout(resolve, 3000))])
  removeTempRoots()
}

export const runE2e = async ({ checker, repos, commits = 10, mutations = [], policy = 'broad', feedsSource = null, keep = false, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, log = () => {} }) => {
  settings.timeoutMs = timeoutSeconds * 1000
  const feeds = resolveFeedsSource(checker, feedsSource)
  const report = { schema: 'model-eol/e2e-changed@0', checker, policy, flags: POLICY_FLAGS[policy], commits, mutations, feeds_source: feeds, timeout_seconds: timeoutSeconds, repos: [], pairs: [] }
  for (const repo of repos) {
    const source = path.resolve(repo)
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-e2e-changed-')))
    if (!keep) liveTempRoots.add(tempRoot)
    const entry = { repo: source, status: 'ok', reason: null, pairs: 0, temp: keep ? tempRoot : null, skipped_mutations: [] }
    report.repos.push(entry)
    try {
      const session = new RepoSession({ source, tempRoot, checker, policy, feedsSource: feeds })
      const prepared = fs.existsSync(source) ? await session.prepare() : { failed: 'path does not exist' }
      if (prepared.failed || prepared.skipped) {
        entry.status = prepared.failed ? 'failed' : 'skipped'
        entry.reason = prepared.failed ?? prepared.skipped
        log(`${entry.status} ${source}: ${entry.reason}`)
        continue
      }
      entry.head = session.head
      entry.note = session.headNote
      const pairs = await session.historyPairs(commits)
      for (const mutation of mutations) {
        const result = await session.mutate(mutation)
        if (result.skipped) entry.skipped_mutations.push({ mutation, reason: result.skipped })
        else pairs.push(...result.pairs)
      }
      for (const pair of pairs) {
        const evaluated = await session.evaluatePair(pair)
        report.pairs.push(evaluated)
        entry.pairs++
        const label = evaluated.mutation ? `mutation ${evaluated.mutation}` : evaluated.head.slice(0, 12)
        const inert = evaluated.inert ? ' (inert)' : ''
        log(`${evaluated.result} ${path.basename(source)} ${label}${inert}${evaluated.reasons.length ? `: ${evaluated.reasons.join('; ')}` : ''}`)
      }
    } catch (error) {
      if (error instanceof InterruptedError) throw error
      entry.status = 'error'
      entry.reason = error.message
      log(`error ${source}: ${error.message}`)
    } finally {
      if (!keep && !stopping) {
        fs.rmSync(tempRoot, { recursive: true, force: true })
        liveTempRoots.delete(tempRoot)
      }
    }
  }
  const evaluated = report.pairs.filter(pair => pair.counts)
  const ratios = evaluated.map(pair => pair.timings.ratio).filter(ratio => ratio !== null)
  const reasonCount = prefix => report.pairs.filter(pair => pair.reasons.some(reason => reason.startsWith(prefix))).length
  report.summary = {
    repos: report.repos.length,
    repos_skipped: report.repos.filter(repo => repo.status === 'skipped').length,
    repos_failed: report.repos.filter(repo => repo.status === 'failed' || repo.status === 'error').length,
    pairs: report.pairs.length,
    evaluated: evaluated.length,
    failed: report.pairs.filter(pair => pair.result === 'fail').length,
    missing: report.pairs.reduce((sum, pair) => sum + pair.missing.length, 0),
    extra: report.pairs.reduce((sum, pair) => sum + pair.extra.length, 0),
    oracle_errors: report.pairs.reduce((sum, pair) => sum + pair.oracle_errors.length, 0),
    crashes: reasonCount('crash'),
    exit_mismatches: reasonCount('exit mismatch'),
    incomplete_gates: reasonCount('incomplete head coverage') + reasonCount('full head check exited 2') + reasonCount('full head check failed'),
    subdir_checks: report.pairs.filter(pair => pair.subdir_check).length,
    subdir_failures: reasonCount('subdirectory check'),
    incomplete: report.pairs.filter(pair => pair.result === 'incomplete').length,
    allow_incomplete: report.pairs.filter(pair => pair.allow_incomplete.base || pair.allow_incomplete.head).length,
    false_clean: reasonCount('false clean'),
    line_map_fallbacks: report.pairs.reduce((sum, pair) => sum + pair.line_map_fallbacks.length, 0),
    inert: report.pairs.filter(pair => pair.inert).map(pair => pair.mutation),
    skipped_mutations: report.repos.flatMap(repo => repo.skipped_mutations.map(({ mutation }) => mutation)),
    slow: evaluated.filter(pair => pair.timings.slow).length,
    timing_ratio_median: ratios.length ? Number(median(ratios).toFixed(3)) : null,
    timing_ratio_max: ratios.length ? Number(Math.max(...ratios).toFixed(3)) : null,
  }
  report.ok = report.summary.failed === 0 && report.summary.repos_failed === 0 && report.summary.evaluated > 0
  return report
}

export const formatSummary = report => {
  const s = report.summary
  const lines = [
    `model-eol --changed e2e: ${s.repos} repo(s) (${s.repos_skipped} skipped, ${s.repos_failed} failed), ${s.pairs} pair(s), ${s.evaluated} evaluated, policy ${report.policy}`,
    `  missing ${s.missing}, extra ${s.extra}, crashes ${s.crashes}, exit mismatches ${s.exit_mismatches}, oracle errors ${s.oracle_errors}, incomplete gates ${s.incomplete_gates}, false clean ${s.false_clean}`,
    `  incomplete ${s.incomplete}, compared with --allow-incomplete ${s.allow_incomplete}, diff line-map fallbacks ${s.line_map_fallbacks}, subdirectory checks ${s.subdir_checks} (${s.subdir_failures} failed)`,
    `  inert mutations ${s.inert.length ? s.inert.join(',') : 'none'}`,
    `  timing --changed/full head: median ${s.timing_ratio_median ?? 'n/a'}x, max ${s.timing_ratio_max ?? 'n/a'}x, slow ${s.slow}`,
  ]
  for (const repo of report.repos) {
    if (repo.status !== 'ok') lines.push(`  ${repo.status} ${repo.repo}: ${repo.reason}`)
    for (const { mutation, reason } of repo.skipped_mutations) lines.push(`  skipped mutation ${mutation} in ${path.basename(repo.repo)}: ${reason}`)
  }
  if (s.evaluated === 0) lines.push('  no pair was evaluated')
  for (const pair of report.pairs.filter(pair => pair.result !== 'pass')) {
    lines.push(`  ${pair.result.toUpperCase()} ${pair.base.slice(0, 12)}..${pair.head.slice(0, 12)}${pair.working_tree ? '+worktree' : ''}${pair.mutation ? ` (mutation ${pair.mutation})` : ''}: ${pair.reasons.join('; ')}`)
    for (const finding of pair.missing.slice(0, 10)) lines.push(`    missing ${finding.file}:${finding.line} ${finding.id} (${finding.reason})`)
  }
  lines.push(report.ok ? 'result: PASS' : 'result: FAIL')
  return lines.join('\n')
}

async function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      checker: { type: 'string' },
      repo: { type: 'string', multiple: true },
      commits: { type: 'string' },
      synthetic: { type: 'boolean' },
      mutations: { type: 'string' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
      policy: { type: 'string' },
      'feeds-source': { type: 'string' },
      'timeout-seconds': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'node scripts/e2e-changed.mjs --help',
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  if (positionals.length) throw usageError(`unexpected positional argument: ${positionals[0]}`)
  if (!values.checker) throw usageError('--checker is required')
  const checker = path.resolve(values.checker)
  if (!fs.existsSync(checker) || !fs.statSync(checker).isFile()) throw usageError(`--checker ${values.checker} is not a file`)
  if (!values.repo?.length) throw usageError('at least one --repo is required')
  const policy = values.policy ?? 'broad'
  if (!Object.hasOwn(POLICY_FLAGS, policy)) throw usageError('--policy must be broad or config')
  const commits = values.commits === undefined ? 10 : Number(values.commits)
  if (!Number.isInteger(commits) || commits < 0) throw usageError('--commits must be a non-negative integer')
  const timeoutSeconds = values['timeout-seconds'] === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values['timeout-seconds'])
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw usageError('--timeout-seconds must be a positive number')
  const mutations = values.mutations !== undefined ? values.mutations.split(',').filter(Boolean) : values.synthetic ? MUTATIONS : []
  const unknown = mutations.find(mutation => !MUTATIONS.includes(mutation))
  if (unknown) throw usageError(`unknown mutation ${unknown}; known: ${MUTATIONS.join(',')}`)
  if (values['feeds-source'] !== undefined && !fs.existsSync(values['feeds-source'])) throw usageError(`--feeds-source ${values['feeds-source']} does not exist`)
  const report = await runE2e({
    checker,
    repos: values.repo,
    commits,
    mutations,
    policy,
    feedsSource: values['feeds-source'] ?? null,
    keep: values.keep ?? false,
    timeoutSeconds,
    log: line => console.error(line),
  })
  if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(formatSummary(report))
  for (const repo of report.repos.filter(repo => repo.temp)) console.log(`kept ${repo.temp}`)
  return report.ok ? 0 : 1
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  for (const signal of Object.keys(SIGNAL_EXIT)) {
    process.on(signal, async () => {
      await stopForSignal(signal)
      process.exit(SIGNAL_EXIT[signal])
    })
  }
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof InterruptedError) {
      await new Promise(() => {})
    }
    removeTempRoots()
    console.error(`e2e-changed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
