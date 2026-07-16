import { AUTH_BRIDGE_URL, supabase } from './supabase'

export type QocSession = {
  profile: { id: string; displayName: string; avatarUrl?: string | null; isAdmin: boolean; isOfficial: boolean }
  roles: Array<{ key: string; scopeType: string; scopeId?: string | null; permissions: string[] }>
}

export async function signInWithQuata(phone: string, countryCode: string, password: string) {
  const response = await fetch(AUTH_BRIDGE_URL, {
    method: 'POST',
    headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_dQILq4zEe6xW1TpJPQwMHw_gk6ZlaX3', 'content-type': 'application/json' },
    body: JSON.stringify({ phone_local: phone.replace(/\D/g, ''), country_code: countryCode.replace(/\D/g, ''), password }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || !payload.session) throw new Error(payload.error === 'invalid_credentials' ? 'No se ha podido iniciar sesión con los datos proporcionados.' : 'No se ha podido conectar con Qüata. Inténtalo de nuevo.')
  const { error } = await supabase.auth.setSession({ access_token: payload.session.access_token, refresh_token: payload.session.refresh_token })
  if (error) throw error
  return payload
}

export async function signOutFromQoc() {
  // A dashboard logout is local by design: it must immediately remove the
  // browser session even if the Auth server is temporarily unreachable.
  await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined)
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) storage.removeItem(key)
    }
  }
}

export async function getQocSession(): Promise<QocSession> {
  const { data, error } = await supabase.rpc('qoc_session')
  if (error) throw error
  return data as QocSession
}

export async function getModuleData<T = unknown>(module: string, limit = 50): Promise<T> {
  const { data, error } = await supabase.rpc('qoc_module_data', { p_module: module, p_limit: limit })
  if (error) throw error
  return data as T
}

export async function getUserGrowthSeries(points = 13): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase.rpc('qoc_user_growth_series', { p_points: points })
  if (error) throw error
  return data as Array<Record<string, unknown>>
}

export async function getSosAlerts(limit = 50): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase.rpc('qoc_sos_alerts', { p_limit: limit })
  if (error) throw error
  return data as Array<Record<string, unknown>>
}

export async function getSosThreadMessages(threadId: number | string, limit = 500): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await supabase.rpc('qoc_sos_thread_messages', { p_thread_id: Number(threadId), p_limit: limit })
  if (error) throw error
  return data as Array<Record<string, unknown>>
}

export async function getTerritories(query: string, status: string, activity: string, page: number, pageSize = 20): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_territories', {
    p_query: query || null,
    p_status: status,
    p_activity: activity,
    p_page: page,
    p_page_size: pageSize,
  })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function getModerationReportDetail(reportId: number | string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_moderation_report_detail', { p_report_id: Number(reportId) })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function decideModerationReport(reportId: number | string, decision: 'reviewing' | 'dismiss' | 'remove_content', note?: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_moderation_decide', {
    p_report_id: Number(reportId), p_decision: decision, p_note: note || null,
  })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function getModerationReports(query: string, status: string, targetType: string, page: number, pageSize = 20): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_moderation_reports', {
    p_query: query || null, p_status: status, p_target_type: targetType, p_page: page, p_page_size: pageSize,
  })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function getModerationFullContent(reportId: number | string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_moderation_full_content', { p_report_id: Number(reportId) })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function getOfficialProfiles(query: string, territory: string, accountType: string, page: number, pageSize = 20): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_official_profiles', {
    p_query: query || null, p_territory: territory, p_account_type: accountType, p_page: page, p_page_size: pageSize,
  })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function getOfficialPosts(query: string, status: string, postType: string, language: string, page: number, pageSize = 20): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_official_posts_filtered', {
    p_query: query || null, p_status: status, p_post_type: postType, p_language: language, p_page: page, p_page_size: pageSize,
  })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function deleteOfficialPostGroup(translationGroupId: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_official_posts_delete_group', { p_translation_group_id: translationGroupId })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function translateOfficialTexts(sourceLanguage: string, targetLanguage: string, texts: string[]): Promise<string[]> {
  const { data, error } = await supabase.functions.invoke('qoc-deepl-translate', { body: { sourceLanguage, targetLanguage, texts } })
  if (error || !Array.isArray(data?.translations)) throw new Error('No se han podido generar las traducciones.')
  return data.translations.map((text: unknown) => String(text || ''))
}

export async function createOfficialPostVariants(profileId: string, posts: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('qoc_official_posts_create_variants', { p_profile_id: profileId, p_posts: posts })
  if (error) throw error
  return data as Record<string, unknown>
}

export async function uploadOfficialMedia(file: File): Promise<{ url: string; type: 'image' | 'video' }> {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) throw new Error('La sesión ha caducado.')
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')

  if (file.type.startsWith('video/')) {
    const form = new FormData()
    form.append('video', file, safeName)
    const response = await fetch('https://egquata.com/wp-json/quqos/v1/upload-video', {
      method: 'POST',
      body: form,
      // Send a WordPress browser session if it exists, while preserving the
      // Android app's direct multipart upload contract for this endpoint.
      credentials: 'include',
    })
    const payload = await response.json().catch(() => null) as { url?: unknown; data?: { url?: unknown }; message?: unknown } | null
    const url = typeof payload?.url === 'string'
      ? payload.url
      : typeof payload?.data?.url === 'string'
        ? payload.data.url
        : null
    if (!response.ok || !url) {
      const detail = typeof payload?.message === 'string' ? payload.message : 'WordPress no ha aceptado el vídeo.'
      throw new Error(detail)
    }
    return { url, type: 'video' }
  }

  const path = `official-posts/${auth.user.id}/${crypto.randomUUID()}-${safeName}`
  const { error } = await supabase.storage.from('official-media').upload(path, file, { contentType: file.type || undefined, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from('official-media').getPublicUrl(path)
  return { url: data.publicUrl, type: 'image' }
}

export async function qocCommand<T = unknown>(command: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc('qoc_command', { p_command: command, p_payload: payload })
  if (error) throw error
  return data as T
}
