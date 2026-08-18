#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import { assertSha512Integrity } from './package-integrity.mjs'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packagePattern = /^model-eol@(0|0\.\d+\.\d+)$/
const versionPattern = /^0\.\d+\.\d+$/

const usage = 'Usage: node scripts/published-consumer-uat.mjs --package model-eol@VERSION --expected-version VERSION --expected-integrity SHA512_SRI [--expected-engine RANGE]'

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

const parseJson = (text, label) => {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error.message}`)
  }
}

const waitForPublishedVersion = ({ version, expectedIntegrity, cache }) => {
  let detail = ''
  for (let attempt = 1; attempt <= 12; attempt++) {
    const result = spawnSync(npm, ['view', `model-eol@${version}`, 'version', 'dist.integrity', '--json', '--cache', cache, '--prefer-online'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!result.error && result.status === 0) {
      let metadata = null
      try {
        metadata = JSON.parse(result.stdout)
      } catch {
      }
      if (metadata?.version === version) {
        const registryIntegrity = assertSha512Integrity(metadata['dist.integrity'], `model-eol@${version} registry integrity`)
        if (registryIntegrity !== expectedIntegrity) {
          throw new Error(`model-eol@${version} registry integrity ${registryIntegrity} does not match release integrity ${expectedIntegrity}`)
        }
        return registryIntegrity
      }
    }
    detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
    if (attempt < 12) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
  }
  throw new Error(`npm did not expose model-eol@${version} after 60 seconds: ${detail}`)
}

export function runPublishedConsumerUat({ packageSpec, expectedVersion, expectedIntegrity, expectedEngine = null }) {
  if (!packagePattern.test(packageSpec)) fail('--package must be model-eol@0 or an exact stable 0.x version')
  if (!versionPattern.test(expectedVersion)) fail('--expected-version must be an exact stable 0.x version')
  const releaseIntegrity = assertSha512Integrity(expectedIntegrity, '--expected-integrity')
  if (expectedEngine !== null && (!expectedEngine || /[\r\n]/.test(expectedEngine))) fail('--expected-engine must be a non-empty single-line range')

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-published-uat-'))
  const consumer = path.join(temp, 'consumer')
  const cache = path.join(temp, 'npm-cache')
  try {
    waitForPublishedVersion({ version: expectedVersion, expectedIntegrity: releaseIntegrity, cache })
    fs.mkdirSync(consumer)
    fs.writeFileSync(path.join(consumer, 'package.json'), `${JSON.stringify({
      name: 'model-eol-published-uat',
      private: true,
      scripts: { 'eval:model-eol': 'node eval-model-swap.mjs' },
    }, null, 2)}\n`)
    fs.writeFileSync(path.join(consumer, 'app.mjs'), [
      'import OpenAI from "openai"',
      'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })',
      'export const model = "o3-deep-research"',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(consumer, 'eval-model-swap.mjs'), [
      "import fs from 'node:fs'",
      "const source = fs.readFileSync(new URL('./app.mjs', import.meta.url), 'utf8')",
      "const oldId = process.env.MODEL_EOL_OLD_ID",
      "const newId = process.env.MODEL_EOL_NEW_ID",
      "if (!oldId || !newId || !source.includes(newId) || source.includes(oldId)) throw new Error('planned model swap was not applied')",
      '',
    ].join('\n'))
    run('git', ['init', '-q', '-b', 'main'], { cwd: consumer })
    run('git', ['config', 'user.name', 'model-eol published UAT'], { cwd: consumer })
    run('git', ['config', 'user.email', 'published-uat@example.invalid'], { cwd: consumer })
    run(npm, [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online',
      '--cache', cache, packageSpec,
    ], { cwd: consumer })

    const installedRoot = path.join(consumer, 'node_modules', 'model-eol')
    const manifest = parseJson(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'), 'installed manifest')
    if (manifest.version !== expectedVersion) {
      throw new Error(`${packageSpec} installed ${manifest.version}; expected ${expectedVersion}`)
    }
    const lock = parseJson(fs.readFileSync(path.join(consumer, 'package-lock.json'), 'utf8'), 'consumer package lock')
    const lockedPackage = lock.packages?.['node_modules/model-eol']
    if (lockedPackage?.version !== expectedVersion || lockedPackage?.integrity !== releaseIntegrity) {
      throw new Error(`${packageSpec} lock entry is not bound to model-eol@${expectedVersion} with integrity ${releaseIntegrity}`)
    }
    if (expectedEngine !== null && manifest.engines?.node !== expectedEngine) {
      throw new Error(`${packageSpec} declares Node ${manifest.engines?.node}; expected ${expectedEngine}`)
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (manifest[field] && Object.keys(manifest[field]).length) throw new Error(`${packageSpec} unexpectedly has ${field}`)
    }
    const harnessSource = path.join(installedRoot, 'examples', 'model-eol-eval.mjs')
    if (!fs.existsSync(harnessSource)) throw new Error(`${packageSpec} does not contain examples/model-eol-eval.mjs`)
    fs.mkdirSync(path.join(consumer, 'scripts'))
    fs.copyFileSync(harnessSource, path.join(consumer, 'scripts', 'model-eol-eval.mjs'))
    fs.writeFileSync(path.join(consumer, '.model-eol.json'), `${JSON.stringify({
      eval: { command: 'node scripts/model-eol-eval.mjs' },
    }, null, 2)}\n`)
    run('git', ['add', '.model-eol.json', 'app.mjs', 'eval-model-swap.mjs', 'package.json', 'package-lock.json', 'scripts/model-eol-eval.mjs'], { cwd: consumer })
    run('git', ['commit', '-q', '-m', 'consumer fixture with eval harness'], { cwd: consumer })

    const binSuffix = process.platform === 'win32' ? '.cmd' : ''
    const checker = path.join(consumer, 'node_modules', '.bin', `model-eol${binSuffix}`)
    const bot = path.join(consumer, 'node_modules', '.bin', `model-eol-bot${binSuffix}`)
    const inventory = parseJson(run(checker, ['inventory', '.'], { cwd: consumer }).stdout, 'published inventory')
    if (inventory.schema !== 'model-eol/inventory@0.1' || !inventory.model_references.some(item => item.matched === 'o3-deep-research')) {
      throw new Error('published checker did not inventory the consumer model')
    }
    const inventoryFile = path.join(temp, 'inventory.json')
    fs.writeFileSync(inventoryFile, `${JSON.stringify(inventory, null, 2)}\n`)
    const validation = run(checker, ['validate', inventoryFile], { cwd: consumer })
    if (!validation.stdout.includes('valid inventory document')) throw new Error('published checker did not validate its own inventory artifact')

    const checkResult = spawnSync(checker, ['check', '.', '--json'], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    })
    if (checkResult.error || checkResult.status !== 1) {
      const detail = checkResult.error?.message || checkResult.stderr?.trim() || checkResult.stdout?.trim() || `exit ${checkResult.status}`
      throw new Error(`published check --json did not preserve its finding exit code: ${detail}`)
    }
    const checkDocument = parseJson(checkResult.stdout, 'published check report')
    if (checkDocument.schema !== 'model-eol/check@0.1' || !checkDocument.findings.length) {
      throw new Error('published checker did not emit its public check discriminator and finding')
    }
    const checkFile = path.join(temp, 'check.json')
    fs.writeFileSync(checkFile, checkResult.stdout)
    const checkValidation = run(checker, ['validate', checkFile], { cwd: consumer })
    if (!checkValidation.stdout.includes('valid check document')) throw new Error('published checker did not validate its own check artifact')

    const planResult = run(checker, ['plan', '.', '--days', '90', '--scope', 'direct'], { cwd: consumer })
    const plan = parseJson(planResult.stdout, 'published plan')
    if (plan.plan_schema !== 'model-eol.plan/0.1' || plan.items.length !== 1) {
      throw new Error('published checker did not produce the expected safe migration plan')
    }
    const planFile = path.join(temp, 'plan.json')
    const evalFile = path.join(temp, 'eval.json')
    fs.writeFileSync(planFile, planResult.stdout)
    run(bot, ['evaluate', '--target-dir', consumer, '--plan-file', planFile, '--output-file', evalFile], { cwd: consumer })
    const evaluation = parseJson(fs.readFileSync(evalFile, 'utf8'), 'published evaluation')
    if (evaluation.schema !== 'model-eol.eval/0.1' || evaluation.configured !== true || !/^[0-9a-f]{40,64}$/.test(evaluation.base_sha)) {
      throw new Error('published bot did not produce a configured commit-bound evaluator manifest')
    }
    if (evaluation.results.length !== 1 || evaluation.results[0]?.status !== 'pass' || evaluation.results[0]?.exit_code !== 0) {
      throw new Error('published eval harness did not return exactly one passing result')
    }
    if (!evaluation.results[0]?.report?.includes('The repository verification command passed')) {
      throw new Error('published eval harness did not emit its bounded passing report')
    }
    const dryRun = run(bot, ['--dry-run', '--target-dir', consumer, '--repo', 'example/published-uat'], {
      cwd: consumer,
      env: { ...process.env, MODEL_EOL_EVAL_RESULTS_FILE: evalFile },
    })
    const planned = plan.items[0]
    const expectedDecision = `- create ${planned.publisher}/${planned.id}`
    if (!dryRun.stdout.includes(expectedDecision) || !dryRun.stdout.includes('Result: pass (exit code 0).')) {
      throw new Error(`published bot dry-run did not authorize the evaluated migration ${planned.publisher}/${planned.id}`)
    }
    if (!dryRun.stdout.includes(planned.replacement) || !dryRun.stdout.includes('The repository verification command passed')) {
      throw new Error('published bot dry-run did not preserve the evaluated old/new migration identity and report')
    }

    return { version: manifest.version, integrity: releaseIntegrity, references: inventory.model_references.length, items: plan.items.length }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      package: { type: 'string' },
      'expected-version': { type: 'string' },
      'expected-integrity': { type: 'string' },
      'expected-engine': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  if (positionals.length) fail(`unexpected positional argument: ${positionals[0]}`)
  if (!values.package) fail('--package is required')
  if (!values['expected-version']) fail('--expected-version is required')
  if (!values['expected-integrity']) fail('--expected-integrity is required')
  const result = runPublishedConsumerUat({
    packageSpec: values.package,
    expectedVersion: values['expected-version'],
    expectedIntegrity: values['expected-integrity'],
    expectedEngine: values['expected-engine'] ?? null,
  })
  console.log(`published consumer UAT passed for model-eol@${result.version} (${result.references} reference(s), ${result.items} migration item)`)
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`published consumer UAT failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
