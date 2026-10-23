export const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024
export const SOURCE_FETCH_DEADLINE_MS = 30_000

async function readBoundedBody(response) {
  const tooLarge = () => new Error(`response exceeds ${MAX_SOURCE_BODY_BYTES} bytes`)
  if (Number(response.headers?.get('content-length')) > MAX_SOURCE_BODY_BYTES) throw tooLarge()
  const chunks = []
  let bytes = 0
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > MAX_SOURCE_BODY_BYTES) throw tooLarge()
      chunks.push(Buffer.from(chunk))
    }
  } else {
    const chunk = Buffer.from(await response.text())
    if (chunk.byteLength > MAX_SOURCE_BODY_BYTES) throw tooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchBoundedBody(url, source, fetchImpl = globalThis.fetch, { headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, SOURCE_FETCH_DEADLINE_MS)
  try {
    // Providers geo-localize without Accept-Language; the date parsers are English-only.
    const response = await fetchImpl(url, { headers: { 'accept-language': 'en', ...headers }, signal: controller.signal })
    if (!response.ok) {
      let detail = ''
      try { detail = (await readBoundedBody(response)).trim().slice(0, 300) } catch {}
      throw new Error(`HTTP ${response.status}${detail ? ` - ${detail}` : ''}`)
    }
    const body = await readBoundedBody(response)
    if (!body.trim()) throw new Error('empty response')
    return body
  } catch (error) {
    controller.abort()
    throw new Error(`${source} fetch failed for ${url}: ${timedOut ? `exceeded the ${SOURCE_FETCH_DEADLINE_MS} ms deadline` : error.message}`)
  } finally {
    clearTimeout(timeout)
  }
}
