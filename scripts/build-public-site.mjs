#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import { assertValidFeed } from '../lib/validate-feed.mjs'
import { readFeedRefreshReceipt } from './feed-refresh-receipt.mjs'

const PUBLIC_BASE = 'https://thossullivan.github.io/model-eol'
const SCHEMA_VERSION = '0.1'
const defaultRoot = path.resolve(import.meta.dirname, '..')

const usage = () => 'Usage: node scripts/build-public-site.mjs --out-dir DIR --receipt FILE [--source-sha SHA] [--repo-dir DIR]'

const fail = message => {
  const error = new Error(`${message}\n${usage()}`)
  error.exitCode = 2
  throw error
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const gitHead = repoDir => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' })
  if (result.error || result.status !== 0) {
    throw new Error(`unable to resolve site source commit: ${(result.stderr || result.error?.message || '').trim()}`)
  }
  return result.stdout.trim()
}

const git = (repoDir, args, { encoding = 'utf8' } = {}) => {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = encoding === null
      ? result.error?.message
      : (result.stderr || result.error?.message || '').trim()
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

const assertSha = (value, name) => {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) fail(`${name} must be a 40-64 character hexadecimal Git commit`)
  return value.toLowerCase()
}

const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const publishedJsonPaths = root => ['schema', 'feeds'].flatMap(directory =>
  fs.readdirSync(path.join(root, directory))
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => `${directory}/${name}`)).sort()

const assertPublishedInputsBound = ({ root, sourceCommit }) => {
  const status = git(root, [
    'status', '--porcelain=v1', '--untracked-files=all', '--',
    ':(glob)schema/*.json', ':(glob)feeds/*.json',
  ])
  if (status.trim()) throw new Error(`published schema/feed inputs are dirty relative to ${sourceCommit}: ${status.trim()}`)

  const committed = git(root, ['ls-tree', '-r', '--name-only', '-z', sourceCommit, '--', 'schema', 'feeds'], { encoding: null })
    .toString('utf8')
    .split('\0')
    .filter(name => /^(?:schema|feeds)\/[^/]+\.json$/.test(name))
    .sort()
  const working = publishedJsonPaths(root)
  if (JSON.stringify(committed) !== JSON.stringify(working)) {
    throw new Error(`published schema/feed file set does not match source commit ${sourceCommit}`)
  }

  for (const relative of working) {
    const file = path.join(root, ...relative.split('/'))
    if (!fs.lstatSync(file).isFile()) throw new Error(`published input must be a regular file: ${relative}`)
    const committedBytes = git(root, ['show', `${sourceCommit}:${relative}`], { encoding: null })
    const workingBytes = fs.readFileSync(file)
    if (!workingBytes.equals(committedBytes)) {
      throw new Error(`published input ${relative} does not match source commit ${sourceCommit}`)
    }
  }
}

const copyJsonDirectory = ({ from, to, validate = null }) => {
  const names = fs.readdirSync(from).filter(name => name.endsWith('.json')).sort()
  if (!names.length) throw new Error(`no JSON files found in ${from}`)
  fs.mkdirSync(to, { recursive: true })
  return names.map(name => {
    const source = path.join(from, name)
    const bytes = fs.readFileSync(source)
    const document = JSON.parse(bytes.toString('utf8'))
    if (validate) validate(document, source)
    fs.writeFileSync(path.join(to, name), bytes)
    return { name, document, sha256: sha256(bytes) }
  })
}

const html = ({ schemas, feeds }) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>model-eol public data</title>
</head>
<body>
  <main>
    <h1>model-eol public data</h1>
    <p>Versioned, machine-readable lifecycle contracts from <a href="https://github.com/thossullivan/model-eol">model-eol</a>.</p>
    <h2>Schemas</h2>
    <ul>${schemas.map(({ name }) => `\n      <li><a href="schema/${SCHEMA_VERSION}/${name}">${name}</a></li>`).join('')}\n    </ul>
    <h2>Feeds</h2>
    <ul>${feeds.map(({ name }) => `\n      <li><a href="feeds/${name}">${name}</a></li>`).join('')}\n    </ul>
    <p><a href="changelog.atom">Atom changelog</a> · <a href="health.json">refresh health</a> · <a href="index.json">publication manifest</a></p>
  </main>
</body>
</html>
`

export function buildPublicSite({
  repoDir = defaultRoot,
  outDir,
  receiptFile,
  sourceSha,
}) {
  const root = path.resolve(repoDir)
  const output = path.resolve(outDir)
  if (!receiptFile) fail('--receipt is required')
  const receiptResult = readFeedRefreshReceipt(path.resolve(receiptFile), { repoDir: root })
  if (!receiptResult.matches) {
    throw new Error(`feed refresh receipt does not match the feeds being published: ${receiptResult.mismatches.join('; ')}`)
  }
  const receipt = receiptResult.receipt
  const headCommit = assertSha(gitHead(root), 'repository HEAD')
  const sourceCommit = assertSha(sourceSha ?? headCommit, '--source-sha')
  if (sourceCommit !== headCommit) throw new Error(`--source-sha ${sourceCommit} does not match repository HEAD ${headCommit}`)
  assertPublishedInputsBound({ root, sourceCommit })

  if (fs.existsSync(output) && fs.readdirSync(output).length) {
    throw new Error(`output directory must be empty: ${output}`)
  }
  fs.mkdirSync(output, { recursive: true })

  const schemas = copyJsonDirectory({
    from: path.join(root, 'schema'),
    to: path.join(output, 'schema', SCHEMA_VERSION),
  })
  const feeds = copyJsonDirectory({
    from: path.join(root, 'feeds'),
    to: path.join(output, 'feeds'),
    validate: (feed, source) => assertValidFeed(feed, source),
  })

  const changelog = spawnSync(process.execPath, [
    path.join(root, 'scripts', 'feed-changelog.mjs'),
    '--repo-dir', root,
    '--out', path.join(output, 'changelog.atom'),
  ], { cwd: root, encoding: 'utf8' })
  if (changelog.error || changelog.status !== 0) {
    throw new Error(`failed to build Atom changelog: ${(changelog.stderr || changelog.error?.message || '').trim()}`)
  }

  const feedRecords = feeds.map(({ name, document, sha256: digest }) => ({
    publisher: document.publisher,
    generated: document.generated,
    url: `${PUBLIC_BASE}/feeds/${name}`,
    sha256: digest,
  }))
  writeJson(path.join(output, 'health.json'), {
    schema: 'model-eol/health@0.1',
    last_checked: receipt.checked_at,
    refresh_run: receipt.refresh_run,
    refresh_commit: receipt.refresh_commit,
    published_commit: sourceCommit,
    feeds: feedRecords,
  })
  writeJson(path.join(output, 'index.json'), {
    schema: 'model-eol/publication@0.1',
    published_commit: sourceCommit,
    schemas: schemas.map(({ name }) => ({
      id: `${PUBLIC_BASE}/schema/${SCHEMA_VERSION}/${name}`,
      url: `${PUBLIC_BASE}/schema/${SCHEMA_VERSION}/${name}`,
    })),
    feeds: feedRecords,
    atom: `${PUBLIC_BASE}/changelog.atom`,
    health: `${PUBLIC_BASE}/health.json`,
  })
  fs.writeFileSync(path.join(output, 'index.html'), html({ schemas, feeds }))

  return { output, schemas: schemas.length, feeds: feeds.length }
}

function main(argv) {
  const { values, positionals } = parseCliArgs({
    args: argv,
    options: {
      'out-dir': { type: 'string' },
      receipt: { type: 'string' },
      'source-sha': { type: 'string' },
      'repo-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: usage(),
  })
  if (values.help) {
    console.log(usage())
    return 0
  }
  if (positionals.length) fail(`unexpected positional argument: ${positionals[0]}`)
  if (!values['out-dir']) fail('--out-dir is required')
  if (!values.receipt) fail('--receipt is required')

  const result = buildPublicSite({
    repoDir: values['repo-dir'] ?? defaultRoot,
    outDir: values['out-dir'],
    receiptFile: values.receipt,
    sourceSha: values['source-sha'],
  })
  console.log(`built ${result.schemas} schemas and ${result.feeds} feeds in ${result.output}`)
  return 0
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`public site build failed: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  }
}
