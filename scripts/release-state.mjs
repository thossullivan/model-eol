#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'

const versionPattern = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const shaPattern = /^[0-9a-f]{40,64}$/

const usage = `Usage:
  node scripts/release-state.mjs target --event-name push|workflow_dispatch [--requested-version VERSION]
  node scripts/release-state.mjs resolve --event-name push|workflow_dispatch --source-sha SHA --published-json JSON --github-release-exists true|false [--requested-version VERSION] [--github-output FILE]`

const fail = message => {
  const error = new Error(`${message}\n${usage}`)
  error.exitCode = 2
  throw error
}

const versionParts = (value, label) => {
  const match = typeof value === 'string' ? versionPattern.exec(value) : null
  if (!match) throw new Error(`${label} must be an exact stable 0.x version, got ${value}`)
  return [0, Number(match[1]), Number(match[2])]
}

const compareVersions = (left, right) => {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1
  }
  return 0
}

export const targetReleaseVersion = ({ eventName, sourceVersion, requestedVersion = null }) => {
  const source = versionParts(sourceVersion, 'source package version')
  if (eventName === 'push') return `${source[0]}.${source[1]}.${source[2] + 1}`
  if (eventName !== 'workflow_dispatch') throw new Error(`unsupported release event ${eventName}`)
  const requested = versionParts(requestedVersion, 'requested release version')
  if (compareVersions(requested, source) <= 0) throw new Error(`release version ${requestedVersion} must be greater than package version ${sourceVersion}`)
  return requestedVersion
}

export function resolveReleaseState({
  eventName,
  sourceVersion,
  requestedVersion = null,
  sourceCommit,
  mainCommit,
  publishedVersions = [],
  githubReleaseExists,
  tag = null,
}) {
  if (!shaPattern.test(sourceCommit ?? '')) throw new Error('source commit must be a 40-64 character lowercase hexadecimal Git commit')
  if (!shaPattern.test(mainCommit ?? '')) throw new Error('origin/main commit must be a 40-64 character lowercase hexadecimal Git commit')
  if (!Array.isArray(publishedVersions) || publishedVersions.some(version => typeof version !== 'string')) throw new Error('published versions must be an array of strings')
  if (typeof githubReleaseExists !== 'boolean') throw new Error('GitHub release state must be boolean')
  const version = targetReleaseVersion({ eventName, sourceVersion, requestedVersion })
  const releaseTag = `v${version}`
  const published = publishedVersions.includes(version)

  if (tag === null) {
    if (published) throw new Error(`${version} exists on npm without immutable tag ${releaseTag}; refusing to invent a release commit`)
    if (githubReleaseExists) throw new Error(`GitHub release ${releaseTag} exists without its immutable Git tag`)
    if (mainCommit !== sourceCommit) throw new Error(`origin/main moved from release source ${sourceCommit} to ${mainCommit}; refusing a non-atomic release push`)
    return {
      version,
      tag: releaseTag,
      mode: 'create',
      publish: true,
      createGithubRelease: true,
      releaseCommit: null,
    }
  }

  if (!tag || typeof tag !== 'object' || Array.isArray(tag)) throw new Error('tag state must be an object or null')
  for (const [label, value] of [
    ['release tag commit', tag.commit],
    ['release tag parent', tag.parent],
    ['moving v0 commit', tag.movingCommit],
  ]) {
    if (!shaPattern.test(value ?? '')) throw new Error(`${label} must be a Git commit`)
  }
  if (tag.parent !== sourceCommit) throw new Error(`${releaseTag} is not the release commit directly above source ${sourceCommit}`)
  if (tag.version !== version) throw new Error(`${releaseTag} contains package version ${tag.version}, expected ${version}`)
  if (tag.movingCommit !== tag.commit) throw new Error(`moving v0 tag ${tag.movingCommit} does not match immutable ${releaseTag} commit ${tag.commit}`)
  if (tag.mainContainsRelease !== true) throw new Error(`origin/main does not contain immutable release commit ${tag.commit}`)
  if (JSON.stringify(tag.changedPaths) !== JSON.stringify(['package.json'])) {
    throw new Error(`${releaseTag} release commit must change only package.json; got ${(tag.changedPaths ?? []).join(', ')}`)
  }
  if (githubReleaseExists && !published) throw new Error(`${releaseTag} has a GitHub release but model-eol@${version} is missing from npm`)
  return {
    version,
    tag: releaseTag,
    mode: 'resume',
    publish: !published,
    createGithubRelease: !githubReleaseExists,
    releaseCommit: tag.commit,
  }
}

const runGit = (args, { allowStatus = [] } = {}) => {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error) throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`)
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`)
  }
  return result
}

const revParse = ref => runGit(['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim()

const maybeRevParse = ref => {
  const result = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { allowStatus: [1, 128] })
  return result.status === 0 ? result.stdout.trim() : null
}

const packageVersionAt = commit => {
  const result = runGit(['show', `${commit}:package.json`])
  try {
    return JSON.parse(result.stdout).version
  } catch (error) {
    throw new Error(`package.json at ${commit} is invalid: ${error.message}`)
  }
}

const currentPackageVersion = () => {
  try {
    return JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  } catch (error) {
    throw new Error(`unable to read source package.json: ${error.message}`)
  }
}

const parseBoolean = (value, label) => {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${label} must be true or false`)
}

const appendGithubOutput = (file, state) => {
  fs.appendFileSync(file, [
    `version=${state.version}`,
    `tag=${state.tag}`,
    `mode=${state.mode}`,
    `publish=${state.publish}`,
    `create_github_release=${state.createGithubRelease}`,
    `release_commit=${state.releaseCommit ?? ''}`,
    '',
  ].join('\n'))
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'event-name': { type: 'string' },
      'requested-version': { type: 'string' },
      'source-sha': { type: 'string' },
      'published-json': { type: 'string' },
      'github-release-exists': { type: 'string' },
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
  if (!command || extra.length || !['target', 'resolve'].includes(command)) fail('command must be target or resolve')
  if (!values['event-name']) fail('--event-name is required')
  const sourceVersion = currentPackageVersion()
  const requestedVersion = values['requested-version'] ?? null
  if (command === 'target') {
    console.log(targetReleaseVersion({ eventName: values['event-name'], sourceVersion, requestedVersion }))
    return 0
  }
  for (const name of ['source-sha', 'published-json', 'github-release-exists']) {
    if (values[name] === undefined) fail(`--${name} is required for resolve`)
  }
  const sourceCommit = revParse('HEAD')
  if (sourceCommit !== values['source-sha']) throw new Error(`checked out source ${sourceCommit} does not match workflow source ${values['source-sha']}`)
  let publishedVersions
  try {
    const parsed = JSON.parse(values['published-json'])
    publishedVersions = Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    throw new Error(`--published-json is invalid: ${error.message}`)
  }
  const version = targetReleaseVersion({ eventName: values['event-name'], sourceVersion, requestedVersion })
  const releaseTag = `v${version}`
  const releaseCommit = maybeRevParse(`refs/tags/${releaseTag}`)
  let tag = null
  const mainCommit = revParse('refs/remotes/origin/main')
  if (releaseCommit !== null) {
    const parentLine = runGit(['rev-list', '--parents', '-n', '1', releaseCommit]).stdout.trim().split(/\s+/)
    if (parentLine.length !== 2) throw new Error(`${releaseTag} must identify a single-parent release commit`)
    const parent = parentLine[1]
    const changedPaths = runGit(['diff', '--name-only', `${parent}..${releaseCommit}`]).stdout.split('\n').filter(Boolean).sort()
    const ancestry = runGit(['merge-base', '--is-ancestor', releaseCommit, mainCommit], { allowStatus: [1] })
    tag = {
      commit: releaseCommit,
      parent,
      version: packageVersionAt(releaseCommit),
      movingCommit: maybeRevParse('refs/tags/v0'),
      mainContainsRelease: ancestry.status === 0,
      changedPaths,
    }
  }
  const state = resolveReleaseState({
    eventName: values['event-name'],
    sourceVersion,
    requestedVersion,
    sourceCommit,
    mainCommit,
    publishedVersions,
    githubReleaseExists: parseBoolean(values['github-release-exists'], '--github-release-exists'),
    tag,
  })
  if (values['github-output']) appendGithubOutput(values['github-output'], state)
  console.log(JSON.stringify(state, null, 2))
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`release state failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
