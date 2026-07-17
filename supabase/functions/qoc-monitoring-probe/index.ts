import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

type ProbeResult = { serviceKey: 'wordpress' | 'deepl'; status: 'operational' | 'attention'; latencyMs: number; statusCode: number | null; detail: string }

async function probe(url: string, init?: RequestInit): Promise<{ response: Response | null; latencyMs: number }> {
  const startedAt = performance.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) })
    return { response, latencyMs: Math.round(performance.now() - startedAt) }
  } catch {
    return { response: null, latencyMs: Math.round(performance.now() - startedAt) }
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders })

  const token = request.headers.get('authorization')
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders })

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: token } } })
  const { data: session, error: sessionError } = await supabase.rpc('qoc_session')
  if (sessionError || !session) return Response.json({ error: 'qoc_access_denied' }, { status: 403, headers: corsHeaders })

  const wordpress = await probe('https://egquata.com/wp-json/')
  const deepLKey = Deno.env.get('DEEPL_API_KEY')
  const deepl = deepLKey
    ? await probe('https://api-free.deepl.com/v2/usage', { headers: { Authorization: `DeepL-Auth-Key ${deepLKey}` } })
    : { response: null, latencyMs: 0 }
  const results: ProbeResult[] = [
    {
      serviceKey: 'wordpress',
      status: wordpress.response?.ok ? 'operational' : 'attention',
      latencyMs: wordpress.latencyMs,
      statusCode: wordpress.response?.status ?? null,
      detail: wordpress.response?.ok ? 'API de WordPress accesible.' : 'No se ha podido consultar la API de WordPress.',
    },
    {
      serviceKey: 'deepl',
      status: deepl.response?.ok ? 'operational' : 'attention',
      latencyMs: deepl.latencyMs,
      statusCode: deepl.response?.status ?? null,
      detail: !deepLKey ? 'La clave de DeepL no está configurada.' : deepl.response?.ok ? 'Endpoint de uso de DeepL autenticado y accesible.' : `El endpoint de uso de DeepL respondió ${deepl.response?.status ?? 'sin respuesta'}.`,
    },
  ]

  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { error: insertError } = await admin.from('qoc_service_checks').insert(results.map((item) => ({
    service_key: item.serviceKey,
    status: item.status,
    latency_ms: item.latencyMs,
    status_code: item.statusCode,
    detail: item.detail,
  })))
  if (insertError) return Response.json({ error: 'probe_storage_failed' }, { status: 500, headers: corsHeaders })

  return Response.json({ services: results }, { headers: corsHeaders })
})
