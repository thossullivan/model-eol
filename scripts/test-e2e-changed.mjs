#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { blameLineMap, diffFileRecords, diffLineMap, guardWrite } from './e2e-changed.mjs'
import { lifecycleFor, loadFeeds } from '../lib/feeds.mjs'

const root = path.resolve(import.meta.dirname, '..')
const harness = path.join(root, 'scripts', 'e2e-changed.mjs')
const checker = path.join(root, 'check.mjs')
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-e2e-changed-test-')))

{
  const clone = path.join(tempRoot, 'guard-clone')
  const outside = path.join(tempRoot, 'guard-outside')
  fs.mkdirSync(path.join(clone, 'sub'), { recursive: true })
  fs.mkdirSync(outside)
  fs.symlinkSync(path.join(outside, 'shared.json'), path.join(clone, '.model-eol.json'))
  fs.symlinkSync(outside, path.join(clone, 'linked'))
  assert.throws(() => guardWrite(clone, '.model-eol.json'), /symlink/, 'mutations refuse to write through a symlinked config')
  assert.throws(() => guardWrite(clone, 'linked/new.json'), /symlink/, 'mutations refuse to write under a symlinked directory')
  assert.equal(guardWrite(clone, 'sub/new/file.py'), path.join(clone, 'sub/new/file.py'), 'mutations write plain paths inside the clone')
  assert.equal(fs.readdirSync(outside).length, 0, 'the guard writes nothing itself')
  console.log('ok: mutation writes never follow a symlink out of the clone')
}
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

// Shims live outside the checkout, so the harness must find feeds for g, j, and k without a feeds/ next to them.
const writeShim = (name, body) => {
  const file = path.join(tempRoot, 'shims', `${name}.mjs`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const changed = args.includes('--changed')
const isBad = finding => (finding.status === 'retired' || finding.status === 'retiring') && finding.waiver?.active !== true
const real = extra => spawnSync(process.execPath, [${JSON.stringify(checker)}, ...args, ...extra], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
const pass = result => {
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 2)
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const holdWithGrandchild = () => {
  fs.mkdirSync(path.join(os.tmpdir(), 'model-eol-base-shim-' + process.pid))
  const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' })
  if (process.env.E2E_GRANDCHILD_PIDFILE) fs.appendFileSync(process.env.E2E_GRANDCHILD_PIDFILE, grandchild.pid + '\\n')
  sleep(60000)
}
${body}
`)
  return file
}

let runs = 0
const runHarness = (checkerPath, repos, { mutations = null, synthetic = false, commits = null, policy = 'config', extra = [], env = {} } = {}) => new Promise((resolve, reject) => {
  const out = path.join(tempRoot, `report-${runs++}.json`)
  const args = [harness, '--checker', checkerPath, ...repos.flatMap(repo => ['--repo', repo]), '--policy', policy, '--out', out, ...extra]
  if (synthetic) args.push('--synthetic')
  if (mutations) args.push('--mutations', mutations)
  if (commits !== null) args.push('--commits', String(commits))
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject)
  child.on('close', code => resolve({ code, out: stdout, err: stderr, report: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }))
})

const detail = run => `\n${run.out}\n${run.err}`
const alive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (condition, ms, label) => {
  const deadline = Date.now() + ms
  while (!condition()) {
    assert(Date.now() < deadline, label)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const pidsIn = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
const leftovers = directory => fs.readdirSync(directory).filter(name => name.startsWith('model-eol-'))

try {
  const blameRepo = newRepo('blame')
  write(blameRepo, 'f.txt', 'a\nb\nc\nd\n')
  const blameBase = commit(blameRepo, 'base')
  git(blameRepo, 'mv', 'f.txt', 'g.txt')
  write(blameRepo, 'g.txt', 'x\ny\na\nb\nC\nd\n')
  const blameHead = commit(blameRepo, 'rename and edit')
  const blameMap = await blameLineMap(blameRepo, blameBase, blameHead, 'g.txt')
  assert.deepEqual(Object.fromEntries(blameMap), {
    1: { base: false },
    2: { base: false },
    3: { base: true, file: 'f.txt', line: 1 },
    4: { base: true, file: 'f.txt', line: 2 },
    5: { base: false },
    6: { base: true, file: 'f.txt', line: 4 },
  }, 'git blame attributes unchanged lines to the boundary commit with base file names and line numbers')
  const blameDiff = await diffFileRecords(blameRepo, blameBase, blameHead)
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(line => diffLineMap(blameDiff, 'g.txt', line)), [1, 2, 3, 4, 5, 6].map(line => blameMap.get(line)), 'the diff fallback maps the rename case like blame')
  fs.writeFileSync(path.join(blameRepo, 'data.txt'), 'a\nb\0\nc\n')
  const binaryBase = commit(blameRepo, 'binary-looking file')
  fs.writeFileSync(path.join(blameRepo, 'data.txt'), 'new\na\nb\0\nc\n')
  const binaryHead = commit(blameRepo, 'insert a line above')
  assert.deepEqual(diffLineMap(await diffFileRecords(blameRepo, binaryBase, binaryHead), 'data.txt', 2), { base: true, file: 'data.txt', line: 1 }, 'the diff fallback maps binary-looking files as text')
  console.log('ok: blame line map follows renames; the diff fallback agrees and reads binary-looking files as text')

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
  const mergeDiff = await diffFileRecords(mergeRepo, mergeBase, mergeHead)
  const mergeMap = await blameLineMap(mergeRepo, mergeBase, mergeHead, 'app.py')
  assert.deepEqual([1, 2, 3, 4].map(line => mergeMap.get(line)), [1, 2, 3, 4].map(line => diffLineMap(mergeDiff, 'app.py', line)), 'first-parent blame maps the merge like git diff BASE HEAD')
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
  write(repo, 'pkg/service.py', `MODEL = "${RETIRED}"\n`)
  const subdirAdded = commit(repo, 'add a bad line under pkg/')

  const incompleteRepo = newRepo('incomplete')
  write(incompleteRepo, 'app.py', `MODEL = "${RETIRED}"\n`)
  fs.writeFileSync(path.join(incompleteRepo, 'binary.py'), Buffer.from([0x4d, 0x3d, 0xff, 0xfe, 0x0a]))
  commit(incompleteRepo, 'base with an invalid UTF-8 file')
  write(incompleteRepo, 'app.py', `MODEL = "${RETIRED}"\nOTHER = "${RETIRED}"\n`)
  const incompleteHead = commit(incompleteRepo, 'add a bad line next to coverage loss')

  const empty = path.join(tempRoot, 'empty')
  fs.mkdirSync(empty)
  git(empty, 'init', '-q')

  const oddRepo = newRepo('odd-names')
  write(oddRepo, 'odd\\name.py', `A = 1\nMODEL = "${RETIRED}"\n`)
  commit(oddRepo, 'base')
  write(oddRepo, 'odd\\name.py', `A = 2\nMODEL = "${RETIRED}"\nNEW = "${RETIRED}"\n`)
  commit(oddRepo, 'edit')

  const markedRepo = (name, marker) => {
    const marked = newRepo(name)
    write(marked, 'app.py', `MODEL = "${RETIRED}"\n`)
    commit(marked, 'base')
    write(marked, marker, 'the shim misbehaves on full checks here\n')
    commit(marked, `add ${marker}`)
    return marked
  }
  const slowRepo = markedRepo('slow', 'slow.marker')
  const brokenRepo = markedRepo('broken', 'broken.marker')
  const plain = path.join(tempRoot, 'plain')
  fs.mkdirSync(plain)

  const dropped = path.join(tempRoot, 'dropped.jsonl')
  const shims = {
    dropNewlyActionable: writeShim('drop-newly-actionable', `
const result = real([])
if (!changed || ![0, 1].includes(result.status)) pass(result)
const doc = JSON.parse(result.stdout)
const kept = doc.findings.filter(finding => finding.changed?.reason !== 'newly-actionable')
for (const finding of doc.findings.filter(finding => !kept.includes(finding))) {
  fs.appendFileSync(${JSON.stringify(dropped)}, JSON.stringify({ file: finding.file, line: finding.line, id: finding.id }) + '\\n')
}
process.stdout.write(JSON.stringify({ ...doc, findings: kept }))
process.exit(kept.some(isBad) ? 1 : 0)
`),
    dropOne: writeShim('drop-one-added-line', `
const result = real([])
if (!changed || result.status !== 1) pass(result)
const doc = JSON.parse(result.stdout)
const index = doc.findings.findIndex(finding => isBad(finding) && finding.changed?.reason === 'added-line')
if (index !== -1) doc.findings.splice(index, 1)
process.stdout.write(JSON.stringify(doc))
process.exit(1)
`),
    lenient: writeShim('lenient', `
const result = real(changed && !args.includes('--allow-incomplete') ? ['--allow-incomplete'] : [])
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(changed && result.status === 1 ? 0 : result.status ?? 2)
`),
    phantom: writeShim('phantom', `
const result = real([])
if (changed || ![0, 1].includes(result.status)) pass(result)
const doc = JSON.parse(result.stdout)
doc.findings.push({ ...doc.findings.find(isBad), file: 'phantom.py', line: 1 })
process.stdout.write(JSON.stringify(doc))
process.exit(1)
`),
    // Blind to uncommitted edits (like a gate that diffs commits only) and to subdirectory targets.
    blind: writeShim('blind', `
const target = args[args.indexOf('check') + 1]
const dirty = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { stdio: 'ignore' }).status !== 0
if (changed && (dirty || target !== '.')) {
  process.stdout.write(JSON.stringify({ schema: 'model-eol/check@0.1', findings: [] }))
  process.exit(0)
}
pass(real([]))
`),
    misbehaveOnMarkers: writeShim('misbehave-on-markers', `
if (!changed && fs.existsSync('slow.marker')) sleep(60000)
if (!changed && fs.existsSync('broken.marker')) {
  process.stdout.write('not json')
  process.exit(3)
}
pass(real([]))
`),
    hold: writeShim('hold-changed', `
if (changed) holdWithGrandchild()
pass(real([]))
`),
  }

  const timeoutTmp = path.join(tempRoot, 'timeout-tmp')
  fs.mkdirSync(timeoutTmp)
  const timeoutPids = path.join(tempRoot, 'timeout-pids')
  const traceDir = path.join(tempRoot, 'trace2')
  fs.mkdirSync(traceDir)
  const [passing, incomplete, dropping, droppingOne, lenientRun, phantomRun, odd, nothing, missingRepo, notGit, blindRun, misbehaving, timedOut, traced] = await (async () => {
    const jobs = [
      () => runHarness(checker, [repo, empty], { synthetic: true }),
      () => runHarness(checker, [incompleteRepo], { mutations: 'h,k' }),
      () => runHarness(shims.dropNewlyActionable, [repo]),
      () => runHarness(shims.dropOne, [repo], { commits: 3 }),
      () => runHarness(shims.lenient, [repo, incompleteRepo], { commits: 3 }),
      () => runHarness(shims.phantom, [repo], { commits: 1 }),
      () => runHarness(checker, [oddRepo, mergeRepo], { policy: 'broad', commits: 1 }),
      () => runHarness(checker, [repo], { commits: 0 }),
      () => runHarness(checker, [path.join(tempRoot, 'missing-repo'), oddRepo], { commits: 1, policy: 'broad' }),
      () => runHarness(checker, [plain, oddRepo], { commits: 1, policy: 'broad' }),
      () => runHarness(shims.blind, [repo], { commits: 1, mutations: 'g,j,k,m,n' }),
      () => runHarness(shims.misbehaveOnMarkers, [oddRepo, slowRepo, brokenRepo], { commits: 1, policy: 'broad', extra: ['--timeout-seconds', '5'] }),
      () => runHarness(shims.hold, [oddRepo], { commits: 1, policy: 'broad', extra: ['--timeout-seconds', '5'], env: { TMPDIR: timeoutTmp, E2E_GRANDCHILD_PIDFILE: timeoutPids } }),
      () => runHarness(checker, [repo], { commits: 0, mutations: 'b,h', env: { GIT_TRACE2_EVENT: traceDir } }),
    ]
    const results = new Array(jobs.length)
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const index = next++
        results[index] = await jobs[index]()
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    return results
  })()

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
  const subdirPair = pairFor(subdirAdded)
  assert(subdirPair.subdir_check?.target === 'pkg' && subdirPair.subdir_check.base_ref === 'HEAD~1' && subdirPair.subdir_check.required === 1 && subdirPair.subdir_check.missing.length === 0 && subdirPair.subdir_check.exit === 1, 'the subdirectory target with a symbolic base ref reports the required finding under pkg/')
  const mutations = new Map(report.pairs.filter(pair => pair.mutation).map(pair => [pair.mutation, pair]))
  for (const mutation of ['a', 'b', 'c', 'd', 'e', 'f', 'g0', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']) {
    assert(mutations.has(mutation), `synthetic mutation ${mutation} applies to the fixture (skipped: ${JSON.stringify(report.repos[0].skipped_mutations)})`)
    assert.equal(typeof mutations.get(mutation).inert, 'boolean', `mutation ${mutation} records whether it was inert`)
  }
  for (const mutation of ['f', 'g', 'h', 'j', 'k', 'm', 'n']) assert.equal(mutations.get(mutation).inert, false, `mutation ${mutation} changes a finding's status`)
  assert(mutations.get('k').working_tree && mutations.get('k').counts.required_changed_line >= 1, 'an untracked file is a working-tree change whose bad findings are all required')
  assert(mutations.get('g').flags.includes('--feeds') && mutations.get('g').counts.required_unchanged_line >= 1, 'an in-repo feeds change makes an unchanged reference newly actionable')
  assert(mutations.get('g0').base_unavailable && mutations.get('g0').changed_reasons['base-unavailable'] >= 1, 'introducing an in-repo feeds directory is base-unavailable for affected bad findings')
  const invalidBase = mutations.get('l')
  assert(invalidBase.base_unavailable && invalidBase.exit.changed === 1 && invalidBase.changed_reasons['base-unavailable'] >= 1, 'an invalid base config reports affected bad findings as base-unavailable')
  assert(mutations.get('m').working_tree && mutations.get('m').counts.required_unchanged_line >= 1, 'an uncommitted config edit makes an unchanged reference newly actionable')
  assert(mutations.get('n').working_tree && mutations.get('n').counts.required_changed_line === 1, 'an uncommitted source edit adds a required bad line')
  assert(passing.out.includes('result: PASS'), 'summary reports a pass')
  console.log(`ok: harness passes on check.mjs (${report.summary.pairs} pairs, inert: ${report.summary.inert.join(',') || 'none'})`)

  assert.equal(incomplete.code, 0, `harness compares an incomplete-coverage repository with --allow-incomplete:${detail(incomplete)}`)
  const incompletePair = incomplete.report.pairs.find(pair => pair.head === incompleteHead && !pair.mutation)
  assert(incompletePair.exit.changed === 2 && incompletePair.allow_incomplete.head && incompletePair.counts.required_changed_line === 1, 'incomplete head coverage fails --changed with exit 2, then the comparison runs with --allow-incomplete')
  assert(incomplete.report.repos[0].skipped_mutations.length === 0 && ['h', 'k'].every(mutation => incomplete.report.pairs.some(pair => pair.mutation === mutation && pair.allow_incomplete.head)), 'mutations still apply when the HEAD scan is incomplete')
  console.log('ok: incomplete coverage must not produce a gate result, and still gets mutations')

  assert.equal(dropping.code, 1, `harness fails a checker that drops newly actionable findings:${detail(dropping)}`)
  const droppedFindings = fs.readFileSync(dropped, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const missing = dropping.report.pairs.flatMap(pair => pair.missing.map(finding => ({ file: finding.file, line: finding.line, id: finding.id })))
  const sortKey = finding => JSON.stringify([finding.file, finding.line, finding.id])
  assert(droppedFindings.length >= 3, 'the shim dropped newly actionable findings')
  assert.deepEqual(missing.map(sortKey).sort(), droppedFindings.map(sortKey).sort(), 'every dropped finding is listed as missing, and nothing else')
  assert(dropping.report.pairs.find(pair => pair.head === ignoreRemoval).reasons.includes('false clean: --changed exited 0'), 'the shim\'s clean exit on the ignore-removal pair is a false clean')
  assert(dropping.out.includes('missing legacy.py:2 o3-deep-research'), 'summary names the missing finding')
  console.log(`ok: harness fails a shim that drops newly actionable findings (${missing.length} missing)`)

  assert.equal(droppingOne.code, 1, `harness fails a checker that keeps exit 1 but drops one added-line finding:${detail(droppingOne)}`)
  const dropOnePair = droppingOne.report.pairs.find(pair => pair.head === addedLines)
  assert(dropOnePair.missing.length === 1 && dropOnePair.missing[0].reason === 'changed-line' && !dropOnePair.reasons.some(reason => reason.startsWith('exit mismatch')), 'the dropped added-line finding is missing while the exit code stays consistent')
  assert(dropOnePair.result === 'fail' && dropOnePair.reasons.includes('missing 1 oracle-required finding(s)'), 'a missing finding fails the pair even when --changed exits 1')
  console.log('ok: harness fails a shim that drops one finding and keeps exit 1')

  assert.equal(lenientRun.code, 1, `harness fails a checker whose --changed exit code is wrong:${detail(lenientRun)}`)
  assert(lenientRun.report.pairs.find(pair => pair.head === addedLines).reasons.some(reason => reason.startsWith('exit mismatch: --changed exited 0')), 'exit 0 with bad findings is an exit mismatch')
  assert(lenientRun.report.pairs.find(pair => pair.head === incompleteHead).reasons.some(reason => reason.startsWith('incomplete head coverage produced a --changed gate result')), 'a gate result despite incomplete head coverage fails')
  console.log('ok: harness fails wrong --changed exit codes and gate results on incomplete coverage')

  assert.equal(phantomRun.code, 1, `an oracle error fails the run:${detail(phantomRun)}`)
  assert(phantomRun.report.summary.oracle_errors >= 1 && phantomRun.report.pairs[0].reasons.some(reason => reason.startsWith('oracle:')), 'the unmappable finding is reported as an oracle error')
  console.log('ok: oracle errors fail the run')

  assert.equal(odd.code, 0, `a backslash file name and a --no-ff merge map without false findings:${detail(odd)}`)
  const oddPair = odd.report.pairs.find(pair => pair.repo === oddRepo)
  assert(oddPair.counts.old_debt === 1 && oddPair.counts.required_changed_line === 1, 'the backslash file keeps old debt and its added line apart')
  const mergePair = odd.report.pairs.find(pair => pair.head === mergeHead)
  assert(mergePair.base === mergeBase && mergePair.counts.old_debt === 1 && mergePair.counts.required_changed_line === 1 && mergePair.line_map_fallbacks.length === 0, 'the merge pair keeps merged-in old debt apart from the merged added line')
  console.log('ok: backslash file names and --no-ff merges map through blame')

  assert(nothing.code === 1 && nothing.report.summary.evaluated === 0, 'a run that evaluates no pair fails')
  assert(missingRepo.code === 1 && missingRepo.report.summary.repos_failed === 1 && missingRepo.report.summary.evaluated === 1, 'a repository that cannot be cloned fails the run even when others pass')
  assert(notGit.code === 1 && notGit.report.repos[0].status === 'failed', 'a directory that is not a git repository fails the run')
  const usage = spawnSync(process.execPath, [harness, '--repo', repo], { encoding: 'utf8' })
  assert.equal(usage.status, 2, 'a missing --checker is a usage error')
  console.log('ok: evaluating nothing, unclonable repositories, and usage errors fail')

  assert.equal(blindRun.code, 1, `harness fails a checker blind to uncommitted edits and subdirectory targets:${detail(blindRun)}`)
  assert.deepEqual(blindRun.report.repos[0].skipped_mutations, [], 'g, j, and k apply with a checker that has no feeds/ next to it')
  const blind = new Map(blindRun.report.pairs.map(pair => [pair.mutation ?? 'history', pair]))
  for (const mutation of ['m', 'n']) assert(blind.get(mutation).result === 'fail' && blind.get(mutation).missing.length >= 1, `the blind shim misses the uncommitted edit of mutation ${mutation}`)
  for (const mutation of ['g0', 'g', 'j', 'k']) assert.equal(blind.get(mutation).result, 'pass', `mutation ${mutation} passes through the blind shim`)
  assert(blind.get('history').reasons.some(reason => reason.startsWith('subdirectory check: missing')), 'the blind shim fails the subdirectory check')
  console.log('ok: uncommitted edits, subdirectory targets, and shims without feeds are covered')

  assert.equal(misbehaving.code, 1, `full head checks that time out or fail are failures:${detail(misbehaving)}`)
  const misbehaved = repoDir => misbehaving.report.pairs.find(pair => pair.repo === repoDir)
  assert(misbehaved(slowRepo).reasons.some(reason => reason.startsWith('crash: full head check timed out')), 'a full check timeout is a crash, not an incomplete pair')
  assert(misbehaved(brokenRepo).reasons.some(reason => reason.startsWith('full head check failed (exit 3')), 'a failed full head check with a clean --changed exit fails the pair')
  console.log('ok: full check timeouts and failures fail the pair')

  assert.equal(timedOut.code, 1, `a --changed timeout fails the run:${detail(timedOut)}`)
  assert.equal(timedOut.report.summary.crashes, 1, 'the --changed timeout is a crash')
  assert.deepEqual(leftovers(timeoutTmp), [], 'a timed-out checker leaves no model-eol-base-* or harness temp tree in TMPDIR')
  const timeoutGrandchildren = pidsIn(timeoutPids)
  assert(timeoutGrandchildren.length === 1, 'the held --changed run started a grandchild')
  await waitFor(() => !timeoutGrandchildren.some(alive), 3000, 'a timeout kills the checker\'s grandchildren')
  console.log('ok: timeouts kill the whole process group and leave no temp trees')

  assert.equal(traced.code, 0, `the traced mutation run passes:${detail(traced)}`)
  const traceEvents = fs.readdirSync(traceDir).flatMap(name => fs.readFileSync(path.join(traceDir, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
  const commands = traceEvents.filter(event => event.event === 'cmd_name').map(event => event.name)
  const spawned = traceEvents.filter(event => event.event === 'child_start').map(event => event.argv ?? [])
  assert(commands.filter(name => name === 'commit').length >= 2, 'the traced run records the harness\'s mutation commits')
  // Git before 2.29 still starts gc --auto after each commit; with gc.auto=0 it exits without repacking.
  assert.deepEqual(commands.filter(name => ['maintenance', 'repack', 'prune', 'prune-packed'].includes(name)), [], 'harness commits start no auto maintenance in the clone')
  assert(!spawned.some(argv => ['maintenance', 'repack', 'prune', 'prune-packed'].some(name => argv.includes(name))), 'no git process spawns maintenance, repack, or prune')
  console.log('ok: harness commits run no background maintenance that could delete commits in the clone')

  const signalRun = async (signal, code) => {
    const signalTmp = path.join(tempRoot, `signal-${signal}`)
    const pids = path.join(tempRoot, `signal-${signal}-pids`)
    fs.mkdirSync(signalTmp)
    const child = spawn(process.execPath, [harness, '--checker', shims.hold, '--repo', oddRepo, '--commits', '1', '--policy', 'broad'], {
      env: { ...process.env, TMPDIR: signalTmp, E2E_GRANDCHILD_PIDFILE: pids },
      stdio: 'ignore',
    })
    const exited = new Promise(resolve => child.on('exit', (exitCode, exitSignal) => resolve({ exitCode, exitSignal })))
    await waitFor(() => pidsIn(pids).length > 0, 60000, `the ${signal} run reached the held --changed check`)
    const sent = Date.now()
    process.kill(child.pid, signal)
    const status = await exited
    const latency = Date.now() - sent
    assert.equal(status.exitCode, code, `${signal} to the harness alone exits ${code} (got ${JSON.stringify(status)})`)
    assert(latency < 5000, `${signal} to the harness alone is handled promptly (${latency} ms)`)
    assert.deepEqual(leftovers(signalTmp), [], `${signal} removes the temp root`)
    await waitFor(() => !pidsIn(pids).some(alive), 3000, `${signal} kills the running checker's grandchildren`)
  }
  await Promise.all([signalRun('SIGTERM', 143), signalRun('SIGHUP', 129), signalRun('SIGINT', 130)])
  console.log('ok: SIGTERM, SIGHUP, and SIGINT to the harness alone stop it promptly and clean up')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('e2e-changed harness tests passed')
