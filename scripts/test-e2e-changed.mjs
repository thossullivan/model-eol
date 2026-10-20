#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { blameLineMap } from './e2e-changed.mjs'

const root = path.resolve(import.meta.dirname, '..')
const harness = path.join(root, 'scripts', 'e2e-changed.mjs')
const checker = path.join(root, 'check.mjs')
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-e2e-changed-test-')))
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=e2e test', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr}`)
  return result.stdout.trim()
}

const write = (repo, file, content) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
}

const commit = (repo, message) => {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '--no-verify', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

const runHarness = (checkerPath, repos, out, { synthetic = true } = {}) => {
  const result = spawnSync(process.execPath, [harness, '--checker', checkerPath, ...repos.flatMap(repo => ['--repo', repo]), ...(synthetic ? ['--synthetic'] : []), '--out', out], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr, report: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

try {
  const blameRepo = path.join(tempRoot, 'blame')
  fs.mkdirSync(blameRepo)
  git(blameRepo, 'init', '-q')
  write(blameRepo, 'f.txt', 'a\nb\nc\nd\n')
  const blameBase = commit(blameRepo, 'base')
  git(blameRepo, 'mv', 'f.txt', 'g.txt')
  write(blameRepo, 'g.txt', 'x\ny\na\nb\nC\nd\n')
  const blameHead = commit(blameRepo, 'rename and edit')
  const lineMap = blameLineMap(blameRepo, blameBase, blameHead, 'g.txt')
  assert.deepEqual(Object.fromEntries(lineMap), {
    1: { base: false },
    2: { base: false },
    3: { base: true, file: 'f.txt', line: 1 },
    4: { base: true, file: 'f.txt', line: 2 },
    5: { base: false },
    6: { base: true, file: 'f.txt', line: 4 },
  }, 'git blame attributes unchanged lines to the boundary commit with base file names and line numbers')
  console.log('ok: blame line map follows renames and keeps base line numbers')

  const repo = path.join(tempRoot, 'consumer')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  write(repo, '.model-eol.json', `${JSON.stringify({ ignore: { models: ['o3-deep-research'], paths: ['generated/**'] } }, null, 2)}\n`)
  write(repo, 'app.py', 'MODEL = "claude-opus-4-1-20250805"\n\nFALLBACK = "gpt-5.6-sol"\n')
  write(repo, 'legacy.py', 'import os\nMODEL = "o3-deep-research"\n')
  write(repo, 'generated/old.py', 'MODEL = "claude-opus-4-1-20250805"\n')
  commit(repo, 'base')
  write(repo, '.model-eol.json', `${JSON.stringify({ ignore: { paths: ['generated/**'] } }, null, 2)}\n`)
  const configChange = commit(repo, 'stop ignoring o3-deep-research')
  write(repo, 'app.py', '# header\n# more\nMODEL = "claude-opus-4-1-20250805"\n\nFALLBACK = "gpt-5.6-sol"\n')
  const debtMove = commit(repo, 'move old debt down')
  const empty = path.join(tempRoot, 'empty')
  fs.mkdirSync(empty)
  git(empty, 'init', '-q')

  const passing = runHarness(checker, [repo, empty], path.join(tempRoot, 'pass.json'))
  assert.equal(passing.code, 0, `harness passes on the bundled checker:\n${passing.out}\n${passing.err}`)
  const { report } = passing
  assert.equal(report.summary.missing, 0, 'bundled checker misses no oracle-required finding')
  assert.equal(report.summary.crashes, 0, 'bundled checker does not crash')
  assert.equal(report.repos.find(entry => entry.repo === empty)?.reason, 'no commits', 'a repository without commits is skipped and reported')
  const configPair = report.pairs.find(pair => pair.head === configChange)
  assert(configPair?.counts.required_unchanged_line >= 1, 'the config-change pair has an oracle-required finding on an unchanged line')
  assert(configPair.counts.changed_bad >= 1 && configPair.exit.changed === 1, 'the config-change pair fails the --changed gate')
  const movePair = report.pairs.find(pair => pair.head === debtMove)
  assert(movePair?.counts.old_debt >= 1 && movePair.counts.required === 0 && movePair.exit.changed === 0, 'moving old debt down is old debt to the oracle and clean to --changed')
  const mutations = new Set(report.pairs.map(pair => pair.mutation).filter(Boolean))
  for (const mutation of ['a', 'b', 'c', 'd', 'e', 'f']) assert(mutations.has(mutation), `synthetic mutation ${mutation} applies to the fixture`)
  const ignoreRemoval = report.pairs.find(pair => pair.mutation === 'f')
  assert(ignoreRemoval.counts.required_unchanged_line >= 1, 'removing a path ignore makes an unchanged reference newly actionable')
  assert(passing.out.includes('result: PASS'), 'summary reports a pass')
  console.log(`ok: harness passes on check.mjs (${report.summary.pairs} pairs)`)

  const dropped = path.join(tempRoot, 'dropped.jsonl')
  const shim = path.join(tempRoot, 'drop-newly-actionable.mjs')
  fs.writeFileSync(shim, `import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, [${JSON.stringify(checker)}, ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
process.stderr.write(result.stderr)
if (!process.argv.includes('--changed') || ![0, 1].includes(result.status)) {
  process.stdout.write(result.stdout)
  process.exit(result.status ?? 2)
}
const doc = JSON.parse(result.stdout)
const kept = doc.findings.filter(finding => finding.changed?.reason !== 'newly-actionable')
for (const finding of doc.findings.filter(finding => !kept.includes(finding))) {
  fs.appendFileSync(${JSON.stringify(dropped)}, JSON.stringify({ file: finding.file, line: finding.line, id: finding.id }) + '\\n')
}
process.stdout.write(JSON.stringify({ ...doc, findings: kept }, null, 2) + '\\n')
const bad = kept.some(finding => (finding.status === 'retired' || finding.status === 'retiring') && finding.waiver?.active !== true)
process.exit(bad ? 1 : 0)
`)
  const failing = runHarness(shim, [repo], path.join(tempRoot, 'fail.json'), { synthetic: false })
  assert.equal(failing.code, 1, `harness fails a checker that drops newly actionable findings:\n${failing.out}\n${failing.err}`)
  const droppedFindings = fs.readFileSync(dropped, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const missing = failing.report.pairs.flatMap(pair => pair.missing.map(finding => ({ file: finding.file, line: finding.line, id: finding.id })))
  const sortKey = finding => JSON.stringify([finding.file, finding.line, finding.id])
  assert(droppedFindings.length >= 1, 'the shim dropped a newly actionable finding')
  assert.deepEqual(missing.map(sortKey).sort(), droppedFindings.map(sortKey).sort(), 'every dropped finding is listed as missing, and nothing else')
  assert(failing.report.pairs.find(pair => pair.head === configChange).reasons.includes('false clean: --changed exited 0'), 'the shim\'s clean exit on the config-change pair is a false clean')
  assert(failing.out.includes('result: FAIL') && failing.out.includes('missing legacy.py:2 o3-deep-research'), 'summary names the missing finding')
  console.log(`ok: harness fails the shim with ${missing.length} missing finding(s)`)

  const usage = spawnSync(process.execPath, [harness, '--repo', repo], { encoding: 'utf8' })
  assert.equal(usage.status, 2, 'a missing --checker is a usage error')
  console.log('ok: usage errors exit 2')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('e2e-changed harness tests passed')
