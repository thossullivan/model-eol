#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const harness = path.join(root, 'examples', 'model-eol-eval.mjs')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-eval-harness-'))
const planPath = path.join(temp, 'plan.json')
const reportPath = path.join(temp, 'report.md')
const packagePath = path.join(temp, 'package.json')
const checker = path.join(root, 'check.mjs')
const bot = path.join(root, 'bot', 'bot.mjs')

const plan = {
  plan_schema: 'model-eol.plan/0.1',
  items: [{
    file: 'client.mjs',
    id: 'old-model',
    replacement: 'new-model',
  }],
}

const runHarness = () => spawnSync(process.execPath, [harness], {
  cwd: temp,
  env: {
    ...process.env,
    MODEL_EOL_OLD_ID: 'old-model',
    MODEL_EOL_NEW_ID: 'new-model',
    MODEL_EOL_PLAN: planPath,
    MODEL_EOL_REPORT: reportPath,
  },
  encoding: 'utf8',
})

try {
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`)
  fs.writeFileSync(path.join(temp, 'verify.mjs'), 'console.log("private test output")\n')
  fs.writeFileSync(packagePath, JSON.stringify({
    name: 'model-eol-eval-harness-test',
    private: true,
    scripts: { 'eval:model-eol': 'node verify.mjs' },
  }))

  const passing = runHarness()
  assert.equal(passing.status, 0, passing.stderr)
  const passingReport = fs.readFileSync(reportPath, 'utf8')
  assert.match(passingReport, /Result: pass/)
  assert.match(passingReport, /old-model.*new-model/)
  assert(!passingReport.includes('private test output'), 'publishable report excludes arbitrary test output')

  fs.writeFileSync(path.join(temp, 'verify.mjs'), 'console.error("secret-like failure output"); process.exit(7)\n')
  const failing = runHarness()
  assert.equal(failing.status, 1)
  const failingReport = fs.readFileSync(reportPath, 'utf8')
  assert.match(failingReport, /Result: fail/)
  assert.match(failingReport, /Exit code: 7/)
  assert(!failingReport.includes('secret-like failure output'), 'failure report excludes arbitrary stderr')

  plan.items[0].id = 'different-model'
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`)
  const crossed = runHarness()
  assert.equal(crossed.status, 1)
  assert.match(fs.readFileSync(reportPath, 'utf8'), /outside MODEL_EOL_OLD_ID/)

  const uatRepo = path.join(temp, 'self-named-model-eol')
  const invocationDir = path.join(temp, 'external-invocation')
  const uatPlanPath = path.join(invocationDir, 'plan.json')
  const uatEvalPath = path.join(invocationDir, 'eval.json')
  fs.mkdirSync(path.join(uatRepo, 'scripts'), { recursive: true })
  fs.mkdirSync(invocationDir)
  fs.copyFileSync(harness, path.join(uatRepo, 'scripts', 'model-eol-eval.mjs'))
  fs.writeFileSync(path.join(uatRepo, 'package.json'), `${JSON.stringify({
    name: 'model-eol',
    private: true,
    scripts: { 'eval:model-eol': 'node verify-model-swap.mjs' },
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(uatRepo, '.model-eol.json'), '{"eval":{"command":"node scripts/model-eol-eval.mjs"}}\n')
  fs.writeFileSync(path.join(uatRepo, 'app.mjs'), [
    'import OpenAI from "openai"',
    'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })',
    'export const model = "o3-deep-research"',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(uatRepo, 'verify-model-swap.mjs'), [
    "import fs from 'node:fs'",
    "const source = fs.readFileSync(new URL('./app.mjs', import.meta.url), 'utf8')",
    "if (source.includes(process.env.MODEL_EOL_OLD_ID) || !source.includes(process.env.MODEL_EOL_NEW_ID)) process.exit(1)",
    '',
  ].join('\n'))
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.name', 'model-eol local UAT'],
    ['config', 'user.email', 'local-uat@example.invalid'],
    ['add', '.'],
    ['commit', '-q', '-m', 'self-named local UAT fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: uatRepo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }

  const planned = spawnSync('bash', ['-c',
    'cd "$MODEL_EOL_UAT_REPO" && "$MODEL_EOL_UAT_NODE" "$MODEL_EOL_UAT_CHECKER" plan . --days 90 --scope direct',
  ], {
    cwd: invocationDir,
    env: {
      ...process.env,
      MODEL_EOL_UAT_REPO: uatRepo,
      MODEL_EOL_UAT_NODE: process.execPath,
      MODEL_EOL_UAT_CHECKER: checker,
    },
    encoding: 'utf8',
  })
  assert.equal(planned.status, 0, planned.stderr)
  fs.writeFileSync(uatPlanPath, planned.stdout)
  const uatPlan = JSON.parse(planned.stdout)
  assert.equal(uatPlan.items.length, 1)
  assert.equal(path.isAbsolute(uatPlan.items[0].file), false, 'external invocation plans clone-portable repository-relative paths')

  const evaluated = spawnSync(process.execPath, [
    bot, 'evaluate',
    '--target-dir', uatRepo,
    '--plan-file', uatPlanPath,
    '--output-file', uatEvalPath,
  ], { cwd: invocationDir, encoding: 'utf8' })
  assert.equal(evaluated.status, 0, evaluated.stderr)
  const uatEval = JSON.parse(fs.readFileSync(uatEvalPath, 'utf8'))
  assert.equal(uatEval.results.length, 1)
  assert.equal(uatEval.results[0].status, 'pass')

  const authorized = spawnSync(process.execPath, [
    bot, '--dry-run', '--target-dir', uatRepo, '--repo', 'example/local-uat',
  ], {
    cwd: invocationDir,
    env: { ...process.env, MODEL_EOL_EVAL_RESULTS_FILE: uatEvalPath },
    encoding: 'utf8',
  })
  assert.equal(authorized.status, 0, authorized.stderr)
  assert.match(authorized.stdout, /- create openai\/o3-deep-research/)
  assert.match(authorized.stdout, /Result: pass \(exit code 0\)/)
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}

console.log('eval harness contract tests passed')
