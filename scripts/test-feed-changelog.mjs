#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..')
const generator = path.join(root, 'scripts', 'feed-changelog.mjs')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-feed-changelog-test-'))
const feedFile = path.join(tempRoot, 'feeds', 'test.json')

let failures = 0
const assert = (condition, message) => {
  if (!condition) {
    console.error(`FAIL: ${message}`)
    failures++
  } else {
    console.log(`ok: ${message}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? tempRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`)
  }
  return result.stdout
}

function git(args, env = {}) {
  return run('git', args, { env })
}

function writeFeed(feed) {
  fs.writeFileSync(feedFile, `${JSON.stringify(feed, null, 2)}\n`)
}

function commit(message, date) {
  git(['add', 'feeds/test.json'])
  git(['commit', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  })
}

try {
  const unknownFlag = spawnSync(process.execPath, [generator, '--dyas', '90'], {
    cwd: tempRoot,
    encoding: 'utf8',
  })
  assert(unknownFlag.status === 2 && unknownFlag.stderr.includes('--dyas') && unknownFlag.stderr.includes('--help'), 'unknown changelog flags exit 2 with the bad flag and help hint')
  const helpFlag = spawnSync(process.execPath, [generator, '--help'], { encoding: 'utf8' })
  assert(helpFlag.status === 0 && helpFlag.stdout.includes('Usage:'), '--help exits 0 with usage text')

  fs.mkdirSync(path.dirname(feedFile), { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'user.name', 'Feed Changelog Test'])

  const source = 'https://example.invalid/models'
  writeFeed({
    spec: 'model-eol/0.1',
    publisher: 'test',
    generated: '2026-01-01T00:00:00Z',
    source,
    models: [{ id: 'old-model', shutdown: '2026-12-31', source }],
  })
  commit('initial feed', '2026-01-01T00:00:00Z')

  writeFeed({
    spec: 'model-eol/0.1',
    publisher: 'test',
    generated: '2026-01-02T00:00:00Z',
    source,
    models: [
      { id: 'old-model', shutdown: '2027-01-31', source },
      { id: 'new-model', shutdown: '2027-06-01', source },
    ],
  })
  commit('change shutdown and add model', '2026-01-02T00:00:00Z')

  writeFeed({
    spec: 'model-eol/0.1',
    publisher: 'test',
    generated: '2026-01-03T00:00:00Z',
    source,
    models: [
      { id: 'old-model', shutdown: '2027-01-31', source },
      { id: 'new-model', shutdown: '2027-06-01', source },
    ],
  })
  commit('metadata-only generated timestamp', '2026-01-03T00:00:00Z')

  const atom = run(process.execPath, [generator, '--repo-dir', tempRoot])
  const entryCount = (atom.match(/<entry>/g) ?? []).length
  const closingEntryCount = (atom.match(/<\/entry>/g) ?? []).length
  assert(entryCount === 2 && closingEntryCount === 2, 'timestamp-only commit is skipped and semantic entries remain')
  assert(atom.includes('<title>test: 1 shutdown change, 1 model added</title>'), 'entry title includes shutdown and added-model counts')
  assert(atom.includes('<title>initial import</title>'), 'initial feed import is represented')
  assert(atom.includes('&lt;pre&gt;') && !atom.includes('<pre>'), 'Atom content wrapper is XML-escaped')
  assert(atom.includes('<author><name>model-eol maintainers</name></author>'), 'Atom feed identifies its author')
  assert(atom.includes('<link rel="self" href="https://thossullivan.github.io/model-eol/changelog.atom" />'), 'Atom feed publishes its canonical subscription URL')

  for (const tag of ['feed', 'entry', 'title', 'updated']) {
    const opening = (atom.match(new RegExp(`<${tag}(?:\\s|>)`, 'g')) ?? []).length
    const closing = (atom.match(new RegExp(`</${tag}>`, 'g')) ?? []).length
    assert(opening === closing, `${tag} tags are balanced`)
  }
  assert(!atom.includes('metadata-only generated timestamp'), 'metadata-only commit subject is absent from output')

  const limited = run(process.execPath, [generator, '--repo-dir', tempRoot, '--limit', '2'])
  assert((limited.match(/<entry>/g) ?? []).length === 1, '--limit limits commits before rendering entries')

  const markdown = run(process.execPath, [generator, '--repo-dir', tempRoot, '--format', 'markdown'])
  assert(markdown.startsWith('# model-eol feed changelog'), 'markdown format has a changelog heading')
  assert(markdown.includes('## 2026-01-02T00:00:00Z - test: 1 shutdown change, 1 model added'), 'markdown format renders the same semantic entry')
  assert(!markdown.includes('<feed'), 'markdown format is not Atom')
} catch (error) {
  console.error(`FAIL: feed changelog test setup failed: ${error.message}`)
  failures++
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

if (failures) process.exitCode = 1
