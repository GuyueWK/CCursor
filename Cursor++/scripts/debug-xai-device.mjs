// SuperGrok device-code login probe (terminal version of the panel flow).
//
// Mirrors the opencode xAI plugin fingerprint:
//   client_id = b1a00492-073a-47ea-816f-4c329264a828
//   scope     = openid profile email offline_access grok-cli:access api:access
//   referrer  = opencode
//
// Usage (PowerShell):
//   node scripts/debug-xai-device.mjs            # print challenge, poll until approved
//   node scripts/debug-xai-device.mjs --save     # also write ~/.ccursor/xai-credentials.json
//
// Output is one JSON line per event, desensitised: token length + 4-char
// hint only. Paste the lines back; they contain no secret.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const ISSUER = 'https://auth.x.ai/oauth2'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const REQUEST_TIMEOUT_MS = 15000
const POLL_SAFETY_MARGIN_MS = 3000
const SLOW_DOWN_EXTRA_MS = 5000
const SHOULD_SAVE = process.argv.includes('--save')
const CREDENTIALS_PATH = join(homedir(), '.ccursor', 'xai-credentials.json')

function logEvent(event) {
  console.log(JSON.stringify(event))
}

function describeToken(token) {
  if (!token)
    return 'none'
  return `len=${token.length} hint=${String(token).slice(0, 4)}...`
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Cursor++/ccursor (xai-oauth-debug)',
    },
    body: new URLSearchParams(params).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  }
  catch {
    body = null
  }
  return { status: response.status, ok: response.ok, body, snippet: text.slice(0, 200) }
}

function positiveSeconds(value, fallback) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds : fallback
}

const started = await postForm(`${ISSUER}/device/code`, {
  client_id: CLIENT_ID,
  scope: SCOPE,
  referrer: 'opencode',
})
if (!started.ok || !started.body?.device_code || !started.body?.user_code || !started.body?.verification_uri) {
  logEvent({ phase: 'device-code', ok: false, status: started.status, snippet: started.snippet })
  process.exit(1)
}
const deviceCode = started.body.device_code
const userCode = started.body.user_code
const verificationUri = started.body.verification_uri_complete || started.body.verification_uri
const expiresInSec = positiveSeconds(started.body.expires_in, 300)
let intervalMs = Math.max(positiveSeconds(started.body.interval, 5) * 1000, 1000)
const expiresAtMs = Date.now() + expiresInSec * 1000
logEvent({ phase: 'challenge', ok: true, url: verificationUri, userCode, expiresInSec })

let pair = null
for (;;) {
  if (Date.now() >= expiresAtMs) {
    logEvent({ phase: 'poll', ok: false, error: 'expired_token - device code expired, re-run' })
    process.exit(1)
  }
  const attempt = await postForm(`${ISSUER}/token`, {
    grant_type: DEVICE_GRANT,
    client_id: CLIENT_ID,
    device_code: deviceCode,
  })
  if (attempt.ok && attempt.body?.access_token) {
    pair = attempt.body
    break
  }
  const errorCode = attempt.body?.error
  if (errorCode === 'authorization_pending') {
    await new Promise(resolve => setTimeout(resolve, intervalMs + POLL_SAFETY_MARGIN_MS))
    continue
  }
  if (errorCode === 'slow_down') {
    intervalMs += SLOW_DOWN_EXTRA_MS
    await new Promise(resolve => setTimeout(resolve, intervalMs + POLL_SAFETY_MARGIN_MS))
    continue
  }
  logEvent({ phase: 'poll', ok: false, status: attempt.status, error: errorCode || '(unknown)', snippet: attempt.snippet })
  process.exit(1)
}

const accessToken = String(pair.access_token || '')
const refreshToken = String(pair.refresh_token || '')
if (!refreshToken) {
  logEvent({ phase: 'poll', ok: false, error: 'missing refresh_token in token response' })
  process.exit(1)
}
const expiresIn = Number(pair.expires_in)
const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : Date.now() + 3600 * 1000
logEvent({
  phase: 'poll',
  ok: true,
  access: describeToken(accessToken),
  refresh: describeToken(refreshToken),
  expiresInSec: Math.round((expiresAt - Date.now()) / 1000),
})

if (SHOULD_SAVE) {
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true })
  const payload = JSON.stringify({
    access: accessToken,
    refresh: refreshToken,
    expiresAt,
    obtainedAt: new Date().toISOString(),
  }, null, 2)
  const tmpPath = `${CREDENTIALS_PATH}.tmp-${process.pid}`
  writeFileSync(tmpPath, `${payload}\n`, 'utf-8')
  renameSync(tmpPath, CREDENTIALS_PATH)
  const readable = existsSync(CREDENTIALS_PATH) ? readFileSync(CREDENTIALS_PATH, 'utf-8').length : 0
  logEvent({ phase: 'save', ok: true, path: CREDENTIALS_PATH, bytes: readable })
}
