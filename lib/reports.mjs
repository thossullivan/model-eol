import { isBad } from './feeds.mjs'
import { color } from './color.mjs'
import { incompleteScanNotes } from './scanner.mjs'

export const marker = status =>
  status === 'retired' ? '✗' :
  status === 'retiring' ? '!' :
  status === 'watch' ? '?' :
  '·'

const shutdownText = finding => finding.date_precision === 'earliest'
  ? `no earlier than ${finding.shutdown}`
  : finding.shutdown

const replacementTail = finding => finding.replacement
  ? ` -> ${finding.replacement}`
  : finding.replacement_options?.length
    ? ` options: ${finding.replacement_options.join(' | ')}`
    : ''

export const findingTail = (f, days) =>
  f.status === 'retired' && !f.shutdown ? `RETIRED (shutdown date unavailable)${replacementTail(f)}` :
  f.status === 'retired' ? `RETIRED ${shutdownText(f)} (${-f.days} days ago)${replacementTail(f)}` :
  f.status === 'retiring' ? `RETIRES ${shutdownText(f)} (${f.days} days)${replacementTail(f)}` :
  f.status === 'scheduled' ? `scheduled ${shutdownText(f)} (${f.days} days, outside --days ${f.threshold_days ?? days})` :
  f.status === 'watch' ? 'deprecation announced, no shutdown date yet' :
  'no retirement scheduled'

const statusStyle = status =>
  status === 'retired' ? 'red' :
  status === 'retiring' ? 'yellow' :
  status === 'ok' ? 'dim' :
  null

const humanFinding = (status, line) => {
  const style = statusStyle(status)
  return style ? color(style, line) : line
}

export const buildInventory = ({ scan, findings, days, via, scope, targets }) => {
  const byKey = new Map(findings.map(f => [`${f.file}:${f.line}:${f.matched}`, f]))
  const modelReferences = scan.modelRefs.map(ref => {
    const lifecycle = byKey.get(`${ref.file}:${ref.line}:${ref.matched}`)
    return {
      kind: ref.kind,
      file: ref.file,
      line: ref.line,
      matched: ref.matched,
      id: ref.id,
      publisher: ref.publisher,
      usage: ref.usage,
      resolved_provider: ref.resolved_provider,
      confidence: ref.confidence,
      evidence: ref.evidence,
      status: lifecycle.status,
      shutdown: lifecycle.shutdown,
      date_precision: lifecycle.date_precision,
      distribution_status: lifecycle.distribution_status,
      via: lifecycle.via,
      requested_via: lifecycle.requested_via,
      days: lifecycle.days,
      threshold_days: lifecycle.threshold_days,
      effective_scope: lifecycle.effective_scope,
      ...(lifecycle.policy_provenance ? { policy_provenance: lifecycle.policy_provenance } : {}),
      ...(ref.mapped_from ? { mapped_from: ref.mapped_from } : {}),
      safe_until: lifecycle.safe_until,
      replacement: lifecycle.replacement,
      source: ref.source,
      policy: ref.policy ?? null,
      feed_generated: ref.generated ?? null,
    }
  })
  return {
    schema: 'model-eol/inventory@0.1',
    generated: new Date().toISOString(),
    threshold_days: days,
    distributor: via,
    scope,
    targets,
    scanned_files: scan.files.length,
    scan_notes: scan.notes ?? [],
    summary: {
      model_references: modelReferences.length,
      candidate_model_references: scan.candidateRefs.length,
      integration_hints: scan.integrationHints.length,
      retired_or_retiring: modelReferences.filter(isBad).length,
      cloud_or_gateway_hints: scan.integrationHints.filter(h => h.usage !== 'direct-api').length,
    },
    model_references: modelReferences,
    candidate_model_references: scan.candidateRefs,
    integration_hints: scan.integrationHints,
  }
}

export const buildSchedule = inventory => {
  const severity = { retired: 0, retiring: 1, scheduled: 2, watch: 3, ok: 4 }
  const inScope = item =>
    (item.effective_scope ?? inventory.scope) !== 'direct' || item.usage === 'direct-api' || item.usage === 'model-reference'
  const items = inventory.model_references
    .filter(item => item.status !== 'ok')
    .filter(inScope)
    .sort((a, b) =>
      (severity[a.status] ?? 9) - (severity[b.status] ?? 9) ||
      String(a.shutdown ?? '9999-99-99').localeCompare(String(b.shutdown ?? '9999-99-99')) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    )
  const earliest = inventory.model_references
    .filter(inScope)
    .filter(item => item.safe_until)
    .sort((a, b) =>
      a.safe_until.localeCompare(b.safe_until) ||
      a.id.localeCompare(b.id) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    )[0]
  const policyGuarantees = [...new Map(inventory.model_references
    .filter(inScope)
    .filter(item => item.status === 'ok' && item.safe_until && item.policy && item.feed_generated)
    .map(item => [`${item.publisher}:${item.id}`, item]))
    .values()]
    .sort((a, b) =>
      a.safe_until.localeCompare(b.safe_until) ||
      a.id.localeCompare(b.id) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    )
  const result = {
    schema: 'model-eol/schedule@0.1',
    generated: inventory.generated,
    threshold_days: inventory.threshold_days,
    distributor: inventory.distributor,
    scope: inventory.scope,
    targets: inventory.targets,
    scanned_files: inventory.scanned_files,
    scan_notes: inventory.scan_notes ?? [],
    earliest_risk: earliest ? { safe_until: earliest.safe_until, id: earliest.id } : null,
    items,
    candidate_model_references: inventory.candidate_model_references,
    unresolved_integrations: inventory.integration_hints.filter(h => h.usage !== 'direct-api'),
  }
  Object.defineProperty(result, '_policy_guarantees', {
    value: policyGuarantees,
    enumerable: false,
  })
  return result
}

export const buildAlert = schedule => {
  const errors = schedule.items.filter(item => item.status === 'retired' || item.status === 'retiring')
  const warnings = [
    ...schedule.items.filter(item => item.status === 'scheduled' || item.status === 'watch'),
    ...schedule.candidate_model_references.map(item => ({ ...item, status: 'unknown' })),
    ...schedule.unresolved_integrations.map(item => ({ ...item, status: 'unresolved' })),
  ]
  return {
    schema: 'model-eol/alert@0.1',
    generated: schedule.generated,
    threshold_days: schedule.threshold_days,
    distributor: schedule.distributor,
    scope: schedule.scope,
    scan_notes: schedule.scan_notes ?? [],
    errors,
    warnings,
  }
}

export const formatCheck = ({ findings, bad, scannedFiles, days, scope }) => {
  const out = []
  if (findings.length === 0) {
    out.push(color('bold', `model-eol: no tracked model IDs found in ${scannedFiles} files for --scope ${scope}`))
  }
  for (const f of findings) {
    const where = `${f.file}:${f.line}`
    out.push(humanFinding(f.status, `${marker(f.status)} ${where}  ${f.matched}  ${findingTail(f, days)}${f.via && f.via !== 'publisher' ? `  [via ${f.via}]` : ''}`))
  }
  if (bad.length) out.push(`\n${color('bold', `model-eol: ${bad.length} finding(s) at or past the ${days}-day threshold`)}`)
  return out.join('\n')
}

export const formatInventory = (inventory, days) => {
  const out = [color('bold', `model-eol inventory: ${inventory.summary.model_references} tracked model reference(s), ${inventory.summary.candidate_model_references} candidate(s), ${inventory.summary.integration_hints} integration hint(s) across ${inventory.scanned_files} files`)]
  const incompleteNotes = incompleteScanNotes(inventory.scan_notes ?? [])
  if (incompleteNotes.length) out.push(`WARNING: scan incomplete; ${incompleteNotes.length} coverage-loss note(s) recorded`)
  if (inventory.model_references.length) {
    out.push('\nModel references')
    for (const item of inventory.model_references) {
      out.push(humanFinding(item.status, `${marker(item.status)} ${item.file}:${item.line}  ${item.matched}  ${item.publisher}/${item.id}  ${item.usage}  ${findingTail(item, days)}`))
    }
  }
  if (inventory.candidate_model_references.length) {
    out.push('\nCandidate model references')
    for (const item of inventory.candidate_model_references) {
      out.push(`? ${item.file}:${item.line}  ${item.matched}  ${item.usage}  ${item.reason}`)
    }
  }
  if (inventory.integration_hints.length) {
    out.push('\nIntegration hints')
    for (const h of inventory.integration_hints) {
      const note = h.usage === 'direct-api' ? 'direct API signal' : 'resolver needed for exact deployed model'
      out.push(color('dim', `? ${h.file}:${h.line}  ${h.provider}  ${h.evidence}  (${note})`))
    }
  }
  return out.join('\n')
}

export const formatSchedule = (schedule, days) => {
  const out = [color('bold', `model-eol schedule: ${schedule.items.length} scheduled/watch finding(s), ${schedule.candidate_model_references.length} candidate(s), ${schedule.unresolved_integrations.length} unresolved cloud/gateway hint(s)`)]
  const incompleteNotes = incompleteScanNotes(schedule.scan_notes ?? [])
  if (incompleteNotes.length) out.push(`WARNING: scan incomplete; ${incompleteNotes.length} coverage-loss note(s) recorded`)
  for (const item of schedule.items) {
    const safeUntil = item.safe_until ? `  [safe until ${item.safe_until}]` : ''
    out.push(humanFinding(item.status, `${marker(item.status)} ${item.shutdown ? shutdownText(item) : 'TBD'}  ${item.file}:${item.line}  ${item.matched}  ${findingTail(item, days)}  [${item.usage}]${safeUntil}`))
  }
  if (schedule.unresolved_integrations.length) {
    out.push('\nUnresolved cloud/gateway references')
    for (const h of schedule.unresolved_integrations) {
      out.push(color('dim', `? ${h.file}:${h.line}  ${h.provider}  ${h.evidence}  (needs provider/gateway resolver)`))
    }
  }
  for (const item of schedule._policy_guarantees ?? []) {
    const feedGenerated = String(item.feed_generated).slice(0, 10)
    out.push(`guaranteed until ${item.safe_until} per ${item.publisher} stated policy (>=${item.policy.min_notice_days}d notice, feed generated ${feedGenerated})`)
  }
  out.push(color('bold', schedule.earliest_risk
    ? `earliest risk: ${schedule.earliest_risk.safe_until} (${schedule.earliest_risk.id})`
    : 'earliest risk: none'))
  return out.join('\n')
}

export const formatInventoryCycloneDX = inventory => {
  const components = new Map()
  for (const item of inventory.model_references) {
    let component = components.get(item.id)
    if (!component) {
      component = {
        type: 'machine-learning-model',
        name: item.id,
        group: item.publisher,
        properties: [
          { name: 'model-eol:status', value: String(item.status) },
          { name: 'model-eol:shutdown', value: item.shutdown ?? '' },
          { name: 'model-eol:replacement', value: item.replacement ?? '' },
          { name: 'model-eol:usage', value: item.usage },
        ],
        evidence: { occurrences: [] },
      }
      components.set(item.id, component)
    }
    const usage = component.properties.find(property => property.name === 'model-eol:usage')
    const usages = new Set(usage.value ? usage.value.split(',') : [])
    usages.add(item.usage)
    usage.value = [...usages].sort().join(',')
    component.evidence.occurrences.push({ location: `${item.file}#${item.line}` })
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: inventory.generated,
      properties: [
        { name: 'model-eol:generator', value: 'model-eol/inventory-cyclonedx@0.1' },
      ],
    },
    components: [...components.values()],
  }
}

const annotationEscape = value => String(value)
  .replaceAll('%', '%25')
  .replaceAll('\r', '%0D')
  .replaceAll('\n', '%0A')
  .replaceAll(':', '%3A')
  .replaceAll(',', '%2C')

export const formatAlertGithub = (alert, days) => {
  const out = []
  const incompleteNotes = incompleteScanNotes(alert.scan_notes ?? [])
  if (incompleteNotes.length) out.push(`::warning title=${annotationEscape('model-eol scan')}::${annotationEscape(`Scan incomplete; ${incompleteNotes.length} coverage-loss note(s) recorded`)}`)
  for (const item of alert.errors) {
    const title = `model-eol ${item.status}: ${item.matched}`
    out.push(`::error file=${annotationEscape(item.file)},line=${item.line},title=${annotationEscape(title)}::${annotationEscape(findingTail(item, days))}`)
  }
  for (const item of alert.warnings) {
    const title = item.kind === 'integration-hint'
      ? `model-eol unresolved ${item.provider}`
      : `model-eol ${item.status}: ${item.matched ?? item.provider}`
    const message = item.kind === 'integration-hint'
      ? `${item.evidence}; provider/gateway resolver needed`
      : item.status === 'unknown'
        ? `${item.matched} is model-like but not present in loaded feeds`
        : findingTail(item, days)
    out.push(`::warning file=${annotationEscape(item.file)},line=${item.line},title=${annotationEscape(title)}::${annotationEscape(message)}`)
  }
  if (!out.length) out.push('model-eol alert: no findings')
  return out.join('\n')
}

export const formatAlertMarkdown = (alert, days) => {
  const out = ['# model-eol alert', '']
  const incompleteNotes = incompleteScanNotes(alert.scan_notes ?? [])
  if (incompleteNotes.length) out.push(`> Warning: scan incomplete; ${incompleteNotes.length} coverage-loss note(s) recorded.`, '')
  out.push(`- Errors: ${alert.errors.length}`)
  out.push(`- Warnings: ${alert.warnings.length}`)
  if (alert.errors.length) {
    out.push('', '## Errors')
    for (const item of alert.errors) {
      out.push(`- ${item.file}:${item.line} \`${item.matched}\` - ${findingTail(item, days)}`)
    }
  }
  if (alert.warnings.length) {
    out.push('', '## Warnings')
    for (const item of alert.warnings) {
      const label = item.matched ?? item.provider
      const detail = item.kind === 'integration-hint'
        ? `${item.evidence}; resolver needed`
        : item.status === 'unknown'
          ? item.reason
          : findingTail(item, days)
      out.push(`- ${item.file}:${item.line} \`${label}\` - ${detail}`)
    }
  }
  return out.join('\n')
}

export const formatAlertBadge = alert => {
  const retired = alert.errors.filter(item => item.status === 'retired').length
  const retiring = alert.errors.filter(item => item.status === 'retiring').length
  const parts = []
  if (retired) parts.push(`${retired} retired`)
  if (retiring) parts.push(`${retiring} retiring`)
  return {
    schemaVersion: 1,
    label: 'model-eol',
    message: parts.length ? parts.join(' · ') : 'clear',
    color: retired ? 'red' : retiring ? 'orange' : 'brightgreen',
  }
}
