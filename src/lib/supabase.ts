import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL || 'https://yrrlankpwmhluexshxnw.supabase.co'
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_dQILq4zEe6xW1TpJPQwMHw_gk6ZlaX3'

export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
})

export const AUTH_BRIDGE_URL = `${url}/functions/v1/quata-auth-bridge`
