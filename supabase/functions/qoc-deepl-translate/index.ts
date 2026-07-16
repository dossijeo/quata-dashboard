import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const languageMap: Record<string, string> = { es: 'ES', fr: 'FR', en: 'EN-GB' }

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders })

  const token = request.headers.get('authorization')
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401, headers: corsHeaders })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: token } } },
  )
  const { data: session, error: sessionError } = await supabase.rpc('qoc_session')
  if (sessionError || !session) return Response.json({ error: 'qoc_access_denied' }, { status: 403, headers: corsHeaders })

  const body = await request.json().catch(() => null)
  const sourceLanguage = languageMap[String(body?.sourceLanguage || '').toLowerCase()]
  const targetLanguage = languageMap[String(body?.targetLanguage || '').toLowerCase()]
  const texts = Array.isArray(body?.texts) ? body.texts.map((text: unknown) => String(text ?? '')).filter(Boolean) : []
  if (!sourceLanguage || !targetLanguage || sourceLanguage === targetLanguage || !texts.length) {
    return Response.json({ error: 'invalid_translation_request' }, { status: 400, headers: corsHeaders })
  }

  const apiKey = Deno.env.get('DEEPL_API_KEY')
  if (!apiKey) return Response.json({ error: 'translation_not_configured' }, { status: 503, headers: corsHeaders })
  const form = new URLSearchParams({ source_lang: sourceLanguage, target_lang: targetLanguage, tag_handling: 'html' })
  texts.forEach((text: string) => form.append('text', text))
  const response = await fetch('https://api-free.deepl.com/v2/translate', {
    method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) return Response.json({ error: 'translation_failed' }, { status: 502, headers: corsHeaders })
  return Response.json({ translations: (payload.translations || []).map((item: { text?: string }) => item.text || '') }, { headers: corsHeaders })
})
