import { isBad } from './feeds.mjs'

export const marker = status =>
  status === 'retired' ? '✗' :
  status === 'retiring' ? '!' :
  status === 'watch' ? '?' :
  '·'

export const findingTail = (f, days) =>
  f.status === 'retired' ? `RETIRED ${f.shutdown} (${-f.days} days ago)${f.replacement ? ` -> ${f.replacement}` : ''}` :
  f.status === 'retiring' ? `RETIRES ${f.shutdown} (${f.days} days)${f.replacement ? ` -> ${f.replacement}` : ''}` :
  f.status === 'scheduled' ? `scheduled ${f.shutdown} (${f.days} days, outside --days ${days})` :
  f.status === 'watch' ? 'deprecation announced, no shutdown date yet' :
  'no retirement scheduled'

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
      via: lifecycle.via,
      days: lifecycle.days,
      replacement: lifecycle.replacement,
      source: ref.source,
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
    summary: {
      model_references: modelReferences.length,
      integration_hints: scan.integrationHints.length,
      retired_or_retiring: modelReferences.filter(isBad).length,
      cloud_or_gateway_hints: scan.integrationHints.filter(h => h.usage !== 'direct-api').length,
    },
    model_references: modelReferences,
    integration_hints: scan.integrationHints,
  }
}

export const buildSchedule = inventory => {
  const severity = { retired: 0, retiring: 1, scheduled: 2, watch: 3, ok: 4 }
  const inScope = item =>
    inventory.scope !== 'direct' || item.usage === 'direct-api' || item.usage === 'model-reference'
  const items = inventory.model_references
    .filter(item => item.status !== 'ok')
    .filter(inScope)
    .sort((a, b) =>
      (severity[a.status] ?? 9) - (severity[b.status] ?? 9) ||
      String(a.shutdown ?? '9999-99-99').localeCompare(String(b.shutdown ?? '9999-99-99')) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line
    )
  return {
    schema: 'model-eol/schedule@0.1',
    generated: inventory.generated,
    threshold_days: inventory.threshold_days,
    distributor: inventory.distributor,
    scope: inventory.scope,
    targets: inventory.targets,
    scanned_files: inventory.scanned_files,
    items,
    unresolved_integrations: inventory.integration_hints.filter(h => h.usage !== 'direct-api'),
  }
}

export const formatCheck = ({ findings, bad, scannedFiles, days, scope }) => {
  const out = []
  if (findings.length === 0) {
    out.push(`model-eol: no tracked model IDs found in ${scannedFiles} files for --scope ${scope}`)
  }
  for (const f of findings) {
    const where = `${f.file}:${f.line}`
    out.push(`${marker(f.status)} ${where}  ${f.matched}  ${findingTail(f, days)}${f.via && f.via !== 'publisher' ? `  [via ${f.via}]` : ''}`)
  }
  if (bad.length) out.push(`\nmodel-eol: ${bad.length} finding(s) at or past the ${days}-day threshold`)
  return out.join('\n')
}

export const formatInventory = (inventory, days) => {
  const out = [`model-eol inventory: ${inventory.summary.model_references} tracked model reference(s), ${inventory.summary.integration_hints} integration hint(s) across ${inventory.scanned_files} files`]
  if (inventory.model_references.length) {
    out.push('\nModel references')
    for (const item of inventory.model_references) {
      out.push(`${marker(item.status)} ${item.file}:${item.line}  ${item.matched}  ${item.publisher}/${item.id}  ${item.usage}  ${findingTail(item, days)}`)
    }
  }
  if (inventory.integration_hints.length) {
    out.push('\nIntegration hints')
    for (const h of inventory.integration_hints) {
      const note = h.usage === 'direct-api' ? 'direct API signal' : 'resolver needed for exact deployed model'
      out.push(`? ${h.file}:${h.line}  ${h.provider}  ${h.evidence}  (${note})`)
    }
  }
  return out.join('\n')
}

export const formatSchedule = (schedule, days) => {
  const out = [`model-eol schedule: ${schedule.items.length} scheduled/watch finding(s), ${schedule.unresolved_integrations.length} unresolved cloud/gateway hint(s)`]
  for (const item of schedule.items) {
    out.push(`${marker(item.status)} ${item.shutdown ?? 'TBD'}  ${item.file}:${item.line}  ${item.matched}  ${findingTail(item, days)}  [${item.usage}]`)
  }
  if (schedule.unresolved_integrations.length) {
    out.push('\nUnresolved cloud/gateway references')
    for (const h of schedule.unresolved_integrations) {
      out.push(`? ${h.file}:${h.line}  ${h.provider}  ${h.evidence}  (needs provider/gateway resolver)`)
    }
  }
  return out.join('\n')
}
