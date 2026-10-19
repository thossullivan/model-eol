#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import { assertSha512Integrity, sha512Integrity } from '../lib/receipts.mjs'

export { assertSha512Integrity, sha512Integrity }

const usage = 'Usage: node scripts/package-integrity.mjs verify --tarball FILE --expected-integrity SHA512_SRI'

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

export const verifyPackageIntegrity = ({ tarball, expectedIntegrity }) => {
  const expected = assertSha512Integrity(expectedIntegrity, 'expected integrity')
  const actual = sha512Integrity(fs.readFileSync(tarball))
  if (actual !== expected) throw new Error(`package integrity mismatch for ${tarball}: expected ${expected}, got ${actual}`)
  return actual
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tarball: { type: 'string' },
      'expected-integrity': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  const [command, ...extra] = positionals
  if (command !== 'verify' || extra.length) fail('command must be verify')
  if (!values.tarball) fail('--tarball is required')
  if (!values['expected-integrity']) fail('--expected-integrity is required')
  console.log(verifyPackageIntegrity({
    tarball: path.resolve(values.tarball),
    expectedIntegrity: values['expected-integrity'],
  }))
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`package integrity failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
