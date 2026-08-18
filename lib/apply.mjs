import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { assertValidPlanDocument, readJsonDocument, validatePlanItems } from './validate-document.mjs'

export { validatePlanItems }

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const occurrenceIndex = (line, value, occurrence) => {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1
  let cursor = 0
  for (let i = 0; i <= occurrence; i++) {
    const index = line.indexOf(value, cursor)
    if (index === -1) return -1
    if (i === occurrence) return index
    cursor = index + value.length
  }
  return -1
}

const itemLabel = item => `${item.file}:${item.line}`

const printError = (item, message) => {
  console.error(`model-eol: apply refused ${itemLabel(item)}: ${message}`)
}

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

const resolvePlanFile = (rootDir, file) => {
  const lexicalRoot = path.resolve(rootDir)
  if (file.split(/[\\/]/).includes('..')) throw new Error('file path contains .. traversal')
  const resolved = path.resolve(lexicalRoot, file)
  if (isInside(lexicalRoot, resolved)) return resolved
  if (!path.isAbsolute(file)) throw new Error('file resolves outside rootDir')

  // Remap only system-level root aliases such as macOS /var -> /private/var.
  const physicalRoot = fs.realpathSync(lexicalRoot)
  let candidateRoot = path.dirname(resolved)
  while (true) {
    try {
      if (fs.realpathSync(candidateRoot) === physicalRoot) {
        const relative = path.relative(candidateRoot, resolved)
        const remapped = path.resolve(lexicalRoot, relative)
        if (isInside(lexicalRoot, remapped)) return remapped
      }
    } catch {
    }
    const parent = path.dirname(candidateRoot)
    if (parent === candidateRoot) break
    candidateRoot = parent
  }
  throw new Error('file resolves outside rootDir')
}

const assertSafePath = (rootDir, file) => {
  const root = path.resolve(rootDir)
  if (!isInside(root, file)) throw new Error('file resolves outside rootDir')

  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink()) throw new Error(`file path contains symlink component: ${root}`)
  if (!rootStat.isDirectory()) throw new Error(`rootDir is not a directory: ${root}`)

  const relative = path.relative(root, file)
  const components = relative === '' ? [] : relative.split(path.sep)
  let current = root
  let currentStat = rootStat
  for (const [index, component] of components.entries()) {
    current = path.join(current, component)
    currentStat = fs.lstatSync(current)
    if (currentStat.isSymbolicLink()) throw new Error(`file path contains symlink component: ${current}`)
    if (index < components.length - 1 && !currentStat.isDirectory()) {
      throw new Error(`parent path component is not a directory: ${current}`)
    }
  }
  if (!currentStat.isFile()) throw new Error(`target is not a regular file: ${file}`)
  return currentStat
}

const readTarget = (rootDir, file) => {
  assertSafePath(rootDir, file)
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let descriptor
  let stat
  let buffer
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
    stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`target is not a regular file: ${file}`)
    buffer = fs.readFileSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }

  const pathStat = assertSafePath(rootDir, file)
  if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
    throw new Error(`target changed while it was being read: ${file}`)
  }
  let text
  try {
    text = utf8Decoder.decode(buffer)
  } catch {
    throw new Error(`target is not valid UTF-8: ${file}`)
  }
  return {
    buffer,
    text,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o7777,
  }
}

const groupItems = items => {
  const groups = new Map()
  for (const item of items) {
    const file = item.resolvedFile ?? item.file
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(item)
  }
  return groups
}

const groupItemsByLine = items => {
  const groups = new Map()
  for (const item of items) {
    if (!groups.has(item.line)) groups.set(item.line, [])
    groups.get(item.line).push(item)
  }
  return groups
}

const MAX_RESTORE_ITEMS = 16
const MAX_RESTORE_STATES = 10000

const locateOccurrences = (line, items) => {
  const locations = []
  const failures = []
  for (const item of items) {
    const index = occurrenceIndex(line, item.matched, item.occurrence)
    if (index === -1) {
      failures.push({ item, message: 'expected occurrence of matched text is missing' })
      continue
    }
    locations.push({ item, index })
  }
  return { locations, failures }
}

const locateReplacements = (line, items) => {
  const located = locateOccurrences(line, items)
  if (located.failures.length) return located
  const failures = []
  const locations = []
  for (const location of located.locations) {
    const end = location.index + location.item.matched.length
    const conflict = locations.find(existing => (
      location.index < existing.index + existing.item.matched.length &&
      existing.index < end
    ))
    if (conflict) {
      const message = conflict.index === location.index
        ? 'duplicate occurrence in plan'
        : 'replacement span overlaps another plan item'
      failures.push({ item: location.item, message })
      continue
    }
    locations.push(location)
  }
  return { locations, failures }
}

const applyLocatedReplacements = (line, locations) => {
  let updated = line
  for (const { item, index } of locations.toSorted((a, b) => b.index - a.index)) {
    updated = updated.slice(0, index) + item.replacement + updated.slice(index + item.matched.length)
  }
  return updated
}

const hasExpectedPreImage = (line, items) => {
  const expected = items[0].expected_line_sha256
  return items.every(item => item.expected_line_sha256 === expected) && sha256(line) === expected
}

const restoreGroup = (postImage, items) => {
  const expected = items[0].expected_line_sha256
  if (!items.every(item => item.expected_line_sha256 === expected)) return null
  if (items.length > MAX_RESTORE_ITEMS) return null

  const descriptors = items.map((item, planIndex) => ({ item, planIndex }))
  const visited = new Set()
  const search = (line, remaining) => {
    if (visited.size >= MAX_RESTORE_STATES) return null
    const state = `${remaining.map(({ planIndex }) => planIndex).join(',')}\u0000${line}`
    if (visited.has(state)) return null
    visited.add(state)

    if (remaining.length === 0) {
      if (sha256(line) !== expected) return null
      const located = locateReplacements(line, items)
      if (located.failures.length) return null
      return applyLocatedReplacements(line, located.locations) === postImage ? line : null
    }

    for (const [remainingIndex, { item }] of remaining.entries()) {
      let cursor = 0
      while (true) {
        const index = line.indexOf(item.replacement, cursor)
        if (index === -1) break
        const restored = line.slice(0, index) + item.matched + line.slice(index + item.replacement.length)
        const next = remaining.slice(0, remainingIndex).concat(remaining.slice(remainingIndex + 1))
        const result = search(restored, next)
        if (result !== null) return result
        cursor = index + item.replacement.length
      }
    }
    return null
  }

  return search(postImage, descriptors)
}

const temporaryFileFor = (file, purpose) => path.join(
  path.dirname(file),
  `.model-eol-${path.basename(file)}-${process.pid}-${purpose}-${crypto.randomBytes(12).toString('hex')}.tmp`,
)

const sortedItems = items => items.toSorted((a, b) => a.planIndex - b.planIndex)

const analyzeFile = (file, items, snapshot) => {
  const lines = snapshot.text.split('\n')
  const ready = []
  const already = []
  const failures = []
  const readyGroups = []

  for (const [lineNumber, lineItems] of groupItemsByLine(items)) {
    const line = lines[lineNumber - 1]
    if (line === undefined) {
      for (const item of lineItems) failures.push({ item, message: 'line is not present' })
      continue
    }

    if (lineItems.length > MAX_RESTORE_ITEMS) {
      for (const item of lineItems) failures.push({ item, message: 'line hash does not match expected_line_sha256' })
      continue
    }

    if (hasExpectedPreImage(line, lineItems)) {
      const located = locateReplacements(line, lineItems)
      failures.push(...located.failures)
      for (const location of located.locations) {
        ready.push(location.item)
      }
      readyGroups.push({
        lineNumber,
        items: located.locations.map(location => location.item),
        locations: located.locations,
      })
      continue
    }

    if (restoreGroup(line, lineItems) !== null) already.push(...lineItems)
    else {
      for (const item of lineItems) failures.push({ item, message: 'line hash does not match expected_line_sha256' })
    }
  }

  const updatedLines = lines.slice()
  for (const { lineNumber, locations } of readyGroups) {
    updatedLines[lineNumber - 1] = applyLocatedReplacements(lines[lineNumber - 1], locations)
  }

  return {
    file,
    items,
    snapshot,
    ready: sortedItems(ready),
    already: sortedItems(already),
    failures,
    updatedContent: updatedLines.join('\n'),
  }
}

const inspectFiles = (rootDir, prepared) => {
  const analyses = []
  const failures = []
  for (const [file, items] of groupItems(prepared)) {
    try {
      const analysis = analyzeFile(file, items, readTarget(rootDir, file))
      analyses.push(analysis)
      failures.push(...analysis.failures)
    } catch (error) {
      for (const item of items) failures.push({ item, message: `unreadable file: ${error.message}` })
    }
  }
  return { analyses, failures }
}

const uniqueFailures = failures => {
  const seen = new Set()
  return failures
    .toSorted((a, b) => a.item.planIndex - b.item.planIndex)
    .filter(failure => {
      if (seen.has(failure.item)) return false
      seen.add(failure.item)
      return true
    })
}

const reportAlready = (analyses, excluded = new Set()) => {
  let alreadyApplied = 0
  const items = sortedItems(analyses.flatMap(analysis => analysis.already))
  for (const item of items) {
    if (excluded.has(item)) continue
    console.log(`already-applied ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
    alreadyApplied++
  }
  return alreadyApplied
}

const reportRefusal = (analyses, failures, cascadeMessage) => {
  const specific = uniqueFailures(failures)
  const refused = new Set(specific.map(failure => failure.item))
  for (const failure of specific) printError(failure.item, failure.message)

  let failed = specific.length
  const ready = sortedItems(analyses.flatMap(analysis => analysis.ready))
  for (const item of ready) {
    if (refused.has(item)) continue
    printError(item, cascadeMessage)
    refused.add(item)
    failed++
  }
  const alreadyApplied = reportAlready(analyses, refused)
  return { failed, applied: 0, alreadyApplied }
}

const snapshotsMatch = (left, right) => (
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.buffer.equals(right.buffer)
)

const verifySnapshots = (rootDir, analyses) => {
  const failures = []
  for (const analysis of analyses) {
    try {
      const latest = readTarget(rootDir, analysis.file)
      if (!snapshotsMatch(latest, analysis.snapshot)) {
        for (const item of analysis.items) failures.push({ item, message: 'target changed after validation' })
      }
    } catch (error) {
      for (const item of analysis.items) failures.push({ item, message: `write failed: ${error.message}` })
    }
  }
  return failures
}

const writeStagedFile = (file, content, mode, created) => {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  )
  created.push(file)
  try {
    fs.writeFileSync(descriptor, content)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.chmodSync(file, mode)
}

const removeTemporaryFiles = (temporaryFiles, unlinkSync) => {
  const failures = []
  for (const temporaryFile of temporaryFiles) {
    if (!temporaryFile) continue
    try {
      unlinkSync(temporaryFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push({ temporaryFile, error })
    }
  }
  return failures
}

const cleanupFailureDetail = failures => failures.length
  ? `; temporary cleanup failed (${failures.map(({ temporaryFile, error }) => `${temporaryFile}: ${error.message}`).join('; ')})`
  : ''

const reportCleanupFailures = failures => {
  for (const { temporaryFile, error } of failures) {
    console.error(`model-eol: apply cleanup failed ${temporaryFile}: ${error.message}`)
  }
}

const stageAnalysis = (rootDir, analysis, unlinkSync) => {
  assertSafePath(rootDir, analysis.file)
  const nextPath = temporaryFileFor(analysis.file, 'next')
  const backupPath = temporaryFileFor(analysis.file, 'backup')
  const created = []
  try {
    writeStagedFile(nextPath, Buffer.from(analysis.updatedContent, 'utf8'), analysis.snapshot.mode, created)
    writeStagedFile(backupPath, analysis.snapshot.buffer, analysis.snapshot.mode, created)
    return { analysis, nextPath, backupPath, keepBackup: false }
  } catch (error) {
    const cleanupFailures = removeTemporaryFiles(created, unlinkSync)
    throw new Error(`${error.message}${cleanupFailureDetail(cleanupFailures)}`)
  }
}

const cleanupStages = (stages, unlinkSync) => removeTemporaryFiles(
  stages.flatMap(stage => [stage.nextPath, stage.keepBackup ? null : stage.backupPath]),
  unlinkSync,
)

export const applyPlan = ({ planPath, dryRun = false, rootDir, _test } = {}) => {
  if (typeof rootDir !== 'string' || rootDir.length === 0) throw new Error('applyPlan requires rootDir')
  const plan = readJsonDocument(planPath)
  assertValidPlanDocument(plan)

  const prepared = []
  const pathFailures = []
  for (const [planIndex, item] of plan.items.entries()) {
    try {
      prepared.push({ ...item, planIndex, resolvedFile: resolvePlanFile(rootDir, item.file) })
    } catch (error) {
      pathFailures.push({ item: { ...item, planIndex }, message: error.message })
    }
  }

  const initial = inspectFiles(rootDir, prepared)
  const initialFailures = pathFailures.concat(initial.failures)
  if (initialFailures.length) {
    return reportRefusal(
      initial.analyses,
      initialFailures,
      'another item in this plan failed validation; no files were changed',
    )
  }

  const initiallyReady = initial.analyses.flatMap(analysis => analysis.ready)
  if (dryRun) {
    const alreadyApplied = reportAlready(initial.analyses)
    for (const item of sortedItems(initiallyReady)) {
      console.log(`would change ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
    }
    return { failed: 0, applied: 0, alreadyApplied }
  }
  if (!initiallyReady.length) {
    return { failed: 0, applied: 0, alreadyApplied: reportAlready(initial.analyses) }
  }

  // Re-read every plan target together before staging output.
  const current = inspectFiles(rootDir, prepared)
  if (current.failures.length) {
    return reportRefusal(
      current.analyses,
      current.failures,
      'another item in this plan failed revalidation; no files were changed',
    )
  }

  const currentReady = current.analyses.flatMap(analysis => analysis.ready)
  if (!currentReady.length) {
    return { failed: 0, applied: 0, alreadyApplied: reportAlready(current.analyses) }
  }

  const unlinkSync = typeof _test?.unlinkSync === 'function'
    ? temporaryFile => _test.unlinkSync(temporaryFile)
    : temporaryFile => fs.unlinkSync(temporaryFile)

  const stages = []
  let stagingFailure = null
  for (const analysis of current.analyses) {
    if (!analysis.ready.length) continue
    try {
      stages.push(stageAnalysis(rootDir, analysis, unlinkSync))
    } catch (error) {
      stagingFailure = { analysis, error }
      break
    }
  }
  if (stagingFailure) {
    reportCleanupFailures(cleanupStages(stages, unlinkSync))
    return reportRefusal(
      current.analyses,
      stagingFailure.analysis.ready.map(item => ({ item, message: `write failed: ${stagingFailure.error.message}` })),
      'another file could not be staged; no files were changed',
    )
  }

  // Verify every snapshot again before the first commit rename.
  const precommitFailures = verifySnapshots(rootDir, current.analyses)
  if (precommitFailures.length) {
    reportCleanupFailures(cleanupStages(stages, unlinkSync))
    return reportRefusal(
      current.analyses,
      precommitFailures,
      'another target changed before commit; no files were changed',
    )
  }

  const renameSync = typeof _test?.renameSync === 'function'
    ? (source, target, context) => _test.renameSync(source, target, context)
    : (source, target) => fs.renameSync(source, target)
  const committed = []
  let commitFailure = null
  for (const [index, stage] of stages.entries()) {
    try {
      const latest = readTarget(rootDir, stage.analysis.file)
      if (!snapshotsMatch(latest, stage.analysis.snapshot)) throw new Error('target changed after pre-commit verification')
      renameSync(stage.nextPath, stage.analysis.file, { phase: 'commit', index, file: stage.analysis.file })
      stage.nextPath = null
      committed.push(stage)
    } catch (error) {
      commitFailure = { stage, error }
      break
    }
  }

  if (commitFailure) {
    const rollbackFailures = []
    for (const [rollbackIndex, stage] of committed.toReversed().entries()) {
      try {
        assertSafePath(rootDir, stage.analysis.file)
        renameSync(stage.backupPath, stage.analysis.file, {
          phase: 'rollback',
          index: rollbackIndex,
          file: stage.analysis.file,
        })
        stage.backupPath = null
      } catch (error) {
        stage.keepBackup = true
        rollbackFailures.push({ stage, error })
      }
    }
    reportCleanupFailures(cleanupStages(stages, unlinkSync))

    const rollbackDetail = rollbackFailures.length
      ? `; rollback incomplete (${rollbackFailures.map(({ stage, error }) => `${stage.analysis.file}: ${error.message}; backup retained at ${stage.backupPath}`).join('; ')})`
      : committed.length ? '; earlier file commits were rolled back' : ''
    const cascadeMessage = rollbackFailures.length
      ? 'another file failed during plan commit and rollback was incomplete'
      : 'another file failed during plan commit; earlier commits were rolled back'
    return reportRefusal(
      current.analyses,
      commitFailure.stage.analysis.ready.map(item => ({
        item,
        message: `write failed: ${commitFailure.error.message}${rollbackDetail}`,
      })),
      cascadeMessage,
    )
  }

  const cleanupFailures = cleanupStages(stages, unlinkSync)
  reportCleanupFailures(cleanupFailures)
  const alreadyApplied = reportAlready(current.analyses)
  for (const item of sortedItems(currentReady)) {
    console.log(`applied ${itemLabel(item)}: ${item.matched} -> ${item.replacement}`)
  }
  return { failed: cleanupFailures.length, applied: currentReady.length, alreadyApplied }
}
