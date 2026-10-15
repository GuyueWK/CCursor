 // Route C probe: GET https://opencode.ai/zen/go/v1/usage with Bearer Go API key.
 //
 // Why this exists:
 //   The HTML scrape (route A) needs a browser session cookie and bounces to
 //   /console/login with a bare 302 whenever the session is not recognised.
 //   The Zen quota endpoint (route C, same one the web console is built on)
 //   only needs the Go API key you already use for inference, so there is
 //   no cookie, no workspaceId and no 302 guessing.
 //
 // Usage (PowerShell, key stays on this machine, do NOT paste it into chat):
 //   $env:GO_API_KEY = '<your Go API key>'   # or OPENCODE_API_KEY
 //   node scripts/debug-go-usage-zen.mjs
 //
 // Key resolution order (first hit wins, mirrors mellena1/opencode-go-usage):
 //   1. $env:GO_API_KEY
 //   2. $env:OPENCODE_API_KEY
 //   3. ~/.ccursor/providers.json (first provider whose baseUrl or name looks like opencode Go)
 //   4. opencode auth.json (opencode-go entry preferred over legacy opencode entry)
 //
 // Output is ONE JSON line, desensitised: key length + 4-char hint only,
 // plus HTTP status and the three usage windows when the call succeeds.
 // Paste the whole line back; it contains no secret.
 import { readFileSync, existsSync } from 'node:fs'
 import { homedir } from 'node:os'
 import { join } from 'node:path'

 const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go'
 const FETCH_TIMEOUT_MS = 15000

 function stripWrappingQuotes(rawText) {
   const trimmedText = String(rawText || '').trim()
   if (trimmedText.length >= 2) {
     const firstChar = trimmedText[0]
     const lastChar = trimmedText[trimmedText.length - 1]
     if ((firstChar === '"' && lastChar === '"') || (firstChar === '\'' && lastChar === '\'')) {
       return trimmedText.slice(1, -1).trim()
     }
   }
   return trimmedText
 }

 function normalizeApiKey(rawKey) {
   let cleanedKey = stripWrappingQuotes(rawKey)
   cleanedKey = cleanedKey.replace(/^bearer\s+/i, '').trim()
   cleanedKey = cleanedKey.replace(/\s+/g, '')
   return cleanedKey
 }

 function describeApiKey(normalizedKey) {
   if (!normalizedKey) {
     return { keyLength: 0, keyHint: 'none' }
   }
   const visiblePrefix = normalizedKey.slice(0, 4)
   return { keyLength: normalizedKey.length, keyHint: `${visiblePrefix}...` }
 }

 function readJsonFileSafely(filePath) {
   try {
     if (!existsSync(filePath)) {
       return null
     }
     const fileContent = readFileSync(filePath, 'utf8')
     return JSON.parse(fileContent)
   } catch (parseError) {
     return { __readError: parseError instanceof Error ? parseError.message : String(parseError) }
   }
 }

 function looksLikeGoProvider(providerEntry) {
   if (!providerEntry || typeof providerEntry !== 'object') {
     return false
   }
   const baseUrlText = String(providerEntry.baseUrl || '')
   const providerName = String(providerEntry.name || providerEntry.id || '')
   return baseUrlText.includes('opencode.ai/zen/go') || /opencode[\s_-]*go/i.test(providerName)
 }

 function extractKeyFromCcursorProviders() {
   const providersPath = join(homedir(), '.ccursor', 'providers.json')
   const parsedProviders = readJsonFileSafely(providersPath)
   if (!parsedProviders || parsedProviders.__readError || !Array.isArray(parsedProviders.providers)) {
     return null
   }
   for (const providerEntry of parsedProviders.providers) {
     if (!looksLikeGoProvider(providerEntry)) {
       continue
     }
     const candidateKey = providerEntry?.auth?.value
     const normalizedKey = normalizeApiKey(candidateKey || '')
     if (normalizedKey) {
       return { key: normalizedKey, source: `ccursor:providers.json:${providerEntry.id || providerEntry.name || 'go'}` }
     }
   }
   return null
 }

 function extractApiKeyFromAuthJsonObject(parsedAuthJson) {
   if (!parsedAuthJson || typeof parsedAuthJson !== 'object' || parsedAuthJson.__readError) {
     return null
   }
   const entryNamesInPreferenceOrder = ['opencode-go', 'opencode_go', 'opencode']
   for (const entryName of entryNamesInPreferenceOrder) {
     const authEntry = parsedAuthJson[entryName]
     if (!authEntry || typeof authEntry !== 'object') {
       continue
     }
     for (const fieldName of ['apiKey', 'apikey', 'key', 'token', 'accessToken']) {
       const candidateKey = normalizeApiKey(authEntry[fieldName] || '')
       if (candidateKey.length >= 8) {
         return { key: candidateKey, entryName }
       }
     }
   }
   return null
 }

 function extractKeyFromOpencodeAuthJson() {
   const candidatePaths = []
   if (process.env.OPENCODE_AUTH_JSON) {
     candidatePaths.push(String(process.env.OPENCODE_AUTH_JSON))
   }
   const xdgDataHome = process.env.XDG_DATA_HOME ? String(process.env.XDG_DATA_HOME) : ''
   if (xdgDataHome) {
     candidatePaths.push(join(xdgDataHome, 'opencode', 'auth.json'))
   }
   candidatePaths.push(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))
   candidatePaths.push(join(homedir(), '.config', 'opencode', 'auth.json'))
   if (process.env.APPDATA) {
     candidatePaths.push(join(String(process.env.APPDATA), 'opencode', 'auth.json'))
   }
   if (process.env.LOCALAPPDATA) {
     candidatePaths.push(join(String(process.env.LOCALAPPDATA), 'opencode', 'auth.json'))
   }
   for (const candidatePath of candidatePaths) {
     const parsedAuthJson = readJsonFileSafely(candidatePath)
     if (!parsedAuthJson) {
       continue
     }
     const extractedKey = extractApiKeyFromAuthJsonObject(parsedAuthJson)
     if (extractedKey) {
       return { key: extractedKey.key, source: `auth.json:${candidatePath}:${extractedKey.entryName}` }
     }
   }
   return null
 }

 function resolveGoApiKey() {
   const explicitKey = normalizeApiKey(process.env.GO_API_KEY || '')
   if (explicitKey) {
     return { key: explicitKey, source: 'env:GO_API_KEY' }
   }
   const opencodeEnvKey = normalizeApiKey(process.env.OPENCODE_API_KEY || '')
   if (opencodeEnvKey) {
     return { key: opencodeEnvKey, source: 'env:OPENCODE_API_KEY' }
   }
   const ccursorKey = extractKeyFromCcursorProviders()
   if (ccursorKey) {
     return ccursorKey
   }
   const authJsonKey = extractKeyFromOpencodeAuthJson()
   if (authJsonKey) {
     return authJsonKey
   }
   return null
 }

 function formatResetCountdown(resetsAtText) {
   if (!resetsAtText) {
     return ''
   }
   const resetsAtMs = Date.parse(String(resetsAtText))
   if (Number.isNaN(resetsAtMs)) {
     return String(resetsAtText).slice(0, 32)
   }
   const remainingSec = Math.max(0, Math.round((resetsAtMs - Date.now()) / 1000))
   const totalMinutes = Math.max(1, Math.round(remainingSec / 60))
   if (totalMinutes < 60) {
     return `${totalMinutes}m`
   }
   const totalHours = Math.floor(totalMinutes / 60)
   const restMinutes = totalMinutes % 60
   if (totalHours < 24) {
     return restMinutes > 0 ? `${totalHours}h${restMinutes}m` : `${totalHours}h`
   }
   const totalDays = Math.floor(totalHours / 24)
   const restHours = totalHours % 24
   return restHours > 0 ? `${totalDays}d${restHours}h` : `${totalDays}d`
 }

 function summarizeUsagePayload(parsedBody) {
   if (!parsedBody || typeof parsedBody !== 'object') {
     return { usage: null, topLevelKeys: [] }
   }
   const usageNode = parsedBody.usage || parsedBody.data?.usage || parsedBody
   if (!usageNode || typeof usageNode !== 'object') {
     return { usage: null, topLevelKeys: Object.keys(parsedBody).slice(0, 12) }
   }
   const pickWindow = (windowNode) => {
     if (!windowNode || typeof windowNode !== 'object') {
       return null
     }
     const percentValue = Number(windowNode.percent)
     if (!Number.isFinite(percentValue)) {
       return null
     }
     return {
       percent: percentValue,
       status: typeof windowNode.status === 'string' ? windowNode.status : undefined,
       resetsAt: typeof windowNode.resetsAt === 'string' ? windowNode.resetsAt : undefined,
       resetIn: typeof windowNode.resetsAt === 'string' ? formatResetCountdown(windowNode.resetsAt) : undefined,
     }
   }
   const rollingWindow = pickWindow(usageNode.rolling)
   const weeklyWindow = pickWindow(usageNode.weekly)
   const monthlyWindow = pickWindow(usageNode.monthly)
   if (!rollingWindow || !weeklyWindow || !monthlyWindow) {
     return { usage: null, topLevelKeys: Object.keys(usageNode).slice(0, 12) }
   }
   return { usage: { rolling: rollingWindow, weekly: weeklyWindow, monthly: monthlyWindow } }
 }

 const resolvedKey = resolveGoApiKey()
 if (!resolvedKey) {
   console.error('need GO_API_KEY or OPENCODE_API_KEY env var (or a configured Go provider / opencode auth.json)')
   process.exit(2)
 }

 const baseUrlText = stripWrappingQuotes(process.env.GO_BASE_URL || '').replace(/\/+$/, '') || DEFAULT_BASE_URL
 const usageUrl = `${baseUrlText}/v1/usage`
 const keyDescription = describeApiKey(resolvedKey.key)

 let httpStatus = -1
 let responseLocation = ''
 let parsedBody = null
 let bodySnippet = ''
 let fetchError = ''
 try {
   const httpResponse = await fetch(usageUrl, {
     method: 'GET',
     headers: {
       Accept: 'application/json',
       Authorization: `Bearer ${resolvedKey.key}`,
       'User-Agent': 'Cursor++/ccursor (go-usage-zen)',
     },
     redirect: 'manual',
     signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
   })
   httpStatus = httpResponse.status
   responseLocation = (httpResponse.headers.get('location') || '').slice(0, 200)
   const responseText = await httpResponse.text().catch(() => '')
   bodySnippet = responseText.slice(0, 300)
   try {
     parsedBody = responseText ? JSON.parse(responseText) : null
   } catch (jsonError) {
     parsedBody = null
   }
 } catch (thrownError) {
   fetchError = thrownError instanceof Error ? thrownError.message : String(thrownError)
 }

 const { usage: usageWindows, topLevelKeys } = summarizeUsagePayload(parsedBody)
 let displayText = null
 if (usageWindows) {
   displayText = `Go 5h ${Math.round(usageWindows.rolling.percent)}%(${usageWindows.rolling.resetIn || '?'}) · W${Math.round(usageWindows.weekly.percent)}%(${usageWindows.weekly.resetIn || '?'}) · M${Math.round(usageWindows.monthly.percent)}%`
 }

 let errorHint = fetchError || undefined
 if (!fetchError && !usageWindows) {
   if (httpStatus === 401) {
     errorHint = '401 = key rejected, check the Go API key (provider auth.value / OPENCODE_API_KEY)'
   } else if (httpStatus === 403) {
     errorHint = '403 = key valid but no Go subscription (EntitlementError), check the workspace plan'
   } else if (httpStatus >= 300 && httpStatus < 400) {
     errorHint = `redirect to ${responseLocation || '(empty)'} = endpoint moved or baseUrl wrong`
   } else if (httpStatus !== -1) {
     errorHint = `unexpected status, topLevelKeys=${(topLevelKeys || []).join(',') || '(empty)'} snippet=${bodySnippet.slice(0, 120)}`
   }
 }

 console.log(JSON.stringify({
   keySource: resolvedKey.source,
   keyLength: keyDescription.keyLength,
   keyHint: keyDescription.keyHint,
   baseUrl: baseUrlText,
   status: httpStatus,
   location: responseLocation || undefined,
   ok: usageWindows !== null,
   usage: usageWindows,
   display: displayText,
   errorHint,
 }))
