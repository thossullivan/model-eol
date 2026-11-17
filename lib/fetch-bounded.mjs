export const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024
export const SOURCE_FETCH_DEADLINE_MS = 30_000
export const MAX_ERROR_DETAIL_BYTES = 1024
export const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function readBoundedBody(response) {
  const tooLarge = () => new Error(`response exceeds ${MAX_SOURCE_BODY_BYTES} bytes`)
  if (Number(response.headers?.get('content-length')) > MAX_SOURCE_BODY_BYTES) throw tooLarge()
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text) > MAX_SOURCE_BODY_BYTES) throw tooLarge()
    return text.replace(/^\uFEFF/, '')
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_SOURCE_BODY_BYTES) throw tooLarge()
    chunks.push(buffer)
  }
  // TextDecoder strips a leading BOM as response.text() does.
  return new TextDecoder().decode(Buffer.concat(chunks))
}

async function readErrorDetail(response) {
  let text = ''
  if (!response.body) {
    text = typeof response.text === 'function' ? (await response.text()).slice(0, MAX_ERROR_DETAIL_BYTES) : ''
  } else {
    const chunks = []
    let bytes = 0
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      chunks.push(buffer)
      bytes += buffer.byteLength
      if (bytes >= MAX_ERROR_DETAIL_BYTES) break
    }
    text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_ERROR_DETAIL_BYTES))
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key'])
const CREDENTIAL_HEADER_HINT = /auth|key|token|secret|session|cookie|password|signature|credential/i

/** Header names that carry a credential: the known ones, any name that looks like one, and every name in secretHeaders. */
export function credentialHeaderNames(headers = {}, secretHeaders = []) {
  const secret = new Set([...secretHeaders].map(name => String(name).toLowerCase()))
  return Object.keys(headers).filter(name => {
    const lower = name.toLowerCase()
    return CREDENTIAL_HEADERS.has(lower) || CREDENTIAL_HEADER_HINT.test(lower) || secret.has(lower)
  })
}

function redactCredentials(text, values) {
  let redacted = text
  for (const value of values) {
    const parts = [value, ...value.split(/\s+/)].filter(part => part.length >= 8)
    for (const part of parts) redacted = redacted.split(part).join('[redacted]')
  }
  return redacted
}

export async function fetchBoundedBody(url, source, fetchImpl = globalThis.fetch, { headers = {}, secretHeaders = [] } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  const controller = new AbortController()
  let timedOut = false
  let errorStatus
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, SOURCE_FETCH_DEADLINE_MS)
  const credentials = credentialHeaderNames(headers, secretHeaders).map(name => String(headers[name]))
  try {
    // A credential must not follow a redirect to another origin; ordinary headers such as Accept may.
    const follow = !credentials.length
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    const init = { headers: { 'accept-language': 'en', ...headers }, redirect: follow ? 'manual' : 'error', signal: controller.signal }
    let target = url
    let response = await fetchImpl(target, init)
    for (let hop = 1; follow && REDIRECT_STATUSES.has(response.status); hop++) {
      if (hop > MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`)
      const location = typeof response.headers?.get === 'function' ? response.headers.get('location') : null
      if (!location) throw new Error(`HTTP ${response.status} redirect without a Location header`)
      const next = new URL(location, target)
      if (next.protocol !== 'https:') throw new Error(`redirected to a ${next.protocol} URL`)
      try { await response.body?.cancel?.() } catch {}
      target = next.href
      response = await fetchImpl(target, init)
    }
    const landed = typeof response.url === 'string' && response.url ? new URL(response.url) : undefined
    if (landed && new URL(url).protocol === 'https:' && landed.protocol !== 'https:') {
      throw new Error(`redirected to a ${landed.protocol} URL`)
    }
    if (!response.ok) {
      errorStatus = response.status
      let detail = ''
      try { detail = await readErrorDetail(response) } catch {}
      throw new Error(`HTTP ${response.status}${detail ? ` - ${detail}` : ''}`)
    }
    const body = await readBoundedBody(response)
    if (!body.trim()) throw new Error('empty response')
    return body
  } catch (error) {
    controller.abort()
    const deadline = `exceeded the ${SOURCE_FETCH_DEADLINE_MS} ms deadline`
    const cause = error.cause?.message ? ` (${String(error.cause.message).replace(/\s+/g, ' ')})` : ''
    const reason = timedOut ? (errorStatus === undefined ? deadline : `HTTP ${errorStatus}, then ${deadline} reading the body`) : `${error.message}${cause}`
    // Node echoes a rejected header value, which may be a credential, in its error message.
    throw new Error(`${source} fetch failed for ${url}: ${redactCredentials(reason, credentials).replace(/\s+/g, ' ')}`)
  } finally {
    clearTimeout(timeout)
  }
}
