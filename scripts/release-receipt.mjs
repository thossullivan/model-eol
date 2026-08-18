#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import { assertSha512Integrity } from './package-integrity.mjs'

export const RELEASE_RECEIPT_SCHEMA = 'model-eol/npm-release-result@0.2'

const versionPattern = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const shaPattern = /^[0-9a-f]{40,64}$/

const usage = `Usage:
  node scripts/release-receipt.mjs create --out FILE --source-sha SHA [--version VERSION --release-sha SHA --registry-integrity SHA512_SRI]
  node scripts/release-receipt.mjs verify --receipt FILE [--expected-source-sha SHA] [--github-output FILE]`

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

const assertSha = (value, label) => {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error(`${label} must be a 40-64 character lowercase hexadecimal Git commit`)
  return value
}

const assertVersion = value => {
  if (typeof value !== 'string' || !versionPattern.test(value)) throw new Error(`release version must be an exact stable 0.x version, got ${value}`)
  return value
}

const exactKeys = (value, keys) => {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`release receipt fields must be exactly ${expected.join(', ')}; got ${actual.join(', ')}`)
}

export function createReleaseReceipt({ sourceCommit, version = null, releaseCommit = null, registryIntegrity = null }) {
  const receipt = {
    schema: RELEASE_RECEIPT_SCHEMA,
    released: version !== null,
    source_commit: assertSha(sourceCommit, 'source_commit'),
  }
  if (version === null) {
    if (releaseCommit !== null || registryIntegrity !== null) throw new Error('release_commit and registry_integrity cannot be set for a no-release result')
    return receipt
  }
  receipt.version = assertVersion(version)
  receipt.tag = `v${version}`
  receipt.release_commit = assertSha(releaseCommit, 'release_commit')
  receipt.registry_integrity = assertSha512Integrity(registryIntegrity, 'registry_integrity')
  return receipt
}

export function validateReleaseReceipt(receipt, { expectedSourceCommit = null } = {}) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('release receipt must be a JSON object')
  if (typeof receipt.released !== 'boolean') throw new Error('release receipt released must be boolean')
  exactKeys(receipt, receipt.released
    ? ['schema', 'released', 'source_commit', 'version', 'tag', 'release_commit', 'registry_integrity']
    : ['schema', 'released', 'source_commit'])
  if (receipt.schema !== RELEASE_RECEIPT_SCHEMA) throw new Error(`unsupported release receipt schema ${receipt.schema}`)
  const sourceCommit = assertSha(receipt.source_commit, 'source_commit')
  if (expectedSourceCommit !== null && sourceCommit !== assertSha(expectedSourceCommit, 'expected source commit')) {
    throw new Error(`receipt source_commit ${sourceCommit} does not match workflow source ${expectedSourceCommit}`)
  }
  if (receipt.released) {
    assertVersion(receipt.version)
    if (receipt.tag !== `v${receipt.version}`) throw new Error(`release receipt tag ${receipt.tag} does not match version ${receipt.version}`)
    assertSha(receipt.release_commit, 'release_commit')
    assertSha512Integrity(receipt.registry_integrity, 'registry_integrity')
  }
  return receipt
}

const readReceipt = (file, options) => {
  let receipt
  try {
    receipt = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read release receipt ${file}: ${error.message}`)
  }
  return validateReleaseReceipt(receipt, options)
}

const appendGithubOutput = (file, receipt) => {
  fs.appendFileSync(file, [
    `released=${receipt.released}`,
    `version=${receipt.version ?? ''}`,
    `tag=${receipt.tag ?? ''}`,
    `release_commit=${receipt.release_commit ?? ''}`,
    `registry_integrity=${receipt.registry_integrity ?? ''}`,
    '',
  ].join('\n'))
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'source-sha': { type: 'string' },
      version: { type: 'string' },
      'release-sha': { type: 'string' },
      'registry-integrity': { type: 'string' },
      receipt: { type: 'string' },
      'expected-source-sha': { type: 'string' },
      'github-output': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const [command, ...extra] = positionals
  if (!command || extra.length || !['create', 'verify'].includes(command)) fail('command must be create or verify')
  if (command === 'create') {
    if (!values.out) fail('--out is required for create')
    if (!values['source-sha']) fail('--source-sha is required for create')
    const releaseFields = [values.version, values['release-sha'], values['registry-integrity']]
    if (releaseFields.some(value => value === undefined) && releaseFields.some(value => value !== undefined)) {
      fail('--version, --release-sha, and --registry-integrity must be supplied together')
    }
    const receipt = createReleaseReceipt({
      sourceCommit: values['source-sha'],
      version: values.version ?? null,
      releaseCommit: values['release-sha'] ?? null,
      registryIntegrity: values['registry-integrity'] ?? null,
    })
    fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true })
    fs.writeFileSync(values.out, `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(receipt.released ? `wrote release receipt for ${receipt.tag}` : 'wrote no-release receipt')
    return 0
  }
  if (!values.receipt) fail('--receipt is required for verify')
  const receipt = readReceipt(values.receipt, { expectedSourceCommit: values['expected-source-sha'] ?? null })
  if (values['github-output']) appendGithubOutput(values['github-output'], receipt)
  console.log(receipt.released ? `verified release receipt for ${receipt.tag}` : 'verified no-release receipt')
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`release receipt failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
