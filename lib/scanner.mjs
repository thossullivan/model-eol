import fs from 'node:fs'
import path from 'node:path'

import { buildModelPattern } from './feeds.mjs'

export const CODE_EXT = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml',
  '.toml', '.env', '.ini', '.cfg', '.sh', '.rb', '.go', '.java', '.cs',
])
export const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst'])
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', '.astro',
])

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
    const confidence = nearest.usage === 'direct-api' ? 'high' : 'medium'
    return { usage: nearest.usage, provider: nearest.provider, confidence, evidence: nearest.evidence }
  }

  const lowerFile = file.toLowerCase()
  if (lowerFile.includes('azure')) return { usage: 'cloud-provider', provider: 'azure-ai-foundry', confidence: 'low', evidence: 'azure-like file path' }
  if (lowerFile.includes('bedrock')) return { usage: 'cloud-provider', provider: 'aws-bedrock', confidence: 'low', evidence: 'bedrock-like file path' }
  if (lowerFile.includes('vertex')) return { usage: 'cloud-provider', provider: 'vertex-ai', confidence: 'low', evidence: 'vertex-like file path' }

  return { usage: 'model-reference', provider: publisher, confidence: 'medium', evidence: 'tracked model ID or alias' }
}

export const collectFiles = (targets, { includeDocs = false } = {}) => {
  const files = []
  const walk = p => {
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return
      for (const f of fs.readdirSync(p)) walk(path.join(p, f))
      return
    }
    const ext = path.extname(p)
    if (CODE_EXT.has(ext) || (includeDocs && DOC_EXT.has(ext))) files.push(p)
  }
  for (const t of targets) walk(t)
  return files
}

export const scanTargets = ({ targets, entries, keys, includeDocs = false }) => {
  const files = collectFiles(targets, { includeDocs })
  const pattern = buildModelPattern(keys)
  const modelRefs = []
  const integrationHints = []

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
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
          usage: classification.usage,
          resolved_provider: classification.provider,
          confidence: classification.confidence,
          evidence: classification.evidence,
        })
      }
    }
  }

  return { files, modelRefs, integrationHints }
}
