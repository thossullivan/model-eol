import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { isBad } from './feeds.mjs'
import { MAX_FILE_BYTES, SKIP_DIRS, baseLineFor, changedLinesForTargets, incompleteScanNotes, isAddedLine } from './scanner.mjs'

export class BaseUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BaseUnavailableError'
  }
}

export const inCheckScope = finding =>
  finding.effective_scope !== 'direct' || finding.usage === 'direct-api' || finding.usage === 'model-reference'

const runGit = (gitRoot, label, args, { input } = {}) => {
  const result = spawnSync('git', args, {
    cwd: gitRoot,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`
    throw new Error(`git ${label} failed: ${detail}`)
  }
  return result.stdout
}

const nulRecords = buffer => buffer.toString('utf8').split('\0').filter(Boolean)

const repoRelative = (gitRoot, absolute) => {
  const relative = path.relative(gitRoot, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

const realLocation = (target, { directory }) => {
  const absolute = path.resolve(target)
  try {
    return directory ? fs.realpathSync(absolute) : path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
  } catch {
    return absolute
  }
}

const safeTreePath = relative => relative.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')

const scannableTreePath = relative => safeTreePath(relative) && !relative.split('/').some(part => SKIP_DIRS.has(part))

const regularBlob = entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')

const untrackedFiles = (gitRoot, relativeTargets) => new Set(nulRecords(runGit(gitRoot, 'ls-files', [
  'ls-files', '-z', '--others', '--exclude-standard', '--', ...relativeTargets,
])).filter(relative => !relative.endsWith('/')).map(relative => path.resolve(gitRoot, relative)))

const gitPathChanged = (gitRoot, baseCommit, relative) => {
  const diff = runGit(gitRoot, 'diff', [
    '--literal-pathspecs', 'diff', '--no-color', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', baseCommit, '--', relative,
  ])
  if (diff.length) return true
  return runGit(gitRoot, 'ls-files', ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', relative]).length > 0
}

const listBaseTree = (gitRoot, baseCommit, pathspecs) => {
  const entries = new Map()
  for (const record of nulRecords(runGit(gitRoot, 'ls-tree', [
    '--literal-pathspecs', 'ls-tree', '-r', '-z', '-l', '--full-tree', baseCommit, '--', ...pathspecs,
  ]))) {
    const separator = record.indexOf('\t')
    const [mode, type, oid, size] = record.slice(0, separator).split(/ +/)
    if (separator === -1 || !/^[0-7]{6}$/.test(mode) || !/^[0-9a-f]{40,64}$/.test(oid ?? '')) {
      throw new Error('git ls-tree returned a malformed record')
    }
    entries.set(record.slice(separator + 1), { mode, type, oid, size: size === '-' ? null : Number(size) })
  }
  return entries
}

const readBlobs = (gitRoot, entries) => {
  const output = runGit(gitRoot, 'cat-file', ['cat-file', '--batch'], { input: entries.map(entry => `${entry.oid}\n`).join('') })
  const blobs = []
  let offset = 0
  for (const entry of entries) {
    const newline = output.indexOf(0x0a, offset)
    if (newline === -1) throw new Error('git cat-file returned a truncated record')
    const [oid, type, size] = output.toString('utf8', offset, newline).split(' ')
    if (oid !== entry.oid || type !== 'blob' || !/^\d+$/.test(size ?? '')) {
      throw new Error(`git cat-file could not read blob ${entry.oid}`)
    }
    const start = newline + 1
    const end = start + Number(size)
    if (end + 1 > output.length) throw new Error('git cat-file returned a truncated record')
    blobs.push(output.subarray(start, end))
    offset = end + 1
  }
  return blobs
}

const materialize = (gitRoot, treeRoot, writes) => {
  const failed = new Set()
  const blobs = writes.length ? readBlobs(gitRoot, writes.map(write => write.entry)) : []
  for (const [index, write] of writes.entries()) {
    const target = path.join(treeRoot, ...write.relative.split('/'))
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, blobs[index], { flag: 'wx' })
    } catch {
      failed.add(write.relative)
    }
  }
  return failed
}

const findingKey = (relative, line, id, matched) => JSON.stringify([relative, line, id, matched])

const baseSummary = finding => ({
  status: finding.status,
  via: finding.via,
  usage: finding.usage,
  threshold_days: finding.threshold_days,
  effective_scope: finding.effective_scope,
})

export const selectChangedFindings = ({ targets, baseRef, findings, checkFindings, scannedFiles, configFile, feedsDir, evaluateBase }) => {
  const diff = changedLinesForTargets(targets, baseRef)
  const { gitRoot, baseCommit } = diff
  const untracked = untrackedFiles(gitRoot, diff.relativeTargets)
  const configRelative = repoRelative(gitRoot, realLocation(configFile ?? path.join(gitRoot, '.model-eol.json'), { directory: false }))
  const feedsRelative = repoRelative(gitRoot, realLocation(feedsDir, { directory: true }))
  const configChanged = configRelative !== null && gitPathChanged(gitRoot, baseCommit, configRelative)
  const feedsChanged = feedsRelative !== null && gitPathChanged(gitRoot, baseCommit, feedsRelative)
  const sharedInputs = [...(configChanged ? ['config'] : []), ...(feedsChanged ? ['feeds'] : [])]

  const affected = new Map()
  for (const file of scannedFiles) {
    const absolute = path.resolve(file)
    const record = diff.files.get(absolute)
    const isUntracked = untracked.has(absolute)
    const inputs = [
      ...sharedInputs,
      ...(record?.renamed ? ['rename'] : []),
      ...(record?.hunks.length ? ['file'] : []),
      ...(isUntracked ? ['untracked'] : []),
    ]
    if (!inputs.length) continue
    affected.set(absolute, {
      inputs,
      baseRelative: isUntracked ? null : record ? record.basePath : repoRelative(gitRoot, absolute),
      hunks: record?.hunks ?? [],
    })
  }

  const occurrences = new Map()
  const seen = new Map()
  for (const finding of findings) {
    const key = findingKey(path.resolve(finding.file), finding.line, finding.id, finding.matched)
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    occurrences.set(finding, index)
  }

  const candidates = checkFindings.filter(finding =>
    !isAddedLine(diff.added, finding.file, finding.line) && isBad(finding) && affected.has(path.resolve(finding.file)))
  const baseRelatives = [...new Set(candidates
    .map(finding => affected.get(path.resolve(finding.file)).baseRelative)
    .filter(relative => relative !== null))]

  const baseFindings = new Map()
  const incomplete = new Set()
  let unavailable = null
  if (baseRelatives.length) {
    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-base-')))
    try {
      const treeRoot = path.join(tempRoot, 'tree')
      fs.mkdirSync(treeRoot)
      const pathspecs = [...new Set([
        ...diff.relativeTargets,
        ...(configChanged ? [configRelative] : []),
        ...(feedsChanged ? [feedsRelative] : []),
      ])]
      const tree = listBaseTree(gitRoot, baseCommit, pathspecs)
      const writes = new Map()
      const scanned = []
      for (const relative of baseRelatives) {
        const entry = tree.get(relative)
        if (!entry || !scannableTreePath(relative)) continue
        if (!regularBlob(entry) || entry.size > MAX_FILE_BYTES) {
          incomplete.add(relative)
          continue
        }
        writes.set(relative, { relative, entry })
        scanned.push(relative)
      }
      const required = []
      let baseConfigFile
      if (configChanged) {
        const entry = tree.get(configRelative)
        if (!entry) {
          baseConfigFile = null
        } else if (!regularBlob(entry) || !safeTreePath(configRelative)) {
          unavailable = `base config ${configRelative} is not a regular file`
        } else {
          writes.set(configRelative, { relative: configRelative, entry })
          required.push(configRelative)
          baseConfigFile = path.join(treeRoot, ...configRelative.split('/'))
        }
      }
      let baseFeedsDir
      if (feedsChanged) {
        baseFeedsDir = path.join(treeRoot, ...feedsRelative.split('/'))
        for (const [relative, entry] of tree) {
          const name = relative.startsWith(`${feedsRelative}/`) ? relative.slice(feedsRelative.length + 1) : null
          if (name === null || name.includes('/') || !name.endsWith('.json')) continue
          if (!regularBlob(entry) || !safeTreePath(relative)) {
            unavailable ??= `base feed ${relative} is not a regular file`
            continue
          }
          writes.set(relative, { relative, entry })
          required.push(relative)
        }
      }
      if (unavailable === null) {
        const failed = materialize(gitRoot, treeRoot, [...writes.values()])
        const failedRequired = required.find(relative => failed.has(relative))
        if (failedRequired) unavailable = `could not materialize base file ${failedRequired}`
        for (const relative of scanned) if (failed.has(relative)) incomplete.add(relative)
        const files = scanned.filter(relative => !failed.has(relative)).map(relative => path.join(treeRoot, ...relative.split('/')))
        if (unavailable === null && files.length) {
          const relativeToTree = file => path.relative(treeRoot, path.resolve(file)).split(path.sep).join('/')
          try {
            const base = evaluateBase({ treeRoot, files, configFile: baseConfigFile, feedsDir: baseFeedsDir })
            for (const note of incompleteScanNotes(base.notes)) if (note.file) incomplete.add(relativeToTree(note.file))
            for (const finding of base.findings) {
              const key = findingKey(relativeToTree(finding.file), finding.line, finding.id, finding.matched)
              if (!baseFindings.has(key)) baseFindings.set(key, [])
              baseFindings.get(key).push(finding)
            }
          } catch (error) {
            if (!(error instanceof BaseUnavailableError)) throw error
            unavailable = error.message.split(`${treeRoot}${path.sep}`).join(`${baseRef}:`).split(treeRoot).join(`${baseRef}:`)
          }
        }
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  return checkFindings.flatMap(finding => {
    if (isAddedLine(diff.added, finding.file, finding.line)) return [{ ...finding, changed: { reason: 'added-line' } }]
    const file = isBad(finding) ? affected.get(path.resolve(finding.file)) : null
    if (!file) return []
    const newlyActionable = base => [{ ...finding, changed: { reason: 'newly-actionable', inputs: [...file.inputs], base } }]
    if (file.baseRelative === null) return newlyActionable(null)
    if (unavailable !== null) return [{ ...finding, changed: { reason: 'base-unavailable', message: unavailable } }]
    const baseLine = baseLineFor(file.hunks, finding.line)
    if (baseLine === null || incomplete.has(file.baseRelative)) return newlyActionable(null)
    const match = baseFindings.get(findingKey(file.baseRelative, baseLine, finding.id, finding.matched))?.[occurrences.get(finding)]
    if (!match) return newlyActionable(null)
    if (isBad(match) && inCheckScope(match)) return []
    return newlyActionable(baseSummary(match))
  })
}
