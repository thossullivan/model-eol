#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { VERIFICATION_SCHEMA, assertValidVerification, sha512Integrity, verificationResult } from '../lib/receipts.mjs'
import { validateDocument } from '../lib/validate-document.mjs'

const root = path.resolve(import.meta.dirname, '..')
const checker = path.join(root, 'check.mjs')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-verify-test-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const baseEnv = { ...process.env }
delete baseEnv.MODEL_EOL_EVAL_COMMAND
let failures = 0
let reports = 0

const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failures++
  } else {
    console.log(`ok: ${message}`)
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`)
  return result.stdout
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

// runs text and --json forms; every JSON report must validate and agree with the exit code
const verify = (args, { env = baseEnv, nodeArgs = [] } = {}) => {
  const text = spawnSync(process.execPath, [...nodeArgs, checker, 'verify', ...args], { encoding: 'utf8', env })
  const json = spawnSync(process.execPath, [...nodeArgs, checker, 'verify', ...args, '--json'], { encoding: 'utf8', env })
  let report = null
  if (json.status !== 2) {
    report = JSON.parse(json.stdout)
    const validation = validateDocument(report)
    if (validation.type !== 'verification' || validation.errors.length) {
      throw new Error(`verify --json output failed validation: ${JSON.stringify(validation.errors)}`)
    }
    const requireAll = args.includes('--require-all')
    const expectedCode = report.result === 'mismatch' || (report.result === 'partial' && requireAll) ? 1 : 0
    if (json.status !== expectedCode || text.status !== expectedCode) throw new Error(`verify exit codes ${text.status}/${json.status} disagree with result ${report.result}`)
    reports++
  }
  return {
    code: text.status,
    out: text.stdout,
    err: text.stderr,
    jsonOut: json.stdout,
    jsonErr: json.stderr,
    report,
    statuses: report ? Object.fromEntries(report.claims.map(claim => [claim.claim, claim.status])) : {},
    mismatches: report ? report.claims.filter(claim => claim.status === 'mismatch').map(claim => claim.claim) : [],
  }
}

const refused = (label, args, detail, options) => {
  const result = verify(args, options)
  const printed = `${result.out}${result.err}${result.jsonOut}${result.jsonErr}`
  assert(result.code === 2 && !/\bverified\b/.test(printed) && result.err.includes(detail), `${label} exits 2 without printing verified (${detail})`)
}

const exactlyMismatched = (label, result, claim) => {
  assert(result.code === 1 && result.report.result === 'mismatch' && JSON.stringify(result.mismatches) === JSON.stringify([claim]), `${label} exits 1 with a mismatch for exactly ${claim} (got ${result.mismatches.join(', ') || 'none'})`)
}

try {
  const fakeCommit = 'c'.repeat(40)
  const sourceCommit = 'a1'.repeat(20)
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim()
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

  const verificationSchemaDocument = JSON.parse(fs.readFileSync(path.join(root, 'schema', 'model-eol.verification.schema.json'), 'utf8'))
  assert(validateDocument(verificationSchemaDocument).errors.length === 0, 'the verification schema is a registered public schema')
  assert(verificationResult([]) === 'partial', 'a verification with no applicable claim is partial, never verified')
  assert(verificationResult([{ status: 'verified' }, { status: 'not-applicable' }]) === 'verified', 'not-applicable claims do not block verified')
  assert(verificationResult([{ status: 'not-applicable' }]) === 'partial', 'only not-applicable claims is partial')
  assert(verificationResult([{ status: 'verified' }, { status: 'not-checked' }]) === 'partial', 'an unchecked claim makes the result partial')
  assert(verificationResult([{ status: 'not-checked' }, { status: 'mismatch' }]) === 'mismatch', 'any mismatch makes the result mismatch')
  let inconsistent = ''
  try {
    assertValidVerification({ schema: VERIFICATION_SCHEMA, claims: [{ claim: 'x', status: 'mismatch' }], result: 'verified' })
  } catch (error) {
    inconsistent = error.message
  }
  assert(inconsistent.includes('does not follow from its claims'), 'a verification document whose result contradicts its claims is rejected')
  const forged = { schema: VERIFICATION_SCHEMA, receipt: { path: 'r.json', schema: 'model-eol.eval/0.1', sha256: '0'.repeat(64) }, structural: 'valid', claims: [{ claim: 'base_sha', status: 'not-checked', input: '--commit SHA' }], result: 'verified' }
  assert(validateDocument(forged).errors.some(error => error.message.includes('does not follow')), 'model-eol validate rejects a verified result over unchecked claims')
  const sameValue = { claim: 'base_sha', status: 'verified', expected: 'a', actual: 'a', input: '--commit a' }
  assert(validateDocument({ ...forged, claims: [sameValue], result: 'verified' }).errors.length === 0, 'a self-consistent verification report validates')
  for (const [label, claims, result, detail] of [
    ['a verified claim whose values differ', [{ ...sameValue, actual: 'b' }], 'verified', 'different expected and actual'],
    ['a mismatch claim whose values are equal', [{ ...sameValue, status: 'mismatch' }], 'mismatch', 'equal expected and actual'],
    ['a not-checked claim without its input', [{ claim: 'base_sha', status: 'not-checked' }], 'partial', 'must name the input'],
    ['duplicate claim names', [sameValue, sameValue], 'verified', 'more than once'],
  ]) {
    assert(validateDocument({ ...forged, claims, result }).errors.some(error => error.message.includes(detail)), `model-eol validate rejects ${label}`)
  }

  // npm-release-result from a real npm pack of this checkout
  const packDir = path.join(tempRoot, 'pack')
  fs.mkdirSync(packDir)
  const packed = JSON.parse(run(npm, ['pack', root, '--json', '--ignore-scripts'], { cwd: packDir }))[0]
  const tarball = path.join(packDir, packed.filename)
  assert(sha512Integrity(fs.readFileSync(tarball)) === packed.integrity, 'npm pack integrity is the sha512 SRI of the tarball bytes')
  const releaseFile = path.join(tempRoot, 'release.json')
  run(process.execPath, [path.join(root, 'scripts', 'release-receipt.mjs'), 'create', '--out', releaseFile, '--source-sha', sourceCommit, '--version', version, '--release-sha', head, '--registry-integrity', packed.integrity])
  const releaseArgs = [releaseFile, '--package', tarball, '--commit', head, '--source-commit', sourceCommit, '--version', version]
  const genuineRelease = verify(releaseArgs)
  assert(genuineRelease.code === 0 && genuineRelease.report.result === 'verified' && genuineRelease.report.claims.length === 4 && genuineRelease.report.claims.every(claim => claim.status === 'verified'), 'a genuine release receipt verifies every claim against the packed tarball')
  assert(genuineRelease.out.includes('result: verified') && genuineRelease.out.includes('registry_integrity'), 'text output names each claim and the overall result')
  const receiptBytes = fs.readFileSync(releaseFile)
  assert(genuineRelease.report.receipt.sha256 === run(process.execPath, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(${JSON.stringify(releaseFile)})).digest('hex'))`]) && receiptBytes.length > 0, 'the report binds the SHA-256 of the receipt bytes')
  assert(genuineRelease.report.receipt.schema === 'model-eol/npm-release-result@0.2' && genuineRelease.report.structural === 'valid', 'the report names the receipt schema and structural validity')
  const upperRelease = verify([releaseFile, '--package', tarball, '--commit', head.toUpperCase(), '--source-commit', sourceCommit.toUpperCase(), '--version', version])
  assert(upperRelease.code === 0 && upperRelease.report.result === 'verified', 'uppercase SHA inputs are lowercased like build-public-site')

  const releaseTamper = (field, value) => {
    const receipt = JSON.parse(fs.readFileSync(releaseFile, 'utf8'))
    Object.assign(receipt, typeof field === 'string' ? { [field]: value } : field)
    return writeJson(path.join(tempRoot, `release-${Object.keys(typeof field === 'string' ? { [field]: 0 } : field).join('-')}.json`), receipt)
  }
  exactlyMismatched('a tampered release commit', verify([releaseTamper('release_commit', 'd'.repeat(40)), ...releaseArgs.slice(1)]), 'release_commit')
  exactlyMismatched('a tampered source commit', verify([releaseTamper('source_commit', 'e'.repeat(40)), ...releaseArgs.slice(1)]), 'source_commit')
  exactlyMismatched('a tampered version and tag', verify([releaseTamper({ version: '0.0.1', tag: 'v0.0.1' }), ...releaseArgs.slice(1)]), 'version')
  const tamperedTarball = path.join(tempRoot, 'tampered.tgz')
  const tarballBytes = Buffer.from(fs.readFileSync(tarball))
  tarballBytes[Math.floor(tarballBytes.length / 2)] ^= 1
  fs.writeFileSync(tamperedTarball, tarballBytes)
  const tamperedPackage = verify([releaseFile, '--package', tamperedTarball, '--commit', head, '--source-commit', sourceCommit, '--version', version])
  exactlyMismatched('a tarball with one byte changed', tamperedPackage, 'registry_integrity')
  assert(tamperedPackage.out.includes(`receipt ${packed.integrity}`) && tamperedPackage.out.includes(sha512Integrity(tarballBytes)), 'a mismatch prints the receipt value and the computed value')
  const tamperedJson = tamperedPackage.report.claims.find(claim => claim.claim === 'registry_integrity')
  assert(tamperedJson.expected === packed.integrity && tamperedJson.actual === sha512Integrity(tarballBytes) && tamperedJson.input.includes('--package'), 'a JSON mismatch carries expected, actual, and input')

  const partialRelease = verify([releaseFile, '--commit', head])
  assert(partialRelease.code === 0 && partialRelease.report.result === 'partial' && partialRelease.statuses.registry_integrity === 'not-checked' && partialRelease.statuses.release_commit === 'verified', 'missing release inputs give partial with exit 0')
  assert(partialRelease.report.claims.find(claim => claim.claim === 'registry_integrity').input === '--package FILE.tgz', 'a not-checked claim names the input that would check it')
  assert(!partialRelease.out.includes('result: verified'), 'partial is never printed as verified')
  assert(verify([releaseFile, '--commit', head, '--require-all']).code === 1, '--require-all turns partial into exit 1')
  assert(verify([releaseFile]).report.result === 'partial', 'a receipt with no inputs at all is partial')

  const noReleaseFile = path.join(tempRoot, 'no-release.json')
  run(process.execPath, [path.join(root, 'scripts', 'release-receipt.mjs'), 'create', '--out', noReleaseFile, '--source-sha', sourceCommit])
  const noRelease = verify([noReleaseFile, '--source-commit', sourceCommit])
  assert(noRelease.code === 0 && noRelease.report.result === 'verified' && noRelease.statuses.source_commit === 'verified' && !('released' in noRelease.statuses), 'a no-release receipt verifies through its source commit alone')
  assert(['release_commit', 'version', 'registry_integrity'].every(claim => noRelease.statuses[claim] === 'not-applicable') && noRelease.out.includes('records no release'), 'a no-release receipt reports the release claims as not applicable, not verified')
  const noReleaseWithPackage = verify([noReleaseFile, '--source-commit', sourceCommit, '--package', tarball])
  exactlyMismatched('a no-release receipt checked against a tarball', noReleaseWithPackage, 'released')
  const releasedClaim = noReleaseWithPackage.report.claims.find(claim => claim.claim === 'released')
  assert(releasedClaim.expected === false && releasedClaim.actual === true && releasedClaim.input.includes('--package') && noReleaseWithPackage.statuses.registry_integrity === 'not-applicable', 'the released claim records that the release inputs assert a release the receipt denies')
  for (const flag of [['--commit', head], ['--version', version]]) {
    exactlyMismatched(`a no-release receipt checked with ${flag[0]}`, verify([noReleaseFile, '--source-commit', sourceCommit, ...flag]), 'released')
  }
  const headNoReleaseFile = path.join(tempRoot, 'no-release-head.json')
  run(process.execPath, [path.join(root, 'scripts', 'release-receipt.mjs'), 'create', '--out', headNoReleaseFile, '--source-sha', head])
  const junkTarball = path.join(tempRoot, 'junk.tgz')
  fs.writeFileSync(junkTarball, 'junk')
  const releaseGate = verify([headNoReleaseFile, '--source-commit', head, '--commit', head, '--version', '0.8.4', '--package', junkTarball, '--require-all'])
  exactlyMismatched('a no-release receipt used as a release gate for any tarball', releaseGate, 'released')
  assert(!releaseGate.out.includes('result: verified'), 'a no-release receipt never passes a release gate')
  assert(verify([noReleaseFile]).report.result === 'partial' && verify([noReleaseFile, '--require-all']).code === 1, 'a no-release receipt without --source-commit is partial')
  exactlyMismatched('a no-release receipt with the wrong source commit', verify([noReleaseFile, '--source-commit', fakeCommit]), 'source_commit')

  // feed-refresh receipt from the real feeds
  const refreshFile = path.join(tempRoot, 'refresh.json')
  const runUrl = 'https://github.com/thossullivan/model-eol/actions/runs/39251319949'
  run(process.execPath, [path.join(root, 'scripts', 'feed-refresh-receipt.mjs'), 'create', '--repo-dir', root, '--out', refreshFile, '--state', 'clean', '--checked-at', '2026-10-19T05:23:00Z', '--refresh-run-url', runUrl, '--refresh-sha', head])
  const feedsDir = path.join(root, 'feeds')
  const feedNames = fs.readdirSync(feedsDir).filter(name => name.endsWith('.json')).sort()
  const refreshArgs = ['--feeds-dir', feedsDir, '--commit', head, '--run-url', runUrl]
  const genuineRefresh = verify([refreshFile, ...refreshArgs])
  assert(genuineRefresh.report.receipt.state === 'clean' && genuineRefresh.report.receipt.checked_at === '2026-10-19T05:23:00Z' && !('pending_pr' in genuineRefresh.report.receipt) && genuineRefresh.out.includes('state clean, checked 2026-10-19T05:23:00Z'), 'a clean refresh report shows its state and check time as information')
  const pendingFile = path.join(tempRoot, 'refresh-pending.json')
  const pendingPr = 'https://github.com/thossullivan/model-eol/pull/115'
  run(process.execPath, [path.join(root, 'scripts', 'feed-refresh-receipt.mjs'), 'create', '--repo-dir', root, '--out', pendingFile, '--state', 'pending', '--checked-at', '2026-10-19T12:21:19Z', '--refresh-run-url', runUrl, '--refresh-sha', head, '--pending-pr-url', pendingPr])
  const pendingRefresh = verify([pendingFile, ...refreshArgs])
  assert(pendingRefresh.report.result === 'verified' && pendingRefresh.report.receipt.state === 'pending' && pendingRefresh.report.receipt.pending_pr === pendingPr && pendingRefresh.out.includes(`pending feed PR ${pendingPr}`), 'a pending refresh report shows its pending PR without changing the result rules')
  assert(!('state' in genuineRelease.report.receipt), 'release reports carry no refresh state')
  assert(genuineRefresh.code === 0 && genuineRefresh.report.result === 'verified' && genuineRefresh.report.claims.length === feedNames.length + 2, 'a genuine refresh receipt verifies every feed, the commit, and the run')
  assert(verify([refreshFile, '--feeds-dir', feedsDir, '--commit', head, '--run-url', 'HTTPS://GITHUB.COM/thossullivan/model-eol/actions/runs/39251319949']).report.result === 'verified', 'the run URL is compared after the receipt writer normalization')
  const unnormalizedRun = writeJson(path.join(tempRoot, 'refresh-unnormalized.json'), { ...JSON.parse(fs.readFileSync(refreshFile, 'utf8')), refresh_run: 'https://GitHub.com/thossullivan/model-eol/actions/runs/39251319949' })
  assert(verify([unnormalizedRun, ...refreshArgs]).report.result === 'verified', 'the receipt run URL is normalized the same way before comparison')
  const copyFeeds = name => {
    const dir = path.join(tempRoot, name, 'feeds')
    fs.cpSync(feedsDir, dir, { recursive: true })
    return dir
  }
  const changedFeeds = copyFeeds('changed')
  fs.appendFileSync(path.join(changedFeeds, feedNames[0]), ' ')
  exactlyMismatched('one feed file with changed bytes', verify([refreshFile, '--feeds-dir', changedFeeds, '--commit', head, '--run-url', runUrl]), `feeds/${feedNames[0]}`)
  const addedFeeds = copyFeeds('added')
  fs.writeFileSync(path.join(addedFeeds, 'zz-extra.json'), '{}\n')
  const added = verify([refreshFile, '--feeds-dir', addedFeeds, '--commit', head, '--run-url', runUrl])
  exactlyMismatched('an added feed file', added, 'feeds/zz-extra.json')
  assert(added.report.claims.find(claim => claim.claim === 'feeds/zz-extra.json').expected === null, 'an extra feed file has no receipt value')
  const notesFeeds = copyFeeds('notes')
  fs.writeFileSync(path.join(notesFeeds, 'README.md'), 'not a feed\n')
  assert(verify([refreshFile, '--feeds-dir', notesFeeds, '--commit', head, '--run-url', runUrl]).report.result === 'verified', 'non-JSON files in the feeds directory are ignored, as the receipt writer ignores them')
  const removedFeeds = copyFeeds('removed')
  fs.rmSync(path.join(removedFeeds, feedNames.at(-1)))
  const removed = verify([refreshFile, '--feeds-dir', removedFeeds, '--commit', head, '--run-url', runUrl])
  exactlyMismatched('a removed feed file', removed, `feeds/${feedNames.at(-1)}`)
  assert(removed.report.claims.find(claim => claim.claim === `feeds/${feedNames.at(-1)}`).actual === null && removed.out.includes('(absent)'), 'a missing feed file has no computed value')
  exactlyMismatched('a refresh receipt checked against another commit', verify([refreshFile, '--feeds-dir', feedsDir, '--commit', fakeCommit, '--run-url', runUrl]), 'refresh_commit')
  exactlyMismatched('a refresh receipt checked against another run', verify([refreshFile, '--feeds-dir', feedsDir, '--commit', head, '--run-url', 'https://github.com/thossullivan/model-eol/actions/runs/1']), 'refresh_run')
  const refreshPartial = verify([refreshFile, '--commit', head])
  assert(refreshPartial.code === 0 && refreshPartial.report.result === 'partial' && refreshPartial.statuses[`feeds/${feedNames[0]}`] === 'not-checked', 'a refresh receipt without --feeds-dir is partial')
  assert(verify([refreshFile, '--commit', head, '--require-all']).code === 1, 'a partial refresh verification fails under --require-all')
  refused('a repository root passed as --feeds-dir', [refreshFile, '--feeds-dir', root], 'feeds directory itself')
  refused('a file passed as --feeds-dir', [refreshFile, '--feeds-dir', path.join(feedsDir, feedNames[0])], 'is not a directory')
  const emptyFeeds = path.join(tempRoot, 'empty-feeds')
  fs.mkdirSync(emptyFeeds)
  refused('an empty --feeds-dir', [refreshFile, '--feeds-dir', emptyFeeds], 'no JSON feeds')
  refused('a non-HTTPS --run-url', [refreshFile, '--run-url', 'http://github.com/x'], 'HTTPS URL')

  // eval manifest from model-eol-bot evaluate on a scratch repository
  const repo = path.join(tempRoot, 'eval-repo')
  const direct = fs.readFileSync(path.join(root, 'bot', 'test', 'fixture', 'direct.py'), 'utf8')
  for (const [file, contents] of Object.entries({
    'public/direct.py': direct,
    'second/direct.py': direct.replace('o3-deep-research', 'o4-mini-deep-research'),
    'vendor/direct.py': direct,
  })) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), contents)
  }
  const configFile = writeJson(path.join(repo, '.model-eol.json'), {
    days: 3650,
    scope: 'direct',
    ignore: { paths: ['vendor/**'] },
    eval: { command: `node -e "require('node:fs').writeFileSync(process.env.MODEL_EOL_REPORT, 'checked')"`, timeout_ms: 5000 },
  })
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'verify-fixture'], ['config', 'user.email', 'verify@example.invalid'], ['add', '.'], ['commit', '-m', 'fixture']]) run('git', args, { cwd: repo })
  const repoHead = run('git', ['rev-parse', 'HEAD'], { cwd: repo }).trim()
  const planFile = path.join(tempRoot, 'plan.json')
  fs.writeFileSync(planFile, run(process.execPath, [checker, 'plan', '.'], { cwd: repo }))
  const evalFile = path.join(tempRoot, 'eval.json')
  run(process.execPath, [path.join(root, 'bot', 'bot.mjs'), 'evaluate', '--target-dir', repo, '--plan-file', planFile, '--output-file', evalFile])
  const manifest = JSON.parse(fs.readFileSync(evalFile, 'utf8'))
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  assert(manifest.configured && manifest.results.length === 2 && plan.items.every(item => !item.file.startsWith('vendor/')), 'the eval fixture yields two results and honors its ignored path')
  const evalArgs = ['--commit', repoHead, '--plan', planFile, '--config', configFile, '--feeds-dir', feedsDir]
  const genuineEval = verify([evalFile, ...evalArgs])
  assert(genuineEval.code === 0 && genuineEval.report.result === 'verified' && genuineEval.report.claims.length === 6, 'a genuine eval manifest verifies base_sha, plan, config, configured, and every feed digest')
  assert(manifest.results.every(result => genuineEval.statuses[`results[${result.publisher}/${result.id}].feed_digest`] === 'verified'), 'each eval result is matched to its planned group by identity')

  const evalTamper = (name, mutate) => {
    const document = structuredClone(manifest)
    mutate(document)
    return writeJson(path.join(tempRoot, `eval-${name}.json`), document)
  }
  exactlyMismatched('a tampered eval base commit', verify([evalTamper('base', document => { document.base_sha = fakeCommit }), ...evalArgs]), 'base_sha')
  exactlyMismatched('a tampered plan digest', verify([evalTamper('plan', document => { document.plan_digest = '0'.repeat(64) }), ...evalArgs]), 'plan_digest')
  exactlyMismatched('a tampered eval config digest', verify([evalTamper('config', document => { document.eval_config_digest = '0'.repeat(64) }), ...evalArgs]), 'eval_config_digest')
  const firstLabel = `results[${manifest.results[0].publisher}/${manifest.results[0].id}].feed_digest`
  exactlyMismatched('one tampered feed digest', verify([evalTamper('feed', document => { document.results[0].feed_digest = '0'.repeat(64) }), ...evalArgs]), firstLabel)
  exactlyMismatched('a missing eval result', verify([evalTamper('missing', document => { document.results.splice(0, 1) }), ...evalArgs]), firstLabel)
  exactlyMismatched('an unexpected eval identity', verify([evalTamper('unexpected', document => { document.results.push({ ...document.results[0], id: 'not-planned' }) }), ...evalArgs]), `results[${manifest.results[0].publisher}/not-planned].feed_digest`)
  const rerouted = verify([evalTamper('rerouted', document => { document.results[0].via = 'aws-bedrock' }), ...evalArgs])
  assert(rerouted.code === 1 && rerouted.mismatches.includes(`results[${manifest.results[0].publisher}/${manifest.results[0].id}@aws-bedrock].feed_digest`) && rerouted.mismatches.includes(firstLabel), 'a result moved to another clock is both unexpected and leaves its planned group missing')
  exactlyMismatched('a duplicated eval identity', verify([evalTamper('duplicate', document => { document.results.push(structuredClone(document.results[0])) }), ...evalArgs]), `${firstLabel} (duplicate 2)`)
  const tripled = verify([evalTamper('tripled', document => { document.results.push(structuredClone(document.results[0]), structuredClone(document.results[0])) }), ...evalArgs])
  assert(tripled.code === 1 && JSON.stringify(tripled.mismatches) === JSON.stringify([`${firstLabel} (duplicate 2)`, `${firstLabel} (duplicate 3)`]), 'each extra copy of a result identity gets its own uniquely named mismatch')
  const unconfiguredConfig = writeJson(path.join(tempRoot, 'unconfigured.json'), { days: 3650, scope: 'direct', ignore: { paths: ['vendor/**'] }, eval: { timeout_ms: 5000 } })
  const unconfigured = verify([evalFile, '--commit', repoHead, '--plan', planFile, '--config', unconfiguredConfig])
  assert(unconfigured.statuses.configured === 'mismatch' && unconfigured.statuses.eval_config_digest === 'mismatch' && unconfigured.code === 1, 'a config without eval.command contradicts a configured manifest')
  const unconfiguredEvalFile = path.join(tempRoot, 'eval-unconfigured.json')
  run(process.execPath, [path.join(root, 'bot', 'bot.mjs'), 'evaluate', '--target-dir', repo, '--config', unconfiguredConfig, '--plan-file', planFile, '--output-file', unconfiguredEvalFile])
  const unconfiguredEval = verify([unconfiguredEvalFile, '--commit', repoHead, '--plan', planFile, '--config', unconfiguredConfig, '--feeds-dir', feedsDir])
  assert(unconfiguredEval.code === 0 && unconfiguredEval.report.result === 'verified' && unconfiguredEval.report.claims.length === 4, 'an unconfigured manifest verifies with no per-result claims, as the bot expects no results')
  const extraIgnoreConfig =writeJson(path.join(tempRoot, 'extra-ignore.json'), { ...JSON.parse(fs.readFileSync(configFile, 'utf8')), ignore: { paths: ['vendor/**'], models: [manifest.results[1].id] } })
  const extraIgnore = verify([evalFile, '--commit', repoHead, '--plan', planFile, '--config', extraIgnoreConfig, '--feeds-dir', feedsDir])
  assert(extraIgnore.code === 1 && JSON.stringify(extraIgnore.mismatches) === JSON.stringify([`results[${manifest.results[1].publisher}/${manifest.results[1].id}].feed_digest`]) && extraIgnore.statuses.eval_config_digest === 'verified', 'feed-digest grouping follows the config ignore rules as the bot applies them')

  const overrideCommand = `node -e "require('node:fs').writeFileSync(process.env.MODEL_EOL_REPORT, 'override')"`
  const overrideEvalFile = path.join(tempRoot, 'eval-override.json')
  run(process.execPath, [path.join(root, 'bot', 'bot.mjs'), 'evaluate', '--target-dir', repo, '--plan-file', planFile, '--output-file', overrideEvalFile], { env: { ...baseEnv, MODEL_EOL_EVAL_COMMAND: overrideCommand } })
  const overrideVerified = verify([overrideEvalFile, ...evalArgs], { env: { ...baseEnv, MODEL_EOL_EVAL_COMMAND: overrideCommand } })
  assert(overrideVerified.report.result === 'verified' && overrideVerified.out.includes('MODEL_EOL_EVAL_COMMAND override'), 'an override-evaluated manifest verifies under the same override and the output says so')
  exactlyMismatched('an override-evaluated manifest checked without the override', verify([overrideEvalFile, ...evalArgs]), 'eval_config_digest')
  const blankOverride = verify([evalFile, ...evalArgs], { env: { ...baseEnv, MODEL_EOL_EVAL_COMMAND: '   ' } })
  assert(blankOverride.report.result === 'verified' && blankOverride.out.includes('set but blank'), 'a blank override is ignored as the bot ignores it, and the output says so')

  const evalPartial = verify([evalFile, '--commit', repoHead, '--plan', planFile])
  assert(evalPartial.code === 0 && evalPartial.report.result === 'partial' && evalPartial.statuses[firstLabel] === 'not-checked' && evalPartial.statuses.eval_config_digest === 'not-checked', 'an eval manifest without --config is partial and leaves feed digests unchecked')
  const evalNoConfig = verify([evalFile, '--commit', repoHead, '--plan', planFile, '--feeds-dir', feedsDir])
  assert(evalNoConfig.code === 0 && evalNoConfig.report.result === 'partial' && evalNoConfig.statuses[firstLabel] === 'not-checked' && evalNoConfig.report.claims.find(claim => claim.claim === firstLabel).input.includes('--config'), 'feed digests stay unchecked without --config, whose ignore rules shape the groups')
  assert(verify([evalFile, '--commit', repoHead, '--plan', planFile, '--require-all']).code === 1, 'a partial eval verification fails under --require-all')
  refused('an invalid --plan', [evalFile, '--plan', configFile], 'plan schema')
  const missingPlan = verify([evalFile, '--plan', path.join(tempRoot, 'missing-plan.json')])
  assert(missingPlan.code === 2 && missingPlan.err.includes('could not read --plan') && !missingPlan.err.includes('not UTF-8 JSON'), 'a missing --plan file is reported as unreadable, not as bad JSON')
  const plannedId = manifest.results[0].id
  for (const field of ['distributions', 'aliases']) {
    const dir = copyFeeds(`malformed-${field}`)
    const feedFile = fs.readdirSync(dir).map(name => path.join(dir, name)).find(file => JSON.parse(fs.readFileSync(file, 'utf8')).models?.some(model => model.id === plannedId))
    const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'))
    feed.models.find(model => model.id === plannedId)[field] = 5
    fs.writeFileSync(feedFile, JSON.stringify(feed))
    refused(`a feed whose planned model has ${field}: 5`, [evalFile, ...evalArgs.slice(0, 6), '--feeds-dir', dir], 'malformed feed')
  }
  const crashPreload = path.join(tempRoot, 'crash-preload.mjs')
  fs.writeFileSync(crashPreload, [
    "import crypto from 'node:crypto'",
    'const createHash = crypto.createHash',
    "crypto.createHash = (algorithm, ...rest) => { if (algorithm === 'sha512') throw new TypeError('injected failure'); return createHash(algorithm, ...rest) }",
    '',
  ].join('\n'))
  refused('an unexpected internal error', [releaseFile, '--package', tarball], 'unexpected error, nothing was checked: injected failure', { nodeArgs: ['--import', crashPreload] })
  refused('a plan with the right schema but malformed items', [evalFile, '--plan', writeJson(path.join(tempRoot, 'bad-plan.json'), { ...plan, items: [{ file: 'x.py' }] })], 'not a valid plan')
  refused('an unreadable --config', [evalFile, '--config', path.join(tempRoot, 'missing-config.json')], '--config')
  refused('a repository root as the eval --feeds-dir', [evalFile, ...evalArgs.slice(0, 6), '--feeds-dir', root], 'feeds directory itself')

  // exit 2 paths
  const unsupportedRelease = writeJson(path.join(tempRoot, 'release-0.3.json'), { ...JSON.parse(fs.readFileSync(releaseFile, 'utf8')), schema: 'model-eol/npm-release-result@0.3' })
  refused('an npm-release-result@0.3 receipt', [unsupportedRelease, ...releaseArgs.slice(1)], 'supported schemas: model-eol/feed-refresh-receipt@0.1, model-eol/npm-release-result@0.2, model-eol.eval/0.1')
  refused('a model-eol.eval/0.2 manifest', [writeJson(path.join(tempRoot, 'eval-0.2.json'), { ...manifest, schema: 'model-eol.eval/0.2' }), ...evalArgs], 'unsupported receipt schema "model-eol.eval/0.2"')
  refused('a receipt without a schema', [writeJson(path.join(tempRoot, 'no-schema.json'), { released: false })], 'unsupported receipt schema (missing)')
  refused('a structurally invalid receipt', [releaseTamper({ tag: 'v9.9.9' }), ...releaseArgs.slice(1)], 'structurally invalid')
  refused('a receipt with an uppercase commit', [releaseTamper('release_commit', head.toUpperCase()), ...releaseArgs.slice(1)], 'structurally invalid')
  refused('an unreadable receipt', [path.join(tempRoot, 'does-not-exist.json')], 'could not read receipt')
  const notJson = path.join(tempRoot, 'not-json.json')
  fs.writeFileSync(notJson, 'not json')
  refused('a non-JSON receipt', [notJson], 'not UTF-8 JSON')
  const markedBytes = Buffer.from(fs.readFileSync(refreshFile, 'utf8').replace(runUrl, `${runUrl}/MARK`))
  const markAt = markedBytes.indexOf('MARK')
  const invalidUtf8 = path.join(tempRoot, 'invalid-utf8.json')
  fs.writeFileSync(invalidUtf8, Buffer.concat([markedBytes.subarray(0, markAt), Buffer.from([0xff]), markedBytes.subarray(markAt + 4)]))
  refused('a receipt with an invalid UTF-8 byte inside an otherwise valid run URL', [invalidUtf8, ...refreshArgs], 'not UTF-8 JSON')
  const bomReceipt = path.join(tempRoot, 'bom.json')
  fs.writeFileSync(bomReceipt, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(refreshFile)]))
  refused('a receipt with a byte order mark', [bomReceipt, ...refreshArgs], 'not UTF-8 JSON')
  refused('an unreadable --package', [releaseFile, '--package', path.join(tempRoot, 'missing.tgz')], 'could not read --package')
  refused('verify without a receipt', [], 'exactly one RECEIPT')
  refused('verify with two receipts', [releaseFile, refreshFile], 'exactly one RECEIPT')
  refused('an unknown verify option', [releaseFile, '--days', '3'], '--days is not supported by verify')
  refused('a flag that does not apply to the receipt kind', [releaseFile, '--run-url', runUrl], '--run-url does not apply')
  refused('a feed directory for a release receipt', [releaseFile, '--feeds-dir', feedsDir], '--feeds-dir does not apply')
  refused('a short --commit', [releaseFile, '--commit', head.slice(0, 39)], '--commit must be')
  refused('a non-hex --source-commit', [releaseFile, '--source-commit', 'g'.repeat(40)], '--source-commit must be')
  refused('a v-prefixed --version', [releaseFile, '--version', `v${version}`], '--version must be')
  for (const [command, flag] of [['check', '--commit'], ['plan', '--require-all'], ['apply', '--package'], ['inventory', '--version'], ['schedule', '--feeds-dir'], ['alert', '--run-url'], ['check', '--source-commit']]) {
    const args = flag === '--require-all' ? [command, flag] : [command, flag, 'x']
    if (command === 'apply') args.push('--plan', planFile)
    const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8', cwd: tempRoot, env: baseEnv })
    assert(result.status === 2 && result.stderr.includes(`${flag} is only supported by the verify command`), `${command} refuses the verify-only ${flag} flag`)
  }

  const help = spawnSync(process.execPath, [checker, '--help'], { encoding: 'utf8' })
  for (const text of ['verify RECEIPT', '--feeds-dir DIR', '--commit SHA', '--run-url URL', '--package FILE.tgz', '--source-commit SHA', '--version X.Y.Z', '--require-all', 'partial', 'mismatch']) {
    assert(help.stdout.includes(text), `help documents ${text}`)
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  assert(!readme.includes('arrives in a later release') && readme.includes('model-eol verify') && readme.includes('--require-all') && readme.includes('`partial`'), 'README documents verify instead of promising it later')
  assert(reports >= 35, `every non-refused verify run emitted a valid ${VERIFICATION_SCHEMA} document (${reports} checked)`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify tests passed')
