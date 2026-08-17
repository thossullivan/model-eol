#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const actionPath = path.join(root, 'action.yml')
const actionSource = fs.readFileSync(actionPath, 'utf8')

const inputDefaults = new Map()
let inInputs = false
let currentInput = null
for (const line of actionSource.split('\n')) {
  if (line === 'inputs:') {
    inInputs = true
    continue
  }
  if (line === 'runs:') {
    inInputs = false
    currentInput = null
  }
  if (!inInputs) continue
  const inputMatch = line.match(/^  ([a-z][a-z0-9-]*):$/)
  if (inputMatch) {
    currentInput = inputMatch[1]
    continue
  }
  const defaultMatch = line.match(/^    default: '(.*)'$/)
  if (currentInput && defaultMatch) inputDefaults.set(currentInput, defaultMatch[1].replaceAll("''", "'"))
}

const runMarker = '      run: |\n'
const runStart = actionSource.indexOf(runMarker)
assert.notEqual(runStart, -1, 'action.yml has a composite run block')
const runLines = actionSource.slice(runStart + runMarker.length).split('\n')
let shell = ''
for (const line of runLines) {
  if (line && !line.startsWith('        ')) break
  shell += `${line.startsWith('        ') ? line.slice(8) : ''}\n`
}

const requiredDefaults = [
  'command',
  'paths',
  'days',
  'via',
  'scope',
  'changed',
  'format',
  'feeds',
  'config',
  'include-docs',
  'allow-incomplete',
  'json',
  'output-file',
]
for (const input of requiredDefaults) assert(inputDefaults.has(input), `${input} declares an Action default`)
assert.equal(inputDefaults.get('days'), '', 'Action does not mask configured threshold_days')
assert.equal(inputDefaults.get('scope'), '', 'Action does not mask configured scope')
assert.equal(inputDefaults.get('format'), '', 'format default is delegated to each command')

const envNameByInput = {
  command: 'MODEL_EOL_COMMAND',
  paths: 'MODEL_EOL_PATHS',
  days: 'MODEL_EOL_DAYS',
  via: 'MODEL_EOL_VIA',
  scope: 'MODEL_EOL_SCOPE',
  changed: 'MODEL_EOL_CHANGED',
  format: 'MODEL_EOL_FORMAT',
  feeds: 'MODEL_EOL_FEEDS',
  config: 'MODEL_EOL_CONFIG',
  'include-docs': 'MODEL_EOL_INCLUDE_DOCS',
  'allow-incomplete': 'MODEL_EOL_ALLOW_INCOMPLETE',
  json: 'MODEL_EOL_JSON',
  'output-file': 'MODEL_EOL_OUTPUT_FILE',
}
const actionEnvBindings = new Map()
for (const line of actionSource.split('\n')) {
  const binding = line.match(/^        (MODEL_EOL_[A-Z_]+): \$\{\{ inputs(?:\.([a-z][a-z0-9-]*)|\['([a-z][a-z0-9-]*)'\]) \}\}$/)
  if (binding) actionEnvBindings.set(binding[1], binding[2] ?? binding[3])
}
for (const [input, envName] of Object.entries(envNameByInput)) {
  assert.equal(actionEnvBindings.get(envName), input, `${input} is wired into the composite shell environment`)
}

const runAction = (inputs = {}, { cwd = root } = {}) => {
  const env = { ...process.env, MODEL_EOL_ACTION_PATH: root }
  for (const [input, envName] of Object.entries(envNameByInput)) {
    env[envName] = String(Object.hasOwn(inputs, input) ? inputs[input] : inputDefaults.get(input))
  }
  const result = spawnSync('bash', ['-c', shell], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.error) throw result.error
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const parseJson = (value, message) => {
  try {
    return JSON.parse(value)
  } catch (error) {
    assert.fail(`${message}: ${error.message}\n${value}`)
  }
}

const fixture = 'test/fixture'
const check = runAction({ command: 'check', paths: fixture })
assert.equal(check.code, 1, 'check preserves finding exit code with Action defaults')
assert.match(check.out, /model-eol:/, 'check emits its text report')

const inventory = runAction({ command: 'inventory', paths: fixture })
assert.equal(inventory.code, 0, `inventory accepts its default format: ${inventory.err}`)
assert.equal(parseJson(inventory.out, 'default inventory output is JSON').schema, 'model-eol/inventory@0.1')

const schedule = runAction({ command: 'schedule', paths: fixture })
assert.equal(schedule.code, 0, `schedule works with Action defaults: ${schedule.err}`)
assert.match(schedule.out, /model-eol schedule:/, 'schedule emits its text report')

const alert = runAction({ command: 'alert', paths: fixture })
assert.equal(alert.code, 1, 'alert preserves finding exit code with Action defaults')
assert.match(alert.out, /::(?:error|warning)/, 'alert defaults to GitHub annotations')

const plan = runAction({ command: 'plan', paths: fixture })
assert.equal(plan.code, 0, `plan works with Action defaults: ${plan.err}`)
assert.equal(parseJson(plan.out, 'plan output is JSON').plan_schema, 'model-eol.plan/0.1')

const cyclonedx = runAction({ command: 'inventory', paths: fixture, format: 'cyclonedx' })
assert.equal(cyclonedx.code, 0, `inventory accepts its command-specific format: ${cyclonedx.err}`)
assert.equal(parseJson(cyclonedx.out, 'CycloneDX output is JSON').bomFormat, 'CycloneDX')

const markdown = runAction({ command: 'alert', paths: fixture, format: 'markdown' })
assert.equal(markdown.code, 1, 'Markdown alert preserves finding exit code')
assert.match(markdown.out, /^# model-eol alert/m, 'alert accepts its command-specific format')

const jsonCheck = runAction({ command: 'check', paths: fixture, json: 'true' })
assert.equal(jsonCheck.code, 1, 'JSON check preserves finding exit code')
assert(Array.isArray(parseJson(jsonCheck.out, 'check --json emits JSON').findings), 'json input reaches the CLI')

const invalidCommand = runAction({ command: 'apply', paths: fixture })
assert.equal(invalidCommand.code, 2, 'Action rejects commands outside its scanning contract')
assert.match(invalidCommand.err, /command must be/, 'invalid command has an actionable diagnostic')

const wrongFormatCommand = runAction({ command: 'schedule', paths: fixture, format: 'json' })
assert.equal(wrongFormatCommand.code, 2, 'Action rejects format for commands that do not accept it')

const wrongChangedCommand = runAction({ command: 'inventory', paths: fixture, changed: 'HEAD~1' })
assert.equal(wrongChangedCommand.code, 2, 'Action rejects changed for commands other than check')

const invalidBoolean = runAction({ command: 'inventory', paths: fixture, json: 'yes' })
assert.equal(invalidBoolean.code, 2, 'Action rejects ambiguous boolean input values')
assert.match(invalidBoolean.err, /json must be true or false/, 'invalid boolean names the input')

const wrongAllowIncompleteCommand = runAction({
  command: 'inventory',
  paths: fixture,
  'allow-incomplete': 'true',
})
assert.equal(wrongAllowIncompleteCommand.code, 2, 'Action rejects allow-incomplete outside check and plan')
assert.match(wrongAllowIncompleteCommand.err, /only supported by the check and plan/, 'allow-incomplete error names supported commands')

const wrongJsonCommand = runAction({ command: 'plan', paths: fixture, json: 'true' })
assert.equal(wrongJsonCommand.code, 2, 'Action rejects redundant json input for plan')
assert.match(wrongJsonCommand.err, /only supported by the check, inventory, schedule, and alert/, 'json error names supported commands')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-action-contract-'))
try {
  const docsOnly = path.join(tempRoot, 'docs only')
  fs.mkdirSync(docsOnly)
  fs.writeFileSync(path.join(docsOnly, 'README.md'), 'Use `o3-deep-research` here.\n')
  const withoutDocs = runAction({ command: 'check', paths: 'docs only\n' }, { cwd: tempRoot })
  assert.equal(withoutDocs.code, 0, 'documentation stays excluded by default')
  const withDocs = runAction({ command: 'check', paths: 'docs only\n', 'include-docs': 'true' }, { cwd: tempRoot })
  assert.equal(withDocs.code, 1, 'include-docs boolean reaches the CLI')

  const firstPath = path.join(tempRoot, 'first path')
  const secondPath = path.join(tempRoot, 'second path')
  fs.mkdirSync(firstPath)
  fs.mkdirSync(secondPath)
  fs.writeFileSync(path.join(firstPath, 'app.py'), 'MODEL = "o3-deep-research"\n')
  fs.writeFileSync(path.join(secondPath, 'app.py'), 'MODEL = "gpt-5.6-sol"\n')
  const multilinePaths = runAction({ command: 'inventory', paths: 'first path\nsecond path' }, { cwd: tempRoot })
  assert.equal(multilinePaths.code, 0, `newline-separated paths preserve spaces: ${multilinePaths.err}`)
  assert.deepEqual(parseJson(multilinePaths.out, 'multiline path inventory is JSON').targets, ['first path', 'second path'])

  const outputPath = path.join(tempRoot, 'inventory.json')
  const outputInventory = runAction({ command: 'inventory', paths: 'first path\n', 'output-file': outputPath }, { cwd: tempRoot })
  assert.equal(outputInventory.code, 0, `output-file succeeds for reports: ${outputInventory.err}`)
  assert.equal(fs.readFileSync(outputPath, 'utf8'), outputInventory.out, 'output-file is an exact stdout copy')

  const findingOutputPath = path.join(tempRoot, 'finding.txt')
  const outputCheck = runAction({ command: 'check', paths: 'first path\n', 'output-file': findingOutputPath }, { cwd: tempRoot })
  assert.equal(outputCheck.code, 1, 'output-file does not mask the CLI finding exit code')
  assert.equal(fs.readFileSync(findingOutputPath, 'utf8'), outputCheck.out, 'finding output is still captured')

  const impossibleOutput = runAction({
    command: 'inventory',
    paths: 'first path\n',
    'output-file': path.join(tempRoot, 'missing', 'inventory.json'),
  }, { cwd: tempRoot })
  assert.notEqual(impossibleOutput.code, 0, 'an unwritable output-file fails a successful report')

  const usageOutputPath = path.join(tempRoot, 'usage-error.txt')
  const outputUsageError = runAction({
    command: 'inventory',
    paths: 'first path\n',
    format: 'not-a-format',
    'output-file': usageOutputPath,
  }, { cwd: tempRoot })
  assert.equal(outputUsageError.code, 2, 'output-file does not mask the CLI usage exit code')
  assert.equal(fs.readFileSync(usageOutputPath, 'utf8'), outputUsageError.out, 'usage-error stdout is captured exactly')

  const configuredPath = path.join(tempRoot, 'configured gateway')
  fs.mkdirSync(configuredPath)
  fs.writeFileSync(path.join(configuredPath, 'gateway.ts'), [
    'const baseURL = "https://openrouter.ai/api/v1";',
    'const model = "openai/gpt-4-0613";',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(configuredPath, '.model-eol.json'), '{"scope":"direct"}\n')
  const configuredDefault = runAction({ command: 'check', paths: 'configured gateway\n' }, { cwd: tempRoot })
  assert.equal(configuredDefault.code, 0, 'empty Action defaults preserve repository config')
  const configuredOverride = runAction({ command: 'check', paths: 'configured gateway\n', scope: 'all' }, { cwd: tempRoot })
  assert.equal(configuredOverride.code, 1, 'explicit Action input overrides repository config')

  const selectedConfig = path.join(tempRoot, 'selected-config.json')
  fs.writeFileSync(selectedConfig, '{"ignore":{"models":["o3-deep-research"]}}\n')
  const explicitConfig = runAction({
    command: 'check',
    paths: 'first path\n',
    config: selectedConfig,
  }, { cwd: tempRoot })
  assert.equal(explicitConfig.code, 0, 'config input selects an explicit shared config')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

console.log('action contract tests passed')
