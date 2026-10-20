import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { isBad } from './feeds.mjs'
import { MAX_FILE_BYTES, SKIP_DIRS, baseLineFor, changedLinesForTargets, displayPath, incompleteScanNotes, isAddedLine } from './scanner.mjs'

export class BaseUnavailableError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BaseUnavailableError'
  }
}

export const inCheckScope = finding =>
  finding.effective_scope !== 'direct' || finding.usage === 'direct-api' || finding.usage === 'model-reference'

const MAX_SYMLINK_DEPTH = 40

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
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join('/')
}

const lexicalRepoPath = (gitRoot, absolute) => {
  const parts = path.resolve(absolute).split(path.sep)
  for (let index = 1; index <= parts.length; index++) {
    let real
    try {
      real = fs.realpathSync(parts.slice(0, index).join(path.sep) || path.sep)
    } catch {
      return null
    }
    if (real === gitRoot) return parts.slice(index).join('/')
  }
  return null
}

const repoLocation = (gitRoot, target) => {
  const lexical = lexicalRepoPath(gitRoot, target)
  if (lexical !== null) return lexical
  try {
    return repoRelative(gitRoot, fs.realpathSync(path.resolve(target)))
  } catch {
    return null
  }
}

const isIgnored = (gitRoot, relative) => {
  if (relative === '') return false
  const result = spawnSync('git', ['check-ignore', '-q', '--', `./${relative}`], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (!result.error && (result.status === 0 || result.status === 1)) return result.status === 0
  const detail = String(result.stderr ?? '').trim() || result.error?.message || `exit ${result.status}`
  if (result.status === 128 && /in submodule|beyond a symbolic link/i.test(detail)) return false
  throw new Error(`git check-ignore failed: ${detail}`)
}

const readRegular = absolute => {
  let descriptor
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0))
  } catch (error) {
    return error.code === 'ENOENT' ? { bytes: null } : { message: error.message }
  }
  try {
    return fs.fstatSync(descriptor).isFile() ? { bytes: fs.readFileSync(descriptor) } : { message: 'not a regular file' }
  } catch (error) {
    return { message: error.message }
  } finally {
    fs.closeSync(descriptor)
  }
}

const readHead = absolute => {
  const result = readRegular(absolute)
  if (result.message) throw new Error(`could not read ${absolute}: ${result.message}`)
  return result.bytes
}

const scannableTreePath = relative => relative.split('/').every(part =>
  part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !SKIP_DIRS.has(part))

const regularBlob = entry => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')

const untrackedFiles = (gitRoot, relativeTargets) => new Set(nulRecords(runGit(gitRoot, 'ls-files', [
  '--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...relativeTargets,
])).filter(relative => !relative.endsWith('/')).map(relative => path.resolve(gitRoot, relative)))

const parseTree = output => {
  const entries = new Map()
  for (const record of nulRecords(output)) {
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

const baseTreeReader = (gitRoot, baseCommit) => {
  const lsTree = (pathspecs, { recursive = false } = {}) => parseTree(runGit(gitRoot, 'ls-tree', [
    '--literal-pathspecs', 'ls-tree', ...(recursive ? ['-r'] : []), '-z', '-l', '--full-tree', baseCommit,
    ...(pathspecs.length ? ['--', ...pathspecs] : []),
  ]))
  const entries = new Map()
  const lookup = relative => {
    if (!entries.has(relative)) entries.set(relative, lsTree([relative]).get(relative) ?? null)
    return entries.get(relative)
  }
  const blobs = new Map()
  const read = entry => {
    if (!blobs.has(entry.oid)) blobs.set(entry.oid, readBlobs(gitRoot, [entry])[0])
    return blobs.get(entry.oid)
  }
  const children = relative => [...lsTree(relative === '' ? [] : [`${relative}/`])].map(([child, entry]) => ({
    name: relative === '' ? child : child.slice(relative.length + 1),
    entry,
  }))
  const resolve = (relative, depth = 0) => {
    if (depth > MAX_SYMLINK_DEPTH) return { state: 'unavailable', message: 'too many levels of symbolic links' }
    const parts = relative === '' ? [] : relative.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/')
      const entry = lookup(prefix)
      if (!entry) return { state: 'absent' }
      const rest = parts.slice(index)
      if (entry.mode === '160000') return { state: 'submodule', prefix, commit: entry.oid, rest: rest.join('/') }
      if (entry.mode === '120000') {
        const target = read(entry).toString('utf8')
        const absolute = path.resolve(gitRoot, ...path.posix.dirname(prefix).split('/'), target)
        const inside = repoRelative(gitRoot, absolute) ?? lexicalRepoPath(gitRoot, absolute)
        if (inside === null) return { state: 'outside', absolute: path.join(absolute, ...rest) }
        return resolve([inside, ...rest].filter(Boolean).join('/'), depth + 1)
      }
      if (rest.length && entry.type !== 'tree') return { state: 'absent' }
      if (!rest.length && entry.type !== 'tree') {
        return regularBlob(entry) ? { state: 'blob', entry } : { state: 'unavailable', message: 'not a regular file' }
      }
    }
    return { state: 'tree', relative }
  }
  return { root: gitRoot, lsTree, read, children, resolve }
}

const submoduleReader = (reader, prefix, commit) => {
  const unavailable = { state: 'unavailable', message: `in submodule ${prefix}, which is not checked out with base commit ${commit}` }
  let root
  try {
    root = fs.realpathSync(path.join(reader.root, ...prefix.split('/')))
    const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (toplevel.status !== 0 || fs.realpathSync(toplevel.stdout.trim()) !== root) return unavailable
  } catch {
    return unavailable
  }
  const present = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'ignore' })
  return present.status === 0 ? baseTreeReader(root, commit) : unavailable
}

const resolveBase = (reader, relative, depth = 0) => {
  const resolved = reader.resolve(relative)
  if (resolved.state !== 'submodule') return { ...resolved, reader }
  if (depth > MAX_SYMLINK_DEPTH) return { state: 'unavailable', message: 'too many nested submodules' }
  const submodule = submoduleReader(reader, resolved.prefix, resolved.commit)
  return submodule.state === 'unavailable' ? submodule : resolveBase(submodule, resolved.rest, depth + 1)
}

const sameBytes = (left, right) => left === null || right === null ? left === right : left.equals(right)

const configInput = ({ gitRoot, tree, configFile }) => {
  const location = repoLocation(gitRoot, configFile ?? path.join(gitRoot, '.model-eol.json'))
  if (location === null || location === '') return { changed: false }
  const resolved = resolveBase(tree, location)
  if (resolved.state === 'absent' && isIgnored(gitRoot, location)) return { changed: false }
  const head = configFile ? readHead(configFile) : null
  const base = resolved.state === 'blob' ? { bytes: resolved.reader.read(resolved.entry) }
    : resolved.state === 'absent' ? { bytes: null }
      : resolved.state === 'outside' ? readRegular(resolved.absolute)
        : { message: resolved.message ?? 'a directory' }
  if (base.message) return { changed: true, location, unavailable: `base config ${location} is ${base.message}` }
  return { changed: !sameBytes(head, base.bytes), location, bytes: base.bytes }
}

const readFeedDirectory = directory => {
  const files = new Map()
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const result = readRegular(path.join(directory, name))
    if (result.message || result.bytes === null) return { message: `entry ${name} is ${result.message ?? 'missing'}` }
    files.set(name, result.bytes)
  }
  return { files }
}

const feedsInput = ({ gitRoot, tree, feedsDir }) => {
  const location = repoLocation(gitRoot, feedsDir)
  if (location === null) return { changed: false }
  const directory = resolveBase(tree, location)
  if (directory.state === 'absent' && isIgnored(gitRoot, location)) return { changed: false }
  const label = location || '.'
  const headFiles = readFeedDirectory(feedsDir)
  if (headFiles.message) throw new Error(`could not read feeds ${feedsDir}: ${headFiles.message}`)
  const head = headFiles.files
  const unavailable = message => ({ changed: true, location, unavailable: `base feeds ${message}` })
  let base
  if (directory.state === 'tree') {
    base = new Map()
    const { reader } = directory
    for (const { name, entry } of reader.children(directory.relative)) {
      if (!name.endsWith('.json')) continue
      const resolved = regularBlob(entry) ? { state: 'blob', entry, reader }
        : entry.mode === '120000' ? resolveBase(reader, directory.relative ? `${directory.relative}/${name}` : name)
          : null
      const outside = resolved?.state === 'outside' ? readRegular(resolved.absolute) : null
      if (resolved?.state === 'blob') base.set(name, resolved.reader.read(resolved.entry))
      else if (outside?.bytes) base.set(name, outside.bytes)
      else return unavailable(`entry ${label}/${name} is not a readable regular file at base`)
    }
  } else if (directory.state === 'outside') {
    let listed
    try {
      listed = readFeedDirectory(directory.absolute)
    } catch (error) {
      return unavailable(`directory ${label} could not be read at base: ${error.message}`)
    }
    if (listed.message) return unavailable(`directory ${label} at base: ${listed.message}`)
    base = listed.files
  } else if (directory.state === 'unavailable') {
    return unavailable(`directory ${label} is ${directory.message}`)
  } else {
    return unavailable(`directory ${label} is ${directory.state === 'absent' ? 'missing' : 'not a directory'} at base`)
  }
  const changed = head.size !== base.size || [...head].some(([name, bytes]) => !base.has(name) || !bytes.equals(base.get(name)))
  return { changed, location, files: base }
}

const temporaryRoot = gitRoot => {
  const tmp = fs.realpathSync(os.tmpdir())
  if (repoRelative(gitRoot, tmp) !== null) {
    throw new Error(`the temporary directory ${tmp} is inside the git repository; set TMPDIR to a directory outside it`)
  }
  return fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'model-eol-base-')))
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
  const tree = baseTreeReader(gitRoot, baseCommit)
  const untracked = untrackedFiles(gitRoot, diff.relativeTargets)
  const config = configInput({ gitRoot, tree, configFile })
  const feeds = feedsInput({ gitRoot, tree, feedsDir })
  const sharedInputs = [...(config.changed ? ['config'] : []), ...(feeds.changed ? ['feeds'] : [])]

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
  let unavailable = (config.changed && config.unavailable) || (feeds.changed && feeds.unavailable) || null
  if (baseRelatives.length && unavailable === null) {
    const tempRoot = temporaryRoot(gitRoot)
    try {
      const treeRoot = path.join(tempRoot, 'tree')
      fs.mkdirSync(treeRoot)
      const listing = tree.lsTree(diff.relativeTargets, { recursive: true })
      const writes = []
      for (const relative of baseRelatives) {
        const entry = listing.get(relative)
        if (!entry || !scannableTreePath(relative)) continue
        if (!regularBlob(entry) || entry.size > MAX_FILE_BYTES) {
          incomplete.add(relative)
          continue
        }
        writes.push({ relative, entry, target: path.join(treeRoot, ...relative.split('/')) })
      }
      const blobs = writes.length ? readBlobs(gitRoot, writes.map(write => write.entry)) : []
      const files = []
      for (const [index, write] of writes.entries()) {
        try {
          fs.mkdirSync(path.dirname(write.target), { recursive: true })
          fs.writeFileSync(write.target, blobs[index], { flag: 'wx' })
          files.push(write.target)
        } catch {
          incomplete.add(write.relative)
        }
      }
      const replacements = [[`${treeRoot}${path.sep}`, `${baseRef}:`], [treeRoot, `${baseRef}:`]]
      let baseConfigFile
      if (config.changed) {
        baseConfigFile = null
        if (config.bytes !== null) {
          baseConfigFile = path.join(tempRoot, 'config', path.posix.basename(config.location))
          fs.mkdirSync(path.dirname(baseConfigFile))
          fs.writeFileSync(baseConfigFile, config.bytes, { flag: 'wx' })
          replacements.unshift([baseConfigFile, `${baseRef}:${config.location}`])
        }
      }
      let baseFeedsDir
      if (feeds.changed) {
        baseFeedsDir = path.join(tempRoot, 'feeds')
        fs.mkdirSync(baseFeedsDir)
        for (const [name, bytes] of feeds.files) fs.writeFileSync(path.join(baseFeedsDir, name), bytes, { flag: 'wx' })
        replacements.unshift([`${baseFeedsDir}${path.sep}`, `${baseRef}:${feeds.location ? `${feeds.location}/` : ''}`], [baseFeedsDir, `${baseRef}:${feeds.location || '.'}`])
      }
      if (files.length) {
        const relativeToTree = file => path.relative(treeRoot, path.resolve(file)).split(path.sep).join('/')
        try {
          const base = evaluateBase({
            treeRoot,
            files,
            configFile: baseConfigFile,
            feedsDir: baseFeedsDir,
            classificationPathFor: file => displayPath(path.join(gitRoot, ...relativeToTree(file).split('/'))),
          })
          for (const note of incompleteScanNotes(base.notes)) if (note.file) incomplete.add(relativeToTree(note.file))
          for (const finding of base.findings) {
            const key = findingKey(relativeToTree(finding.file), finding.line, finding.id, finding.matched)
            if (!baseFindings.has(key)) baseFindings.set(key, [])
            baseFindings.get(key).push(finding)
          }
        } catch (error) {
          if (!(error instanceof BaseUnavailableError)) throw error
          unavailable = replacements.reduce((message, [from, to]) => message.split(from).join(to), error.message)
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
