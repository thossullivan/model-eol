import crypto from 'node:crypto'
import fs from 'node:fs'

import { isBad, lifecycleFor } from './feeds.mjs'

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

const sourceList = (ref, finding, via) => {
  const sources = []
  if (ref.source) sources.push(ref.source)
  const distribution = via
    ? (ref.entry.distributions ?? []).find(d => d.via === via)
    : null
  if (finding.via === via && distribution?.source) sources.push(distribution.source)
  return [...new Set(sources)]
}

const readLines = (file, cache) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8').split('\n'))
  return cache.get(file)
}

const notesFor = ref => [ref.feedNote, ref.entry.notes].filter(Boolean).join(' - ') || null

const issueFor = (ref, finding, reason, via) => ({
  file: ref.file,
  line: ref.line,
  matched: ref.matched,
  id: ref.id,
  publisher: ref.publisher,
  usage: ref.usage,
  confidence: ref.confidence,
  status: finding.status,
  shutdown: finding.shutdown,
  via: finding.via,
  days: finding.days,
  replacement: finding.replacement,
  reason,
  sources: sourceList(ref, finding, via),
  notes: notesFor(ref),
})

const scopeIncludes = (ref, scope) =>
  scope !== 'direct' || ref.usage === 'direct-api' || ref.usage === 'model-reference'

const occurrenceInLine = (line, matched, index) => {
  let occurrence = 0
  let cursor = 0
  while (true) {
    const found = line.indexOf(matched, cursor)
    if (found === -1 || found >= index) return occurrence
    occurrence++
    cursor = found + matched.length
  }
}

export const buildPlan = ({ scan, findings, entries, days, via, scope }) => {
  const items = []
  const issues = []
  const lineCache = new Map()

  scan.modelRefs.forEach((ref, index) => {
    if (!scopeIncludes(ref, scope)) return
    const finding = findings[index]
    if (!finding || finding.status === 'ok') return

    let reason
    if (finding.status === 'watch') reason = 'watch'
    else if (finding.status !== 'retired' && finding.status !== 'retiring') reason = 'outside-threshold'
    else if (finding.via === 'publisher-fallback') reason = 'publisher-fallback'
    else if (ref.usage !== 'direct-api' || ref.confidence !== 'high') reason = 'not-direct-api'
    else if (!finding.replacement) reason = 'no-replacement'
    else {
      const replacementRecord = entries.get(finding.replacement)
      if (!replacementRecord) reason = 'replacement-unresolved'
      else {
        const replacementLifecycle = lifecycleFor(replacementRecord.entry, { days, via })
        if (isBad(replacementLifecycle)) reason = 'replacement-retiring'
      }
    }

    let lines
    try {
      lines = readLines(ref.file, lineCache)
    } catch (e) {
      reason = reason ?? 'unreadable-file'
    }
    const line = lines?.[ref.line - 1]
    if (line === undefined) reason = reason ?? 'line-unavailable'

    if (reason) {
      issues.push(issueFor(ref, finding, reason, via))
      return
    }

    const occurrence = Number.isInteger(ref.occurrence)
      ? ref.occurrence
      : occurrenceInLine(line, ref.matched, line.indexOf(ref.matched))
    if (line.indexOf(ref.matched) === -1) {
      issues.push(issueFor(ref, finding, 'match-unavailable', via))
      return
    }

    items.push({
      file: ref.file,
      line: ref.line,
      occurrence,
      matched: ref.matched,
      expected_line_sha256: sha256(line),
      id: ref.id,
      publisher: ref.publisher,
      replacement: finding.replacement,
      shutdown: finding.shutdown,
      days: finding.days,
      status: finding.status,
      sources: sourceList(ref, finding, via),
      notes: notesFor(ref),
    })
  })

  for (const candidate of scan.candidateRefs) {
    if (scope === 'direct' && candidate.usage !== 'direct-api' && candidate.usage !== 'model-reference') continue
    issues.push({
      file: candidate.file,
      line: candidate.line,
      matched: candidate.matched,
      usage: candidate.usage,
      confidence: candidate.confidence,
      reason: 'candidate',
      notes: candidate.reason,
    })
  }

  for (const hint of scan.integrationHints) {
    if (hint.usage === 'direct-api') continue
    issues.push({
      file: hint.file,
      line: hint.line,
      matched: hint.matched,
      usage: hint.usage,
      provider: hint.provider,
      reason: 'unresolved-channel',
      notes: hint.evidence,
    })
  }

  return {
    plan_schema: 'model-eol.plan/0.1',
    generated: new Date().toISOString(),
    threshold_days: days,
    via,
    scan_notes: scan.notes,
    items,
    issues,
  }
}
