#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { verifyPackageIntegrity } from '../../scripts/package-integrity.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-package-test-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
  console.log(`ok: ${message}`)
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

try {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert(!manifest[field] || Object.keys(manifest[field]).length === 0, `package ${field} remains empty`)
  }
  assert(manifest.bin?.['model-eol'] === 'check.mjs', 'package exposes the model-eol checker bin')
  assert(manifest.bin?.['model-eol-bot'] === 'bot/bot.mjs', 'package exposes the model-eol-bot bin')
  assert(manifest.engines?.node === '>=22', 'package declares the supported Node 22 floor')
  const workflow = fs.readFileSync(path.join(root, 'bot.yml.example'), 'utf8')
  for (const [action, major, count] of [
    ['checkout', 'v7', 3],
    ['setup-node', 'v7', 3],
    ['upload-artifact', 'v7', 2],
    ['download-artifact', 'v8', 3],
  ]) {
    const references = [...workflow.matchAll(new RegExp(`actions/${action}@(v\\d+)`, 'g'))].map(match => match[1])
    assert(references.length === count && references.every(reference => reference === major), `consumer workflow uses the Node 24 ${action}@${major} action`)
  }
  for (const [file, count] of [
    ['README.md', 1],
    ['examples/workflows/model-eol.yml', 2],
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const references = [...source.matchAll(/actions\/checkout@(v\d+)/g)].map(match => match[1])
    assert(references.length === count && references.every(reference => reference === 'v7'), `${file} uses the Node 24 checkout@v7 action`)
    const setupReferences = [...source.matchAll(/actions\/setup-node@(v\d+)/g)].map(match => match[1])
    assert(setupReferences.length === count && setupReferences.every(reference => reference === 'v7'), `${file} sets up a supported Node runtime before every composite Action use`)
    assert(source.match(/node-version: 22/g)?.length === count, `${file} pins every composite Action job to Node 22`)
    assert(source.match(/package-manager-cache: false/g)?.length === count, `${file} disables package-manager caching for every composite Action job`)
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
  assert(
    readme.includes('repo="$(pwd -P)"')
      && readme.includes('cd "$tmp"')
      && readme.match(/MODEL_EOL_UAT_REPO="\$repo"/g)?.length === 2
      && readme.includes(`-c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan .'`)
      && readme.includes(`-c 'cd "$MODEL_EOL_UAT_REPO" && model-eol plan . --days 90 --scope direct'`)
      && readme.match(/--target-dir "\$repo"/g)?.length >= 2,
    'README resolves published bins externally while planning from the consumer repository for clone-portable paths',
  )
  assert(workflow.match(/node-version: 22/g)?.length === 3, 'consumer workflow runs every model-eol job on supported Node 22')
  assert(workflow.match(/package-manager-cache: false/g)?.length === 3, 'consumer workflow disables automatic package-manager caching in every job')
  const repositoryWorkflows = fs.readdirSync(path.join(root, '.github', 'workflows'))
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map(file => fs.readFileSync(path.join(root, '.github', 'workflows', file), 'utf8'))
    .join('\n')
  for (const [action, major] of [
    ['checkout', 'v7'],
    ['setup-node', 'v7'],
    ['upload-artifact', 'v7'],
    ['download-artifact', 'v8'],
    ['configure-pages', 'v6'],
    ['upload-pages-artifact', 'v5'],
    ['deploy-pages', 'v5'],
  ]) {
    const references = [...repositoryWorkflows.matchAll(new RegExp(`actions/${action}@(v\\d+)`, 'g'))].map(match => match[1])
    if (references.length) assert(references.every(reference => reference === major), `repository workflows use actions/${action}@${major}`)
  }
  const setupNodeCount = repositoryWorkflows.match(/actions\/setup-node@v7/g)?.length ?? 0
  assert(setupNodeCount > 0 && repositoryWorkflows.match(/package-manager-cache: false/g)?.length === setupNodeCount, 'repository workflows disable automatic package-manager caching in every Node job')
  assert(repositoryWorkflows.includes('node scripts/published-consumer-uat.mjs'), 'release automation smoke-tests the exact published package')
  assert(repositoryWorkflows.includes('uses: thossullivan/model-eol@v0'), 'hosted consumer UAT exercises the moving v0 Action')
  assert(repositoryWorkflows.includes('name: npm-release-result') && repositoryWorkflows.includes('run-id: ${{ github.event.workflow_run.id }}'), 'hosted consumer UAT receives the exact release version artifact')
  assert(repositoryWorkflows.includes('Moving v0 Action validate round-trip UAT'), 'hosted moving v0 Action validates its emitted inventory')
  assert(repositoryWorkflows.includes('Immutable release Action validate round-trip UAT'), 'hosted UAT validates the immutable release Action before monitoring moving v0')
  assert(repositoryWorkflows.includes('--expected-integrity "$INTEGRITY"') && repositoryWorkflows.includes('npm publish "$RELEASE_TARBALL" --ignore-scripts'), 'hosted release UAT binds the installed package to the exact published tarball')
  assert(workflow.includes('MODEL_EOL_PACKAGE: model-eol@0'), 'consumer workflow uses the model-eol v0 package line')
  assert(workflow.includes(`-c 'cd "$GITHUB_WORKSPACE" && if [ -f .model-eol.json ]; then model-eol plan .`) && workflow.includes('--target-dir "$GITHUB_WORKSPACE"'), 'consumer workflow invokes both published bins outside self-shadowing consumer package resolution')
  assert(!workflow.includes('node check.mjs') && !workflow.includes('node bot/bot.mjs'), 'consumer workflow has no repository-local tool assumption')
  assert(workflow.match(/persist-credentials: false/g)?.length === 3, 'all workflow jobs disable persisted checkout credentials')
  assert(workflow.match(/npm view "\$MODEL_EOL_PACKAGE" version/g)?.length === 1, 'workflow resolves the moving major package line exactly once')
  assert(workflow.match(/--package="model-eol@\$MODEL_EOL_VERSION"/g)?.length === 3, 'plan, evaluate, and publish use the same resolved exact package version')
  const versionGuards = workflow.split('\n').filter(line => line.includes('MODEL_EOL_VERSION" =~'))
  assert(versionGuards.length === 3 && versionGuards.every(line => line.includes('^[0-9]+\\.[0-9]+\\.[0-9]+$')), 'every consumer accepts only a stable x.y.z version before shell use')
  assert(workflow.includes('model-eol-version'), 'resolved exact package version is carried as a workflow artifact')
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'))
  assert(!publishJob.includes('OPENAI_API_KEY') && !publishJob.includes('ANTHROPIC_API_KEY') && !publishJob.includes('GOOGLE_API_KEY') && !publishJob.includes('GEMINI_API_KEY'), 'write-capable publish job receives no provider API keys')
  assert(!/^\s+(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY):/m.test(workflow), 'copy-ready workflow injects no provider secret until the consumer explicitly opts in')
  assert(workflow.includes('model-eol-bot evaluate') && workflow.includes('MODEL_EOL_EVAL_RESULTS_FILE'), 'consumer workflow uses the isolated evaluator manifest contract')

  const packResult = run(npm, ['pack', root, '--json', '--ignore-scripts'], { cwd: tempRoot })
  const packOutput = JSON.parse(packResult.stdout)
  const packed = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput && typeof packOutput === 'object'
      ? packOutput[manifest.name] ?? Object.values(packOutput)[0]
      : null
  assert(packed?.filename, 'npm pack produced a tarball description')
  const packedFiles = new Set((packed.files ?? []).map(file => file.path))
  for (const file of [
    'check.mjs',
    'bot.yml.example',
    'bot/bot.mjs',
    'bot/lib/common.mjs',
    'bot/lib/config.mjs',
    'bot/lib/eval.mjs',
    'bot/lib/feeds.mjs',
    'bot/lib/git.mjs',
    'bot/lib/github.mjs',
    'examples/model-eol-eval.mjs',
    'schema/model-eol.check.schema.json',
  ]) {
    assert(packedFiles.has(file), `packed artifact contains ${file}`)
  }
  for (const file of ['check.mjs', 'bot/bot.mjs']) {
    const mode = packed.files.find(entry => entry.path === file)?.mode ?? 0
    assert((mode & 0o111) !== 0, `packed bin ${file} is executable`)
  }
  assert(![...packedFiles].some(file => file.startsWith('bot/test/')), 'packed artifact excludes bot tests')

  const consumer = path.join(tempRoot, 'consumer')
  const npmCache = path.join(tempRoot, 'npm-cache')
  fs.mkdirSync(consumer)
  fs.writeFileSync(path.join(consumer, 'app.py'), [
    'from openai import OpenAI',
    'client = OpenAI()',
    'result = client.responses.create(model="o3-deep-research-2025-06-26", input="test")',
    '',
  ].join('\n'))
  run('git', ['init', '-b', 'main'], { cwd: consumer })
  run('git', ['config', 'user.name', 'package-contract'], { cwd: consumer })
  run('git', ['config', 'user.email', 'package-contract@example.invalid'], { cwd: consumer })
  run('git', ['add', 'app.py'], { cwd: consumer })
  run('git', ['commit', '-m', 'consumer fixture'], { cwd: consumer })
  const tarball = path.join(tempRoot, packed.filename)
  assert(verifyPackageIntegrity({ tarball, expectedIntegrity: packed.integrity }) === packed.integrity, 'release integrity verifier matches npm pack bytes')
  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--offline',
    '--cache', npmCache,
    tarball,
  ], { cwd: consumer })

  const installedRoot = path.join(consumer, 'node_modules', 'model-eol')
  const consumerManifestFile = path.join(consumer, 'package.json')
  const consumerManifest = JSON.parse(fs.readFileSync(consumerManifestFile, 'utf8'))
  consumerManifest.scripts = { 'eval:model-eol': 'node verify-model-swap.mjs' }
  fs.writeFileSync(consumerManifestFile, `${JSON.stringify(consumerManifest, null, 2)}\n`)
  fs.copyFileSync(path.join(installedRoot, 'examples', 'model-eol-eval.mjs'), path.join(consumer, 'model-eol-eval.mjs'))
  fs.writeFileSync(path.join(consumer, '.model-eol.json'), '{"eval":{"command":"node model-eol-eval.mjs"}}\n')
  fs.writeFileSync(path.join(consumer, 'verify-model-swap.mjs'), [
    "import fs from 'node:fs'",
    "const source = fs.readFileSync(new URL('./app.py', import.meta.url), 'utf8')",
    "const oldId = process.env.MODEL_EOL_OLD_ID",
    "const newId = process.env.MODEL_EOL_NEW_ID",
    "if (!oldId || !newId || source.includes(oldId) || !source.includes(newId)) process.exit(1)",
    '',
  ].join('\n'))
  run('git', ['add', '.model-eol.json', 'model-eol-eval.mjs', 'package.json', 'package-lock.json', 'verify-model-swap.mjs'], { cwd: consumer })
  run('git', ['commit', '-m', 'configure packed eval harness'], { cwd: consumer })
  const binSuffix = process.platform === 'win32' ? '.cmd' : ''
  const checkerBin = path.join(consumer, 'node_modules', '.bin', `model-eol${binSuffix}`)
  const botBin = path.join(consumer, 'node_modules', '.bin', `model-eol-bot${binSuffix}`)
  const checker = run(checkerBin, ['inventory', consumer], { cwd: consumer })
  assert(checker.stdout.includes('o3-deep-research'), 'clean consumer runs the packed model-eol checker bin')
  const packedCheck = spawnSync(checkerBin, ['check', consumer, '--json'], {
    cwd: consumer,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert(!packedCheck.error && packedCheck.status === 1, 'packed check --json preserves its finding exit code')
  const packedCheckDocument = JSON.parse(packedCheck.stdout)
  assert(packedCheckDocument.schema === 'model-eol/check@0.1' && packedCheckDocument.findings.length > 0, 'packed check emits the public check discriminator and findings')
  const packedCheckFile = path.join(tempRoot, 'packed-check.json')
  fs.writeFileSync(packedCheckFile, packedCheck.stdout)
  const packedCheckValidation = run(checkerBin, ['validate', packedCheckFile], { cwd: consumer })
  assert(packedCheckValidation.stdout.includes('valid check document'), 'packed consumer validates its emitted check artifact')
  const validation = run(checkerBin, ['validate', path.join(installedRoot, 'feeds', 'openai.json')], { cwd: consumer })
  assert(validation.stdout.includes('valid feed document'), 'clean consumer runs the packed public document validator')
  const packedPlan = run(checkerBin, ['plan', '.', '--days', '90', '--scope', 'direct'], { cwd: consumer })
  const packedPlanDocument = JSON.parse(packedPlan.stdout)
  const packedPlanFile = path.join(tempRoot, 'packed-plan.json')
  const packedEvalFile = path.join(tempRoot, 'packed-eval.json')
  fs.writeFileSync(packedPlanFile, packedPlan.stdout)
  run(botBin, ['evaluate', '--target-dir', consumer, '--plan-file', packedPlanFile, '--output-file', packedEvalFile], { cwd: consumer })
  const packedEval = JSON.parse(fs.readFileSync(packedEvalFile, 'utf8'))
  assert(packedEval.schema === 'model-eol.eval/0.1' && packedEval.configured === true && /^[0-9a-f]{40,64}$/.test(packedEval.base_sha), 'clean consumer runs the packed configured commit-bound evaluator')
  assert(packedEval.results.length === 1 && packedEval.results[0].status === 'pass' && packedEval.results[0].report?.includes('verification command passed'), 'packed eval starter emits one bounded passing report')
  const bot = run(botBin, ['--dry-run', '--target-dir', consumer, '--repo', 'example/consumer'], {
    cwd: consumer,
    env: { ...process.env, MODEL_EOL_EVAL_RESULTS_FILE: packedEvalFile },
  })
  const migration = packedPlanDocument.items[0]
  assert(
    bot.stdout.includes(`- create ${migration.publisher}/${migration.id}`)
      && bot.stdout.includes('Result: pass (exit code 0).')
      && bot.stdout.includes(migration.replacement),
    'clean consumer authorizes the exact planned migration only from the packed passing evaluator manifest',
  )
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('\npackage contract passed')
