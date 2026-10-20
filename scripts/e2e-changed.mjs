#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { parseCliArgs } from '../lib/cli.mjs'

const usage = 'Usage: node scripts/e2e-changed.mjs --checker PATH/check.mjs --repo DIR [--repo DIR ...] [--commits N] [--synthetic] [--policy broad|config] [--out FILE] [--keep]'
// broad pins every finding into view; config lets each tree's .model-eol.json decide days and scope.
const POLICY_FLAGS = { broad: ['--json', '--days', '90', '--scope', 'all'], config: ['--json'] }
let CHECK_FLAGS = POLICY_FLAGS.broad
const MUTATIONS = ['a', 'b', 'c', 'd', 'e', 'f']
const CODE_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rb', '.java', '.kt', '.rs', '.php', '.cs', '.swift', '.scala'])
const BEDROCK_LINE = 'bedrock = boto3.client("bedrock-runtime")'
const SLOW_FACTOR = 3
const SLOW_GRACE_MS = 2000

const usageError = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  return error
}

const cleanEnv = () => {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name]
  return env
}

// The harness's own git runs ignore user and system config so blame and commits are reproducible.
const gitEnv = () => ({ ...cleanEnv(), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })

const GIT_IDENTITY = ['-c', 'user.name=model-eol e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${os.devNull}`]

const git = (cwd, args, { allowFail = false } = {}) => {
  const result = spawnSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (!allowFail && (result.error || result.status !== 0)) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

export const isBad = finding =>
  (finding.status === 'retired' || finding.status === 'retiring') && finding.waiver?.active !== true

const repoPath = file => String(file).replaceAll('\\', '/').replace(/^\.\//, '')

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
export const blameLineMap = (cwd, base, head, file) => {
  const result = git(cwd, [
    '-c', 'diff.algorithm=myers', '-c', 'diff.indentHeuristic=true', '-c', 'core.quotePath=false',
    'blame', '--line-porcelain', `${base}..${head}`, '--', file,
  ])
  const lines = new Map()
  let current = null
  for (const line of result.stdout.split('\n')) {
    if (current === null) {
      const header = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/)
      if (header) current = { sha: header[1], origLine: Number(header[2]), finalLine: Number(header[3]), filename: null }
      continue
    }
    if (line.startsWith('filename ')) {
      current.filename = unquoteC(line.slice('filename '.length))
      continue
    }
    if (line.startsWith('\t')) {
      lines.set(current.finalLine, current.sha === base
        ? { base: true, file: current.filename, line: current.origLine }
        : { base: false })
      current = null
    }
  }
  return lines
}

const runChecker = ({ checker, cwd, args, env = {} }) => {
  const started = performance.now()
  const result = spawnSync(process.execPath, [checker, 'check', '.', ...args, ...CHECK_FLAGS], {
    cwd,
    env: { ...cleanEnv(), ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  })
  const ms = Math.round(performance.now() - started)
  let doc = null
  try {
    doc = JSON.parse(result.stdout)
  } catch {
  }
  const code = result.error ? null : result.status
  const usable = (code === 0 || code === 1) && Array.isArray(doc?.findings)
  const stderr = (result.error?.message ?? result.stderr ?? '').trim()
  return { code, ms, findings: usable ? doc.findings : null, error: usable ? null : (stderr.split('\n').slice(0, 5).join(' | ') || `exit ${code} without a check document`) }
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

class RepoSession {
  constructor({ source, tempRoot, checker }) {
    this.source = source
    this.tempRoot = tempRoot
    this.checker = checker
    this.clone = path.join(tempRoot, 'clone')
    this.worktrees = new Map()
    this.fullChecks = new Map()
    this.counter = 0
  }

  prepare() {
    const cloned = git(this.tempRoot, ['clone', '-q', '--no-hardlinks', '--no-checkout', '--', this.source, this.clone], { allowFail: true })
    if (cloned.error || cloned.status !== 0) return `clone failed: ${cloned.error?.message || cloned.stderr.trim()}`
    const sourceHead = git(this.source, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true }).stdout.trim()
    const cloneHead = git(this.clone, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true }).stdout.trim()
    if (!sourceHead && !cloneHead) return 'no commits'
    const present = sourceHead && git(this.clone, ['cat-file', '-e', `${sourceHead}^{commit}`], { allowFail: true }).status === 0
    this.head = present ? sourceHead : cloneHead
    if (!this.head) return 'no commits'
    this.headNote = present ? null : `source HEAD ${sourceHead} is not reachable from a branch; using the clone's HEAD`
    return null
  }

  worktree(commit) {
    if (!this.worktrees.has(commit)) {
      const directory = path.join(this.tempRoot, `wt-${this.counter++}`)
      git(this.clone, ['worktree', 'add', '-q', '--detach', directory, commit])
      this.worktrees.set(commit, directory)
    }
    return this.worktrees.get(commit)
  }

  fullCheck(commit) {
    if (!this.fullChecks.has(commit)) {
      this.fullChecks.set(commit, runChecker({ checker: this.checker, cwd: this.worktree(commit), args: [] }))
    }
    return this.fullChecks.get(commit)
  }

  historyPairs(count) {
    const listed = git(this.clone, ['rev-list', '--first-parent', '--parents', `--max-count=${count + 1}`, this.head]).stdout
    return listed.split('\n').filter(Boolean)
      .map(line => line.split(' '))
      .filter(parts => parts.length > 1)
      .slice(0, count)
      .map(([head, base]) => ({ base, head, mutation: null }))
  }

  readConfig(directory) {
    const file = path.join(directory, '.model-eol.json')
    if (!fs.existsSync(file)) return { config: {} }
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'))
      return config && typeof config === 'object' && !Array.isArray(config) ? { config } : { error: 'config is not a JSON object' }
    } catch (error) {
      return { error: `config is not valid JSON: ${error.message}` }
    }
  }

  // Returns the commit for one synthetic mutation on top of HEAD, or { skipped } when the repository has no target for it.
  mutate(mutation) {
    const headCheck = this.fullCheck(this.head)
    if (!headCheck.findings) return { skipped: `full check at HEAD is unusable: ${headCheck.error}` }
    const directory = path.join(this.tempRoot, `mut-${mutation}`)
    git(this.clone, ['worktree', 'add', '-q', '--detach', directory, this.head])
    const referenceLines = new Map()
    const badFiles = new Set()
    for (const finding of headCheck.findings) {
      const file = repoPath(finding.file)
      if (file === '.model-eol.json' || !fs.existsSync(path.join(directory, file))) continue
      if (!referenceLines.has(file)) referenceLines.set(file, new Set())
      referenceLines.get(file).add(finding.line)
      if (isBad(finding)) badFiles.add(file)
    }
    // Files holding a bad reference come first so moves and shifts exercise old debt.
    const files = [...referenceLines.keys()].sort().sort((a, b) => Number(badFiles.has(b)) - Number(badFiles.has(a)))
    const linesOf = file => [...referenceLines.get(file)].sort((a, b) => a - b)
    const writeConfig = config => fs.writeFileSync(path.join(directory, '.model-eol.json'), `${JSON.stringify(config, null, 2)}\n`)
    const insertLines = (file, index, added) => {
      const absolute = path.join(directory, file)
      const lines = fs.readFileSync(absolute, 'utf8').split('\n')
      lines.splice(Math.max(0, Math.min(index, lines.length)), 0, ...added)
      fs.writeFileSync(absolute, lines.join('\n'))
    }
    let description
    const apply = () => {
      if (['a', 'b', 'f'].includes(mutation)) {
        const { config, error } = this.readConfig(directory)
        if (error) return error
        if (mutation === 'a') {
          if (!files.length) return 'no file holds a tracked model reference'
          const dir = path.posix.dirname(files[0])
          const pattern = dir === '.' ? '**' : `${dir}/**`
          config.overrides = [...(Array.isArray(config.overrides) ? config.overrides : []), { paths: [pattern], days: 3650 }]
          description = `override days 3650 for ${pattern}`
        } else if (mutation === 'b') {
          if (config.via === 'aws-bedrock') return 'config already uses via aws-bedrock'
          config.via = 'aws-bedrock'
          description = 'config via aws-bedrock'
        } else {
          const ignore = config.ignore && typeof config.ignore === 'object' ? config.ignore : {}
          const field = ['paths', 'models'].find(name => Array.isArray(ignore[name]) && ignore[name].length)
          if (!field) return 'config ignores no path or model'
          description = `remove ignore.${field} ${JSON.stringify(ignore[field][0])}`
          ignore[field] = ignore[field].slice(1)
        }
        writeConfig(config)
        return null
      }
      if (mutation === 'c') {
        if (!files.length) return 'no file holds a tracked model reference'
        const target = `e2e-moved/${files[0]}`
        fs.mkdirSync(path.dirname(path.join(directory, target)), { recursive: true })
        git(directory, ['mv', '--', files[0], target])
        description = `git mv ${files[0]} ${target}`
        return null
      }
      if (mutation === 'd') {
        const file = files.find(candidate => referenceLines.get(candidate).size > 1)
        if (!file) return 'no file holds references on two lines'
        const line = linesOf(file)[1]
        insertLines(file, line - 1, ['', '', '', '', ''])
        description = `insert 5 lines above ${file}:${line}`
        return null
      }
      if (mutation === 'e') {
        const file = files.find(candidate => CODE_EXTENSIONS.has(path.posix.extname(candidate))) ?? files[0]
        if (!file) return 'no file holds a tracked model reference'
        const line = linesOf(file)[0]
        insertLines(file, line - 2, [BEDROCK_LINE])
        description = `add a Bedrock signal two lines above ${file}:${line}`
        return null
      }
      return `unknown mutation ${mutation}`
    }
    const skipped = apply()
    if (skipped) return { skipped }
    git(directory, ['add', '-A'])
    if (git(directory, ['diff', '--cached', '--quiet'], { allowFail: true }).status === 0) return { skipped: 'mutation changed nothing' }
    git(directory, ['commit', '-q', '--no-verify', '-m', `e2e mutation ${mutation}: ${description}`])
    const commit = git(directory, ['rev-parse', 'HEAD']).stdout.trim()
    this.worktrees.set(commit, directory)
    return { commit, description }
  }

  evaluatePair({ base, head, mutation, description = null }) {
    const pair = {
      repo: this.source,
      base,
      head,
      mutation,
      mutation_description: description,
      result: 'pass',
      reasons: [],
      exit: { changed: null, base: null, head: null },
      counts: null,
      missing: [],
      extra: [],
      timings: null,
      stats: null,
    }
    const baseCheck = this.fullCheck(base)
    const headCheck = this.fullCheck(head)
    pair.exit.base = baseCheck.code
    pair.exit.head = headCheck.code
    for (const [label, run] of [['base', baseCheck], ['head', headCheck]]) {
      if (!run.findings) pair.reasons.push(`full ${label} check: ${run.error}`)
    }
    if (pair.reasons.length) {
      pair.result = 'incomplete'
      return pair
    }

    const statsFile = path.join(this.tempRoot, `stats-${this.counter++}.json`)
    const changedRun = runChecker({
      checker: this.checker,
      cwd: this.worktree(head),
      args: ['--changed', base],
      env: { MODEL_EOL_CHANGED_STATS: statsFile },
    })
    pair.exit.changed = changedRun.code
    if (fs.existsSync(statsFile)) {
      const text = fs.readFileSync(statsFile, 'utf8')
      try {
        pair.stats = JSON.parse(text)
      } catch {
        pair.stats = { raw: text }
      }
    }
    const ratio = headCheck.ms > 0 ? changedRun.ms / headCheck.ms : null
    pair.timings = {
      changed_ms: changedRun.ms,
      full_head_ms: headCheck.ms,
      ratio: ratio === null ? null : Number(ratio.toFixed(3)),
      slow: changedRun.ms > SLOW_FACTOR * headCheck.ms + SLOW_GRACE_MS,
    }
    if (!changedRun.findings) {
      pair.result = 'fail'
      pair.reasons.push(`crash: --changed ${changedRun.error}`)
      return pair
    }

    const baseIndex = new Map()
    for (const entry of withOccurrences(baseCheck.findings)) baseIndex.set(`${entry.key}#${entry.occurrence}`, entry.finding)
    const blame = new Map()
    const lineMapFor = file => {
      if (!blame.has(file)) blame.set(file, blameLineMap(this.clone, base, head, file))
      return blame.get(file)
    }
    const required = new Map()
    const oldDebt = new Map()
    let requiredChanged = 0
    let requiredUnchanged = 0
    let headBad = 0
    try {
      for (const { finding, key, occurrence } of withOccurrences(headCheck.findings).filter(entry => isBad(entry.finding))) {
        headBad++
        const mapped = lineMapFor(repoPath(finding.file)).get(finding.line)
        if (!mapped) throw new Error(`git blame has no line ${finding.line} for ${repoPath(finding.file)}`)
        const push = (map, value) => map.set(key, [...map.get(key) ?? [], value])
        if (!mapped.base) {
          requiredChanged++
          push(required, { ...summarize(finding), reason: 'changed-line', base: null })
          continue
        }
        const match = baseIndex.get(`${keyOf(mapped.file, mapped.line, finding.id, finding.matched)}#${occurrence}`)
        if (match && isBad(match)) {
          push(oldDebt, { ...summarize(finding), base: summarize(match) })
          continue
        }
        requiredUnchanged++
        push(required, {
          ...summarize(finding),
          reason: 'newly-actionable',
          base: match ? summarize(match) : { file: mapped.file, line: mapped.line, finding: null },
        })
      }
    } catch (error) {
      pair.result = 'incomplete'
      pair.reasons.push(`oracle: ${error.message}`)
      return pair
    }

    const reported = new Map()
    let changedBad = 0
    for (const finding of changedRun.findings.filter(isBad)) {
      changedBad++
      const key = keyOf(finding.file, finding.line, finding.id, finding.matched)
      reported.set(key, [...reported.get(key) ?? [], finding])
    }
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
    }
    if (pair.missing.length) {
      pair.result = 'fail'
      pair.reasons.push(`missing ${pair.missing.length} oracle-required finding(s)`)
      if (changedRun.code === 0) pair.reasons.push('false clean: --changed exited 0')
    }
    return pair
  }
}

export const runE2e = ({ checker, repos, commits = 10, synthetic = false, keep = false, log = () => {} }) => {
  const report = { schema: 'model-eol/e2e-changed@0', checker, flags: CHECK_FLAGS, commits, synthetic, repos: [], pairs: [] }
  for (const repo of repos) {
    const source = path.resolve(repo)
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-e2e-changed-')))
    const entry = { repo: source, status: 'ok', reason: null, pairs: 0, temp: keep ? tempRoot : null, skipped_mutations: [] }
    report.repos.push(entry)
    try {
      const session = new RepoSession({ source, tempRoot, checker })
      const skipped = fs.existsSync(source) ? session.prepare() : 'path does not exist'
      if (skipped) {
        entry.status = 'skipped'
        entry.reason = skipped
        log(`skip ${source}: ${skipped}`)
        continue
      }
      entry.head = session.head
      entry.note = session.headNote
      const pairs = session.historyPairs(commits)
      if (synthetic) {
        for (const mutation of MUTATIONS) {
          const result = session.mutate(mutation)
          if (result.skipped) entry.skipped_mutations.push({ mutation, reason: result.skipped })
          else pairs.push({ base: session.head, head: result.commit, mutation, description: result.description })
        }
      }
      for (const pair of pairs) {
        const evaluated = session.evaluatePair(pair)
        report.pairs.push(evaluated)
        entry.pairs++
        const label = evaluated.mutation ? `mutation ${evaluated.mutation}` : evaluated.head.slice(0, 12)
        log(`${evaluated.result} ${path.basename(source)} ${label}${evaluated.reasons.length ? `: ${evaluated.reasons.join('; ')}` : ''}`)
      }
    } catch (error) {
      entry.status = 'error'
      entry.reason = error.message
      log(`error ${source}: ${error.message}`)
    } finally {
      if (!keep) fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }
  const evaluated = report.pairs.filter(pair => pair.timings)
  const ratios = evaluated.map(pair => pair.timings.ratio).filter(ratio => ratio !== null)
  report.summary = {
    repos: report.repos.length,
    repos_skipped: report.repos.filter(repo => repo.status !== 'ok').length,
    pairs: report.pairs.length,
    failed: report.pairs.filter(pair => pair.result === 'fail').length,
    missing: report.pairs.reduce((sum, pair) => sum + pair.missing.length, 0),
    extra: report.pairs.reduce((sum, pair) => sum + pair.extra.length, 0),
    crashes: report.pairs.filter(pair => pair.reasons.some(reason => reason.startsWith('crash'))).length,
    incomplete: report.pairs.filter(pair => pair.result === 'incomplete').length,
    false_clean: report.pairs.filter(pair => pair.reasons.some(reason => reason.startsWith('false clean'))).length,
    slow: evaluated.filter(pair => pair.timings.slow).length,
    timing_ratio_median: ratios.length ? Number(median(ratios).toFixed(3)) : null,
    timing_ratio_max: ratios.length ? Number(Math.max(...ratios).toFixed(3)) : null,
  }
  report.ok = report.summary.failed === 0 && report.repos.every(repo => repo.status !== 'error')
  return report
}

export const formatSummary = report => {
  const s = report.summary
  const lines = [
    `model-eol --changed e2e: ${s.repos} repo(s) (${s.repos_skipped} skipped), ${s.pairs} pair(s)`,
    `  missing ${s.missing}, extra ${s.extra}, crashes ${s.crashes}, incomplete ${s.incomplete}, false clean ${s.false_clean}`,
    `  timing --changed/full head: median ${s.timing_ratio_median ?? 'n/a'}x, max ${s.timing_ratio_max ?? 'n/a'}x, slow ${s.slow}`,
  ]
  for (const repo of report.repos.filter(repo => repo.status !== 'ok')) lines.push(`  ${repo.status} ${repo.repo}: ${repo.reason}`)
  for (const pair of report.pairs.filter(pair => pair.result !== 'pass')) {
    lines.push(`  ${pair.result.toUpperCase()} ${pair.base.slice(0, 12)}..${pair.head.slice(0, 12)}${pair.mutation ? ` (mutation ${pair.mutation})` : ''}: ${pair.reasons.join('; ')}`)
    for (const finding of pair.missing.slice(0, 10)) lines.push(`    missing ${finding.file}:${finding.line} ${finding.id} (${finding.reason})`)
  }
  lines.push(report.ok ? 'result: PASS' : 'result: FAIL')
  return lines.join('\n')
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      checker: { type: 'string' },
      repo: { type: 'string', multiple: true },
      commits: { type: 'string' },
      synthetic: { type: 'boolean' },
      out: { type: 'string' },
      keep: { type: 'boolean' },
      policy: { type: 'string' },
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
  CHECK_FLAGS = POLICY_FLAGS[policy]
  const commits = values.commits === undefined ? 10 : Number(values.commits)
  if (!Number.isInteger(commits) || commits < 0) throw usageError('--commits must be a non-negative integer')
  const report = runE2e({ checker, repos: values.repo, commits, synthetic: values.synthetic ?? false, keep: values.keep ?? false, log: line => console.error(line) })
  if (values.out) fs.writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(formatSummary(report))
  for (const repo of report.repos.filter(repo => repo.temp)) console.log(`kept ${repo.temp}`)
  return report.ok ? 0 : 1
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`e2e-changed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
