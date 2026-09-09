export const MAX_SOURCE_BODY_BYTES = 8 * 1024 * 1024

export async function fetchBoundedBody(url, source, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('this Node runtime has no built-in fetch')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    // Request English source documents.
    const response = await fetchImpl(url, { headers: { 'accept-language': 'en' }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
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
    const body = Buffer.concat(chunks).toString('utf8')
    if (!body.trim()) throw new Error('empty response')
    return body
  } catch (error) {
    controller.abort()
    throw new Error(`${source} fetch failed for ${url}: ${error.message}`)
  } finally {
    clearTimeout(timeout)
  }
}

