import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { fetchBoundedBody } from '../../lib/fetch-bounded.mjs'
import { assertValidFeed } from '../../lib/validate-feed.mjs'
import { logWarning } from './common.mjs'

const asBoundedResponse = response => {
  if (response instanceof Response) return response
  const status = typeof response?.status === 'number' ? response.status : 200
  const ok = status < 400 && response?.ok !== false
  const streamed = typeof response?.body?.[Symbol.asyncIterator] === 'function' && typeof response.body !== 'string'
  let text
  if (typeof response?.text === 'function') text = async () => String(await response.text())
  else if (typeof response?.body === 'string') text = async () => response.body
  else if (response?.data !== undefined) text = async () => JSON.stringify(response.data)
  else if (ok) text = async () => JSON.stringify(response)
  return {
    status,
    ok,
    headers: typeof response?.headers?.get === 'function' ? response.headers : undefined,
    body: streamed ? response.body : null,
    text,
  }
}

export const downloadFeeds = async ({
  urls = [],
  fetchImpl = globalThis.fetch,
  vendoredDir,
  allowVendoredFallback = false,
  warn = logWarning,
}) => {
  if (!urls.length) return { dir: vendoredDir, cleanup: () => {} }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-feeds-'))
  try {
    for (const [index, url] of urls.entries()) {
      if (typeof fetchImpl !== 'function') throw new Error('feed fetch transport is not callable')
      const text = await fetchBoundedBody(url, '--feeds-url', async (target, options) => asBoundedResponse(await fetchImpl(target, options)))
      let value
      try {
        value = JSON.parse(text)
      } catch (error) {
        throw new Error(`${url} was not valid JSON: ${error.message}`)
      }
      assertValidFeed(value, url)
      fs.writeFileSync(path.join(tempDir, `feed-${index}.json`), JSON.stringify(value, null, 2))
    }
    return {
      dir: tempDir,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    }
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    if (!allowVendoredFallback) throw new Error(`feed download failed: ${error.message}`)
    warn(`model-eol: warning: feed download failed (${error.message}); using vendored feeds in degraded report-only mode`)
    return { dir: vendoredDir, cleanup: () => {}, degraded: true }
  }
}
