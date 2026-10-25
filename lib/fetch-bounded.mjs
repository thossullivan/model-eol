export const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024
export const SOURCE_FETCH_DEADLINE_MS = 30_000
export const MAX_ERROR_DETAIL_BYTES = 1024

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

export async function fetchBoundedBody(url, source, fetchImpl = globalThis.fetch, { headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  const controller = new AbortController()
  let timedOut = false
  let errorStatus
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, SOURCE_FETCH_DEADLINE_MS)
  try {
    // Caller headers carry credentials, which must not follow a redirect to another origin.
    const redirect = Object.keys(headers).length ? 'error' : 'follow'
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    const response = await fetchImpl(url, { headers: { 'accept-language': 'en', ...headers }, redirect, signal: controller.signal })
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
    let reason = timedOut ? (errorStatus === undefined ? deadline : `HTTP ${errorStatus}, then ${deadline} reading the body`) : `${error.message}${cause}`
    // Node echoes a rejected header value, which may be a credential, in its error message.
    for (const value of Object.values(headers)) if (String(value).length >= 8) reason = reason.split(String(value)).join('[redacted]')
    throw new Error(`${source} fetch failed for ${url}: ${reason.replace(/\s+/g, ' ')}`)
  } finally {
    clearTimeout(timeout)
  }
}
