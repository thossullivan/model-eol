import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'

import { loadConfig } from './config.mjs'
import { effectiveEval, evalConfigDigest, evalIdentity, feedContext, modelGroups, planDigest, sha256 } from './digests.mjs'
import {
  EVAL_RESULTS_SCHEMA,
  FEED_REFRESH_RECEIPT_SCHEMA,
  RELEASE_RECEIPT_SCHEMA,
  SHA_PATTERN,
  VERIFICATION_SCHEMA,
  assertHttpsUrl,
  hashFeedFiles,
  sha512Integrity,
  verificationResult,
} from './receipts.mjs'
import { assertValidPlanDocument, formatDocumentErrors, validateDocument } from './validate-document.mjs'

export class VerifyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VerifyError'
    this.exitCode = 2
  }
}

const refuse = message => {
  throw new VerifyError(message)
}

const KINDS = new Map([
  [FEED_REFRESH_RECEIPT_SCHEMA, { type: 'feed-refresh-receipt', inputs: ['feeds-dir', 'commit', 'run-url'] }],
  [RELEASE_RECEIPT_SCHEMA, { type: 'npm-release-result', inputs: ['package', 'commit', 'source-commit', 'version'] }],
  [EVAL_RESULTS_SCHEMA, { type: 'eval', inputs: ['commit', 'plan', 'config', 'feeds-dir'] }],
])

export const SUPPORTED_RECEIPT_SCHEMAS = Object.freeze([...KINDS.keys()])
export const VERIFY_INPUTS = Object.freeze(['feeds-dir', 'commit', 'run-url', 'package', 'source-commit', 'version', 'plan', 'config'])

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const readReceipt = file => {
  let bytes
  try {
    bytes = fs.readFileSync(file)
  } catch (error) {
    refuse(`could not read receipt ${file}: ${error.message}`)
  }
  let document
  try {
    document = JSON.parse(utf8Decoder.decode(bytes))
  } catch (error) {
    refuse(`receipt ${file} is not UTF-8 JSON: ${error.message}`)
  }
  return { bytes, document }
}

const commitInput = (value, flag) => {
  const commit = String(value).toLowerCase()
  if (!SHA_PATTERN.test(commit)) refuse(`${flag} must be a 40-64 character hexadecimal Git commit`)
  return commit
}

const runUrlInput = value => {
  try {
    return assertHttpsUrl(value, '--run-url')
  } catch (error) {
    refuse(error.message)
  }
}

const versionInput = value => {
  if (!VERSION_PATTERN.test(value)) refuse('--version must be an exact X.Y.Z version without a leading v')
  return value
}

const readBytes = (file, flag) => {
  try {
    return fs.readFileSync(file)
  } catch (error) {
    refuse(`could not read ${flag} ${file}: ${error.message}`)
  }
}

const feedsDirInput = dir => {
  let stat
  try {
    stat = fs.statSync(dir)
  } catch (error) {
    refuse(`could not read --feeds-dir ${dir}: ${error.message}`)
  }
  if (!stat.isDirectory()) refuse(`--feeds-dir ${dir} is not a directory`)
  let nested = false
  try {
    nested = fs.statSync(path.join(dir, 'feeds')).isDirectory()
  } catch {
  }
  if (nested) refuse(`--feeds-dir takes the feeds directory itself, not a repository root; pass ${path.join(dir, 'feeds')}`)
  try {
    return hashFeedFiles(dir)
  } catch (error) {
    refuse(`could not read --feeds-dir ${dir}: ${error.message}`)
  }
}

const planInput = file => {
  let plan
  try {
    plan = JSON.parse(utf8Decoder.decode(readBytes(file, '--plan')))
  } catch (error) {
    if (error instanceof VerifyError) throw error
    refuse(`--plan ${file} is not UTF-8 JSON: ${error.message}`)
  }
  if (plan?.plan_schema !== 'model-eol.plan/0.1') refuse(`--plan ${file} has plan schema ${plan?.plan_schema ?? 'missing'}; expected model-eol.plan/0.1`)
  try {
    return assertValidPlanDocument(plan)
  } catch (error) {
    refuse(`--plan ${file} is not a valid plan: ${error.message}`)
  }
}

const configInput = (file, env) => {
  let config
  try {
    config = loadConfig(file, { allowMissing: false })
  } catch (error) {
    refuse(`--config ${file}: ${error.message}`)
  }
  const override = env.MODEL_EOL_EVAL_COMMAND || null
  const settings = effectiveEval(config, override)
  const note = override === null
    ? ''
    : settings.command === override
      ? ' with the MODEL_EOL_EVAL_COMMAND override from the environment'
      : ' (MODEL_EOL_EVAL_COMMAND is set but blank, so eval.command applies)'
  return { config, settings, label: `--config ${file}${note}` }
}

const compare = (claim, expected, actual, input) => ({
  claim,
  status: expected === actual ? 'verified' : 'mismatch',
  expected,
  actual,
  input,
})

const notChecked = (claim, input) => ({ claim, status: 'not-checked', input })

const notApplicable = (claim, input) => input === undefined
  ? { claim, status: 'not-applicable' }
  : { claim, status: 'not-applicable', input }

const flagLabel = (flag, value) => `--${flag} ${value}`

const feedClaims = (receiptFeeds, dir) => {
  if (dir === undefined) return receiptFeeds.map(feed => notChecked(feed.path, '--feeds-dir DIR'))
  const actual = new Map(feedsDirInput(dir).map(feed => [feed.path, feed.sha256]))
  const expected = new Map(receiptFeeds.map(feed => [feed.path, feed.sha256]))
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .sort((left, right) => left.localeCompare(right))
    .map(file => compare(file, expected.get(file) ?? null, actual.get(file) ?? null, flagLabel('feeds-dir', dir)))
}

const refreshClaims = (receipt, inputs) => [
  ...feedClaims(receipt.feeds, inputs['feeds-dir']),
  inputs.commit === undefined
    ? notChecked('refresh_commit', '--commit SHA')
    : compare('refresh_commit', receipt.refresh_commit, commitInput(inputs.commit, '--commit'), flagLabel('commit', inputs.commit)),
  inputs['run-url'] === undefined
    ? notChecked('refresh_run', '--run-url URL')
    : compare('refresh_run', assertHttpsUrl(receipt.refresh_run, 'refresh_run'), runUrlInput(inputs['run-url']), flagLabel('run-url', inputs['run-url'])),
]

const releaseClaims = (receipt, inputs) => {
  const sourceCommit = inputs['source-commit'] === undefined
    ? notChecked('source_commit', '--source-commit SHA')
    : compare('source_commit', receipt.source_commit, commitInput(inputs['source-commit'], '--source-commit'), flagLabel('source-commit', inputs['source-commit']))
  const given = flag => inputs[flag] === undefined ? undefined : flagLabel(flag, inputs[flag])
  if (!receipt.released) {
    return [
      sourceCommit,
      notApplicable('release_commit', given('commit')),
      notApplicable('version', given('version')),
      notApplicable('registry_integrity', given('package')),
    ]
  }
  return [
    sourceCommit,
    inputs.commit === undefined
      ? notChecked('release_commit', '--commit SHA')
      : compare('release_commit', receipt.release_commit, commitInput(inputs.commit, '--commit'), given('commit')),
    inputs.version === undefined
      ? notChecked('version', '--version X.Y.Z')
      : compare('version', receipt.version, versionInput(inputs.version), given('version')),
    inputs.package === undefined
      ? notChecked('registry_integrity', '--package FILE.tgz')
      : compare('registry_integrity', receipt.registry_integrity, sha512Integrity(readBytes(inputs.package, '--package')), given('package')),
  ]
}

const resultLabel = ({ publisher, id, via }) => `${publisher}/${id}${via ? `@${via}` : ''}`

const evalResultClaims = (receipt, { plan, config, feedsDir }) => {
  const claimFor = result => `results[${resultLabel(result)}].feed_digest`
  if (!plan || !config || feedsDir === undefined) {
    return receipt.results.map(result => notChecked(claimFor(result), '--plan FILE, --feeds-dir DIR, and --config FILE'))
  }
  feedsDirInput(feedsDir)
  if (!receipt.configured) return []
  const input = `--plan, ${flagLabel('feeds-dir', feedsDir)}, and ${config.label}`
  // plan files are root-relative as `model-eol plan .` writes them, so any absolute root reproduces the bot's ignore matching
  const groups = modelGroups(plan, config.config, path.resolve('/'), feedContext(feedsDir))
  const planned = new Map(groups.map(group => [evalIdentity(group.publisher, group.id, group.via), group]))
  const seen = new Set()
  const claims = []
  for (const result of receipt.results) {
    const key = evalIdentity(result.publisher, result.id, result.via)
    const group = planned.get(key)
    if (seen.has(key)) claims.push({ claim: `${claimFor(result)} (duplicate)`, status: 'mismatch', expected: result.feed_digest, actual: null, input })
    else if (!group) claims.push({ claim: claimFor(result), status: 'mismatch', expected: result.feed_digest, actual: null, input })
    else claims.push(compare(claimFor(result), result.feed_digest, group.feedDigest, input))
    seen.add(key)
  }
  for (const [key, group] of planned) {
    if (!seen.has(key)) claims.push({ claim: claimFor(group), status: 'mismatch', expected: null, actual: group.feedDigest, input })
  }
  return claims
}

const evalClaims = (receipt, inputs, env) => {
  const plan = inputs.plan === undefined ? null : planInput(inputs.plan)
  const config = inputs.config === undefined ? null : configInput(inputs.config, env)
  return [
    inputs.commit === undefined
      ? notChecked('base_sha', '--commit SHA')
      : compare('base_sha', receipt.base_sha, commitInput(inputs.commit, '--commit'), flagLabel('commit', inputs.commit)),
    plan
      ? compare('plan_digest', receipt.plan_digest, planDigest(plan), flagLabel('plan', inputs.plan))
      : notChecked('plan_digest', '--plan FILE'),
    config
      ? compare('eval_config_digest', receipt.eval_config_digest, evalConfigDigest(config.settings), config.label)
      : notChecked('eval_config_digest', '--config FILE'),
    config
      ? compare('configured', receipt.configured, Boolean(config.settings.command), config.label)
      : notChecked('configured', '--config FILE'),
    ...evalResultClaims(receipt, { plan, config, feedsDir: inputs['feeds-dir'] }),
  ]
}

export const verifyReceipt = ({ file, inputs = {}, env = process.env }) => {
  const { bytes, document } = readReceipt(file)
  const schema = typeof document?.schema === 'string' ? document.schema : null
  const kind = KINDS.get(schema)
  if (!kind) {
    refuse(`unsupported receipt schema ${schema === null ? '(missing)' : JSON.stringify(schema)}; supported schemas: ${SUPPORTED_RECEIPT_SCHEMAS.join(', ')}`)
  }
  const foreign = Object.keys(inputs).filter(flag => inputs[flag] !== undefined && !kind.inputs.includes(flag))
  if (foreign.length) refuse(`${foreign.map(flag => `--${flag}`).join(', ')} does not apply to ${schema} receipts; accepted inputs: ${kind.inputs.map(flag => `--${flag}`).join(', ')}`)
  const structural = validateDocument(document, { type: kind.type })
  if (structural.errors.length) refuse(`structurally invalid ${schema} receipt ${file}:\n${formatDocumentErrors(structural.errors).map(error => `  ${error}`).join('\n')}`)
  const claims = kind.type === 'feed-refresh-receipt'
    ? refreshClaims(document, inputs)
    : kind.type === 'npm-release-result'
      ? releaseClaims(document, inputs)
      : evalClaims(document, inputs, env)
  return {
    schema: VERIFICATION_SCHEMA,
    receipt: { path: file, schema, sha256: sha256(bytes) },
    structural: 'valid',
    claims,
    result: verificationResult(claims),
  }
}

const shown = value => value === null ? '(absent)' : String(value)

export const formatVerification = report => {
  const width = Math.max(0, ...report.claims.map(claim => claim.claim.length))
  const lines = [
    `receipt ${report.receipt.path}`,
    `  schema ${report.receipt.schema}`,
    `  sha256 ${report.receipt.sha256}`,
    'structural: valid',
  ]
  for (const claim of report.claims) {
    const detail = claim.status === 'verified'
      ? `${shown(claim.actual)} (${claim.input})`
      : claim.status === 'mismatch'
        ? `receipt ${shown(claim.expected)}, ${claim.input} gives ${shown(claim.actual)}`
        : claim.status === 'not-checked'
          ? `needs ${claim.input}`
          : `the receipt records no release${claim.input ? `; ${claim.input} ignored` : ''}`
    lines.push(`  ${claim.status.padEnd(14)} ${claim.claim.padEnd(width)}  ${detail}`)
  }
  const unchecked = report.claims.filter(claim => claim.status === 'not-checked').length
  const mismatched = report.claims.filter(claim => claim.status === 'mismatch').length
  lines.push(report.result === 'mismatch'
    ? `result: mismatch (${mismatched} claim${mismatched === 1 ? '' : 's'} contradicted by the supplied inputs)`
    : report.result === 'partial'
      ? `result: partial (no mismatch, but ${unchecked} claim${unchecked === 1 ? ' was' : 's were'} not checked; supply the inputs above, or use --require-all to fail)`
      : 'result: verified (every applicable claim matched the supplied inputs)')
  return lines.join('\n')
}
