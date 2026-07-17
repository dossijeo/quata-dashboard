import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

type ProfileRow = {
  id: string
  auth_user_id: string | null
  display_name: string | null
  nombre: string | null
  neighborhood: string | null
  barrio: string | null
  country_code: string | null
  code: string | null
  phone_local: string | null
  telefono: string | null
  avatar_url: string | null
  avatar: string | null
  secret_question: string | null
}

const profileFields = 'id,auth_user_id,display_name,nombre,neighborhood,barrio,country_code,code,phone_local,telefono,avatar_url,avatar,secret_question'
const validQuestions = new Set(['madre', 'barrio', 'amigo', 'comida'])

const json = (value: Record<string, unknown>, status = 200) => Response.json(value, { status, headers: corsHeaders })
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '')
const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function publicProfile(profile: ProfileRow) {
  return {
    displayName: profile.display_name?.trim() || profile.nombre?.trim() || 'Usuario',
    neighborhood: profile.neighborhood?.trim() || profile.barrio?.trim() || '',
    countryCode: digits(profile.country_code || profile.code),
    phoneLocal: digits(profile.phone_local || profile.telefono),
    avatarUrl: profile.avatar_url || profile.avatar || null,
    secretQuestion: profile.secret_question || '',
  }
}

async function actorFor(request: Request) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const token = request.headers.get('authorization')
  if (!token || !supabaseUrl || !anonKey || !serviceRoleKey) return null
  const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: token } } })
  const { data: auth } = await client.auth.getUser()
  if (!auth.user) return null
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: profile, error } = await admin.from('community_profiles').select(profileFields).eq('auth_user_id', auth.user.id).maybeSingle()
  if (error || !profile) return null
  return { admin, authUser: auth.user, profile: profile as ProfileRow, serviceRoleKey }
}

async function audit(admin: ReturnType<typeof createClient>, profileId: string, action: string, after: Record<string, unknown>) {
  await admin.from('qoc_audit_log').insert({
    actor_profile_id: profileId,
    action_key: action,
    entity_type: 'community_profile',
    entity_id: profileId,
    after_data: after,
    reason: 'Actualización desde Mi cuenta',
  }).then(() => undefined).catch(() => undefined)
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  try {
    const actor = await actorFor(request)
    if (!actor) return json({ error: 'unauthorized' }, 401)
    const contentType = request.headers.get('content-type') || ''
    const form = contentType.includes('multipart/form-data') ? await request.formData() : null
    const body = form ? Object.fromEntries(form.entries()) : await request.json().catch(() => ({})) as Record<string, unknown>
    const action = String(body.action || '')

    if (action === 'get') return json({ profile: publicProfile(actor.profile) })

    if (action === 'avatar') {
      const file = form?.get('file')
      if (!(file instanceof File) || !file.size) return json({ error: 'Selecciona una imagen para actualizar tu foto.' }, 400)
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
        return json({ error: 'La imagen debe ser JPG, PNG o WebP y no superar 10 MB.' }, 400)
      }
      const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
      const path = `avatars/${actor.profile.id}/${Date.now()}-${crypto.randomUUID()}.${extension}`
      const { error: uploadError } = await actor.admin.storage.from('community-posts').upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false })
      if (uploadError) throw uploadError
      const { data: publicUrl } = actor.admin.storage.from('community-posts').getPublicUrl(path)
      const avatarUrl = publicUrl.publicUrl
      const { data: profile, error } = await actor.admin.from('community_profiles')
        .update({ avatar_url: avatarUrl, avatar: avatarUrl }).eq('id', actor.profile.id).select(profileFields).single()
      if (error) throw error
      if (actor.profile.auth_user_id) await actor.admin.auth.admin.updateUserById(actor.profile.auth_user_id, { user_metadata: { ...actor.authUser.user_metadata, avatar_url: avatarUrl } })
      await audit(actor.admin, actor.profile.id, 'account.avatar.update', { fields: ['avatar_url'] })
      return json({ profile: publicProfile(profile as ProfileRow) })
    }

    if (action !== 'update') return json({ error: 'invalid_action' }, 400)
    const displayName = String(body.displayName || '').trim().slice(0, 80)
    const neighborhood = String(body.neighborhood || '').trim().slice(0, 100)
    const countryCode = digits(body.countryCode).slice(0, 5)
    const phoneLocal = digits(body.phoneLocal).slice(0, 20)
    const secretQuestion = String(body.secretQuestion || '')
    const secretAnswer = String(body.secretAnswer || '').trim().slice(0, 160)
    const newPassword = String(body.newPassword || '')
    if (!displayName || !countryCode || !phoneLocal) return json({ error: 'Completa nombre, prefijo y teléfono.' }, 400)
    if (secretQuestion && !validQuestions.has(secretQuestion)) return json({ error: 'La pregunta de seguridad no es válida.' }, 400)
    if (newPassword && newPassword.length < 6) return json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' }, 400)

    const { data: phoneMatches, error: phoneError } = await actor.admin.from('community_profiles').select('id,country_code,code').eq('phone_local', phoneLocal).neq('id', actor.profile.id)
    if (phoneError) throw phoneError
    if ((phoneMatches || []).some((row) => digits(row.country_code || row.code) === countryCode)) return json({ error: 'Ese teléfono ya está asociado a otra cuenta.' }, 409)

    const e164 = `+${countryCode}${phoneLocal}`
    const updates: Record<string, unknown> = {
      display_name: displayName, nombre: displayName,
      neighborhood: neighborhood || null, barrio: neighborhood || null,
      country_code: countryCode, code: countryCode,
      phone_local: phoneLocal, telefono: phoneLocal,
      phone: e164, phone_e164: e164,
    }
    if (secretQuestion) updates.secret_question = secretQuestion
    if (secretAnswer) updates.secret_answer = secretAnswer
    if (newPassword) { updates.pass_hash = await sha256(newPassword); updates.pass_plain = null }

    if (newPassword && actor.profile.auth_user_id) {
      const authPassword = `Qa-${await sha256(`${actor.profile.id}:${newPassword}:${actor.serviceRoleKey}`)}`
      const { error: authError } = await actor.admin.auth.admin.updateUserById(actor.profile.auth_user_id, {
        password: authPassword,
        user_metadata: { ...actor.authUser.user_metadata, display_name: displayName, neighborhood: neighborhood || null },
      })
      if (authError) throw authError
    }
    const { data: profile, error } = await actor.admin.from('community_profiles').update(updates).eq('id', actor.profile.id).select(profileFields).single()
    if (error) throw error
    if (!newPassword && actor.profile.auth_user_id) await actor.admin.auth.admin.updateUserById(actor.profile.auth_user_id, { user_metadata: { ...actor.authUser.user_metadata, display_name: displayName, neighborhood: neighborhood || null } })
    await audit(actor.admin, actor.profile.id, newPassword ? 'account.password.update' : 'account.update', { fields: Object.keys(updates).filter((key) => !['pass_hash', 'pass_plain', 'secret_answer'].includes(key)) })
    return json({ profile: publicProfile(profile as ProfileRow), passwordChanged: Boolean(newPassword) })
  } catch (error) {
    console.error(error)
    return json({ error: 'No se ha podido actualizar tu cuenta. Inténtalo de nuevo.' }, 500)
  }
})
