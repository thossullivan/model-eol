// AWS Signature Version 4 for header-signed requests, with node:crypto only.
import crypto from 'node:crypto'

export const AWS_SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'

const sha256 = data => crypto.createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest()

/** RFC 3986 encoding: every byte except unreserved characters is percent-encoded in upper case. */
export function awsUriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function decodeComponent(value) {
  try {
    return decodeURIComponent(value.replace(/\+/g, '%20'))
  } catch {
    throw new Error('the request URL has a malformed percent escape')
  }
}

/** The canonical query string: each name and value decoded, re-encoded, and sorted by name, then value. */
export function awsCanonicalQuery(search) {
  const query = search.replace(/^\?/, '')
  if (!query) return ''
  return query.split('&').filter(Boolean).map(pair => {
    const index = pair.indexOf('=')
    const name = index < 0 ? pair : pair.slice(0, index)
    const value = index < 0 ? '' : pair.slice(index + 1)
    return [awsUriEncode(decodeComponent(name)), awsUriEncode(decodeComponent(value))]
  }).sort(([leftName, leftValue], [rightName, rightValue]) => (
    leftName < rightName ? -1 : leftName > rightName ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
  )).map(([name, value]) => `${name}=${value}`).join('&')
}

// Services other than S3 encode each already-encoded path segment once more.
const canonicalPath = pathname => pathname.split('/').map(segment => awsUriEncode(segment)).join('/') || '/'

const amzDate = now => {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw new Error('the signing time is not a valid date')
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** The canonical request, string to sign, and headers to send for one request; the secret is used only to derive the signing key. */
export function signAwsRequest({ method = 'GET', url, headers = {}, body = '', region, service, credentials, now = new Date() }) {
  const { accessKeyId, secretAccessKey, sessionToken } = credentials ?? {}
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS signing needs an access key id and a secret access key')
  if (!/^[a-z0-9-]+$/.test(region ?? '') || !/^[a-z0-9-]+$/.test(service ?? '')) throw new Error('AWS signing needs a region and a service name')
  const target = new URL(url)
  const stamp = amzDate(now)
  const day = stamp.slice(0, 8)
  const signed = new Map()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization' || lower === 'host' || lower === 'x-amz-date' || lower === 'x-amz-security-token') {
      throw new Error(`AWS signing sets the ${lower} header itself`)
    }
    signed.set(lower, String(value).trim().replace(/\s+/g, ' '))
  }
  signed.set('host', target.host)
  signed.set('x-amz-date', stamp)
  if (sessionToken) signed.set('x-amz-security-token', sessionToken)
  const names = [...signed.keys()].sort()
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(target.pathname),
    awsCanonicalQuery(target.search),
    ...names.map(name => `${name}:${signed.get(name)}`),
    '',
    signedHeaders,
    sha256(body),
  ].join('\n')
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = [AWS_SIGV4_ALGORITHM, stamp, scope, sha256(canonicalRequest)].join('\n')
  const key = [day, region, service, 'aws4_request'].reduce(hmac, `AWS4${secretAccessKey}`)
  const signature = hmac(key, stringToSign).toString('hex')
  const out = { ...headers, 'X-Amz-Date': stamp }
  if (sessionToken) out['X-Amz-Security-Token'] = sessionToken
  out.Authorization = `${AWS_SIGV4_ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { headers: out, canonicalRequest, stringToSign, signature }
}
