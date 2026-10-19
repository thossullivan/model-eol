import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { markdownFenceText } from './common.mjs'

const TRUNCATION_MARKER = '\n[model-eol: report truncated]'

const fitUtf8 = (text, limit) => {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  let end = Math.max(0, limit)
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

const truncateReport = (text, limit) => {
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER)
  if (limit <= markerBytes) return fitUtf8(TRUNCATION_MARKER, limit)
  return fitUtf8(text, limit - markerBytes) + TRUNCATION_MARKER
}

export const capReport = (report, limit) => {
  if (report === null || report === undefined) return null
  const cap = Math.max(0, limit)
  const text = Buffer.from(String(report), 'utf8').toString('utf8')
  return Buffer.byteLength(text) > cap ? truncateReport(text, cap) : text
}

export const readReportCapped = (file, limit) => {
  const cap = Math.max(0, limit)
  let lstat
  try {
    lstat = fs.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, report: null }
    throw error
  }
  if (!lstat.isFile() || lstat.isSymbolicLink()) throw new Error(`${file} is not a regular non-symlink file`)
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, report: null }
    throw error
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular non-symlink file`)
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  try {
    const buffer = Buffer.alloc(cap + 1)
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, Math.min(bytesRead, cap)).toString('utf8')
    const truncated = bytesRead > cap || Buffer.byteLength(text) > cap
    return { missing: false, truncated, report: truncated ? truncateReport(text, cap) : text }
  } finally {
    fs.closeSync(fd)
  }
}

export const runEvalHook = ({ command, timeoutMs, maxReportBytes, passEnv = [], cwd, oldId, newId, planPath, reportPath, via = null, mode = 'evaluate' }) => {
  if (mode !== 'evaluate') throw new Error(`unsupported eval mode: ${mode}`)
  if (fs.existsSync(reportPath)) fs.rmSync(reportPath, { force: true })
  const env = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'USER', 'SHELL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of passEnv) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.MODEL_EOL_OLD_ID = oldId
  env.MODEL_EOL_NEW_ID = newId
  env.MODEL_EOL_PLAN = planPath
  env.MODEL_EOL_REPORT = reportPath
  env.MODEL_EOL_VIA = via ?? ''
  env.MODEL_EOL_EVAL_MODE = mode

  const result = spawnSync(command, {
    cwd,
    env,
    shell: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  const timedOut = result.error?.code === 'ETIMEDOUT'
    || result.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  if (timedOut && Number.isInteger(result.pid)) {
    try {
      process.kill(-result.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw new Error(`could not kill eval process group: ${error.message}`)
    }
  }
  const exitCode = Number.isInteger(result.status) ? result.status : null
  let status = timedOut ? 'timeout' : exitCode === 0 ? 'pass' : 'fail'
  let report = null
  try {
    const artifact = readReportCapped(reportPath, maxReportBytes)
    if (artifact.missing && status === 'pass') {
      status = 'fail'
      report = 'eval report artifact is missing'
    } else {
      report = artifact.report
    }
  } catch (error) {
    if (status === 'pass') status = 'fail'
    report = `eval report artifact is unreadable: ${error.message}`
  }
  return { status, exit_code: exitCode, report }
}

export const reportForBody = report => markdownFenceText(report)
