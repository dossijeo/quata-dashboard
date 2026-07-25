import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

type Json = Record<string, unknown>
type Point = { latitude: number; longitude: number }
type Candidate = Point & {
  evidenceId: string
  sourceType: string
  publishedLabel: string
  resolvedLabel: string
  placeId: string
  confidence: number
  resolutionMethod: 'GEOCODING' | 'PLACES_TEXT_SEARCH'
  locationType: string
}

const text = (value: unknown, fallback = '') => String(value ?? fallback).trim()
const rows = (value: unknown) => Array.isArray(value) ? value as Json[] : []
const normalize = (value: unknown) => text(value)
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim()
const finite = (value: unknown) => value !== null && value !== undefined && text(value) !== '' && Number.isFinite(Number(value))
const plusCodePattern = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,}/i

const countryContext: Record<string, { code: string; name: string }> = {
  '240': { code: 'GQ', name: 'Equatorial Guinea' },
  '241': { code: 'GA', name: 'Gabon' },
  '34': { code: 'ES', name: 'Spain' },
}

function distanceSquared(left: Point, right: Point) {
  return (left.latitude - right.latitude) ** 2 + (left.longitude - right.longitude) ** 2
}

function scoreGeocode(label: string, result: Json): number {
  const types = rows(result.types).map((value) => text(value))
  const locationType = text((result.geometry as Json | undefined)?.location_type)
  const formatted = normalize(result.formatted_address)
  const normalizedLabel = normalize(label)
  if (types.includes('country')) return 0
  if (plusCodePattern.test(label)) return 0.99
  const locality = types.some((type) => ['locality', 'sublocality', 'neighborhood', 'administrative_area_level_3'].includes(type))
  const labelPresent = formatted.includes(normalizedLabel)
  if (locality && labelPresent) return 0.93
  if (locality && locationType === 'APPROXIMATE') return 0.82
  if (labelPresent && locationType === 'ROOFTOP') return 0.86
  if (labelPresent) return 0.79
  return 0
}

function scorePlace(label: string, place: Json): number {
  const normalizedLabel = normalize(label)
  const displayName = normalize((place.displayName as Json | undefined)?.text)
  const formatted = normalize(place.formattedAddress)
  const types = rows(place.types).map((value) => text(value))
  if (displayName === normalizedLabel) return 0.96
  if (displayName.startsWith(`${normalizedLabel} `) || displayName.startsWith(`${normalizedLabel}-`)) return 0.91
  if (types.some((type) => ['locality', 'sublocality', 'neighborhood'].includes(type)) && formatted.includes(normalizedLabel)) return 0.9
  if (displayName.includes(normalizedLabel) && formatted.includes(normalizedLabel)) return 0.84
  if (displayName.includes(normalizedLabel)) return 0.78
  return 0
}

async function resolveEvidence(
  apiKey: string,
  evidence: Json,
  country: { code: string; name: string } | undefined,
  anchors: Point[],
): Promise<Candidate | null> {
  const evidenceId = text(evidence.evidenceId)
  const sourceType = text(evidence.sourceType)
  const publishedLabel = text(evidence.placeLabel)
  const normalizedPublishedLabel = publishedLabel.replace(/\s+/g, ' ').trim()
  if (
    !normalizedPublishedLabel
    || normalizedPublishedLabel.startsWith('#')
    || (finite(evidence.latitude) && finite(evidence.longitude))
  ) return null

  const query = [normalizedPublishedLabel, country?.name].filter(Boolean).join(', ')
  const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  geocodeUrl.searchParams.set('address', query)
  geocodeUrl.searchParams.set('key', apiKey)
  if (country) geocodeUrl.searchParams.set('region', country.code.toLowerCase())
  const geocodeResponse = await fetch(geocodeUrl, { signal: AbortSignal.timeout(8_000) })
  const geocodePayload = await geocodeResponse.json().catch(() => ({})) as Json
  const geocodeCandidates = rows(geocodePayload.results)
    .map((result) => {
      const location = ((result.geometry as Json | undefined)?.location || {}) as Json
      return {
        result,
        latitude: Number(location.lat),
        longitude: Number(location.lng),
        score: scoreGeocode(normalizedPublishedLabel, result),
      }
    })
    .filter((candidate) => finite(candidate.latitude) && finite(candidate.longitude) && candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (!anchors.length) return 0
      const nearest = (candidate: Point) => Math.min(...anchors.map((anchor) => distanceSquared(candidate, anchor)))
      return nearest(left) - nearest(right)
    })
  const geocodeMatch = geocodeCandidates[0]
  if (geocodeMatch?.score >= 0.82) {
    return {
      evidenceId,
      sourceType,
      publishedLabel: normalizedPublishedLabel,
      resolvedLabel: text(geocodeMatch.result.formatted_address),
      placeId: text(geocodeMatch.result.place_id),
      latitude: geocodeMatch.latitude,
      longitude: geocodeMatch.longitude,
      confidence: geocodeMatch.score,
      resolutionMethod: 'GEOCODING',
      locationType: text((geocodeMatch.result.geometry as Json | undefined)?.location_type, 'APPROXIMATE'),
    }
  }
  const geocodeFallback = geocodeMatch?.score >= 0.65 ? {
    evidenceId,
    sourceType,
    publishedLabel: normalizedPublishedLabel,
    resolvedLabel: text(geocodeMatch.result.formatted_address),
    placeId: text(geocodeMatch.result.place_id),
    latitude: geocodeMatch.latitude,
    longitude: geocodeMatch.longitude,
    confidence: geocodeMatch.score,
    resolutionMethod: 'GEOCODING' as const,
    locationType: text((geocodeMatch.result.geometry as Json | undefined)?.location_type, 'APPROXIMATE'),
  } : null

  const placesResponse = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    signal: AbortSignal.timeout(8_000),
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    },
    body: JSON.stringify({
      textQuery: query,
      regionCode: country?.code,
      pageSize: 5,
      ...(anchors[0] ? {
        locationBias: {
          circle: {
            center: { latitude: anchors[0].latitude, longitude: anchors[0].longitude },
            radius: 150_000,
          },
        },
      } : {}),
    }),
  })
  const placesPayload = await placesResponse.json().catch(() => ({})) as Json
  const placeCandidates = rows(placesPayload.places)
    .map((place) => {
      const location = (place.location || {}) as Json
      return {
        place,
        latitude: Number(location.latitude),
        longitude: Number(location.longitude),
        score: scorePlace(normalizedPublishedLabel, place),
      }
    })
    .filter((candidate) => finite(candidate.latitude) && finite(candidate.longitude) && candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (!anchors.length) return 0
      const nearest = (candidate: Point) => Math.min(...anchors.map((anchor) => distanceSquared(candidate, anchor)))
      return nearest(left) - nearest(right)
    })
  const placeMatch = placeCandidates[0]
  const placeCandidate: Candidate | null = placeMatch?.score >= 0.65 ? {
    evidenceId,
    sourceType,
    publishedLabel: normalizedPublishedLabel,
    resolvedLabel: text(placeMatch.place.formattedAddress || (placeMatch.place.displayName as Json | undefined)?.text),
    placeId: text(placeMatch.place.id),
    latitude: placeMatch.latitude,
    longitude: placeMatch.longitude,
    confidence: placeMatch.score,
    resolutionMethod: 'PLACES_TEXT_SEARCH',
    locationType: 'APPROXIMATE',
  } : null
  if (placeCandidate && (!geocodeFallback || placeCandidate.confidence >= geocodeFallback.confidence)) return placeCandidate
  return geocodeFallback
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders })

  const token = request.headers.get('authorization')
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders })

  const body = await request.json().catch(() => null)
  const targetUserId = text(body?.targetUserId)
  const requestedIds = Array.isArray(body?.evidenceIds)
    ? body.evidenceIds.map((value: unknown) => text(value)).filter(Boolean).slice(0, 30)
    : []
  const reason = text(body?.reason).slice(0, 220) || null
  if (!targetUserId || !requestedIds.length) {
    return Response.json({ error: 'invalid_geocode_request' }, { status: 400, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: token } } })
  const { data: timeline, error: timelineError } = await userClient.rpc('qoc_citizen_security_location_timeline', {
    p_target_user_id: targetUserId,
    p_date_from: null,
    p_date_to: null,
    p_sources: null,
    p_only_coordinates: false,
    p_reason: reason,
  })
  if (timelineError || !timeline) {
    return Response.json({ error: 'citizen_security_access_denied' }, { status: 403, headers: corsHeaders })
  }

  const apiKey = Deno.env.get('GOOGLE_MAPS_SERVER_API_KEY')
  if (!apiKey) return Response.json({ error: 'geocoding_not_configured' }, { status: 503, headers: corsHeaders })

  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: profile } = await admin
    .from('community_profiles')
    .select('country_code')
    .eq('id', targetUserId)
    .maybeSingle()
  const country = countryContext[text(profile?.country_code).replace(/\D/g, '')]
  const events = rows((timeline as Json).events)
  const anchors = events
    .filter((event) => finite(event.latitude) && finite(event.longitude))
    .map((event) => ({ latitude: Number(event.latitude), longitude: Number(event.longitude) }))
  const requested = events.filter((event) => requestedIds.includes(text(event.evidenceId)))

  const resolved: Candidate[] = []
  const ambiguous: Candidate[] = []
  for (const evidence of requested) {
    try {
      const result = await resolveEvidence(apiKey, evidence, country, anchors)
      if (result?.confidence >= 0.82) resolved.push(result)
      else if (result) ambiguous.push(result)
    } catch {
      // One unavailable provider result must not block the remaining evidence.
    }
  }

  try {
    await userClient.rpc('qoc_citizen_security_log_geocode', {
      p_target_user_id: targetUserId,
      p_evidence_ids: requestedIds,
      p_resolved_count: resolved.length,
      p_ambiguous_count: ambiguous.length,
      p_rejected_count: Math.max(0, requested.length - resolved.length - ambiguous.length),
      p_reason: reason,
    })
  } catch {
    // The geocoding result remains usable if audit replication is temporarily delayed.
  }

  return Response.json({
    provider: 'GOOGLE_MAPS',
    minimumConfidence: 0.82,
    ambiguousMinimumConfidence: 0.65,
    resolved,
    ambiguous,
    rejectedCount: Math.max(0, requested.length - resolved.length - ambiguous.length),
  }, { headers: corsHeaders })
})
