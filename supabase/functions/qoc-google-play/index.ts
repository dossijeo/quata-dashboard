import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

type ServiceAccount = { client_email: string; private_key: string; token_uri: string }
type GoogleReleaseNote = { language?: string; text?: string }
type GoogleTrackRelease = {
  versionCodes?: string[]
  status?: string
  userFraction?: number
  releaseNotes?: GoogleReleaseNote[]
  name?: string
}
type GoogleTrack = { track?: string; releases?: GoogleTrackRelease[] }

function base64Url(value: string) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function pemToBytes(pem: string) {
  const raw = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
  const binary = atob(raw)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function getAccessToken(account: ServiceAccount) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting',
    aud: account.token_uri,
    iat: now,
    exp: now + 3600,
  }))
  const unsigned = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const response = await fetch(account.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${base64Url(String.fromCharCode(...new Uint8Array(signature)))}`,
    }),
  })
  if (!response.ok) throw new Error(`google_token_${response.status}`)
  const body = await response.json() as { access_token?: string }
  if (!body.access_token) throw new Error('google_token_missing')
  return body.access_token
}

async function googleJson(url: string, token: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`google_api_${response.status}`)
  return body as Record<string, unknown>
}

function googleDay(date: Date) {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), timeZone: { id: 'America/Los_Angeles' } }
}

async function queryVitals(metricSet: 'crashRateMetricSet' | 'anrRateMetricSet', token: string, packageName: string) {
  const end = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const start = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
  const metrics = metricSet === 'crashRateMetricSet'
    ? ['crashRate', 'crashRate7dUserWeighted', 'distinctUsers']
    : ['anrRate', 'anrRate7dUserWeighted', 'distinctUsers']
  return googleJson(
    `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${packageName}/${metricSet}:query`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timelineSpec: { aggregationPeriod: 'DAILY', startTime: googleDay(start), endTime: googleDay(end) },
        metrics,
        pageSize: 100,
      }),
    },
  )
}

async function getTracks(token: string, packageName: string) {
  const edit = await googleJson(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  const editId = String(edit.id || '')
  if (!editId) throw new Error('play_edit_missing')
  try {
    return await googleJson(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits/${editId}/tracks`, token)
  } finally {
    await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/edits/${editId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined)
  }
}

/**
 * Android Publisher keeps only the releases currently exposed by a track. We
 * retain every normalized production release in Supabase instead of deleting
 * records that later disappear from the response. A multi-code Play release is
 * represented once, with its largest version code as the client-facing code.
 */
async function archiveProductionReleases(
  admin: ReturnType<typeof createClient>,
  packageName: string,
  tracksPayload: Record<string, unknown>,
) {
  const tracks = (tracksPayload.tracks || []) as GoogleTrack[]
  const production = tracks.find((track) => track.track === 'production')
  const releases = production?.releases || []
  let archived = 0
  let notesArchived = 0

  for (const release of releases) {
    const versionCodes = (release.versionCodes || [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((left, right) => left - right)
    if (versionCodes.length === 0) continue

    const notes = (release.releaseNotes || [])
      .map((note) => ({
        languageTag: note.language?.trim(),
        text: note.text?.trim(),
      }))
      .filter((note): note is { languageTag: string; text: string } => Boolean(note.languageTag && note.text))
    const canonicalCode = versionCodes[versionCodes.length - 1]
    const status = release.status || 'unknown'
    const visible = notes.length > 0 && ['completed', 'inProgress', 'halted'].includes(status)
    const { data: storedRelease, error: releaseError } = await admin
      .from('android_releases')
      .upsert({
        package_name: packageName,
        track: 'production',
        version_code: canonicalCode,
        version_codes: versionCodes,
        version_name: release.name || null,
        release_status: status,
        rollout_fraction: typeof release.userFraction === 'number' ? release.userFraction : null,
        last_synced_at: new Date().toISOString(),
        visible_in_whats_new: visible,
        language_count: notes.length,
        source_payload: release,
      }, { onConflict: 'package_name,track,version_code' })
      .select('id')
      .single()
    if (releaseError) throw releaseError
    archived += 1

    if (storedRelease && notes.length > 0) {
      const { error: notesError } = await admin
        .from('android_release_notes')
        .upsert(notes.map((note) => ({
          release_id: storedRelease.id,
          language_tag: note.languageTag,
          note_text: note.text,
          updated_at: new Date().toISOString(),
        })), { onConflict: 'release_id,language_tag' })
      if (notesError) throw notesError
      notesArchived += notes.length
    }
  }

  return { releases: archived, notes: notesArchived }
}

async function collectGooglePlayData() {
  const rawAccount = Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_B64')
    ? atob(Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_B64') ?? '')
    : Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')
  if (!rawAccount) throw new Error('google_play_not_configured')
  const account = JSON.parse(rawAccount) as ServiceAccount
  const packageName = Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME') || 'com.quata'
  const token = await getAccessToken(account)
  const [apps, tracks, crashMetrics, anrMetrics, anomalies] = await Promise.all([
    googleJson('https://playdeveloperreporting.googleapis.com/v1beta1/apps:search?pageSize=100', token),
    getTracks(token, packageName),
    queryVitals('crashRateMetricSet', token, packageName),
    queryVitals('anrRateMetricSet', token, packageName),
    googleJson(`https://playdeveloperreporting.googleapis.com/v1beta1/apps/${packageName}/anomalies?pageSize=25`, token),
  ])
  return {
    packageName,
    payload: {
      app: ((apps.apps as Record<string, unknown>[] | undefined) || []).find((item) => item.packageName === packageName) || { packageName },
      tracks: tracks.tracks || [],
      vitals: { crash: crashMetrics.rows || [], anr: anrMetrics.rows || [], anomalies: anomalies.anomalies || [] },
      refreshedAt: new Date().toISOString(),
    },
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const syncRequest = request.headers.get('x-qoc-google-play-sync')
  const syncSecret = Deno.env.get('GOOGLE_PLAY_SYNC_SECRET')

  if (syncSecret && syncRequest === syncSecret) {
    try {
      const result = await collectGooglePlayData()
      const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
      const trackPayload = { tracks: result.payload.tracks }
      const archive = await archiveProductionReleases(admin, result.packageName, trackPayload)
      const { error } = await admin.from('qoc_google_play_snapshots').insert({
        package_name: result.packageName,
        payload: { ...result.payload, releaseArchive: archive },
      })
      if (error) throw error
      return Response.json({ synced: true, refreshedAt: result.payload.refreshedAt, releaseArchive: archive }, { headers: corsHeaders })
    } catch (error) {
      console.error(error)
      return Response.json({ error: 'google_play_sync_failed' }, { status: 502, headers: corsHeaders })
    }
  }

  const authorization = request.headers.get('authorization')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const sessionClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization ?? '' } } })
  const { data: session, error: sessionError } = await sessionClient.rpc('qoc_session')
  if (!authorization || sessionError || !session) return Response.json({ error: 'qoc_access_denied' }, { status: 403, headers: corsHeaders })

  const { data, error } = await sessionClient.rpc('qoc_google_play_latest')
  if (error) return Response.json({ error: 'google_play_cache_unavailable' }, { status: 502, headers: corsHeaders })
  return Response.json(data ?? { state: 'pending' }, { headers: corsHeaders })
})
