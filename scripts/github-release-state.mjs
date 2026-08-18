#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'

const stableTagPattern = /^v0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const usage = 'Usage: node scripts/github-release-state.mjs --input PAGINATED_JSON --tag vVERSION'

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

export function stableGithubReleaseExists({ pages, tag }) {
  if (typeof tag !== 'string' || !stableTagPattern.test(tag)) throw new Error(`GitHub release tag must be an exact stable v0.x version, got ${tag}`)
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
    throw new Error('paginated GitHub releases response must be an outer array of page arrays')
  }
  const matches = []
  for (const page of pages) {
    for (const release of page) {
      if (release === null || typeof release !== 'object' || Array.isArray(release)) throw new Error('GitHub release entry must be an object')
      if (typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') {
        throw new Error('GitHub release entry is missing tag_name, draft, or prerelease state')
      }
      if (release.tag_name === tag) matches.push(release)
    }
  }
  if (matches.length > 1) throw new Error(`GitHub releases API returned duplicate entries for ${tag}`)
  if (!matches.length) return false
  if (matches[0].draft || matches[0].prerelease) {
    throw new Error(`${tag} exists as a draft or prerelease; refusing to treat it as the stable release`)
  }
  return true
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      input: { type: 'string' },
      tag: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage,
  })
  if (values.help) {
    console.log(usage)
    return 0
  }
  if (positionals.length) fail(`unexpected positional argument: ${positionals[0]}`)
  if (!values.input) fail('--input is required')
  if (!values.tag) fail('--tag is required')
  let pages
  try {
    pages = JSON.parse(fs.readFileSync(values.input, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read paginated GitHub releases response: ${error.message}`)
  }
  console.log(stableGithubReleaseExists({ pages, tag: values.tag }))
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`GitHub release state failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
