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

const requestedVia = (finding, fallback) => Object.hasOwn(finding, 'requested_via')
  ? finding.requested_via
  : fallback

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
  requested_via: requestedVia(finding, via),
  threshold_days: finding.threshold_days,
  effective_scope: finding.effective_scope,
  ...(finding.policy_provenance ? { policy_provenance: finding.policy_provenance } : {}),
  ...(ref.mapped_from ? { mapped_from: ref.mapped_from } : {}),
  days: finding.days,
  replacement: finding.replacement,
  ...(finding.replacement_options?.length ? { replacement_options: finding.replacement_options } : {}),
  ...(finding.replacement_note ? { replacement_note: finding.replacement_note } : {}),
  waiver: finding.waiver ?? null,
  reason,
  sources: sourceList(ref, finding, via),
  notes: notesFor(ref),
})

const scopeIncludes = (ref, scope, finding = null) =>
  (finding?.effective_scope ?? scope) !== 'direct' || ref.usage === 'direct-api' || ref.usage === 'model-reference'

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
    const finding = findings[index]
    if (!scopeIncludes(ref, scope, finding)) return
    if (!finding || finding.status === 'ok') return
    const effectiveVia = requestedVia(finding, via)
    const effectiveDays = finding.threshold_days ?? days

    if (finding.waiver?.active) {
      issues.push(issueFor(ref, finding, 'waived', effectiveVia))
      return
    }

    let reason
    if (finding.status === 'watch') reason = 'watch'
    else if (finding.status !== 'retired' && finding.status !== 'retiring') reason = 'outside-threshold'
    else if (!finding.shutdown) reason = 'shutdown-date-unavailable'
    else if (finding.via === 'publisher-fallback') reason = 'publisher-fallback'
    else if (ref.usage !== 'direct-api' || ref.confidence !== 'high') reason = 'not-direct-api'
    else if (!finding.replacement && finding.replacement_options?.length) reason = 'replacement-choice'
    else if (!finding.replacement) reason = 'no-replacement'
    else {
      const replacementRecord = entries.get(finding.replacement)
      if (!replacementRecord || replacementRecord.publisher !== finding.publisher) reason = 'replacement-unresolved'
      else {
        const replacementLifecycle = lifecycleFor(replacementRecord.entry, { days: effectiveDays, via: effectiveVia })
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
      issues.push(issueFor(ref, finding, reason, effectiveVia))
      return
    }

    const occurrence = Number.isInteger(ref.occurrence)
      ? ref.occurrence
      : occurrenceInLine(line, ref.matched, line.indexOf(ref.matched))
    if (line.indexOf(ref.matched) === -1) {
      issues.push(issueFor(ref, finding, 'match-unavailable', effectiveVia))
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
      requested_via: effectiveVia,
      threshold_days: effectiveDays,
      effective_scope: finding.effective_scope ?? scope,
      ...(finding.policy_provenance ? { policy_provenance: finding.policy_provenance } : {}),
      ...(ref.mapped_from ? { mapped_from: ref.mapped_from } : {}),
      waiver: finding.waiver ?? null,
      sources: sourceList(ref, finding, effectiveVia),
      notes: notesFor(ref),
    })
  })

  for (const candidate of scan.candidateRefs) {
    if ((candidate.effective_scope ?? scope) === 'direct' && candidate.usage !== 'direct-api' && candidate.usage !== 'model-reference') continue
    issues.push({
      file: candidate.file,
      line: candidate.line,
      matched: candidate.matched,
      usage: candidate.usage,
      confidence: candidate.confidence,
      effective_scope: candidate.effective_scope ?? scope,
      ...(candidate.policy_provenance ? { policy_provenance: candidate.policy_provenance } : {}),
      waiver: null,
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
      waiver: null,
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
