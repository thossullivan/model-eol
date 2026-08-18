#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { parseCliArgs } from '../lib/cli.mjs'
import { compareFeeds, renderSemanticDiff } from '../refresh/diff.mjs'

const DEFAULT_LIMIT = 50
const EMPTY_UPDATED = '1970-01-01T00:00:00Z'
const PUBLIC_ATOM_URL = 'https://thossullivan.github.io/model-eol/changelog.atom'
const repoRoot = path.resolve(import.meta.dirname, '..')

function usageError(message) {
  throw new Error(`${message}\nUsage: node scripts/feed-changelog.mjs [--format atom|markdown] [--out FILE] [--repo-dir DIR] [--limit N]`)
}

function parseChangelogArgs(argv) {
  const { values } = parseCliArgs({
    args: argv,
    options: {
      format: { type: 'string' },
      out: { type: 'string' },
      'repo-dir': { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    help: 'node scripts/feed-changelog.mjs --help',
  })
  if (values.help) {
    console.log('Usage: node scripts/feed-changelog.mjs [--format atom|markdown] [--out FILE] [--repo-dir DIR] [--limit N]')
    process.exit(0)
  }
  const options = {
    format: values.format ?? 'atom',
    out: null,
    repoDir: values['repo-dir'] === undefined ? repoRoot : path.resolve(values['repo-dir']),
    limit: DEFAULT_LIMIT,
  }

  if (!['atom', 'markdown'].includes(options.format)) usageError('--format must be atom or markdown')
  if (values.out !== undefined) {
    if (!values.out) usageError('--out requires a file path')
    options.out = path.resolve(values.out)
  }
  if (values['repo-dir'] === '') usageError('--repo-dir requires a directory path')
  if (values.limit !== undefined) {
    const limit = Number(values.limit)
    if (!Number.isInteger(limit) || limit < 0) usageError('--limit must be a non-negative integer')
    options.limit = limit
  }

  return options
}

function git(repoDir, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
  })

  if (result.error) throw new Error(`failed to run git: ${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }

  return result
}

function commitLog(repoDir, limit) {
  if (limit === 0) return []

  const result = git(repoDir, ['log', '--format=%H%x09%cI%x09%s', '--', 'feeds'])
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)
    .map(line => {
      const [sha, date, ...subjectParts] = line.split('\t')
      return { sha, date, subject: subjectParts.join('\t') }
    })
}

function changedFeedFiles(repoDir, sha) {
  const result = git(repoDir, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '--name-only',
    '-r',
    sha,
    '--',
    'feeds',
  ])

  return [...new Set(result.stdout
    .split('\n')
    .map(file => file.trim())
    .filter(file => file.startsWith('feeds/') && file.endsWith('.json')))]
    .sort()
}

function parents(repoDir, sha) {
  const result = git(repoDir, ['rev-list', '--parents', '-n', '1', sha])
  return result.stdout.trim().split(/\s+/).slice(1).filter(Boolean)
}

function readFeed(repoDir, revision, file) {
  const result = git(repoDir, ['show', `${revision}:${file}`], { allowFailure: true })
  if (result.status !== 0) return null

  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`invalid JSON in ${revision}:${file}: ${error.message}`)
  }
}

function feedName(file, feed) {
  return feed?.publisher || path.basename(file, '.json')
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`
}

function titleFor(file, feed, result) {
  const addedIds = new Set((result.added ?? []).map(model => model.id))
  const newlyAnnounced = (result.newlyAnnounced ?? []).filter(model => !addedIds.has(model.id))
  const parts = []

  if (result.replacementChanges?.length) {
    parts.push(countLabel(result.replacementChanges.length, 'replacement change', 'replacement changes'))
  }
  if (result.shutdownChanges?.length) {
    parts.push(countLabel(result.shutdownChanges.length, 'shutdown change', 'shutdown changes'))
  }
  if (result.added?.length) {
    parts.push(countLabel(result.added.length, 'model added', 'models added'))
  }
  if (newlyAnnounced.length) {
    parts.push(countLabel(newlyAnnounced.length, 'newly announced deprecation', 'newly announced deprecations'))
  }
  if (result.distributionChanges?.length) {
    parts.push(countLabel(result.distributionChanges.length, 'distribution change', 'distribution changes'))
  }
  if (result.unconfirmed?.length) {
    parts.push(countLabel(result.unconfirmed.length, 'unconfirmed entry', 'unconfirmed entries'))
  }
  if (result.unconfirmedDistributions?.length) {
    parts.push(countLabel(result.unconfirmedDistributions.length, 'unconfirmed distribution', 'unconfirmed distributions'))
  }
  if (result.noPublisherFeed?.length) {
    parts.push(countLabel(result.noPublisherFeed.length, 'missing publisher feed', 'missing publisher feeds'))
  }

  return `${feedName(file, feed)}: ${parts.join(', ') || 'semantic changes'}`
}

function collectEntries(repoDir, limit) {
  const commits = commitLog(repoDir, limit)
  const entries = []

  for (const commit of commits) {
    const commitParents = parents(repoDir, commit.sha)
    const parent = commitParents[0]

    for (const file of changedFeedFiles(repoDir, commit.sha)) {
      const current = readFeed(repoDir, commit.sha, file)
      if (!current) continue

      const previous = parent ? readFeed(repoDir, parent, file) : null
      if (!parent || !previous) {
        entries.push({
          ...commit,
          file,
          feed: current,
          initial: true,
          title: 'initial import',
          body: null,
        })
        continue
      }

      const result = compareFeeds(previous, current, { publisher: current.publisher })
      if (!result.changed) continue

      entries.push({
        ...commit,
        file,
        feed: current,
        initial: false,
        title: titleFor(file, current, result),
        body: renderSemanticDiff(result, current, { publisher: current.publisher }),
      })
    }
  }

  return { commits, entries }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function atomEntry(entry) {
  const content = entry.initial
    ? ''
    : `\n    <content type="html">&lt;pre&gt;${escapeXml(entry.body)}&lt;/pre&gt;</content>`
  const summary = entry.subject
    ? `\n    <summary type="text">${escapeXml(entry.subject)}</summary>`
    : ''
  const year = entry.date.slice(0, 4) || '1970'
  const id = `tag:model-eol,${year}:${entry.sha}:${encodeURIComponent(entry.file)}`

  return `  <entry>
    <id>${escapeXml(id)}</id>
    <title>${escapeXml(entry.title)}</title>
    <updated>${escapeXml(entry.date)}</updated>
    <link href="${escapeXml(`https://github.com/thossullivan/model-eol/commit/${entry.sha}`)}" />${summary}${content}
  </entry>`
}

function renderAtom(commits, entries) {
  const updated = commits[0]?.date || EMPTY_UPDATED
  const year = updated.slice(0, 4) || '1970'
  const body = entries.map(atomEntry).join('\n')
  const entryBlock = body ? `\n${body}` : ''

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>tag:model-eol,${year}:feed-changelog</id>
  <title>model-eol feed changelog</title>
  <author><name>model-eol maintainers</name></author>
  <link rel="self" href="${PUBLIC_ATOM_URL}" />
  <link rel="alternate" href="https://github.com/thossullivan/model-eol" />
  <updated>${escapeXml(updated)}</updated>${entryBlock}
</feed>
`
}

function renderMarkdown(entries) {
  const lines = ['# model-eol feed changelog', '']

  for (const entry of entries) {
    lines.push(`## ${entry.date} - ${entry.title}`, '')
    lines.push(`Commit: \`${entry.sha}\``)
    lines.push(`Feed: \`${entry.file}\``)
    if (entry.subject) lines.push(`Subject: ${entry.subject}`)
    lines.push('')
    if (!entry.initial) {
      lines.push(entry.body.trimEnd(), '')
    }
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function main() {
  const options = parseChangelogArgs(process.argv.slice(2))
  const { commits, entries } = collectEntries(options.repoDir, options.limit)
  const output = options.format === 'atom'
    ? renderAtom(commits, entries)
    : renderMarkdown(entries)

  if (options.out) {
    fs.writeFileSync(options.out, output)
  } else {
    process.stdout.write(output)
  }
}

try {
  main()
} catch (error) {
  console.error(`feed changelog failed: ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
