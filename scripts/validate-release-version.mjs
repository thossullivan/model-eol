#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const parts = (value, label) => {
  const match = STABLE_SEMVER.exec(value)
  if (!match) throw new Error(`${label} must be stable x.y.z semver, got ${value}`)
  return match.slice(1).map(Number)
}

export const validateReleaseVersion = ({ current, requested, published = [] }) => {
  const currentParts = parts(current, 'package version')
  const requestedParts = parts(requested, 'release version')
  let comparison = 0
  for (let index = 0; index < requestedParts.length; index++) {
    if (requestedParts[index] === currentParts[index]) continue
    comparison = requestedParts[index] > currentParts[index] ? 1 : -1
    break
  }
  if (comparison <= 0) throw new Error(`release version ${requested} must be greater than package version ${current}`)
  if (published.includes(requested)) throw new Error(`model-eol@${requested} already exists on npm`)
  return requested
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [current, requested, publishedJson] = process.argv.slice(2)
    const parsed = JSON.parse(publishedJson)
    const published = Array.isArray(parsed) ? parsed : [parsed]
    console.log(validateReleaseVersion({ current, requested, published }))
  } catch (error) {
    console.error(`release validation failed: ${error.message}`)
    process.exitCode = 1
  }
}
