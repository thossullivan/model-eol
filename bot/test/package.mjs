#!/usr/bin/env node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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
  const workflow = fs.readFileSync(path.join(root, 'bot.yml.example'), 'utf8')
  assert(workflow.includes('MODEL_EOL_PACKAGE: model-eol@0'), 'consumer workflow uses the model-eol v0 package line')
  assert(workflow.includes('model-eol "${PLAN_ARGS[@]}"') && workflow.includes('model-eol-bot --repo'), 'consumer workflow invokes both published bins')
  assert(!workflow.includes('node check.mjs') && !workflow.includes('node bot/bot.mjs'), 'consumer workflow has no repository-local tool assumption')
  assert(workflow.match(/persist-credentials: false/g)?.length === 2, 'both workflow jobs disable persisted checkout credentials')

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
  fs.writeFileSync(path.join(consumer, 'app.py'), 'model = "o3-deep-research-2025-06-26"\n')
  const tarball = path.join(tempRoot, packed.filename)
  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--offline',
    '--cache', npmCache,
    tarball,
  ], { cwd: consumer })

  const binSuffix = process.platform === 'win32' ? '.cmd' : ''
  const checkerBin = path.join(consumer, 'node_modules', '.bin', `model-eol${binSuffix}`)
  const botBin = path.join(consumer, 'node_modules', '.bin', `model-eol-bot${binSuffix}`)
  const checker = run(checkerBin, ['inventory', consumer], { cwd: consumer })
  assert(checker.stdout.includes('o3-deep-research'), 'clean consumer runs the packed model-eol checker bin')
  const bot = run(botBin, ['--dry-run', '--target-dir', consumer, '--repo', 'example/consumer'], { cwd: consumer })
  assert(bot.stdout.includes('model-eol decision table'), 'clean consumer runs the packed model-eol-bot bin')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('\npackage contract passed')
