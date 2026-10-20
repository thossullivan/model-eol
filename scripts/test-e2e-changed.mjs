#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { blameLineMap, diffFileRecords, diffLineMap } from './e2e-changed.mjs'
import { lifecycleFor, loadFeeds } from '../lib/feeds.mjs'

const root = path.resolve(import.meta.dirname, '..')
const harness = path.join(root, 'scripts', 'e2e-changed.mjs')
const checker = path.join(root, 'check.mjs')
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-e2e-changed-test-')))
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }
const RETIRED = 'claude-opus-4-1-20250805'

const { entries } = loadFeeds(path.join(root, 'feeds'))
const feedIds = [...new Set([...entries.values()].map(record => record.entry.id))].sort()
const statusOf = (id, days, via = null) => {
  const record = entries.get(id)
  return lifecycleFor(record.entry, { days, via, policy: record.policy, generated: record.generated }).status
}
const bad = status => status === 'retired' || status === 'retiring'
// Chosen from the live feeds so the fixture keeps its shape as dates pass.
const FUTURE = feedIds.find(id => statusOf(id, 90) === 'scheduled' && statusOf(id, 36500) === 'retiring')
const VIA_ONLY = feedIds.find(id => !bad(statusOf(id, 36500)) && bad(statusOf(id, 36500, 'aws-bedrock')))
assert(FUTURE, 'the bundled feeds hold a model that is scheduled at 90 days and retiring at 36500')

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

const newRepo = name => {
  const repo = path.join(tempRoot, name)
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  return repo
}

const writeShim = (name, body) => {
  const file = path.join(tempRoot, `${name}.mjs`)
  fs.writeFileSync(file, `import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const changed = args.includes('--changed')
const isBad = finding => (finding.status === 'retired' || finding.status === 'retiring') && finding.waiver?.active !== true
const real = extra => spawnSync(process.execPath, [${JSON.stringify(checker)}, ...args, ...extra], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
${body}
`)
  return file
}

let runs = 0
const runHarness = (checkerPath, repos, { synthetic = false, commits = null, policy = 'config', extra = [] } = {}) => {
  const out = path.join(tempRoot, `report-${runs++}.json`)
  const args = [harness, '--checker', checkerPath, ...repos.flatMap(repo => ['--repo', repo]), '--policy', policy, '--out', out, ...extra]
  if (synthetic) args.push('--synthetic')
  if (commits !== null) args.push('--commits', String(commits))
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr, report: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

const detail = run => `\n${run.out}\n${run.err}`

try {
  const blameRepo = newRepo('blame')
  write(blameRepo, 'f.txt', 'a\nb\nc\nd\n')
  const blameBase = commit(blameRepo, 'base')
  git(blameRepo, 'mv', 'f.txt', 'g.txt')
  write(blameRepo, 'g.txt', 'x\ny\na\nb\nC\nd\n')
  const blameHead = commit(blameRepo, 'rename and edit')
  assert.deepEqual(Object.fromEntries(blameLineMap(blameRepo, blameBase, blameHead, 'g.txt')), {
    1: { base: false },
    2: { base: false },
    3: { base: true, file: 'f.txt', line: 1 },
    4: { base: true, file: 'f.txt', line: 2 },
    5: { base: false },
    6: { base: true, file: 'f.txt', line: 4 },
  }, 'git blame attributes unchanged lines to the boundary commit with base file names and line numbers')
  const blameDiff = diffFileRecords(blameRepo, blameBase, blameHead)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(line => diffLineMap(blameDiff, 'g.txt', line)), [1, 2, 3, 4, 5, 6].map(line => blameLineMap(blameRepo, blameBase, blameHead, 'g.txt').get(line)), 'the diff fallback maps the rename case like blame')
  console.log('ok: blame line map follows renames and keeps base line numbers; the diff fallback agrees')

  const mergeRepo = newRepo('merge')
  write(mergeRepo, 'app.py', `A = 1\nMODEL = "${RETIRED}"\nB = 2\n`)
  write(mergeRepo, 'other.txt', 'one\n')
  const forkPoint = commit(mergeRepo, 'fork point')
  write(mergeRepo, 'other.txt', 'one\ntwo\n')
  commit(mergeRepo, 'main one')
  write(mergeRepo, 'other.txt', 'one\ntwo\nthree\n')
  const mergeBase = commit(mergeRepo, 'main two (BASE)')
  git(mergeRepo, 'checkout', '-q', '-b', 'side', forkPoint)
  write(mergeRepo, 'app.py', `A = 1\nMODEL = "${RETIRED}"\nB = 2\nNEW = "${RETIRED}"\n`)
  commit(mergeRepo, 'side adds a bad line')
  git(mergeRepo, 'checkout', '-q', 'main')
  git(mergeRepo, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  const mergeHead = git(mergeRepo, 'rev-parse', 'HEAD')
  const plainBlame = git(mergeRepo, 'blame', '--line-porcelain', `${mergeBase}..${mergeHead}`, '--', 'app.py').split('\n').find(line => / 2 2(?: \d+)?$/.test(line))
  assert(plainBlame && !plainBlame.startsWith(mergeBase), 'the fixture reproduces blame without --first-parent blaming an unchanged line on a non-base boundary')
  const mergeDiff = diffFileRecords(mergeRepo, mergeBase, mergeHead)
  assert.deepEqual([1, 2, 3, 4].map(line => blameLineMap(mergeRepo, mergeBase, mergeHead, 'app.py').get(line)), [1, 2, 3, 4].map(line => diffLineMap(mergeDiff, 'app.py', line)), 'first-parent blame maps the merge like git diff BASE HEAD')
  console.log('ok: first-parent blame keeps merged-in old debt on BASE')

  const repo = newRepo('consumer')
  const config = {
    days: 90,
    ignore: { models: ['o3-deep-research'], paths: ['generated/**'] },
    waivers: [{ model: RETIRED, paths: ['waived.py'], reason: 'e2e fixture', owner: 'e2e', expires: '2099-12-31' }],
  }
  const writeConfig = () => write(repo, '.model-eol.json', `${JSON.stringify(config, null, 2)}\n`)
  writeConfig()
  write(repo, 'app.py', `MODEL = "${RETIRED}"\n\nFALLBACK = "gpt-5.6-sol"\n`)
  write(repo, 'legacy.py', 'import os\nMODEL = "o3-deep-research"\n')
  write(repo, 'generated/old.py', `MODEL = "${RETIRED}"\n`)
  write(repo, 'waived.py', `MODEL = "${RETIRED}"\n`)
  write(repo, 'future.py', `MODEL = "${FUTURE}"\n`)
  if (VIA_ONLY) write(repo, 'via_only.py', `MODEL = "${VIA_ONLY}"\n`)
  commit(repo, 'base')
  config.ignore = { paths: ['generated/**'] }
  writeConfig()
  const ignoreRemoval = commit(repo, 'stop ignoring o3-deep-research')
  config.waivers = []
  writeConfig()
  const waiverRemoval = commit(repo, 'remove the waiver')
  config.days = 36500
  writeConfig()
  const daysChange = commit(repo, 'raise days so a scheduled model is retiring')
  config.via = 'aws-bedrock'
  writeConfig()
  const viaChange = commit(repo, 'judge by the Bedrock clock')
  write(repo, 'app.py', `# header\n# more\nMODEL = "${RETIRED}"\n\nFALLBACK = "gpt-5.6-sol"\n`)
  const debtMove = commit(repo, 'move old debt down')
  write(repo, 'app.py', `# header\n# more\nMODEL = "${RETIRED}"\n\nFALLBACK = "gpt-5.6-sol"\nNEW_A = "${RETIRED}"\nNEW_B = "${RETIRED}"\n`)
  const addedLines = commit(repo, 'add two bad lines')
  write(repo, 'safe.py', 'SAFE = "gpt-5.6-sol"\n')
  const addedSafe = commit(repo, 'add a line that is not bad')

  const incompleteRepo = newRepo('incomplete')
  write(incompleteRepo, 'app.py', `MODEL = "${RETIRED}"\n`)
  fs.writeFileSync(path.join(incompleteRepo, 'binary.py'), Buffer.from([0x4d, 0x3d, 0xff, 0xfe, 0x0a]))
  commit(incompleteRepo, 'base with an invalid UTF-8 file')
  write(incompleteRepo, 'app.py', `MODEL = "${RETIRED}"\nOTHER = "${RETIRED}"\n`)
  const incompleteHead = commit(incompleteRepo, 'add a bad line next to coverage loss')

  const empty = path.join(tempRoot, 'empty')
  fs.mkdirSync(empty)
  git(empty, 'init', '-q')

  const passing = runHarness(checker, [repo, empty], { synthetic: true })
  assert.equal(passing.code, 0, `harness passes on the bundled checker:${detail(passing)}`)
  const { report } = passing
  const pairFor = head => report.pairs.find(pair => pair.head === head && !pair.mutation)
  assert.equal(report.summary.missing, 0, 'bundled checker misses no oracle-required finding')
  assert.equal(report.summary.extra, 0, 'bundled checker reports no old debt')
  assert.equal(report.repos.find(entry => entry.repo === empty)?.status, 'skipped', 'a repository without commits is skipped and reported')
  for (const [head, label] of [[ignoreRemoval, 'ignore removal'], [waiverRemoval, 'waiver removal'], [daysChange, 'days change']]) {
    const pair = pairFor(head)
    assert(pair.counts.required_unchanged_line >= 1 && pair.exit.changed === 1, `${label} makes an unchanged reference newly actionable and fails the gate`)
    assert.equal(pair.changed_reasons['newly-actionable'], pair.counts.required_unchanged_line, `${label}: every required finding is reported as newly actionable`)
  }
  assert(pairFor(waiverRemoval).required.some(finding => finding.file === 'waived.py' && finding.base?.status === 'retired'), 'a waived base finding that exists but is not bad becomes required')
  assert(pairFor(daysChange).required.some(finding => finding.file === 'future.py' && finding.status === 'retiring' && finding.base?.status === 'scheduled'), 'a scheduled base finding that becomes retiring is required')
  if (VIA_ONLY) assert(pairFor(viaChange).required.some(finding => finding.file === 'via_only.py'), 'a via change makes an unchanged reference newly actionable')
  const movePair = pairFor(debtMove)
  assert(movePair.counts.old_debt >= 1 && movePair.counts.required === 0 && movePair.exit.changed === 0, 'moving old debt down is old debt to the oracle and clean to --changed')
  assert.equal(pairFor(addedLines).counts.required_changed_line, 2, 'two added bad lines are required')
  const safePair = pairFor(addedSafe)
  assert(safePair.exit.changed === 0 && safePair.counts.changed_bad === 0 && safePair.counts.extra === 0, 'an added line that is not bad is not counted as a bad report')
  const mutations = new Map(report.pairs.filter(pair => pair.mutation).map(pair => [pair.mutation, pair]))
  for (const mutation of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']) {
    assert(mutations.has(mutation), `synthetic mutation ${mutation} applies to the fixture (skipped: ${JSON.stringify(report.repos[0].skipped_mutations)})`)
    assert.equal(typeof mutations.get(mutation).inert, 'boolean', `mutation ${mutation} records whether it was inert`)
  }
  for (const mutation of ['f', 'g', 'h', 'j', 'k']) assert.equal(mutations.get(mutation).inert, false, `mutation ${mutation} changes a finding's status`)
  assert(mutations.get('k').working_tree && mutations.get('k').counts.required_changed_line >= 1, 'an untracked file is a working-tree change whose bad findings are all required')
  assert(mutations.get('g').flags.includes('--feeds') && mutations.get('g').counts.required_unchanged_line >= 1, 'an in-repo feeds change makes an unchanged reference newly actionable')
  const invalidBase = mutations.get('l')
  assert(invalidBase.base_unavailable && invalidBase.exit.changed === 1 && invalidBase.changed_reasons['base-unavailable'] >= 1, 'an invalid base config reports affected bad findings as base-unavailable')
  assert(passing.out.includes('result: PASS'), 'summary reports a pass')
  console.log(`ok: harness passes on check.mjs (${report.summary.pairs} pairs, inert: ${report.summary.inert.join(',') || 'none'})`)

  const incomplete = runHarness(checker, [incompleteRepo])
  assert.equal(incomplete.code, 0, `harness compares an incomplete-coverage repository with --allow-incomplete:${detail(incomplete)}`)
  const incompletePair = incomplete.report.pairs.find(pair => pair.head === incompleteHead)
  assert(incompletePair.exit.changed === 2 && incompletePair.allow_incomplete.head && incompletePair.counts.required_changed_line === 1, 'incomplete head coverage fails --changed with exit 2, then the comparison runs with --allow-incomplete')
  console.log('ok: incomplete coverage must not produce a gate result')

  const dropped = path.join(tempRoot, 'dropped.jsonl')
  const dropNewlyActionable = writeShim('drop-newly-actionable', `
const result = real([])
process.stderr.write(result.stderr)
if (!changed || ![0, 1].includes(result.status)) {
  process.stdout.write(result.stdout)
  process.exit(result.status ?? 2)
}
const doc = JSON.parse(result.stdout)
const kept = doc.findings.filter(finding => finding.changed?.reason !== 'newly-actionable')
for (const finding of doc.findings.filter(finding => !kept.includes(finding))) {
  fs.appendFileSync(${JSON.stringify(dropped)}, JSON.stringify({ file: finding.file, line: finding.line, id: finding.id }) + '\\n')
}
process.stdout.write(JSON.stringify({ ...doc, findings: kept }))
process.exit(kept.some(isBad) ? 1 : 0)
`)
  const dropping = runHarness(dropNewlyActionable, [repo])
  assert.equal(dropping.code, 1, `harness fails a checker that drops newly actionable findings:${detail(dropping)}`)
  const droppedFindings = fs.readFileSync(dropped, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const missing = dropping.report.pairs.flatMap(pair => pair.missing.map(finding => ({ file: finding.file, line: finding.line, id: finding.id })))
  const sortKey = finding => JSON.stringify([finding.file, finding.line, finding.id])
  assert(droppedFindings.length >= 3, 'the shim dropped newly actionable findings')
  assert.deepEqual(missing.map(sortKey).sort(), droppedFindings.map(sortKey).sort(), 'every dropped finding is listed as missing, and nothing else')
  assert(dropping.report.pairs.find(pair => pair.head === ignoreRemoval).reasons.includes('false clean: --changed exited 0'), 'the shim\'s clean exit on the ignore-removal pair is a false clean')
  assert(dropping.out.includes('missing legacy.py:2 o3-deep-research'), 'summary names the missing finding')
  console.log(`ok: harness fails a shim that drops newly actionable findings (${missing.length} missing)`)

  const dropOne = writeShim('drop-one-added-line', `
const result = real([])
process.stderr.write(result.stderr)
if (!changed || result.status !== 1) {
  process.stdout.write(result.stdout)
  process.exit(result.status ?? 2)
}
const doc = JSON.parse(result.stdout)
const index = doc.findings.findIndex(finding => isBad(finding) && finding.changed?.reason === 'added-line')
if (index !== -1) doc.findings.splice(index, 1)
process.stdout.write(JSON.stringify(doc))
process.exit(1)
`)
  const droppingOne = runHarness(dropOne, [repo], { commits: 2 })
  assert.equal(droppingOne.code, 1, `harness fails a checker that keeps exit 1 but drops one added-line finding:${detail(droppingOne)}`)
  const dropOnePair = droppingOne.report.pairs.find(pair => pair.head === addedLines)
  assert(dropOnePair.missing.length === 1 && dropOnePair.missing[0].reason === 'changed-line' && !dropOnePair.reasons.some(reason => reason.startsWith('exit mismatch')), 'the dropped added-line finding is missing while the exit code stays consistent')
  console.log('ok: harness fails a shim that drops one finding and keeps exit 1')

  const lenient = writeShim('lenient', `
const result = real(changed && !args.includes('--allow-incomplete') ? ['--allow-incomplete'] : [])
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(changed && result.status === 1 ? 0 : result.status ?? 2)
`)
  const lenientRun = runHarness(lenient, [repo, incompleteRepo], { commits: 2 })
  assert.equal(lenientRun.code, 1, `harness fails a checker whose --changed exit code is wrong:${detail(lenientRun)}`)
  assert(lenientRun.report.pairs.find(pair => pair.head === addedLines).reasons.some(reason => reason.startsWith('exit mismatch: --changed exited 0')), 'exit 0 with bad findings is an exit mismatch')
  assert(lenientRun.report.pairs.find(pair => pair.head === incompleteHead).reasons.some(reason => reason.startsWith('incomplete head coverage produced a --changed gate result')), 'a gate result despite incomplete head coverage fails')
  console.log('ok: harness fails wrong --changed exit codes and gate results on incomplete coverage')

  const phantom = writeShim('phantom', `
const result = real([])
process.stderr.write(result.stderr)
if (changed || ![0, 1].includes(result.status)) {
  process.stdout.write(result.stdout)
  process.exit(result.status ?? 2)
}
const doc = JSON.parse(result.stdout)
doc.findings.push({ ...doc.findings.find(isBad), file: 'phantom.py', line: 1 })
process.stdout.write(JSON.stringify(doc))
process.exit(1)
`)
  const phantomRun = runHarness(phantom, [repo], { commits: 1 })
  assert.equal(phantomRun.code, 1, `an oracle error fails the run:${detail(phantomRun)}`)
  assert(phantomRun.report.summary.oracle_errors >= 1 && phantomRun.report.pairs[0].reasons.some(reason => reason.startsWith('oracle:')), 'the unmappable finding is reported as an oracle error')
  console.log('ok: oracle errors fail the run')

  const oddRepo = newRepo('odd-names')
  write(oddRepo, 'odd\\name.py', `A = 1\nMODEL = "${RETIRED}"\n`)
  commit(oddRepo, 'base')
  write(oddRepo, 'odd\\name.py', `A = 2\nMODEL = "${RETIRED}"\nNEW = "${RETIRED}"\n`)
  commit(oddRepo, 'edit')
  const odd = runHarness(checker, [oddRepo, mergeRepo], { policy: 'broad', commits: 1 })
  assert.equal(odd.code, 0, `a backslash file name and a --no-ff merge map without false findings:${detail(odd)}`)
  const oddPair = odd.report.pairs.find(pair => pair.repo === oddRepo)
  assert(oddPair.counts.old_debt === 1 && oddPair.counts.required_changed_line === 1, 'the backslash file keeps old debt and its added line apart')
  const mergePair = odd.report.pairs.find(pair => pair.head === mergeHead)
  assert(mergePair.base === mergeBase && mergePair.counts.old_debt === 1 && mergePair.counts.required_changed_line === 1 && mergePair.line_map_fallbacks.length === 0, 'the merge pair keeps merged-in old debt apart from the merged added line')
  console.log('ok: backslash file names and --no-ff merges map through blame')

  const nothing = runHarness(checker, [repo], { commits: 0 })
  assert(nothing.code === 1 && nothing.report.summary.evaluated === 0, 'a run that evaluates no pair fails')
  const missingRepo = runHarness(checker, [path.join(tempRoot, 'missing-repo'), repo], { commits: 1 })
  assert(missingRepo.code === 1 && missingRepo.report.summary.repos_failed === 1 && missingRepo.report.summary.evaluated === 1, 'a repository that cannot be cloned fails the run even when others pass')
  const plain = path.join(tempRoot, 'plain')
  fs.mkdirSync(plain)
  const notGit = runHarness(checker, [plain, repo], { commits: 1 })
  assert(notGit.code === 1 && notGit.report.repos[0].status === 'failed', 'a directory that is not a git repository fails the run')
  const usage = spawnSync(process.execPath, [harness, '--repo', repo], { encoding: 'utf8' })
  assert.equal(usage.status, 2, 'a missing --checker is a usage error')
  console.log('ok: evaluating nothing, unclonable repositories, and usage errors fail')

  const sleeper = writeShim('sleeper', `
if (changed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
const result = real([])
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(result.status ?? 2)
`)
  const timedOut = runHarness(sleeper, [repo], { commits: 1, extra: ['--timeout-seconds', '1'] })
  assert.equal(timedOut.code, 1, `a --changed timeout fails the run:${detail(timedOut)}`)
  assert.equal(timedOut.report.summary.crashes, 1, 'the --changed timeout is a crash')
  const slowRepo = newRepo('slow')
  write(slowRepo, 'app.py', `MODEL = "${RETIRED}"\n`)
  commit(slowRepo, 'base')
  write(slowRepo, 'slow.marker', 'the slow shim sleeps on full checks here\n')
  commit(slowRepo, 'mark the head slow')
  const slowFull = writeShim('slow-full', `
if (!changed && fs.existsSync('slow.marker')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
const result = real([])
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(result.status ?? 2)
`)
  const fullTimeout = runHarness(slowFull, [repo, slowRepo], { commits: 1, extra: ['--timeout-seconds', '1'] })
  assert(fullTimeout.code === 1 && fullTimeout.report.pairs.find(pair => pair.repo === slowRepo).reasons.some(reason => reason.startsWith('crash: full head check timed out')), `a full check timeout is a crash, not an incomplete pair:${detail(fullTimeout)}`)

  const signalTmp = path.join(tempRoot, 'signal-tmp')
  fs.mkdirSync(signalTmp)
  const child = spawn(process.execPath, [harness, '--checker', sleeper, '--repo', repo, '--commits', '1'], {
    env: { ...process.env, TMPDIR: signalTmp },
    stdio: 'ignore',
    detached: true,
  })
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  const deadline = Date.now() + 30000
  const started = () => fs.readdirSync(signalTmp).some(name => name.startsWith('model-eol-e2e-changed-') && fs.readdirSync(path.join(signalTmp, name)).some(entry => entry.startsWith('wt-')))
  while (!started()) {
    assert(Date.now() < deadline, 'the harness created its worktrees')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await new Promise(resolve => setTimeout(resolve, 1500))
  process.kill(-child.pid, 'SIGTERM')
  const status = await exited
  assert.equal(status.code, 143, `SIGTERM exits 143 (got ${JSON.stringify(status)})`)
  assert.deepEqual(fs.readdirSync(signalTmp).filter(name => name.startsWith('model-eol-e2e-changed-')), [], 'SIGTERM removes the temp root')
  console.log('ok: timeouts are crashes and SIGTERM removes the temp root')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('e2e-changed harness tests passed')
