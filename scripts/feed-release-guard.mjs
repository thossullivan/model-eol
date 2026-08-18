#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const isFeedPath = file => file.startsWith('feeds/')
const isRefreshMetadataPath = file => file === 'README.md'

export const classifyFeedReleasePaths = files => {
  const unique = [...new Set(files)]
  const feedChanged = unique.some(isFeedPath)
  const blockedPaths = unique.filter(file => !isFeedPath(file) && !isRefreshMetadataPath(file))
  return {
    changed: feedChanged && blockedPaths.length === 0,
    feedChanged,
    blockedPaths,
  }
}

export const changedPathsSince = (base, { cwd = process.cwd() } = {}) => {
  const result = spawnSync('git', ['diff', '--name-only', '-z', `${base}..HEAD`], {
    cwd,
    encoding: 'utf8',
  })
  if (result.error) throw new Error(`failed to run git: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git diff from ${base} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.split('\0').filter(Boolean)
}

const writeChangedOutput = changed => {
  const line = `changed=${changed}\n`
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line)
  else process.stdout.write(line)
}

const main = () => {
  const [base, ...extra] = process.argv.slice(2)
  if (!base || extra.length) {
    throw new Error('usage: node scripts/feed-release-guard.mjs LAST_RELEASE_TAG')
  }
  const result = classifyFeedReleasePaths(changedPathsSince(base))
  writeChangedOutput(result.changed)
  if (result.blockedPaths.length) {
    console.log(`automatic patch release refused: non-feed changes since ${base}: ${result.blockedPaths.map(file => JSON.stringify(file)).join(', ')}`)
  } else if (!result.feedChanged) {
    console.log(`feeds unchanged since ${base} - no automatic patch release`)
  } else {
    console.log(`only feeds and README refresh metadata changed since ${base} - automatic patch release allowed`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`feed release guard failed: ${error.message}`)
    process.exitCode = 1
  }
}
