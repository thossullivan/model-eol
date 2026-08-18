#!/usr/bin/env node

// Copy this file into the consuming repository and replace VERIFY with the
// smallest command that proves the model-dependent behavior you rely on.
// model-eol runs it from an isolated checkout after applying one migration.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const VERIFY = Object.freeze({ command: npm, args: ['run', 'eval:model-eol'] })

const required = name => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const singleLine = value => String(value).replace(/[\r\n]+/g, ' ').trim()

let reportPath = process.env.MODEL_EOL_REPORT || null
let exitCode = 1
const report = ['## Repository migration eval', '']

try {
  const oldId = required('MODEL_EOL_OLD_ID')
  const newId = required('MODEL_EOL_NEW_ID')
  const planPath = required('MODEL_EOL_PLAN')
  reportPath = required('MODEL_EOL_REPORT')
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  if (plan.plan_schema !== 'model-eol.plan/0.1' || !Array.isArray(plan.items) || plan.items.length === 0) {
    throw new Error('MODEL_EOL_PLAN is not a non-empty model-eol plan')
  }
  if (plan.items.some(item => item.id !== oldId || item.replacement !== newId)) {
    throw new Error('MODEL_EOL_PLAN contains a migration outside MODEL_EOL_OLD_ID/MODEL_EOL_NEW_ID')
  }

  const files = [...new Set(plan.items.map(item => item.file))].sort()
  report.push(
    `- Migration: \`${singleLine(oldId)}\` to \`${singleLine(newId)}\``,
    `- Planned references: ${plan.items.length} across ${files.length} file(s)`,
    `- Verification: \`${VERIFY.command} ${VERIFY.args.join(' ')}\``,
  )

  const started = Date.now()
  const result = spawnSync(VERIFY.command, VERIFY.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  })
  const elapsedMs = Date.now() - started
  const passed = !result.error && result.status === 0
  report.push(
    `- Result: ${passed ? 'pass' : 'fail'}`,
    `- Exit code: ${Number.isInteger(result.status) ? result.status : 'unavailable'}`,
    `- Duration: ${elapsedMs} ms`,
  )
  if (result.signal) report.push(`- Signal: ${singleLine(result.signal)}`)
  if (result.error) report.push(`- Runner error: ${singleLine(result.error.message)}`)
  report.push('', passed
    ? 'The repository verification command passed in the isolated patched checkout.'
    : 'The repository verification command failed. Reproduce it locally for full logs; command output is intentionally not copied into the publishable report.')
  exitCode = passed ? 0 : 1
} catch (error) {
  report.push(`- Result: fail`, '', `Harness error: ${singleLine(error.message)}`)
  exitCode = 1
} finally {
  if (reportPath) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true })
      fs.writeFileSync(reportPath, `${report.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      console.error(`could not write MODEL_EOL_REPORT: ${error.message}`)
      exitCode = 1
    }
  } else {
    console.error('MODEL_EOL_REPORT is required')
  }
}

process.exitCode = exitCode
