#!/usr/bin/env node
// Rewrites the feeds-status span in README.md from the feeds themselves -
// entry counts per publisher and the newest `generated` date. Run by the
// feed-refresh workflow so the README never claims stale freshness.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const readmePath = path.join(root, 'README.md')
const feedsDir = path.join(root, 'feeds')

const feeds = fs.readdirSync(feedsDir).filter(f => f.endsWith('.json')).sort().map(f =>
  JSON.parse(fs.readFileSync(path.join(feedsDir, f), 'utf8')))

const label = p => p === 'openai' ? 'OpenAI' : p.charAt(0).toUpperCase() + p.slice(1)
const counts = feeds.map(f => `${label(f.publisher)} (${f.models.length} entries)`)
const listed = counts.length > 1
  ? `${counts.slice(0, -1).join(', ')} and ${counts.at(-1)}`
  : counts[0]
const newest = feeds.map(f => (f.generated ?? '').slice(0, 10)).sort().at(-1)

const status = `${listed}, generated from the providers' live deprecation pages plus the AWS Bedrock and Google Vertex AI lifecycle pages, feed data generated ${newest}`

const readme = fs.readFileSync(readmePath, 'utf8')
const pattern = /<!-- feeds-status -->[\s\S]*?<!-- \/feeds-status -->/
if (!pattern.test(readme)) {
  console.error('README.md is missing the feeds-status markers')
  process.exit(1)
}
const updated = readme.replace(pattern, `<!-- feeds-status -->${status}<!-- /feeds-status -->`)
if (updated !== readme) {
  fs.writeFileSync(readmePath, updated)
  console.log(`README feeds-status updated: ${status}`)
} else {
  console.log('README feeds-status already current')
}
