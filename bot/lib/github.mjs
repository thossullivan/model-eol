const linkFor = (headers, relation) => {
  const value = headers?.get?.('link') || headers?.get?.('Link') || headers?.link || headers?.Link || ''
  const match = value.split(',').map(part => part.trim()).find(part => part.endsWith(`rel="${relation}"`))
  return match?.match(/^<([^>]+)>/)?.[1] ?? null
}

const bodyFromResponse = async response => {
  if (response === null || response === undefined) return null
  if (Array.isArray(response)) return response
  if (typeof response.json === 'function') {
    try {
      return await response.json()
    } catch (error) {
      if (response.status === 204) return null
      throw error
    }
  }
  if (response.data !== undefined) return response.data
  if (response.body !== undefined) {
    if (typeof response.body === 'string') {
      try { return JSON.parse(response.body) } catch { return response.body }
    }
    return response.body
  }
  return response
}

export class GitHubClient {
  constructor({ repo, apiUrl = 'https://api.github.com', token, transport = globalThis.fetch }) {
    this.repo = repo
    this.apiUrl = apiUrl.replace(/\/$/, '')
    this.token = token
    this.transport = transport
  }

  url(value) {
    return value.startsWith('http://') || value.startsWith('https://')
      ? value
      : `${this.apiUrl}${value}`
  }

  async request(method, endpoint, body = undefined) {
    if (typeof this.transport !== 'function') throw new Error('GitHub transport is not callable')
    const headers = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.token}`,
      'x-github-api-version': '2022-11-28',
    }
    const options = { method, headers }
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      options.body = JSON.stringify(body)
    }
    const response = await this.transport(this.url(endpoint), options)
    const status = typeof response?.status === 'number' ? response.status : 200
    const data = await bodyFromResponse(response)
    if (status >= 400 || response?.ok === false) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data)
      throw new Error(`GitHub ${method} ${endpoint} failed (${status}): ${detail}`)
    }
    return { data, response }
  }

  async listAll(resource) {
    const result = []
    let endpoint = `${resource}?state=all&per_page=100&page=1`
    for (let page = 0; page < 1000; page++) {
      const { data, response } = await this.request('GET', endpoint)
      if (!Array.isArray(data)) throw new Error(`GitHub ${resource} response was not an array`)
      result.push(...data)
      const next = linkFor(response?.headers, 'next')
      if (next) {
        endpoint = next
        continue
      }
      if (data.length < 100) break
      const nextPage = page + 2
      endpoint = `${resource}?state=all&per_page=100&page=${nextPage}`
    }
    return result
  }

  async listPulls() {
    return this.listAll(`/repos/${this.repo}/pulls`)
  }

  async listPullsByHead(branch) {
    const owner = this.repo.split('/')[0]
    const head = encodeURIComponent(`${owner}:${branch}`)
    const { data } = await this.request('GET', `/repos/${this.repo}/pulls?state=all&head=${head}&per_page=100&page=1`)
    if (!Array.isArray(data)) throw new Error(`GitHub pull request head query response was not an array`)
    return data
  }

  async listIssues() {
    const issues = await this.listAll(`/repos/${this.repo}/issues`)
    return issues.filter(issue => !issue.pull_request)
  }

  async createPull(payload) {
    const { data } = await this.request('POST', `/repos/${this.repo}/pulls`, payload)
    if (data?.number === undefined) throw new Error('GitHub pull request response did not contain a number')
    await this.request('POST', `/repos/${this.repo}/issues/${data.number}/labels`, { labels: ['model-eol'] })
    return data
  }

  async updatePull(number, payload) {
    return (await this.request('PATCH', `/repos/${this.repo}/pulls/${number}`, payload)).data
  }

  async comment(number, body) {
    return (await this.request('POST', `/repos/${this.repo}/issues/${number}/comments`, { body })).data
  }

  async createIssue(payload) {
    return (await this.request('POST', `/repos/${this.repo}/issues`, payload)).data
  }

  async updateIssue(number, payload) {
    return (await this.request('PATCH', `/repos/${this.repo}/issues/${number}`, payload)).data
  }
}

export const labelNames = item => (item.labels ?? []).map(label => typeof label === 'string' ? label : label?.name).filter(Boolean)

export const hasModelEolLabel = item => labelNames(item).includes('model-eol')
