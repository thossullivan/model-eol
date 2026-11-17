#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { assertValidFeedSource } from '../lib/validate-document.mjs'

const FEEDS = path.join(import.meta.dirname, '..', 'feeds')
let errors = 0
const err = (file, msg) => {
  console.error(`✗ ${file}: ${msg}`)
  errors++
}

for (const fileName of fs.readdirSync(FEEDS).filter(file => file.endsWith('.json'))) {
  let feed
  let source
  try {
    source = fs.readFileSync(path.join(FEEDS, fileName), 'utf8')
    feed = JSON.parse(source)
  } catch (error) {
    err(fileName, `invalid JSON: ${error.message}`)
    continue
  }
  try {
    assertValidFeedSource(feed, source, fileName)
  } catch (error) {
    for (const line of error.message.split('\n')) {
      console.error(`✗ ${line}`)
      errors++
    }
    continue
  }
  if (!errors) console.log(`✓ ${fileName}: ${feed.models.length} entries, ${feed.publisher}`)
}

console.log(errors ? `\n${errors} validation error(s)` : 'feeds valid')
process.exit(errors ? 1 : 0)
