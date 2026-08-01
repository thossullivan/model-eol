import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const responseText = async response => {
  if (typeof response?.text === 'function') return response.text()
  if (typeof response?.body === 'string') return response.body
  if (response?.data !== undefined) return JSON.stringify(response.data)
  return JSON.stringify(response)
}

const validateFeed = (value, url) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${url} did not contain a JSON object`)
  if (value.spec !== 'model-eol/0.1') throw new Error(`${url} has unsupported spec ${value.spec}`)
  if (!Array.isArray(value.models)) throw new Error(`${url} has no models array`)
}

export const downloadFeeds = async ({ urls = [], fetchImpl = globalThis.fetch, vendoredDir, warn = console.error }) => {
  if (!urls.length) return { dir: vendoredDir, cleanup: () => {} }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-eol-feeds-'))
  try {
    for (const [index, url] of urls.entries()) {
      if (typeof fetchImpl !== 'function') throw new Error('feed fetch transport is not callable')
      const response = await fetchImpl(url)
      const status = typeof response?.status === 'number' ? response.status : 200
      if (status >= 400 || response?.ok === false) throw new Error(`${url} returned HTTP ${status}`)
      let value
      try {
        value = JSON.parse(await responseText(response))
      } catch (error) {
        throw new Error(`${url} was not valid JSON: ${error.message}`)
      }
      validateFeed(value, url)
      fs.writeFileSync(path.join(tempDir, `feed-${index}.json`), JSON.stringify(value, null, 2))
    }
    return {
      dir: tempDir,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    }
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    warn(`model-eol: warning: feed download failed (${error.message}); using vendored feeds`)
    return { dir: vendoredDir, cleanup: () => {} }
  }
}
