import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { buildModelPattern } from './feeds.mjs'
import { matchesAnyGlob, matchesGlob, normalizeRepoPath } from './glob.mjs'

export const CODE_EXT = new Set([
  '.c', '.cc', '.cjs', '.cpp', '.cs', '.cxx', '.go', '.h', '.hpp', '.java', '.js',
  '.jsx', '.kt', '.kts', '.m', '.mjs', '.mm', '.php', '.py', '.rb', '.rs',
  '.scala', '.sh', '.swift', '.ts', '.tsx',
  '.cfg', '.env', '.ini', '.json', '.toml', '.yaml', '.yml',
  '.sql', '.tf', '.tfvars',
])
export const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst'])
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.astro', '.worktrees', '.mypy_cache', '.ruff_cache', '.pytest_cache',
  '.tox', '.terraform', 'target', 'vendor', 'coverage', 'logs', 'tmp',
])
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FILES = 100_000
export const INCOMPLETE_SCAN_REASONS = new Set([
  'file-too-large',
  'unreadable-file',
  'unreadable-path',
  'unreadable-directory',
  'file-count-cap',
  'git-listing-failure',
])

export const incompleteScanNotes = notes => notes.filter(note => INCOMPLETE_SCAN_REASONS.has(note.reason))

export const scanIsIncomplete = notes => incompleteScanNotes(notes).length > 0

const directSignals = [
  ['openai', /\b(OPENAI_API_KEY|api\.openai\.com|from\s+openai\s+import|import\s+OpenAI\s+from\s+['"]openai['"]|require\(['"]openai['"]\)|new\s+OpenAI\s*\()/i, 'OpenAI direct SDK/API'],
  ['anthropic', /\b(ANTHROPIC_API_KEY|api\.anthropic\.com|@anthropic-ai\/sdk|from\s+anthropic\s+import|import\s+Anthropic\s+from\s+['"]@anthropic-ai\/sdk['"]|new\s+Anthropic\s*\()/i, 'Anthropic direct SDK/API'],
  ['google-gemini', /\b(GEMINI_API_KEY|GOOGLE_API_KEY|generativelanguage\.googleapis\.com|@google\/genai|google-generativeai|GoogleGenerativeAI)\b/i, 'Gemini direct SDK/API'],
  ['mistral', /\b(MISTRAL_API_KEY|api\.mistral\.ai|@mistralai\/mistralai|from\s+mistralai\s+import|MistralClient)\b/i, 'Mistral direct SDK/API'],
  ['cohere', /\b(COHERE_API_KEY|api\.cohere\.ai|from\s+cohere\s+import|new\s+CohereClient\s*\()/i, 'Cohere direct SDK/API'],
  ['xai', /\b(XAI_API_KEY|api\.x\.ai)\b/i, 'xAI direct SDK/API'],
]

const cloudSignals = [
  ['azure-ai-foundry', /\b(AZURE_OPENAI|AzureOpenAI|@azure\/openai|azure\.ai\.openai|azure-ai-foundry|AZURE_AI)\b/i, 'Azure Foundry/OpenAI deployment reference'],
  ['aws-bedrock', /\b(BEDROCK_MODEL_ID|bedrock-runtime|BedrockRuntime|InvokeModel|invoke_model|amazon\.bedrock)\b/i, 'Amazon Bedrock reference'],
  ['vertex-ai', /\b(VERTEX_AI|GOOGLE_CLOUD_PROJECT|aiplatform|vertexai|VertexAI|PredictionServiceClient|publishers\/google\/models)\b/i, 'Vertex AI reference'],
]

const gatewaySignals = [
  ['openrouter', /\b(OPENROUTER_API_KEY|openrouter\.ai|openrouter\/)\b/i, 'OpenRouter gateway reference'],
  ['litellm', /\b(LITELLM|litellm|LiteLLM)\b/, 'LiteLLM gateway reference'],
  ['portkey', /\b(PORTKEY_API_KEY|portkey|Portkey)\b/, 'Portkey gateway reference'],
  ['ai-gateway', /\b(AI_GATEWAY|Vercel AI Gateway|ai-gateway)\b/i, 'AI gateway reference'],
]

const allSignals = [
  ...directSignals.map(([provider, pattern, evidence]) => ({ usage: 'direct-api', provider, pattern, evidence })),
  ...cloudSignals.map(([provider, pattern, evidence]) => ({ usage: 'cloud-provider', provider, pattern, evidence })),
  ...gatewaySignals.map(([provider, pattern, evidence]) => ({ usage: 'gateway', provider, pattern, evidence })),
]

const findSignals = text => allSignals.flatMap(signal => {
  const m = text.match(signal.pattern)
  return m ? [{ ...signal, matched: m[0] }] : []
})

const candidatePatterns = [
  /\b(?:model|model_id|modelId|modelName|engine|deployment|deployment_name)\b\s*[:=]\s*["']([^"']{4,120})["']/gi,
  /["']((?:openai|anthropic|google|mistral|cohere|xai|amazon|meta-llama|deepseek|qwen)[\/.:][A-Za-z0-9._:/-]{4,120})["']/gi,
  /["']((?:gpt|o[1345]|claude|gemini|mistral|command|grok|llama|deepseek|qwen|nova|embed)[A-Za-z0-9._:/-]{4,120})["']/gi,
]

const suffixes = value => {
  const parts = value.split(/[\/.:]/).filter(Boolean)
  return parts.flatMap((_, i) => [parts.slice(i).join('/'), parts.slice(i).join('.'), parts.slice(i).join(':')])
}

const isKnownModel = (value, entries) =>
  entries.has(value) || suffixes(value).some(v => entries.has(v))

const findCandidates = (lineText, entries) => {
  const seen = new Set()
  const candidates = []
  for (const pattern of candidatePatterns) {
    pattern.lastIndex = 0
    let m
    while ((m = pattern.exec(lineText)) !== null) {
      const value = m[1].trim()
      if (seen.has(value) || isKnownModel(value, entries)) continue
      seen.add(value)
      candidates.push(value)
    }
  }
  return candidates
}

const classifyRef = ({ file, line, lines, publisher }) => {
  const start = Math.max(0, line - 8)
  const end = Math.min(lines.length, line + 4)
  const signals = []
  for (let i = start; i < end; i++) {
    for (const signal of findSignals(lines[i])) {
      signals.push({ ...signal, distance: Math.abs((i + 1) - line) })
    }
  }
  signals.sort((a, b) => a.distance - b.distance)
  const nearest = signals[0]
  if (nearest) {
    const hasCompetingRoute = signals.some(signal => signal.usage === 'cloud-provider' || signal.usage === 'gateway')
    const confidence = nearest.usage === 'direct-api' && !hasCompetingRoute ? 'high' : 'medium'
    return { usage: nearest.usage, provider: nearest.provider, confidence, evidence: nearest.evidence }
  }

  const lowerFile = file.toLowerCase()
  if (lowerFile.includes('azure')) return { usage: 'cloud-provider', provider: 'azure-ai-foundry', confidence: 'low', evidence: 'azure-like file path' }
  if (lowerFile.includes('bedrock')) return { usage: 'cloud-provider', provider: 'aws-bedrock', confidence: 'low', evidence: 'bedrock-like file path' }
  if (lowerFile.includes('vertex')) return { usage: 'cloud-provider', provider: 'vertex-ai', confidence: 'low', evidence: 'vertex-like file path' }

  return { usage: 'model-reference', provider: publisher, confidence: 'medium', evidence: 'tracked model ID or alias' }
}

const isScannable = (file, includeDocs) => {
  const basename = path.basename(file)
  if (basename === '.model-eol.json') return false
  if (basename === '.env' || basename.startsWith('.env.')) return true
  const ext = path.extname(file)
  return CODE_EXT.has(ext) || (includeDocs && DOC_EXT.has(ext))
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const displayPath = absolute => {
  const relative = path.relative(process.cwd(), absolute)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? relative
    : absolute
}

export const gitRootFor = target => {
  const cwd = fs.lstatSync(target).isDirectory() ? target : path.dirname(target)
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0) return null
  const root = result.stdout.trim()
  return root ? fs.realpathSync(path.resolve(root)) : null
}

const changedKey = (file, line) => `${path.resolve(file)}:${line}`

const parseDiffPath = value => {
  const raw = value.trim()
  if (raw === '/dev/null') return null
  let decoded = raw
  if (raw.startsWith('"')) {
    try {
      decoded = JSON.parse(raw)
    } catch {
      decoded = raw.slice(1, raw.endsWith('"') ? -1 : undefined)
    }
  }
  return decoded.startsWith('b/') ? decoded.slice(2) : decoded
}

export const addedLinesForTargets = (targets, baseRef) => {
  if (!baseRef) throw new Error('--changed requires a base ref')
  const roots = new Set()
  const resolvedTargets = []
  for (const target of targets) {
    let resolvedTarget
    try {
      resolvedTarget = fs.realpathSync(path.resolve(target))
    } catch {
      resolvedTarget = null
    }
    let root
    try {
      root = resolvedTarget ? gitRootFor(resolvedTarget) : null
    } catch {
      root = null
    }
    if (!root) throw new Error(`--changed requires a git repository for target ${target}`)
    roots.add(root)
    resolvedTargets.push({ target, path: resolvedTarget })
  }
  if (roots.size !== 1) throw new Error('--changed targets must belong to the same git repository')
  const gitRoot = [...roots][0]
  const relativeTargets = resolvedTargets.map(({ target, path: resolvedTarget }) => {
    const relative = path.relative(gitRoot, resolvedTarget)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error(`--changed target is outside its git root: ${target}`)
    }
    return relative || '.'
  })
  const result = spawnSync('git', ['diff', '--unified=0', baseRef, '--', ...relativeTargets], {
    cwd: gitRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) {
    const detail = (result.stderr ?? '').trim()
    throw new Error(`--changed git diff failed for base ref "${baseRef}"${detail ? `: ${detail}` : ''}`)
  }

  const added = new Set()
  let file = null
  let inHunk = false
  let newLine = 0
  let newLinesRemaining = 0
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null
      inHunk = false
      newLinesRemaining = 0
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const relative = parseDiffPath(line.slice(4))
      file = relative ? path.resolve(gitRoot, relative) : null
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      inHunk = true
      newLine = Number(hunk[1])
      newLinesRemaining = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    if (!inHunk || !file || newLinesRemaining === 0) continue
    if (line.startsWith('+')) added.add(changedKey(file, newLine))
    if (!line.startsWith('-')) {
      newLine++
      newLinesRemaining--
    }
  }
  return added
}

export const filterFindingsToChanged = (findings, addedLines) =>
  findings.filter(finding => addedLines.has(changedKey(finding.file, finding.line)))

const collectFilesDetailed = (targets, {
  includeDocs = false,
  ignorePaths = [],
  ignoreRoots = [],
  ignoredFiles = [],
} = {}) => {
  const files = []
  const notes = []
  const validTargets = []
  const seen = new Set()
  const canonicalPath = value => {
    const resolved = path.resolve(value)
    try {
      return fs.realpathSync(resolved)
    } catch {
      return resolved
    }
  }
  const excludedFiles = new Set(ignoredFiles.map(canonicalPath))
  const roots = ignoreRoots.map(canonicalPath)
  let fileLimitWarned = false
  let stopped = false

  const note = value => notes.push(value)
  const repoPathsFor = absolute => {
    const resolved = canonicalPath(absolute)
    const repoPaths = []
    for (const root of roots) {
      const relative = path.relative(root, resolved)
      if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue
      repoPaths.push(normalizeRepoPath(relative))
    }
    return repoPaths
  }
  const matchesIgnoredRepoPath = repoPath => matchesAnyGlob(repoPath, ignorePaths) ||
    ignorePaths.some(pattern => {
      const normalizedPattern = normalizeRepoPath(pattern).replace(/\/+$/, '')
      return normalizedPattern && !/[*?]/.test(normalizedPattern) && repoPath.startsWith(`${normalizedPattern}/`)
    })
  const isIgnoredFile = absolute => {
    const resolved = canonicalPath(absolute)
    return excludedFiles.has(resolved) || repoPathsFor(resolved).some(matchesIgnoredRepoPath)
  }
  const isIgnoredDirectoryTree = absolute => repoPathsFor(absolute).some(repoPath =>
    ignorePaths.some(pattern => {
      const normalizedPattern = normalizeRepoPath(pattern)
      const literalDirectory = !/[*?]/.test(normalizedPattern) && normalizedPattern.replace(/\/+$/, '') === repoPath
      const subtreeGlob = normalizedPattern.endsWith('/**') && matchesGlob(repoPath, normalizedPattern.slice(0, -3))
      return literalDirectory || subtreeGlob
    }))
  const addFile = absolute => {
    if (stopped || seen.has(absolute) || isIgnoredFile(absolute)) return
    seen.add(absolute)

    let st
    try {
      st = fs.lstatSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-file', file: displayPath(absolute), message: e.message })
      return
    }
    if (!st.isFile() || st.isSymbolicLink() || !isScannable(absolute, includeDocs)) return
    if (st.size > MAX_FILE_BYTES) {
      note({
        reason: 'file-too-large',
        file: displayPath(absolute),
        bytes: st.size,
        limit_bytes: MAX_FILE_BYTES,
      })
      return
    }
    if (files.length >= MAX_FILES) {
      stopped = true
      if (!fileLimitWarned) {
        note({
          reason: 'file-count-cap',
          file: displayPath(absolute),
          limit_files: MAX_FILES,
          message: `file-count cap (${MAX_FILES}) reached; remaining files skipped`,
        })
        fileLimitWarned = true
      }
      return
    }
    files.push(displayPath(absolute))
  }

  const walk = absolute => {
    if (stopped || excludedFiles.has(canonicalPath(absolute))) return
    let st
    try {
      st = fs.lstatSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-path', file: displayPath(absolute), message: e.message })
      return
    }
    if (st.isSymbolicLink()) return
    if (!st.isDirectory()) {
      addFile(absolute)
      return
    }
    if (isIgnoredDirectoryTree(absolute)) return
    if (SKIP_DIRS.has(path.basename(absolute))) return
    let names
    try {
      names = fs.readdirSync(absolute)
    } catch (e) {
      note({ reason: 'unreadable-directory', file: displayPath(absolute), message: e.message })
      return
    }
    for (const name of names) {
      walk(path.join(absolute, name))
      if (stopped) return
    }
  }

  const listGitFiles = (absoluteTarget, gitRoot) => {
    const relativeTarget = path.relative(gitRoot, absoluteTarget) || '.'
    const result = spawnSync('git', [
      'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', relativeTarget,
    ], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`
      note({
        reason: 'git-listing-failure',
        file: displayPath(absoluteTarget),
        message: `git file listing failed: ${detail}; no recursive fallback used`,
      })
      return
    }
    for (const relativeFile of result.stdout.split('\0')) {
      if (stopped) break
      if (!relativeFile) continue
      const absoluteFile = path.resolve(gitRoot, relativeFile)
      if (path.relative(gitRoot, absoluteFile).split(path.sep).some(part => SKIP_DIRS.has(part))) continue
      addFile(absoluteFile)
    }
  }

  for (const target of targets) {
    const absoluteTarget = path.resolve(target)
    let st
    try {
      st = fs.lstatSync(absoluteTarget)
    } catch (e) {
      console.error(`model-eol: warning: target not found, skipping ${target}`)
      continue
    }
    validTargets.push(absoluteTarget)
    if (st.isSymbolicLink()) {
      note({ reason: 'symlink-skipped', file: displayPath(absoluteTarget) })
      continue
    }

    let resolvedTarget
    try {
      resolvedTarget = fs.realpathSync(absoluteTarget)
    } catch {
      resolvedTarget = absoluteTarget
    }
    const gitRoot = gitRootFor(resolvedTarget)
    if (gitRoot) listGitFiles(resolvedTarget, gitRoot)
    else walk(absoluteTarget)
  }

  return { files, notes, validTargets }
}

export const collectFiles = (targets, options = {}) => collectFilesDetailed(targets, options).files

export const scanTargets = ({
  targets,
  entries,
  keys,
  includeDocs = false,
  ignoreModels = [],
  ignorePaths = [],
  ignoreRoots = [],
  ignoredFiles = [],
}) => {
  const collected = collectFilesDetailed(targets, { includeDocs, ignorePaths, ignoreRoots, ignoredFiles })
  if (collected.validTargets.length === 0) throw new Error('no valid targets remain')
  const { files } = collected
  const pattern = buildModelPattern(keys)
  const ignoredModelKeys = new Set(ignoreModels)
  const ignoredCanonicalIds = new Set(ignoreModels.map(key => entries.get(key)?.entry.id ?? key))
  const ignoresModel = (matched, id = null) =>
    ignoredModelKeys.has(matched) || (id !== null && ignoredCanonicalIds.has(id))
  const modelRefs = []
  const candidateRefs = []
  const integrationHints = []

  const isFeedDocument = (file, text) => {
    if (!file.endsWith('.json')) return false
    try {
      const spec = JSON.parse(text)?.spec
      return typeof spec === 'string' && spec.startsWith('model-eol/')
    } catch {
      return false
    }
  }

  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      collected.notes.push({ reason: 'unreadable-file', file, message: e.message })
      continue
    }
    // A feed document is lifecycle data, not model usage.
    if (isFeedDocument(file, text)) {
      collected.notes.push({ reason: 'feed-document-skipped', file })
      continue
    }
    const lines = text.split('\n')
    for (const [i, lineText] of lines.entries()) {
      for (const signal of findSignals(lineText)) {
        integrationHints.push({
          kind: 'integration-hint',
          usage: signal.usage,
          provider: signal.provider,
          file,
          line: i + 1,
          matched: signal.matched,
          evidence: signal.evidence,
        })
      }

      if (!pattern) continue
      pattern.lastIndex = 0
      let m
      while ((m = pattern.exec(lineText)) !== null) {
        const record = entries.get(m[1])
        if (ignoresModel(m[1], record.entry.id)) continue
        const occurrence = [...lineText.matchAll(new RegExp(escapeRegExp(m[1]), 'g'))]
          .findIndex(match => match.index === m.index)
        const classification = classifyRef({
          file,
          line: i + 1,
          lines,
          publisher: record.publisher,
        })
        modelRefs.push({
          kind: 'model-reference',
          file,
          line: i + 1,
          matched: m[1],
          id: record.entry.id,
          entry: record.entry,
          publisher: record.publisher,
          source: record.source,
          feedNote: record.feedNote,
          policy: record.policy,
          generated: record.generated,
          usage: classification.usage,
          resolved_provider: classification.provider,
          confidence: classification.confidence,
          evidence: classification.evidence,
          occurrence: occurrence < 0 ? 0 : occurrence,
        })
      }

      for (const candidate of findCandidates(lineText, entries)) {
        if (ignoresModel(candidate)) continue
        const classification = classifyRef({
          file,
          line: i + 1,
          lines,
          publisher: 'unknown',
        })
        candidateRefs.push({
          kind: 'candidate-model-reference',
          file,
          line: i + 1,
          matched: candidate,
          usage: classification.usage,
          resolved_provider: classification.provider,
          confidence: classification.confidence === 'high' ? 'medium' : 'low',
          evidence: classification.evidence,
          reason: 'model-like string not present in loaded feeds',
        })
      }
    }
  }

  return { files, modelRefs, candidateRefs, integrationHints, notes: collected.notes, validTargets: collected.validTargets }
}
