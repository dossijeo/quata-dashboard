import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet'
import { divIcon } from 'leaflet'
import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Command, ExternalLink, Eye, FilePlus2,
  Bold, Globe2, Heart, Image, Info, Italic, Languages, Link, List, LogOut, Map, Menu, MessageCircle, Moon, MoreHorizontal, Play, Plus, RefreshCw, Search, Share2, Sun, Trash2, Underline, Upload, Video, X, Zap,
} from 'lucide-react'
import { createOfficialPostVariants, decideModerationReport, deleteOfficialPostGroup, getAnalytics, getAuditEvents, getCommunities, getComplianceOverview, getExecutiveOverview, getGooglePlayOverview, getMediaLibrary, getModerationFullContent, getModerationReportDetail, getModerationReports, getModuleData, getMonitoring, getMyAccount, getOfficialPosts, getOfficialProfiles, getPasswordRecoveryQuestion, getQocSession, getSosAlerts, getSosThreadMessages, getTerritories, getUserGrowthSeries, qocCommand, QocAccount, QocSession, resetPasswordWithSecretAnswer, runMonitoringProbe, signInWithQuata, signOutFromQoc, translateOfficialTexts, updateMyAccount, uploadMyAccountAvatar, uploadOfficialMedia } from './lib/api'
import { moduleBySlug, modules, ModuleMeta } from './lib/catalog'
import { countryPrefixes } from './lib/country-prefixes'
import { supabase } from './lib/supabase'
import { RichBlockEditor } from './components/RichBlockEditor'
import { OfficialMediaEditor } from './components/OfficialMediaEditor'
import { AvatarImageEditor } from './components/AvatarImageEditor'

type JsonRecord = Record<string, unknown>
const formatNumber = (value: unknown) => new Intl.NumberFormat('es-ES').format(Number(value || 0))
const dateTime = (value: unknown) => {
  if (!value) return 'Sin fecha'
  const date = new Date(String(value))
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Sin fecha'
}
const initials = (name?: string) => (name || 'Q').split(' ').slice(0, 2).map((word) => word[0]).join('').toUpperCase()
const QOC_IDLE_TIMEOUT_MS = 15 * 60 * 1000
const QOC_IDLE_ACTIVITY_KEY = 'qoc-last-user-activity'
const isActiveSosAlert = (row: JsonRecord) => {
  const createdAt = new Date(String(row.createdAt)).getTime()
  return Number.isFinite(createdAt) && Date.now() - createdAt <= 24 * 60 * 60 * 1000
}

function App() {
  const [session, setSession] = useState<QocSession | null>(null)
  const [loading, setLoading] = useState(true)
  const endSession = useCallback(() => setSession(null), [])

  useEffect(() => {
    let disposed = false
    const loadQocSession = async () => {
      try {
        const nextSession = await getQocSession()
        if (!disposed) setSession(nextSession)
      } catch {
        if (!disposed) setSession(null)
      } finally {
        if (!disposed) setLoading(false)
      }
    }

    void loadQocSession()
    const { data } = supabase.auth.onAuthStateChange((_event, authSession) => {
      if (!authSession) {
        setSession(null)
        setLoading(false)
        return
      }

      // Supabase holds an internal auth lock while this callback runs. Defer the
      // QOC RPC so the profile lookup cannot wait on that lock indefinitely.
      window.setTimeout(() => { void loadQocSession() }, 0)
    })
    return () => { disposed = true; data.subscription.unsubscribe() }
  }, [])

  if (loading) return <div className="boot"><div className="spinner" /><span>Preparando Qüata Operations Center</span></div>
  if (!session) return <Login onSession={setSession} />
  return <><IdleSessionGuard onExpired={endSession} /><Workspace session={session} onSignOut={endSession} onSessionChange={setSession} /></>
}

function IdleSessionGuard({ onExpired }: { onExpired: () => void }) {
  const lastActivity = useRef(0)
  const closing = useRef(false)
  const refreshInFlight = useRef(false)

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(QOC_IDLE_ACTIVITY_KEY))
    lastActivity.current = Number.isFinite(stored) && stored > 0 ? stored : Date.now()
    if (!stored) window.localStorage.setItem(QOC_IDLE_ACTIVITY_KEY, String(lastActivity.current))

    const closeForInactivity = () => {
      if (closing.current) return
      closing.current = true
      window.localStorage.removeItem(QOC_IDLE_ACTIVITY_KEY)
      void signOutFromQoc().finally(onExpired)
    }
    const hasExpired = () => {
      if (Date.now() - lastActivity.current < QOC_IDLE_TIMEOUT_MS) return false
      closeForInactivity()
      return true
    }
    const refreshIfNeeded = async () => {
      if (refreshInFlight.current || closing.current) return
      const { data } = await supabase.auth.getSession()
      const expiresAt = Number(data.session?.expires_at || 0) * 1000
      if (!data.session) { closeForInactivity(); return }
      if (expiresAt - Date.now() > 2 * 60 * 1000) return
      refreshInFlight.current = true
      try {
        const { data: refreshed } = await supabase.auth.refreshSession()
        if (!refreshed.session) closeForInactivity()
      } finally {
        refreshInFlight.current = false
      }
    }
    const registerActivity = () => {
      if (hasExpired()) return
      lastActivity.current = Date.now()
      window.localStorage.setItem(QOC_IDLE_ACTIVITY_KEY, String(lastActivity.current))
      void refreshIfNeeded()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') registerActivity()
    }
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'scroll', 'touchstart']
    events.forEach((eventName) => window.addEventListener(eventName, registerActivity, { passive: true }))
    document.addEventListener('visibilitychange', onVisibility)
    const interval = window.setInterval(hasExpired, 15_000)
    void refreshIfNeeded()
    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, registerActivity))
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(interval)
    }
  }, [onExpired])
  return null
}

function Login({ onSession }: { onSession: (session: QocSession) => void }) {
  const [recovering, setRecovering] = useState(false)
  const [countryCode, setCountryCode] = useState('240')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await signInWithQuata(phone, countryCode, password); onSession(await getQocSession()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se ha podido iniciar sesión.') }
    finally { setBusy(false) }
  }
  return <main className="login-shell">
    <section className="login-brief">
      <div className="login-brand-lockup"><div className="brand-mark">Q</div><span className="eyebrow">QÜATA</span></div>
      <h1>Operations<br /><em>Center</em></h1>
      <p>Una visión clara para operar, proteger y comunicar en toda la plataforma.</p>
      <div className="login-status"><i /> Plataforma operativa <span>·</span> Supabase conectado</div>
      <div className="login-grid"><b>Operación</b><b>Contenido</b><b>Comunidad</b><b>Gobierno</b></div>
    </section>
    <section className="login-card-wrap"><form className="login-card" onSubmit={submit}>
      <div className="brand-mark compact">Q</div><p className="eyebrow">ACCESO RESTRINGIDO</p><h2>Iniciar sesión</h2>
      <p className="muted">Utiliza las mismas credenciales que en Qüata.</p>
      <label>País y prefijo<CountryPrefixSelect value={countryCode} onChange={setCountryCode} /></label>
      <label>Teléfono<input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} aria-label="Teléfono" /></label>
      <label>Contraseña<input value={password} type="password" onChange={(e) => setPassword(e.target.value)} required aria-label="Contraseña" /></label>
      {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
      <button className="primary full" disabled={busy}>{busy ? <><span className="button-spinner" /> Comprobando acceso...</> : 'Entrar al centro de operaciones'}</button>
      <button type="button" className="login-recovery-link" onClick={() => setRecovering(true)}>He olvidado mi contrase&ntilde;a</button>
      <small>El acceso y las operaciones administrativas quedan registrados.</small>
    </form></section>
    {recovering && <PasswordRecovery close={() => setRecovering(false)} />}
  </main>
}

function PasswordRecovery({ close }: { close: () => void }) {
  const [countryCode, setCountryCode] = useState('240')
  const [phone, setPhone] = useState('')
  const [question, setQuestion] = useState('')
  const [questionSelection, setQuestionSelection] = useState('')
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const normalizedPhone = phone.replace(/\D/g, '')
    setQuestion(''); setQuestionSelection(''); setNotice('')
    if (normalizedPhone.length < 5) return
    let active = true
    const timeout = window.setTimeout(() => {
      setChecking(true)
      void getPasswordRecoveryQuestion(normalizedPhone, countryCode).then((nextQuestion) => {
        if (active) { setQuestion(nextQuestion); setQuestionSelection(nextQuestion) }
      }).catch(() => { if (active) setNotice('No hay ninguna cuenta con ese tel\u00e9fono o no tiene una pregunta de seguridad configurada.') }).finally(() => { if (active) setChecking(false) })
    }, 250)
    return () => { active = false; window.clearTimeout(timeout) }
  }, [countryCode, phone])
  const labels: Record<string, string> = { madre: '\u00bfC\u00f3mo se llama tu madre?', barrio: '\u00bfEn qu\u00e9 barrio creciste?', amigo: '\u00bfNombre de tu mejor amigo?', comida: '\u00bfTu comida favorita?' }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setNotice('')
    if (!question) { setNotice('Introduce un tel\u00e9fono registrado para cargar tu pregunta de seguridad.'); return }
    setBusy(true)
    try { await resetPasswordWithSecretAnswer(phone, countryCode, answer, newPassword); setNotice('Tu contrase\u00f1a se ha actualizado. Ya puedes iniciar sesi\u00f3n.'); setAnswer(''); setNewPassword('') }
    catch (cause) { setNotice(cause instanceof Error && cause.message === 'invalid_secret_answer' ? 'La respuesta secreta no es correcta.' : 'No se ha podido actualizar la contrase\u00f1a. Revisa los datos e int\u00e9ntalo de nuevo.') }
    finally { setBusy(false) }
  }
  return <div className="modal-backdrop"><section className="modal recovery-modal"><header><div><h2>Recuperar contrase&ntilde;a</h2><p>Confirma tu identidad con la pregunta de seguridad de Q&uuml;ata.</p></div><button className="icon" onClick={close} title="Cerrar"><X size={18}/></button></header><form className="recovery-form" onSubmit={submit}>
    <label>Pa&iacute;s y prefijo<CountryPrefixSelect value={countryCode} onChange={setCountryCode}/></label><label>Tel&eacute;fono<input value={phone} inputMode="tel" onChange={(event) => setPhone(event.target.value)} placeholder="Tu tel&eacute;fono registrado" required/></label>
    <label>Tu pregunta secreta<select value={questionSelection} onChange={(event) => setQuestionSelection(event.target.value)} aria-label="Tu pregunta secreta"><option value="">{checking ? 'Cargando pregunta secreta\u2026' : 'Selecciona la pregunta configurada en tu cuenta'}</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Tu respuesta secreta<input value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={!question || busy} required/></label><label>Nueva contrase&ntilde;a<input type="password" value={newPassword} minLength={6} onChange={(event) => setNewPassword(event.target.value)} disabled={!question || busy} required/></label>
    {notice && <div className={notice.includes('actualizado.') ? 'form-success' : 'form-error'}>{notice}</div>}<div className="recovery-actions"><button type="button" className="secondary" onClick={close}>Volver</button><button className="primary" disabled={!question || busy}>{busy ? 'Actualizando\u2026' : 'Actualizar contrase\u00f1a'}</button></div>
  </form></section></div>
}

function CountryPrefixSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false); const [query, setQuery] = useState('')
  const selected = countryPrefixes.find((item) => item.code === value) || countryPrefixes[0]
  const results = countryPrefixes.filter((item) => `${item.label} ${item.code}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')))
  return <div className="country-select"><button type="button" className="country-trigger" onClick={() => { setOpen((current) => !current); setQuery('') }}><Globe2 size={16}/><span>{selected.label}</span><ChevronDown size={15}/></button>{open && <div className="country-popover"><div className="country-search"><Search size={15}/><input autoFocus value={query} placeholder="Buscar país o prefijo" onChange={(event) => setQuery(event.target.value)} /></div><div className="country-results">{results.map((item) => <button type="button" key={`${item.code}-${item.label}`} className={item.code === value ? 'selected' : ''} onClick={() => { onChange(item.code); setOpen(false) }}><span>{item.label.replace(/^\+\d+\s+—\s+/, '')}</span><b>+{item.code}</b></button>)}{!results.length && <p>Sin coincidencias</p>}</div></div>}</div>
}

const securityQuestions = [
  { value: 'madre', label: '¿Cuál es el nombre de tu madre?' },
  { value: 'barrio', label: '¿En qué barrio creciste?' },
  { value: 'amigo', label: '¿Cómo se llamaba tu mejor amigo de infancia?' },
  { value: 'comida', label: '¿Cuál es tu comida favorita?' },
]

function AccountPanel({ session, close, onSessionChange, onSignOut }: { session: QocSession; close: () => void; onSessionChange: (session: QocSession) => void; onSignOut: () => void }) {
  const [account, setAccount] = useState<QocAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null)
  const [form, setForm] = useState({ displayName: '', neighborhood: '', countryCode: '240', phoneLocal: '', secretQuestion: '', secretAnswer: '', newPassword: '' })

  useEffect(() => {
    let active = true
    void getMyAccount().then((profile) => {
      if (!active) return
      setAccount(profile)
      setForm({ displayName: profile.displayName, neighborhood: profile.neighborhood, countryCode: profile.countryCode || '240', phoneLocal: profile.phoneLocal, secretQuestion: profile.secretQuestion, secretAnswer: '', newPassword: '' })
    }).catch(() => active && setNotice('No se han podido cargar tus datos. Inténtalo de nuevo.')).finally(() => active && setLoading(false))
    return () => { active = false }
  }, [])

  const updateSessionProfile = (profile: QocAccount) => {
    setAccount(profile)
    onSessionChange({ ...session, profile: { ...session.profile, displayName: profile.displayName, avatarUrl: profile.avatarUrl, territory: profile.neighborhood || session.profile.territory } })
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setSaving(true); setNotice('')
    try {
      const result = await updateMyAccount(form)
      updateSessionProfile(result.profile)
      setForm((current) => ({ ...current, secretAnswer: '', newPassword: '' }))
      if (result.passwordChanged) {
        window.alert('Tu contraseña se ha actualizado. Por seguridad, inicia sesión de nuevo.')
        await signOutFromQoc(); onSignOut(); window.location.replace('/')
        return
      }
      setNotice('Tus datos se han actualizado correctamente.')
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'No se han podido guardar tus datos.') }
    finally { setSaving(false) }
  }
  const saveAvatar = async (file: File) => {
    setSaving(true); setNotice('')
    try { const profile = await uploadMyAccountAvatar(file); updateSessionProfile(profile); setPendingAvatar(null); setNotice('La imagen de perfil se ha actualizado.') }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : 'No se ha podido actualizar la imagen.') }
    finally { setSaving(false) }
  }
  const pickAvatar = (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) setPendingAvatar(file) }
  const avatar = account?.avatarUrl || session.profile.avatarUrl
  return <><Modal title="Mi cuenta" close={close}><form className="account-panel" onSubmit={save}>
    {loading ? <div className="account-loading"><span className="spinner"/>Cargando tus datos...</div> : <>
      <section className="account-profile-head"><div className="account-avatar">{avatar ? <img src={avatar} alt="Imagen de perfil"/> : initials(form.displayName)}<label className="account-avatar-edit" title="Cambiar imagen"><Upload size={15}/><input type="file" accept="image/jpeg,image/png,image/webp" onChange={pickAvatar} /></label></div><div><b>{form.displayName || 'Tu perfil'}</b><small>La imagen se editará en formato 1:1 antes de guardarse.</small></div></section>
      <div className="account-section"><h3>Mis datos</h3><div className="account-form-grid"><label>Nombre<input value={form.displayName} maxLength={80} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required /></label><label>Barrio<input value={form.neighborhood} maxLength={100} onChange={(event) => setForm({ ...form, neighborhood: event.target.value })} placeholder="Tu barrio" /></label><label>País y prefijo<CountryPrefixSelect value={form.countryCode} onChange={(countryCode) => setForm({ ...form, countryCode })}/></label><label>Teléfono<input inputMode="tel" value={form.phoneLocal} onChange={(event) => setForm({ ...form, phoneLocal: event.target.value.replace(/\D/g, '') })} required /></label></div></div>
      <div className="account-section"><h3>Seguridad</h3><div className="account-form-grid"><label>Nueva contraseña <small>Opcional</small><input type="password" value={form.newPassword} minLength={6} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} placeholder="Deja este campo vacío para mantenerla" /></label><label>Pregunta de seguridad<select value={form.secretQuestion} onChange={(event) => setForm({ ...form, secretQuestion: event.target.value })}><option value="">Mantener la pregunta actual</option>{securityQuestions.map((question) => <option key={question.value} value={question.value}>{question.label}</option>)}</select></label><label className="account-full-row">Nueva respuesta de seguridad <small>Opcional</small><input type="password" value={form.secretAnswer} maxLength={160} onChange={(event) => setForm({ ...form, secretAnswer: event.target.value })} placeholder="Escribe una respuesta nueva para actualizarla" /></label></div></div>
      {notice && <div className={notice.includes('correctamente') || notice.includes('actualizado.') ? 'form-success' : 'form-error'}>{notice}</div>}
      <div className="account-panel-actions"><button type="button" className="secondary" onClick={close} disabled={saving}>Cancelar</button><button className="primary" disabled={saving}>{saving ? 'Guardando...' : 'Guardar cambios'}</button></div>
    </>}
  </form></Modal>{pendingAvatar && <AvatarImageEditor file={pendingAvatar} onCancel={() => setPendingAvatar(null)} onSave={saveAvatar}/>}</>
}

function Workspace({ session, onSignOut, onSessionChange }: { session: QocSession; onSignOut: () => void; onSessionChange: (session: QocSession) => void }) {
  const navigate = useNavigate()
  const editorialOnly = session.profile.isOfficial && !session.profile.isAdmin && session.roles.length === 0
  const visibleModules = editorialOnly ? modules.filter((item) => item.slug === 'editor-oficial') : modules
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [dark, setDark] = useState(() => localStorage.getItem('qoc-theme') === 'dark')
  const [searchOpen, setSearchOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [sosActiveCount, setSosActiveCount] = useState(0)
  const [realtimeStatus, setRealtimeStatus] = useState<'operational' | 'attention' | 'unknown'>('unknown')
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('qoc-theme', dark ? 'dark' : 'light') }, [dark])
  useEffect(() => {
    let active = true
    const refreshSosCount = () => { void getSosAlerts().then((alerts) => { if (active) setSosActiveCount(alerts.filter(isActiveSosAlert).length) }).catch(() => undefined) }
    refreshSosCount()
    const interval = window.setInterval(refreshSosCount, 30_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [])
  useEffect(() => {
    let active = true
    const refreshRealtime = () => { void getMonitoring().then((snapshot) => {
      if (!active) return
      const services = Array.isArray(snapshot.services) ? snapshot.services as JsonRecord[] : []
      const realtime = services.find((service) => String(service.key) === 'realtime')
      setRealtimeStatus(realtime && ['operational', 'attention', 'unknown'].includes(String(realtime.status)) ? String(realtime.status) as 'operational' | 'attention' | 'unknown' : 'unknown')
    }).catch(() => { if (active) setRealtimeStatus('unknown') }) }
    refreshRealtime()
    const interval = window.setInterval(refreshRealtime, 60_000)
    return () => { active = false; window.clearInterval(interval) }
  }, [])
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-brand"><div className="brand-mark compact">Q</div><div><strong>Qüata</strong><small>Operations Center</small></div><button className="icon mobile-only" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
      <nav>{['Operaciones', 'Contenido', 'Comunicación', 'Analítica', 'Plataforma'].filter((group) => visibleModules.some((item) => item.group === group)).map((group) => <NavGroup key={group} group={group} items={visibleModules} close={() => setSidebarOpen(false)} sosActiveCount={sosActiveCount} />)}</nav>
      <button className={`sidebar-foot realtime-status ${realtimeStatus}`} onClick={() => navigate('/monitorizacion')} title="Abrir monitorización"><div className="realtime-dot" /><span>{realtimeStatus === 'operational' ? 'Realtime operativo' : realtimeStatus === 'attention' ? 'Realtime requiere revisión' : 'Realtime sin sonda reciente'}</span></button>
    </aside>
    <main className="main-shell">
      <header className="topbar">
        <button className="icon mobile-only" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
        <button className="context-switch" onClick={() => setAccountOpen(true)} title="Gestionar mi cuenta"><span className="avatar small">{session.profile.avatarUrl ? <img src={session.profile.avatarUrl} alt=""/> : initials(session.profile.displayName)}</span><span><b>{session.profile.displayName}</b><small>{editorialOnly ? 'Cuenta oficial' : session.roles[0]?.key?.replaceAll('_', ' ') || 'Operador'}</small></span><ChevronDown size={15}/></button>
        <div className="topbar-actions"><button className="search-trigger" onClick={() => setSearchOpen(true)}><Search size={16} /><span>Buscar</span><kbd>⌘ K</kbd></button><button className="icon" onClick={() => setDark(!dark)} title="Cambiar tema">{dark ? <Sun size={18} /> : <Moon size={18} />}</button><button className="icon" onClick={() => { void (async () => { await signOutFromQoc(); onSignOut(); window.location.replace('/') })() }} title="Cerrar sesión"><LogOut size={18} /></button></div>
      </header>
      <Routes><Route path="/" element={<Navigate to={editorialOnly ? '/editor-oficial' : '/dashboard'} replace />} /><Route path="/:slug" element={<ModulePage session={session} editorialOnly={editorialOnly} />} /></Routes>
    </main>
    {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
    {searchOpen && <CommandPalette close={() => setSearchOpen(false)} items={visibleModules} />}
    {accountOpen && <AccountPanel session={session} close={() => setAccountOpen(false)} onSessionChange={onSessionChange} onSignOut={onSignOut}/>} 
  </div>
}

function NavGroup({ group, items, close, sosActiveCount }: { group: string; items: ModuleMeta[]; close: () => void; sosActiveCount: number }) {
  const navigate = useNavigate(); const location = locationPath(); const groupModules = items.filter((item) => item.group === group)
  return <section className="nav-group"><p>{group}</p>{groupModules.map((item) => { const Icon = item.icon; const active = location === `/${item.slug}`; return <button key={item.slug} className={active ? 'nav-link active' : 'nav-link'} onClick={() => { navigate(`/${item.slug}`); close() }}><Icon size={17} /><span>{item.label}</span>{item.slug === 'sos' && sosActiveCount > 0 && <b className="nav-count">{sosActiveCount}</b>}</button> })}</section>
}

function locationPath() { return window.location.pathname }

function CommandPalette({ close, items }: { close: () => void; items: ModuleMeta[] }) {
  const navigate = useNavigate(); const [term, setTerm] = useState(''); const results = items.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(term.toLowerCase()))
  return <div className="command-backdrop" onMouseDown={close}><section className="command-panel" onMouseDown={(event) => event.stopPropagation()}><div><Search size={18}/><input autoFocus placeholder="Buscar módulo, usuario o acción..." value={term} onChange={(e) => setTerm(e.target.value)} /><kbd>ESC</kbd></div><p>Ir a</p>{results.slice(0, 8).map((item) => { const Icon = item.icon; return <button key={item.slug} onClick={() => { navigate(`/${item.slug}`); close() }}><Icon size={17}/><span>{item.label}</span><small>{item.group}</small></button> })}</section></div>
}

function ModulePage({ session, editorialOnly }: { session: QocSession; editorialOnly: boolean }) {
  const { slug } = useParams(); const meta = moduleBySlug(slug); const [data, setData] = useState<unknown>(null); const [state, setState] = useState<'loading'|'ready'|'error'>('loading'); const [refresh, setRefresh] = useState(0)
  useEffect(() => { let alive = true; setState('loading'); if (!meta.dataKey || (editorialOnly && meta.slug === 'editor-oficial')) { setData(null); setState('ready'); return } getModuleData(meta.dataKey).then((value) => { if (alive) { setData(value); setState('ready') } }).catch(() => alive && setState('error')); return () => { alive = false } }, [meta.slug, meta.dataKey, refresh, editorialOnly])
  const Icon = meta.icon
  if (editorialOnly && meta.slug !== 'editor-oficial') return <Navigate to="/editor-oficial" replace />
  return <section className="page"><div className="page-head"><div><div className="crumb">Qüata Operations Center <span>/</span> {meta.group}</div><h1><Icon size={27}/>{meta.label}</h1><p>{meta.description}</p></div><div className="page-actions"><button className="secondary" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16}/>Actualizar</button>{primaryAction(meta.slug)}</div></div>
    {state === 'loading' && <SkeletonPage />}{state === 'error' && <ErrorPanel retry={() => setRefresh((value) => value + 1)} />}{state === 'ready' && <ModuleContent meta={meta} data={data} session={session} refresh={() => setRefresh((value) => value + 1)} refreshKey={refresh} />}
  </section>
}

function primaryAction(slug: string) {
  if (slug === 'editor-oficial') return <button className="primary" onClick={() => window.dispatchEvent(new Event('qoc:new-official-post'))}><FilePlus2 size={16}/>Nueva publicación</button>
  return null
}
const SirenIcon = () => <Zap size={16}/>

function ModuleContent({ meta, data, session, refresh, refreshKey }: { meta: ModuleMeta; data: unknown; session: QocSession; refresh: () => void; refreshKey: number }) {
  if (meta.slug === 'dashboard') return <ExecutiveOverview refreshKey={refreshKey} />
  if (meta.slug === 'sos') return <SosModule data={data as JsonRecord[]} mapOnly={false} />
  if (meta.slug === 'territorios') return <CommunitiesModule />
  if (meta.slug === 'moderacion') return <Moderation data={data as JsonRecord[]} refresh={refresh} />
  if (meta.slug === 'usuarios' || meta.slug === 'editor-oficial') return <OfficialModule data={data as JsonRecord} editor={meta.slug === 'editor-oficial'} refresh={refresh} session={session} />
  if (meta.slug === 'biblioteca') return <MediaLibraryModule />
  if (meta.slug === 'monitorizacion') return <MonitoringModule refreshKey={refreshKey} />
  if (meta.slug === 'soporte') return <SupportModule data={data as JsonRecord[]} refresh={refresh} />
  if (meta.slug.startsWith('analitica')) {
    const analyticsScope = ({ 'analitica-usuarios': 'users', 'analitica-contenido': 'content', 'analitica-chat': 'chat', 'analitica-sos': 'sos' } as const)[meta.slug] || 'users'
    return <AnalyticsModule scope={analyticsScope} title={meta.label} refreshSignal={refresh} />
  }
  if (meta.slug === 'versiones') return <PlatformModule data={data as JsonRecord} mode="versiones" refreshKey={refreshKey} />
  if (meta.slug === 'cumplimiento') return <ComplianceModule refreshKey={refreshKey} />
  if (meta.slug === 'auditoria') return <AuditModule refreshSignal={refresh} />
  return <CollectionModule meta={meta} data={data} session={session} />
}

function ExecutiveOverview({ refreshKey }: { refreshKey: number }) {
  const navigate = useNavigate()
  const [overview, setOverview] = useState<JsonRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getExecutiveOverview().then((value) => { if (active) setOverview(value) }).catch(() => {
      if (active) setError('No se ha podido cargar el resumen operativo.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refreshKey])

  if (loading) return <div className="territory-loading"><span className="spinner"/>Preparando la situación operativa…</div>
  if (error || !overview) return <div className="territory-error"><CircleAlert size={18}/><span>{error || 'No hay información operativa disponible.'}</span></div>

  const sos = (overview.sos || {}) as JsonRecord
  const moderation = (overview.moderation || {}) as JsonRecord
  const users = (overview.users || {}) as JsonRecord
  const territories = (overview.territories || {}) as JsonRecord
  const content = (overview.content || {}) as JsonRecord
  const chat = (overview.chat || {}) as JsonRecord
  const security = (overview.security || {}) as JsonRecord
  const version = (overview.version || {}) as JsonRecord
  const services = (overview.services || []) as JsonRecord[]
  const activity = (overview.activity || []) as JsonRecord[]
  const growth = (overview.growthSeries || []) as JsonRecord[]
  const activeSos = Number(sos.active24h || 0)
  const openModeration = Number(moderation.open || 0)
  const rlsExceptions = Number(security.disabledTables || 0)
  const serviceAttention = services.filter((service) => String(service.status) === 'attention').length
  const coverage = Number(security.totalTables || 0) ? Math.round((Number(security.enabledTables || 0) / Number(security.totalTables || 1)) * 100) : 0
  const urgent = activeSos + openModeration + serviceAttention + rlsExceptions
  const relative = (value: unknown) => {
    const millis = Date.now() - new Date(String(value || '')).getTime()
    if (!Number.isFinite(millis)) return 'Sin actividad reciente'
    const minutes = Math.max(0, Math.floor(millis / 60000))
    if (minutes < 1) return 'Ahora mismo'
    if (minutes < 60) return `Hace ${minutes} min`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `Hace ${hours} h`
    return `Hace ${Math.floor(hours / 24)} d`
  }
  const priorityItems = [
    activeSos > 0 ? { key: 'sos', title: `${activeSos} alerta${activeSos === 1 ? '' : 's'} SOS activa${activeSos === 1 ? '' : 's'}`, detail: `Última: ${relative((sos.latest as JsonRecord)?.createdAt)}`, path: '/sos', tone: 'critical' } : null,
    openModeration > 0 ? { key: 'moderation', title: `${openModeration} caso${openModeration === 1 ? '' : 's'} pendiente${openModeration === 1 ? '' : 's'} de moderación`, detail: `Último reporte: ${relative((moderation.latest as JsonRecord)?.createdAt)}`, path: '/moderacion', tone: 'warning' } : null,
    serviceAttention > 0 ? { key: 'services', title: `${serviceAttention} servicio${serviceAttention === 1 ? '' : 's'} requiere revisión`, detail: 'Consulta el estado técnico y las dependencias.', path: '/monitorizacion', tone: 'warning' } : null,
    rlsExceptions > 0 ? { key: 'security', title: `${rlsExceptions} excepción${rlsExceptions === 1 ? '' : 'es'} RLS pendiente${rlsExceptions === 1 ? '' : 's'}`, detail: 'No se aplican cambios automáticos de permisos.', path: '/cumplimiento', tone: 'info' } : null,
  ].filter(Boolean) as Array<{ key: string; title: string; detail: string; path: string; tone: string }>

  return <>
    <section className={`executive-hero ${urgent ? 'has-attention' : ''}`}>
      <div><span className="executive-kicker"><span className={urgent ? 'pulse attention' : 'pulse'}/>{urgent ? 'Atención operativa requerida' : 'Situación operativa estable'}</span><h2>{urgent ? `${urgent} señal${urgent === 1 ? '' : 'es'} para revisar` : 'La plataforma opera con normalidad'}</h2><p>{activeSos ? 'Hay alertas SOS recientes que requieren seguimiento desde el centro de control.' : 'No hay alertas SOS activas en este momento. La actividad y las integraciones se actualizan desde sus fuentes operativas.'}</p><div className="executive-hero-actions"><button className="primary" onClick={() => navigate(activeSos ? '/sos' : '/monitorizacion')}>{activeSos ? 'Abrir Centro SOS' : 'Ver monitorización'}<ExternalLink size={15}/></button><button className="secondary" onClick={() => navigate('/auditoria')}>Ver auditoría</button></div></div>
      <div className="executive-status-orbit"><span>{formatNumber(users.active30d)}</span><small>usuarios activos<br/>en 30 días</small><i/></div>
    </section>
    <section className="executive-kpi-grid">
      <button className="executive-kpi-card" onClick={() => navigate('/usuarios')}><span>Usuarios</span><b>{formatNumber(users.total)}</b><small>+{formatNumber(users.new30d)} altas en 30 días</small></button>
      <button className={`executive-kpi-card ${activeSos ? 'critical' : ''}`} onClick={() => navigate('/sos')}><span>Centro SOS</span><b>{formatNumber(activeSos)}</b><small>{formatNumber(sos.withLocation30d)} alertas geolocalizadas en 30 días</small></button>
      <button className={`executive-kpi-card ${openModeration ? 'warning' : ''}`} onClick={() => navigate('/moderacion')}><span>Moderación</span><b>{formatNumber(openModeration)}</b><small>casos pendientes o en revisión</small></button>
      <button className="executive-kpi-card" onClick={() => navigate('/editor-oficial')}><span>Publicaciones oficiales</span><b>{formatNumber(content.officialPosts)}</b><small>{formatNumber(content.officialPosts30d)} creadas en 30 días</small></button>
    </section>
    <section className="executive-grid">
      <Panel title="Prioridades operativas" action={<button className="panel-action" onClick={() => navigate('/moderacion')}>Ver cola <ExternalLink size={14}/></button>}>
        <div className="executive-priorities">{priorityItems.length ? priorityItems.map((item) => <button key={item.key} className={`executive-priority ${item.tone}`} onClick={() => navigate(item.path)}><span className="severity"/><div><b>{item.title}</b><small>{item.detail}</small></div><ChevronRight size={17}/></button>) : <div className="executive-clear"><Activity size={20}/><div><b>Sin prioridades abiertas</b><span>No hay SOS, incidencias técnicas ni casos de moderación pendientes.</span></div></div>}</div>
      </Panel>
      <Panel title="Pulso de plataforma" action={<button className="panel-action" onClick={() => navigate('/monitorizacion')}>Ver monitorización <ExternalLink size={14}/></button>}>
        <div className="executive-services">{services.map((service) => <button key={String(service.key)} onClick={() => navigate('/monitorizacion')}><span className={`status ${String(service.status || 'unknown')}`}/><b>{String(service.name)}</b><small>{String(service.status) === 'operational' ? 'Operativo' : String(service.status) === 'attention' ? 'Revisar' : 'Sin sonda reciente'}</small></button>)}</div>
      </Panel>
      <Panel title="Crecimiento de usuarios" action={<button className="panel-action" onClick={() => navigate('/analitica-usuarios')}>Analítica <ExternalLink size={14}/></button>}><UserGrowthChart data={growth}/></Panel>
      <Panel title="Actividad administrativa" action={<button className="panel-action" onClick={() => navigate('/auditoria')}>Ver auditoría <ExternalLink size={14}/></button>}>
        <div className="executive-activity">{activity.length ? activity.map((item) => <button key={String(item.id)} onClick={() => navigate('/auditoria')}><span className="activity-mark"/><div><b>{auditActionLabel(String(item.action || ''))}</b><small>{String(item.actor || 'Sistema')} · {relative(item.createdAt)}</small></div><ChevronRight size={15}/></button>) : <div className="no-activity">Sin actividad administrativa registrada.</div>}</div>
      </Panel>
      <Panel title="Comunidad y conversación" action={<button className="panel-action" onClick={() => navigate('/territorios')}>Gestión territorial <ExternalLink size={14}/></button>}>
        <div className="executive-two-column"><div><span>Comunidades</span><b>{formatNumber(territories.communities)}</b><small>{formatNumber(territories.memberships)} participaciones</small></div><div><span>Mensajes en 24 h</span><b>{formatNumber(chat.messages24h)}</b><small>{formatNumber(chat.pendingDelivery15m)} pendientes de entrega</small></div><div><span>Adjuntos en 30 d</span><b>{formatNumber(chat.attachments30d)}</b><small>Biblioteca multimedia</small></div><div><span>Publicaciones feed</span><b>{formatNumber(content.feedPosts30d)}</b><small>Últimos 30 días</small></div></div>
      </Panel>
      <Panel title="Versión y seguridad" action={<button className="panel-action" onClick={() => navigate('/versiones')}>Versiones <ExternalLink size={14}/></button>}>
        <div className="executive-release"><div><span>Producción Android</span><b>{String(version.version || 'Sin sincronizar')}</b><small>version code {String(version.versionCode || '—')} · {relative(version.cachedAt)}</small></div><button className={`executive-security ${rlsExceptions ? 'attention' : ''}`} onClick={() => navigate('/cumplimiento')}><span>{coverage}%</span><small>cobertura RLS</small><b>{rlsExceptions ? `${rlsExceptions} excepción${rlsExceptions === 1 ? '' : 'es'}` : 'Sin excepciones'}</b></button></div>
      </Panel>
    </section>
  </>
}

function ExecutiveDashboardLegacy({ data }: { data: JsonRecord }) {
  const kpis = (data.kpis || []) as JsonRecord[]; const activity = (data.activity || []) as JsonRecord[]; const services = (data.services || []) as JsonRecord[];
  return <><div className="critical-strip"><span className="pulse"/><b>Situación nacional estable</b><span>Sin alertas SOS activas en este momento.</span><button>Ver centro SOS <ExternalLink size={14}/></button></div><div className="kpi-grid">{kpis.map((item) => <article className="kpi" key={String(item.label)}><p>{String(item.label)}</p><strong>{formatNumber(item.value)}</strong><small>{String(item.trend)}</small></article>)}</div><div className="dashboard-grid"><Panel title="Actividad reciente" action="Ver toda"><Timeline rows={activity}/></Panel><Panel title="Estado de servicios"><div className="services">{services.map((item) => <div key={String(item.name)}><span className={`status ${item.status}`}/><b>{String(item.name)}</b><small>{String(item.status) === 'operational' ? 'Operativo' : 'Atención requerida'}</small></div>)}</div></Panel><Panel title="Evolución de usuarios"><MiniChart/></Panel><Panel title="Pendientes prioritarios"><div className="tasks"><p><span className="severity warning"/>Revisar cola de moderación <b>→</b></p><p><span className="severity info"/>Validar campañas programadas <b>→</b></p><p><span className="severity success"/>Comprobar informe semanal <b>→</b></p></div></Panel></div></>
}

function ExecutiveDashboard({ data }: { data: JsonRecord }) {
  const navigate = useNavigate()
  const kpis = (data.kpis || []) as JsonRecord[]
  const activity = (data.activity || []) as JsonRecord[]
  const services = (data.services || []) as JsonRecord[]
  const [analytics, setAnalytics] = useState<JsonRecord | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const [serviceInfo, setServiceInfo] = useState<JsonRecord | null>(null)

  useEffect(() => {
    let active = true
    getUserGrowthSeries().catch(async () => (await getModuleData<JsonRecord>('analytics')).series as JsonRecord[])
      .then((series) => {
        if (!active) return
        setAnalytics({ series })
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  const serviceState = (service: JsonRecord) => {
    const name = String(service.name)
    const descriptions: Record<string, string> = {
      Supabase: 'La sesión actual ha podido consultar los datos operativos de Supabase correctamente.',
      Realtime: 'Los canales de tiempo real están disponibles para las funciones activas de la plataforma.',
      'Firebase push': 'La entrega de notificaciones se gestiona mediante Firebase Cloud Messaging.',
    }
    return { status: String(service.status || 'operational'), label: String(service.status) === 'operational' ? 'Operativo' : 'Sin supervisión', detail: descriptions[name] || 'No hay información adicional de este servicio.' }
  }

  return <>
    <div className="critical-strip"><span className="pulse"/><b>Situación nacional estable</b><span>Sin alertas SOS activas en este momento.</span><button onClick={() => navigate('/sos')}>Ver centro SOS <ExternalLink size={14}/></button></div>
    <div className="kpi-grid">{kpis.map((item) => <article className="kpi" key={String(item.label)}><p>{String(item.label)}</p><strong>{formatNumber(item.value)}</strong><small>{String(item.trend)}</small></article>)}</div>
    <div className="dashboard-grid">
      <Panel title="Actividad reciente" action={<button className="panel-action" onClick={() => setActivityOpen(true)}>Ver toda <ExternalLink size={14}/></button>}><Timeline rows={activity}/></Panel>
      <Panel title="Estado de servicios"><div className="services">{services.map((item) => { const state = serviceState(item); return <div key={String(item.name)}><span className={`status ${state.status}`}/><b>{String(item.name)}</b><small className={state.status === 'degraded' ? 'attention' : ''}>{state.label}</small><button className="service-info" onClick={() => setServiceInfo({ name: item.name, ...state })} title={`Información sobre ${String(item.name)}`}><Info size={15}/></button></div> })}</div></Panel>
      <Panel title="Evolución de usuarios"><UserGrowthChart data={(analytics?.series || []) as JsonRecord[]}/></Panel>
      <Panel title="Pendientes prioritarios"><div className="tasks"><button onClick={() => navigate('/moderacion')}><span className="severity warning"/>Revisar cola de moderación <b>→</b></button><button onClick={() => navigate('/editor-oficial')}><span className="severity success"/>Preparar comunicación oficial <b>→</b></button></div></Panel>
    </div>
    {activityOpen && <Modal title="Actividad reciente" close={() => setActivityOpen(false)}><Timeline rows={activity}/></Modal>}
    {serviceInfo && <Modal title={`Estado de ${String(serviceInfo.name)}`} close={() => setServiceInfo(null)}><div className="service-modal"><span className={`status ${String(serviceInfo.status)}`}/><div><b>{String(serviceInfo.label)}</b><p>{String(serviceInfo.detail)}</p></div></div></Modal>}
  </>
}

function SosModuleLegacy({ data, mapOnly }: { data: JsonRecord[]; mapOnly: boolean }) {
  const rows = data || []; return <div className={mapOnly ? 'map-page' : 'sos-layout'}><Panel title={mapOnly ? 'Mapa operativo nacional' : `Cola de alertas · ${rows.length} activas`} action="Filtros"><div className="map-canvas"><div className="map-grid" />{rows.length ? rows.map((row, index) => <button className="map-pin" style={{ left: `${26 + index * 19}%`, top: `${34 + index * 13}%` }} key={String(row.id)} title={String(row.sender)}><SirenIcon /></button>) : <div className="map-empty"><Map size={34}/><b>Sin ubicaciones activas</b><span>Las alertas SOS aparecerán aquí en tiempo real.</span></div>}<div className="map-legend"><span><i className="pin-dot"/>SOS</span><span><i className="zone-dot"/>Comunidad</span></div></div></Panel>{!mapOnly && <Panel title="Detalle de incidente"><div className="empty-state"><SirenIcon/><b>Selecciona una alerta</b><span>La actividad, ubicación y comunicaciones aparecerán en este panel.</span></div></Panel>} {!mapOnly && <Panel title="Alertas recientes"><DataTable rows={rows} columns={[['sender','Persona'],['message','Mensaje'],['createdAt','Recibida'],['status','Estado']]} /></Panel>}</div>
}

function SosModuleLegacyV2({ data, mapOnly }: { data: JsonRecord[]; mapOnly: boolean }) {
  const [alerts, setAlerts] = useState<JsonRecord[]>(data || [])
  const rows = alerts
  const [selectedId, setSelectedId] = useState<string | null>(() => rows[0] ? String(rows[0].id) : null)
  useEffect(() => {
    let active = true
    getSosAlerts().then((nextAlerts) => {
      if (!active) return
      setAlerts(nextAlerts as JsonRecord[])
      setSelectedId((current) => current && nextAlerts.some((alert) => String(alert.id) === current) ? current : (nextAlerts[0] ? String(nextAlerts[0].id) : null))
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const selected = rows.find((row) => String(row.id) === selectedId) || null
  const isRecent = isActiveSosAlert
  const recent = rows.filter(isRecent)
  const history = rows.filter((row) => !isRecent(row))
  const age = (row: JsonRecord) => {
    const elapsed = Math.max(0, Date.now() - new Date(String(row.createdAt)).getTime())
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours < 1) return 'Hace menos de una hora'
    if (hours < 24) return `Hace ${hours} h`
    return `Hace ${Math.floor(hours / 24)} d`
  }
  const map = <div className="map-canvas"><div className="map-grid" />{rows.length ? rows.map((row, index) => <button className={`map-pin ${String(row.id) === selectedId ? 'selected' : ''}`} style={{ left: `${12 + (index % 5) * 18}%`, top: `${18 + Math.floor(index / 5) * 8}%` }} key={String(row.id)} title={String(row.sender)} onClick={() => setSelectedId(String(row.id))}><SirenIcon /></button>) : <div className="map-empty"><Map size={34}/><b>Sin alertas SOS registradas</b><span>Las próximas alertas aparecerán aquí en tiempo real y se conservarán como histórico operativo.</span></div>}<div className="map-legend"><span><i className="pin-dot"/>Últimas 24 h</span><span><i className="zone-dot"/>Histórico</span></div></div>
  if (mapOnly) return <div className="map-page"><Panel title="Mapa operativo nacional" action="Últimas 50 alertas">{map}</Panel></div>
  const alertList = (items: JsonRecord[], kind: 'recent' | 'history') => items.map((row) => <button className={`sos-alert ${kind} ${String(row.id) === selectedId ? 'selected' : ''}`} key={String(row.id)} onClick={() => setSelectedId(String(row.id))}><span className="sos-alert-dot"/><span><b>{String(row.sender || 'Usuario de Qüata')}</b><small>{String(row.message || 'Alerta SOS')}</small></span><time>{age(row)}</time></button>)
  return <div className="sos-layout"><Panel title="Mapa operativo nacional" action={`${rows.length} de 50`}>{map}</Panel><Panel title="Cola SOS"><div className="sos-summary"><b>{recent.length} activas</b><span>{history.length} en histórico</span></div><div className="sos-queue">{rows.length ? <>{recent.length > 0 && <><p className="queue-heading recent">Últimas 24 horas</p>{alertList(recent, 'recent')}</>}{history.length > 0 && <><p className="queue-heading">Histórico</p>{alertList(history, 'history')}</>}</> : <div className="empty-state compact"><SirenIcon/><b>Sin alertas SOS</b><span>La cola mostrará hasta las últimas 50 alertas enviadas por la red.</span></div>}</div></Panel><Panel title="Detalle de incidente">{selected ? <div className="sos-detail"><span className={isRecent(selected) ? 'badge danger-badge' : 'badge'}>{isRecent(selected) ? 'Reciente' : 'Histórico'}</span><h3>{String(selected.sender || 'Usuario de Qüata')}</h3><p>{String(selected.message || 'Alerta SOS sin mensaje adicional.')}</p><dl><div><dt>Recibida</dt><dd>{dateTime(selected.createdAt)}</dd></div><div><dt>Estado</dt><dd>{String(selected.status || 'registrada')}</dd></div>{Boolean(selected.accuracy) && <div><dt>Precisión</dt><dd>{String(selected.accuracy)} m</dd></div>}</dl></div> : <div className="empty-state"><SirenIcon/><b>Selecciona una alerta</b><span>La actividad, ubicación y comunicaciones aparecerán en este panel.</span></div>}</Panel></div>
}

type SosCluster = { id: string; latitude: number; longitude: number; alerts: JsonRecord[] }

type SosMessage = { title: string; detail: string; latitude?: number; longitude?: number }

function decodeSosMessage(value: unknown): SosMessage {
  const raw = String(value || '').trim()
  const match = raw.match(/^\[SOS:(.*)]$/)
  if (!match) return { title: raw || 'Alerta SOS', detail: raw || 'Alerta SOS sin información adicional.' }
  const fields = new URLSearchParams(match[1].replaceAll(';', '&'))
  const kind = fields.get('kind') || 'alert'
  const name = fields.get('name') || 'Usuario de Qüata'
  const latitudeRaw = fields.get('lat')
  const longitudeRaw = fields.get('lng')
  const latitude = latitudeRaw === null || latitudeRaw.trim() === '' ? Number.NaN : Number(latitudeRaw)
  const longitude = longitudeRaw === null || longitudeRaw.trim() === '' ? Number.NaN : Number(longitudeRaw)
  const accuracy = fields.get('accuracy_m')
  const speed = fields.get('speed_kmh')
  const ageRaw = fields.get('age_ms')
  const age = ageRaw === null || ageRaw.trim() === '' ? Number.NaN : Number(ageRaw)
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)
  const fragments = ['Solicitud urgente de ayuda']
  if (hasCoordinates && Number.isFinite(age)) {
    const minutes = Math.max(0, Math.round(age / 60_000))
    fragments.push(minutes < 1 ? 'Ubicación obtenida ahora' : `Ubicación obtenida hace ${minutes} min`)
  }
  if (hasCoordinates && accuracy) fragments.push(`Precisión ${accuracy} m`)
  if (hasCoordinates && speed) fragments.push(`Velocidad ${speed} km/h`)
  if (!hasCoordinates) fragments.push('Ubicación no disponible')
  return {
    title: kind === 'location_update' || kind === 'update' ? `Ubicación SOS actualizada de ${name}` : `SOS de ${name}`,
    detail: fragments.join(' · '),
    latitude: hasCoordinates ? latitude : undefined,
    longitude: hasCoordinates ? longitude : undefined,
  }
}

function sosCoordinates(alert: JsonRecord) {
  const decoded = decodeSosMessage(alert.message)
  const latitude = alert.latitude === null || alert.latitude === undefined ? decoded.latitude : Number(alert.latitude)
  const longitude = alert.longitude === null || alert.longitude === undefined ? decoded.longitude : Number(alert.longitude)
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  if (latitude === 0 && longitude === 0) return null
  return { latitude, longitude }
}

function sosDistanceKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const toRadians = (value: number) => value * Math.PI / 180
  const dLat = toRadians(b.latitude - a.latitude)
  const dLng = toRadians(b.longitude - a.longitude)
  const factor = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(factor), Math.sqrt(1 - factor))
}

function clusterSosAlerts(alerts: unknown): SosCluster[] {
  const clusters: SosCluster[] = []
  for (const alert of (Array.isArray(alerts) ? alerts : [])) {
    const point = sosCoordinates(alert)
    if (!point) continue
    const nearby = clusters.find((cluster) => sosDistanceKm(cluster, point) <= 1.2)
    if (!nearby) {
      clusters.push({ id: String(alert.id), ...point, alerts: [alert] })
      continue
    }
    nearby.alerts.push(alert)
    nearby.latitude = nearby.alerts.reduce((total, item) => total + (sosCoordinates(item)?.latitude || 0), 0) / nearby.alerts.length
    nearby.longitude = nearby.alerts.reduce((total, item) => total + (sosCoordinates(item)?.longitude || 0), 0) / nearby.alerts.length
  }
  return clusters
}

function SosMapBounds({ clusters, focusedCluster }: { clusters: SosCluster[]; focusedCluster?: SosCluster | null }) {
  const map = useMap()
  const appliedSignature = useRef('')
  const signature = clusters.map((cluster) => cluster.id).join(',')
  const focusSignature = `${signature}:${focusedCluster?.id || 'all'}`
  useEffect(() => {
    if (!clusters.length || appliedSignature.current === focusSignature) return
    appliedSignature.current = focusSignature
    if (focusedCluster) {
      map.flyTo([focusedCluster.latitude, focusedCluster.longitude], focusedCluster.alerts.length > 1 ? 14 : 15, { duration: 0.55 })
      return
    }
    if (clusters.length === 1) map.setView([clusters[0].latitude, clusters[0].longitude], 13)
    else map.fitBounds(clusters.map((cluster) => [cluster.latitude, cluster.longitude] as [number, number]), { padding: [36, 36], maxZoom: 12 })
  }, [clusters, focusSignature, focusedCluster, map])
  return null
}

function SosOperationalMap({ clusters, focusedCluster, selectedClusterId, onSelect }: { clusters: SosCluster[]; focusedCluster?: SosCluster | null; selectedClusterId?: string; onSelect: (cluster: SosCluster) => void }) {
  const marker = (cluster: SosCluster) => divIcon({
    className: 'sos-map-marker-shell',
    html: `<span class="sos-map-marker ${cluster.id === (focusedCluster?.id || selectedClusterId) ? 'selected' : ''}"><span>${cluster.alerts.length > 1 ? cluster.alerts.length : '!'}</span></span>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  })
  return <div className="sos-map-container">{clusters.length ? <MapContainer center={[1.65, 10.26]} zoom={6} scrollWheelZoom className="sos-leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><SosMapBounds clusters={clusters} focusedCluster={focusedCluster}/>{clusters.map((cluster) => <Marker key={cluster.id} position={[cluster.latitude, cluster.longitude]} icon={marker(cluster)} eventHandlers={{ click: () => onSelect(cluster) }} />)}</MapContainer> : <div className="map-empty"><Map size={34}/><b>Sin ubicaciones SOS disponibles</b><span>Las alertas sin coordenadas se mantienen en el histórico, pero no se sitúan sobre el mapa.</span></div>}</div>
}

function SosModule({ data, mapOnly }: { data: JsonRecord[]; mapOnly: boolean }) {
  const [alerts, setAlerts] = useState<JsonRecord[]>(() => Array.isArray(data) ? data : [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [groupOverviewId, setGroupOverviewId] = useState<string | null>(null)
  const [threadAlert, setThreadAlert] = useState<JsonRecord | null>(null)
  const [threadMessages, setThreadMessages] = useState<JsonRecord[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [threadError, setThreadError] = useState('')
  const rows = Array.isArray(alerts) ? alerts : []
  const clusters = useMemo(() => clusterSosAlerts(rows), [rows])

  useEffect(() => {
    let active = true
    getSosAlerts().then((nextAlerts) => {
      if (!active) return
      setAlerts(Array.isArray(nextAlerts) ? nextAlerts as JsonRecord[] : [])
      setSelectedId(null)
      setGroupOverviewId(null)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  const selected = rows.find((row) => String(row.id) === selectedId) || null
  const groupOverview = groupOverviewId ? clusters.find((cluster) => cluster.id === groupOverviewId) || null : null
  const selectedCluster = groupOverview || (selected ? clusters.find((cluster) => cluster.alerts.some((alert) => String(alert.id) === selectedId)) || null : null)
  const selectedMessage = selected ? decodeSosMessage(selected.message) : null
  const isRecent = (row: JsonRecord) => {
    const createdAt = new Date(String(row.createdAt)).getTime()
    return Number.isFinite(createdAt) && Date.now() - createdAt <= 24 * 60 * 60 * 1000
  }
  const age = (row: JsonRecord) => {
    const elapsed = Math.max(0, Date.now() - new Date(String(row.createdAt)).getTime())
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours < 1) return 'Hace menos de una hora'
    if (hours < 24) return `Hace ${hours} h`
    return `Hace ${Math.floor(hours / 24)} d`
  }
  const recent = rows.filter(isRecent)
  const history = rows.filter((row) => !isRecent(row))
  const resetMap = () => { setSelectedId(null); setGroupOverviewId(null) }
  const openGroup = (cluster: SosCluster) => { setSelectedId(null); setGroupOverviewId(cluster.id) }
  const openAlert = (alert: JsonRecord) => { setGroupOverviewId(null); setSelectedId(String(alert.id)) }
  const openThread = async (alert: JsonRecord) => {
    setThreadAlert(alert)
    setThreadMessages([])
    setThreadError('')
    setThreadLoading(true)
    try {
      setThreadMessages(await getSosThreadMessages(String(alert.threadId)))
    } catch {
      setThreadError('No se ha podido cargar esta conversación. Inténtalo de nuevo.')
    } finally {
      setThreadLoading(false)
    }
  }
  const map = <SosOperationalMap clusters={clusters} focusedCluster={selectedCluster} onSelect={openGroup}/>
  const mapAction = selectedCluster
    ? <button className="panel-action" onClick={resetMap}>Ver todas las ubicaciones</button>
    : `${rows.length} de 50`

  if (mapOnly) return <div className="map-page"><Panel title="Mapa operativo nacional" action={mapAction}>{map}</Panel></div>

  const alertList = (items: JsonRecord[], kind: 'recent' | 'history') => items.map((row) => {
    const message = decodeSosMessage(row.message)
    return <button className={`sos-alert ${kind} ${String(row.id) === selectedId ? 'selected' : ''}`} key={String(row.id)} onClick={() => openAlert(row)}><span className="sos-alert-dot"/><span><b>{message.title}</b><small>{message.detail}</small></span><time>{age(row)}</time></button>
  })

  const groupDetail = groupOverview ? <div className="sos-detail"><span className="badge danger-badge">Zona seleccionada</span><h3>{groupOverview.alerts.length === 1 ? 'Alerta SOS en esta ubicación' : `${groupOverview.alerts.length} alertas SOS agrupadas`}</h3><p>{groupOverview.alerts.length === 1 ? 'Selecciona la alerta para consultar todos los detalles del incidente.' : 'Las alertas se han agrupado por proximidad. Selecciona una para ver su detalle individual.'}</p><div className="sos-cluster-detail"><b>{groupOverview.alerts.length} {groupOverview.alerts.length === 1 ? 'alerta' : 'alertas'} en esta ubicación</b><div>{groupOverview.alerts.map((alert) => <button key={String(alert.id)} onClick={() => openAlert(alert)}>{decodeSosMessage(alert.message).title} <small>{age(alert)}</small></button>)}</div></div></div> : null
  const selectedCoordinates = selected ? sosCoordinates(selected) : null
  const mapsUrl = selectedCoordinates ? `https://www.google.com/maps/search/?api=1&query=${selectedCoordinates.latitude},${selectedCoordinates.longitude}` : null
  const detailActions = selected ? <div className="sos-detail-actions">{mapsUrl && <a className="secondary compact" href={mapsUrl} target="_blank" rel="noreferrer"><Map size={15}/>Ver en Google Maps</a>}<button className="secondary compact" onClick={() => { void openThread(selected) }}><Eye size={15}/>Ver mensajes</button>{selectedCluster && selectedCluster.alerts.length > 1 && <button className="secondary compact" onClick={() => openGroup(selectedCluster)}>Volver al grupo ({selectedCluster.alerts.length})</button>}</div> : null
  const alertDetail = selected && selectedMessage ? <div className="sos-detail"><span className={isRecent(selected) ? 'badge danger-badge' : 'badge'}>{isRecent(selected) ? 'Reciente' : 'Histórico'}</span><h3>{selectedMessage.title}</h3><p>{selectedMessage.detail}</p>{detailActions}<dl><div><dt>Recibida</dt><dd>{dateTime(selected.createdAt)}</dd></div><div><dt>Estado</dt><dd>{String(selected.status || 'registrada')}</dd></div>{Boolean(selected.accuracy) && <div><dt>Precisión</dt><dd>{String(selected.accuracy)} m</dd></div>}</dl></div> : null

  return <><div className="sos-layout"><Panel title="Mapa operativo nacional" action={mapAction}>{map}</Panel><Panel title="Cola SOS"><div className="sos-summary"><b>{recent.length} activas</b><span>{history.length} en histórico</span></div><div className="sos-queue">{rows.length ? <>{recent.length > 0 && <><p className="queue-heading recent">Últimas 24 horas</p>{alertList(recent, 'recent')}</>}{history.length > 0 && <><p className="queue-heading">Histórico</p>{alertList(history, 'history')}</>}</> : <div className="empty-state compact"><SirenIcon/><b>Sin alertas SOS</b><span>La cola mostrará hasta las últimas 50 alertas enviadas por la red.</span></div>}</div></Panel><Panel title="Detalle de incidente">{groupDetail || alertDetail || <div className="empty-state"><SirenIcon/><b>Selecciona una alerta o ubicación</b><span>La actividad, ubicación y comunicaciones aparecerán en este panel.</span></div>}</Panel></div>{threadAlert && <SosThreadModal alert={threadAlert} messages={threadMessages} loading={threadLoading} error={threadError} close={() => setThreadAlert(null)}/>}</>
}

function SosAttachmentPreview({ attachment }: { attachment: JsonRecord }) {
  const url = String(attachment.url || '')
  const mimeType = String(attachment.mimeType || '').toLowerCase()
  const name = String(attachment.name || 'Archivo adjunto')
  if (!url) return null
  if (mimeType.startsWith('image/')) return <a className="sos-attachment image" href={url} target="_blank" rel="noreferrer"><img src={url} alt={name}/><span>Abrir imagen</span></a>
  if (mimeType.startsWith('video/')) return <div className="sos-attachment media"><video controls preload="metadata" src={url}/><a href={url} target="_blank" rel="noreferrer">Abrir vídeo</a></div>
  if (mimeType.startsWith('audio/')) {
    const audioType = mimeType === 'audio/ogg' ? 'audio/ogg; codecs=opus' : mimeType
    return <div className="sos-attachment audio"><span>{name}</span><audio controls preload="metadata"><source src={url} type={audioType}/></audio></div>
  }
  if (mimeType === 'application/pdf') return <div className="sos-attachment pdf"><iframe src={`${url}#view=FitH`} title={name}/><a href={url} target="_blank" rel="noreferrer">Abrir PDF</a></div>
  return <a className="sos-attachment file" href={url} target="_blank" rel="noreferrer"><FilePlus2 size={18}/><span><b>{name}</b><small>Abrir archivo adjunto</small></span><ExternalLink size={15}/></a>
}

function SosThreadModal({ alert, messages, loading, error, close }: { alert: JsonRecord; messages: JsonRecord[]; loading: boolean; error: string; close: () => void }) {
  const sosTitle = decodeSosMessage(alert.message).title
  return <Modal title="Mensajes de la conversación SOS" close={close}><div className="sos-thread-modal"><div className="sos-thread-intro"><span className="badge danger-badge">Hilo SOS</span><div><b>{sosTitle}</b><p>Conversación asociada a esta alerta. Revisa las respuestas y actualizaciones para conocer su evolución.</p></div></div>{loading && <div className="sos-thread-loading"><span className="spinner"/>Cargando mensajes…</div>}{error && <div className="form-error">{error}</div>}{!loading && !error && <div className="sos-thread-list">{messages.length ? messages.map((message) => { const body = String(message.body || ''); const decoded = body.startsWith('[SOS:') ? decodeSosMessage(body) : null; const attachments = Array.isArray(message.attachments) ? message.attachments as JsonRecord[] : []; return <article className={`sos-thread-message ${message.isSos ? 'is-sos' : ''}`} key={String(message.id)}><header><b>{String(message.sender || 'Usuario de Qüata')}</b><time>{dateTime(message.createdAt)}</time></header>{decoded ? <><strong>{decoded.title}</strong><p>{decoded.detail}</p></> : body ? <p>{body}</p> : null}{attachments.length > 0 && <div className="sos-attachments">{attachments.map((attachment, index) => <SosAttachmentPreview key={String(attachment.id || index)} attachment={attachment}/>)}</div>}{!decoded && !body && !attachments.length && <p>Mensaje sin contenido</p>}</article> }) : <div className="empty-state compact"><b>Sin mensajes en el hilo</b><span>La conversación no contiene mensajes visibles.</span></div>}</div>}</div></Modal>
}

function SosModulePrevious({ data, mapOnly }: { data: JsonRecord[]; mapOnly: boolean }) {
  const [alerts, setAlerts] = useState<JsonRecord[]>(data || [])
  const rows = alerts
  const clusters = useMemo(() => clusterSosAlerts(rows), [rows])
  const [selectedId, setSelectedId] = useState<string | null>(() => rows[0] ? String(rows[0].id) : null)
  useEffect(() => {
    let active = true
    getSosAlerts().then((nextAlerts) => {
      if (!active) return
      setAlerts(nextAlerts as JsonRecord[])
      setSelectedId((current) => current && nextAlerts.some((alert) => String(alert.id) === current) ? current : (nextAlerts[0] ? String(nextAlerts[0].id) : null))
    }).catch(() => undefined)
    return () => { active = false }
  }, [])
  const selected = rows.find((row) => String(row.id) === selectedId) || null
  const selectedCluster = clusters.find((cluster) => cluster.alerts.some((alert) => String(alert.id) === selectedId)) || null
  const isRecent = (row: JsonRecord) => {
    const createdAt = new Date(String(row.createdAt)).getTime()
    return Number.isFinite(createdAt) && Date.now() - createdAt <= 24 * 60 * 60 * 1000
  }
  const recent = rows.filter(isRecent)
  const history = rows.filter((row) => !isRecent(row))
  const age = (row: JsonRecord) => {
    const elapsed = Math.max(0, Date.now() - new Date(String(row.createdAt)).getTime())
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours < 1) return 'Hace menos de una hora'
    if (hours < 24) return `Hace ${hours} h`
    return `Hace ${Math.floor(hours / 24)} d`
  }
  const map = <SosOperationalMap clusters={clusters} selectedClusterId={selectedCluster?.id} onSelect={(cluster) => setSelectedId(String(cluster.alerts[0].id))}/>
  if (mapOnly) return <div className="map-page"><Panel title="Mapa operativo nacional" action="Últimas 50 alertas">{map}</Panel></div>
  const alertList = (items: JsonRecord[], kind: 'recent' | 'history') => items.map((row) => { const message = decodeSosMessage(row.message); return <button className={`sos-alert ${kind} ${String(row.id) === selectedId ? 'selected' : ''}`} key={String(row.id)} onClick={() => setSelectedId(String(row.id))}><span className="sos-alert-dot"/><span><b>{message.title}</b><small>{message.detail}</small></span><time>{age(row)}</time></button> })
  const selectedMessage = selected ? decodeSosMessage(selected.message) : null
  return <div className="sos-layout"><Panel title="Mapa operativo nacional" action={`${rows.length} de 50`}>{map}</Panel><Panel title="Cola SOS"><div className="sos-summary"><b>{recent.length} activas</b><span>{history.length} en histórico</span></div><div className="sos-queue">{rows.length ? <>{recent.length > 0 && <><p className="queue-heading recent">Últimas 24 horas</p>{alertList(recent, 'recent')}</>}{history.length > 0 && <><p className="queue-heading">Histórico</p>{alertList(history, 'history')}</>}</> : <div className="empty-state compact"><SirenIcon/><b>Sin alertas SOS</b><span>La cola mostrará hasta las últimas 50 alertas enviadas por la red.</span></div>}</div></Panel><Panel title="Detalle de incidente">{selected && selectedMessage ? <div className="sos-detail"><span className={isRecent(selected) ? 'badge danger-badge' : 'badge'}>{isRecent(selected) ? 'Reciente' : 'Histórico'}</span><h3>{selectedMessage.title}</h3><p>{selectedMessage.detail}</p>{selectedCluster && selectedCluster.alerts.length > 1 && <div className="sos-cluster-detail"><b>{selectedCluster.alerts.length} alertas agrupadas en esta ubicación</b><div>{selectedCluster.alerts.map((alert) => <button key={String(alert.id)} className={String(alert.id) === selectedId ? 'selected' : ''} onClick={() => setSelectedId(String(alert.id))}>{decodeSosMessage(alert.message).title} <small>{age(alert)}</small></button>)}</div></div>}<dl><div><dt>Recibida</dt><dd>{dateTime(selected.createdAt)}</dd></div><div><dt>Estado</dt><dd>{String(selected.status || 'registrada')}</dd></div>{Boolean(selected.accuracy) && <div><dt>Precisión</dt><dd>{String(selected.accuracy)} m</dd></div>}</dl></div> : <div className="empty-state"><SirenIcon/><b>Selecciona una alerta</b><span>La actividad, ubicación y comunicaciones aparecerán en este panel.</span></div>}</Panel></div>
}

function TerritoriesModule() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [activity, setActivity] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, page: 1, pageSize: 20 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      getTerritories(query, status, activity, page).then((next) => {
        if (active) setResult(next)
      }).catch(() => {
        if (active) setError('No se han podido cargar las comunidades. Inténtalo de nuevo.')
      }).finally(() => {
        if (active) setLoading(false)
      })
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, status, activity, page, refreshKey])

  const items = (result.items || []) as JsonRecord[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 20)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const updateQuery = (value: string) => { setQuery(value); setPage(1) }
  const updateStatus = (value: string) => { setStatus(value); setPage(1) }
  const updateActivity = (value: string) => { setActivity(value); setPage(1) }

  return <><div className="territory-toolbar"><label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => updateQuery(event.target.value)} placeholder="Buscar barrio, ciudad o identificador" aria-label="Buscar comunidad"/></label><label>Estado<select value={status} onChange={(event) => updateStatus(event.target.value)}><option value="all">Todos</option><option value="active">Activas</option><option value="inactive">Inactivas</option></select></label><label>Actividad<select value={activity} onChange={(event) => updateActivity(event.target.value)}><option value="all">Todas</option><option value="with_activity">Con publicaciones</option><option value="without_activity">Sin publicaciones</option></select></label></div><Panel title="Comunidades y barrios" action={`${total} resultados`}>{error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={() => setRefreshKey((current) => current + 1)}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando comunidades…</div> : <><DataTable rows={items} columns={[['name','Comunidad'],['city','Ciudad'],['memberCount','Miembros'],['postCount','Publicaciones'],['isActive','Estado'],['createdAt','Creada']]} /><div className="territory-pagination"><span>Mostrando {items.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} de {total}</span><div><button className="icon" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} title="Página anterior"><ChevronLeft size={18}/></button><b>Página {page} de {totalPages}</b><button className="icon" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} title="Página siguiente"><ChevronRight size={18}/></button></div></div></>}</Panel></>
}

function Moderation({ refresh }: { data: JsonRecord[]; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<JsonRecord | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selected, setSelected] = useState<JsonRecord | null>(null)
  const [policiesOpen, setPoliciesOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [fullContent, setFullContent] = useState<JsonRecord | null>(null)
  const [fullContentLoading, setFullContentLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [targetType, setTargetType] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, pageSize: 20 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      getModerationReports(query, status, targetType, page).then((value) => { if (active) setResult(value as JsonRecord) }).catch(() => { if (active) setError('No se ha podido cargar la cola de moderación.') }).finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, status, targetType, page, refreshKey])
  const viewCase = async (row: JsonRecord) => {
    setSelected(row); setDetail(null); setDetailLoading(true)
    try { setDetail(await getModerationReportDetail(String(row.id)) as JsonRecord) }
    catch { setDetail({ error: 'No se ha podido cargar el contenido denunciado.' }) }
    finally { setDetailLoading(false) }
  }
  const decide = async (decision: 'reviewing' | 'dismiss' | 'remove_content', note?: string) => {
    if (!selected) return
    setBusy(String(selected.id)); setNotice('')
    try {
      const result = await decideModerationReport(String(selected.id), decision, note)
      const removed = Boolean(result.contentRemoved)
      setNotice(decision === 'remove_content' ? (removed ? 'Contenido retirado y caso cerrado.' : 'El contenido ya no estaba disponible; el caso ha quedado cerrado.') : decision === 'dismiss' ? 'Caso descartado sin retirar contenido.' : 'Caso marcado para revisión.')
      await viewCase(selected); setRefreshKey((current) => current + 1); refresh()
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : 'No se ha podido aplicar la decisión.') }
    finally { setBusy(null) }
  }
  const openFullContent = async () => {
    if (!selected) return
    setFullContentLoading(true); setFullContent(null)
    try { setFullContent(await getModerationFullContent(String(selected.id)) as JsonRecord) }
    catch { setFullContent({ error: 'No se ha podido cargar el contenido completo.' }) }
    finally { setFullContentLoading(false) }
  }
  const rows = (result.items || []) as JsonRecord[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 20)
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const setFilter = (setter: (value: string) => void, value: string) => { setter(value); setPage(1) }
  return <><div className="split-layout"><div><div className="moderation-toolbar"><label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => setFilter(setQuery, event.target.value)} placeholder="Buscar por usuario, tipo o identificador" aria-label="Buscar reportes"/></label><label>Estado<select value={status} onChange={(event) => setFilter(setStatus, event.target.value)}><option value="all">Todos</option><option value="pending">Pendientes</option><option value="reviewing">En revisión</option><option value="removed">Contenido retirado</option><option value="dismissed">Descartados</option></select></label><label>Contenido<select value={targetType} onChange={(event) => setFilter(setTargetType, event.target.value)}><option value="all">Todos</option><option value="community_post">Feed</option><option value="official_post">Muro oficial</option><option value="community_comment">Comentario</option><option value="official_comment">Comentario oficial</option><option value="chat_message">Mensaje de chat</option><option value="profile">Perfil</option></select></label></div><Panel title="Cola de reportes" action={`${total} casos`}>{error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={() => setRefreshKey((current) => current + 1)}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando reportes…</div> : <><DataTable rows={rows} columns={[['targetType','Contenido'],['reporter','Reportado por'],['createdAt','Fecha'],['status','Estado']]} action={(row) => <span className="table-actions"><button onClick={() => viewCase(row)}><Eye size={13}/>Ver caso</button></span>} /><div className="territory-pagination"><span>Mostrando {rows.length ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} de {total}</span><div><button className="icon" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} title="Página anterior"><ChevronLeft size={18}/></button><b>Página {page} de {totalPages}</b><button className="icon" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} title="Página siguiente"><ChevronRight size={18}/></button></div></div></>}</Panel></div><Panel title="Decisiones y trazabilidad"><div className="policy-list"><b>Revisión contextual</b><p>Abre cada caso para ver el contenido original, su autor y los archivos adjuntos antes de tomar una decisión.</p><hr/><b>Acciones disponibles</b><p>Puedes marcar un caso en revisión, descartarlo o retirar el contenido. El estado visible siempre describe la última decisión tomada.</p><button className="secondary full" onClick={() => setPoliciesOpen(true)}>Abrir políticas de moderación</button></div></Panel></div>{selected && <ModerationCaseModal row={selected} detail={detail} loading={detailLoading} busy={busy === String(selected.id)} notice={notice} close={() => { setSelected(null); setNotice('') }} onDecide={decide} onReadMore={openFullContent}/>} {policiesOpen && <ModerationPoliciesModal close={() => setPoliciesOpen(false)}/>} {(fullContentLoading || fullContent) && <ModerationFullContentModal content={fullContent} loading={fullContentLoading} close={() => { setFullContent(null); setFullContentLoading(false) }}/>}</>
}

function ModerationCaseModal({ row, detail, loading, busy, notice, close, onDecide, onReadMore }: { row: JsonRecord; detail: JsonRecord | null; loading: boolean; busy: boolean; notice: string; close: () => void; onDecide: (decision: 'reviewing' | 'dismiss' | 'remove_content', note?: string) => void; onReadMore: () => void }) {
  const target = detail?.target as JsonRecord | undefined
  const report = detail?.report as JsonRecord | undefined
  const reporter = detail?.reporter as JsonRecord | undefined
  const typeLabel = String(row.targetType || '').replaceAll('_', ' ')
  const currentStatus = String(report?.status || row.status || 'pending')
  return <Modal title="Revisar caso de moderación" close={close}><div className="moderation-modal">
    {loading && <div className="moderation-loading"><span className="spinner"/>Cargando contenido denunciado…</div>}
    {!loading && Boolean(detail?.error) && <div className="form-error">{String(detail?.error)}</div>}
    {!loading && target && <>
      <div className="moderation-case-meta"><span className="badge official">{typeLabel}</span><span className={`badge ${currentStatus === 'pending' ? 'neutral' : 'success'}`}>{moderationStatusLabel(currentStatus)}</span><time>Denunciado {dateTime(report?.createdAt || row.createdAt)}</time></div>
      {target.exists === false ? <div className="empty-state compact"><CircleAlert/><b>Contenido eliminado</b><span>El contenido original ya no está disponible, pero el expediente y su decisión se conservan para auditoría.</span></div> : <ModerationContentPreview target={target} reportedProfile={detail?.reportedProfile as JsonRecord | undefined} onReadMore={onReadMore}/>} 
      <div className="moderation-context"><span>Denunciado por <b>{String(reporter?.name || row.reporter || 'Usuario de Qüata')}</b></span></div>
      <form className="moderation-decision" onSubmit={(event) => { event.preventDefault(); const note = String(new FormData(event.currentTarget).get('note') || ''); onDecide('reviewing', note) }}><label>Nota interna (opcional)<textarea name="note" rows={2} placeholder="Contexto de la decisión para auditoría"/></label>{notice && <div className={notice.startsWith('No se') || notice.startsWith('qoc_') ? 'form-error' : 'form-notice'}>{notice}</div>}<div className="form-actions"><button type="button" className={`secondary moderation-decision-button ${currentStatus === 'dismissed' ? 'is-selected' : ''}`} disabled={busy} onClick={() => onDecide('dismiss')}>Descartar</button><button type="submit" className={`secondary moderation-decision-button ${currentStatus === 'reviewing' ? 'is-selected' : ''}`} disabled={busy}>Marcar en revisión</button>{String(row.targetType) !== 'profile' && target.exists !== false && <button type="button" className={`danger moderation-decision-button ${currentStatus === 'removed' ? 'is-selected' : ''}`} disabled={busy} onClick={() => onDecide('remove_content')}>{busy ? 'Aplicando…' : 'Retirar contenido'}</button>}</div></form>
    </>}
  </div></Modal>
}

function ModerationContentPreview({ target, reportedProfile, onReadMore }: { target: JsonRecord; reportedProfile?: JsonRecord; onReadMore: () => void }) {
  const type = String(target.type || '')
  const author = target.author as JsonRecord | undefined
  const authorName = String(author?.name || reportedProfile?.name || 'Usuario de Qüata')
  const avatarUrl = String((author?.avatarUrl || reportedProfile?.avatarUrl) || '')
  const rawBody = String(target.body || '')
  const cleanBody = rawBody.replace(/\[(?:MEDIA_TITULO|UBICACION):[^\]]*\]/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const mediaUrl = String(target.mediaUrl || '')
  const isVideo = String(target.mediaType || '') === 'video'
  const avatar = <div className="moderation-preview-avatar">{avatarUrl ? <img src={avatarUrl} alt=""/> : initials(authorName)}</div>
  const actions = <aside className="moderation-preview-actions"><span><Heart size={15}/><b>0</b></span><span><MessageCircle size={15}/><b>0</b></span><span><Share2 size={15}/></span></aside>
  const media = mediaUrl ? <a href={mediaUrl} target="_blank" rel="noreferrer" className="moderation-preview-media" title={isVideo ? 'Abrir vídeo en una nueva pestaña' : 'Abrir imagen en una nueva pestaña'}>{isVideo ? <><video src={mediaUrl} preload="metadata"/><i><Play size={22} fill="currentColor"/></i></> : <img src={mediaUrl} alt="Contenido denunciado"/>}</a> : null

  if (type === 'community_post') return <article className={`moderation-preview feed ${mediaUrl ? 'has-media' : 'text-only'}`}><div className="moderation-feed-body">{media}{!media && <p className="moderation-feed-quote">{cleanBody || 'Publicación sin texto visible'}</p>}{media && cleanBody && <strong className="moderation-feed-caption">{cleanBody}</strong>}{!media && cleanBody.length > 180 && <button className="moderation-read-more feed-read-more" onClick={onReadMore}>Leer más <ChevronRight size={14}/></button>}<div className="moderation-feed-author">{avatar}<div><b>{authorName}</b><small>{dateTime(target.createdAt)}</small></div></div>{actions}</div></article>
  if (type === 'official_post') return <article className="moderation-preview official"><header>{avatar}<div><b>{authorName}<span className="verified-dot">✓</span></b><small>Cuenta oficial de Qüata · {dateTime(target.createdAt)}</small></div><span className="official-type">{String(target.postType || 'Comunicado')}</span></header>{media}<section><h3>{String(target.title || 'Publicación oficial')}</h3><i className="official-rule"/><p>{cleanBody}</p><button onClick={onReadMore}>Leer más <ChevronRight size={14}/></button></section>{actions}</article>
  if (type === 'chat_message') return <article className="moderation-preview chat"><header>{avatar}<div><b>{authorName}</b><small>{dateTime(target.createdAt)}</small></div></header><div className="chat-bubble">{cleanBody || 'Mensaje con adjunto'}<time>{dateTime(target.createdAt).split(',').pop()?.trim()}</time></div><ModerationChatAttachments attachments={Array.isArray(target.attachments) ? target.attachments as JsonRecord[] : []}/></article>
  if (type.includes('comment')) return <article className="moderation-preview comment"><header>{avatar}<div><b>{authorName}</b><small>{dateTime(target.createdAt)}</small></div></header><p>{cleanBody || 'Comentario sin contenido'}</p><footer><button>Responder</button><button><Heart size={13}/>0</button></footer></article>
  return <article className="moderation-preview profile"><div className="profile-large-avatar">{avatar}</div><b>{authorName}</b><span>Perfil denunciado</span></article>
}

function ModerationChatAttachments({ attachments }: { attachments: JsonRecord[] }) {
  if (!attachments.length) return null
  return <div className="moderation-chat-attachments">{attachments.map((attachment, index) => {
    const url = String(attachment.url || '')
    const name = String(attachment.name || 'Adjunto')
    const mimeType = String(attachment.mimeType || '')
    const key = String(attachment.url || index)
    if (mimeType.startsWith('image/')) return <a className="moderation-chat-attachment image" key={key} href={url} target="_blank" rel="noreferrer"><img src={url} alt={name}/><span>{name}<ExternalLink size={13}/></span></a>
    if (mimeType.startsWith('video/')) return <div className="moderation-chat-attachment video" key={key}><video controls preload="metadata" src={url}/><a href={url} target="_blank" rel="noreferrer">Abrir o descargar vídeo <ExternalLink size={13}/></a></div>
    if (mimeType.startsWith('audio/')) return <div className="moderation-chat-attachment audio" key={key}><audio controls preload="metadata" src={url}/><a href={url} target="_blank" rel="noreferrer">Descargar audio <ExternalLink size={13}/></a></div>
    if (mimeType === 'application/pdf') return <div className="moderation-chat-attachment pdf" key={key}><iframe src={`${url}#view=FitH`} title={name}/><a href={url} target="_blank" rel="noreferrer">Abrir PDF <ExternalLink size={13}/></a></div>
    return <a className="moderation-chat-attachment file" key={key} href={url} target="_blank" rel="noreferrer"><FilePlus2 size={18}/><span><b>{name}</b><small>{mimeType || 'Archivo adjunto'}</small></span><ExternalLink size={13}/></a>
  })}</div>
}

function sanitizeRichContent(html: string) {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const allowed = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'MARK', 'BLOCKQUOTE', 'ASIDE', 'BR', 'A', 'CODE', 'PRE', 'HR'])
  document.body.querySelectorAll('*').forEach((node) => {
    if (!allowed.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes))
      return
    }
    for (const attribute of Array.from(node.attributes)) {
      const safeLink = node.tagName === 'A' && attribute.name === 'href' && /^(https?:|mailto:)/i.test(attribute.value)
      const safeBlockAttribute = (node.tagName === 'ASIDE' && attribute.name === 'data-quata-block' && attribute.value === 'info') || (node.tagName === 'LI' && ['data-quata-todo', 'data-checked'].includes(attribute.name)) || (node.tagName === 'UL' && attribute.name === 'data-quata-list' && attribute.value === 'todo')
      if (!safeLink && !safeBlockAttribute) node.removeAttribute(attribute.name)
    }
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer') }
  })
  return document.body.innerHTML
}

function ModerationFullContentModal({ content, loading, close }: { content: JsonRecord | null; loading: boolean; close: () => void }) {
  const isOfficial = String(content?.type || '') === 'official_post'
  const html = String(content?.contentHtml || '')
  const text = String(content?.contentText || '')
  return <Modal title="Contenido completo" close={close}><div className="moderation-full-content">{loading && <div className="moderation-loading"><span className="spinner"/>Cargando contenido completo…</div>}{!loading && Boolean(content?.error) && <div className="form-error">{String(content?.error)}</div>}{!loading && content && !content.error && <><h2>{String(content.title || '')}</h2>{isOfficial ? <article className="rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichContent(html) }}/> : <article className="plain-full-content">{text.replace(/\[(?:MEDIA_TITULO|UBICACION):[^\]]*\]/g, '').trim()}</article>}</>}</div></Modal>
}

function ModerationPoliciesModal({ close }: { close: () => void }) {
  return <Modal title="Políticas de moderación" close={close}><div className="moderation-policies"><p>Este borrador guía las decisiones operativas de Qüata. Cada intervención debe ser necesaria, proporcionada y quedar registrada.</p><section><b>1. Prioridad de seguridad</b><span>Retira de inmediato contenido que implique riesgo de menores, amenazas creíbles, violencia explícita, explotación o difusión de información personal sensible.</span></section><section><b>2. Acoso, odio e impersonación</b><span>Evalúa el contexto y la reiteración. Retira contenido que ataque, humille o suplante de forma dañina a una persona o colectivo.</span></section><section><b>3. Spam y uso abusivo</b><span>Retira publicaciones, comentarios o mensajes automatizados, engañosos o repetitivos que deterioren la conversación.</span></section><section><b>4. Proporcionalidad y trazabilidad</b><span>Cuando no haya una infracción clara, marca el caso en revisión o descártalo. No uses la retirada de contenido como sustituto de un bloqueo personal.</span></section><section><b>5. Privacidad</b><span>Consulta solo los datos necesarios para resolver el caso y no copies información privada fuera de QOC.</span></section></div></Modal>
}

function OfficialModule({ data, editor, refresh, session }: { data: JsonRecord | null | undefined; editor: boolean; refresh: () => void; session: QocSession }) {
  const editorialOnly = session.profile.isOfficial && !session.profile.isAdmin && session.roles.length === 0
  const accounts = editorialOnly
    ? [{ id: session.profile.id, name: session.profile.displayName, avatarUrl: session.profile.avatarUrl, territory: session.profile.territory || 'Ámbito nacional', isAdmin: false }]
    : ((data?.accounts || []) as JsonRecord[])
  if (editor) return <OfficialPostsManager accounts={accounts} refresh={refresh} />
  return <OfficialDirectory refresh={refresh}/>
}

function OfficialDirectory({ refresh }: { refresh: () => void }) {
  const [profileQuery, setProfileQuery] = useState('')
  const [territory, setTerritory] = useState(() => new URLSearchParams(window.location.search).get('barrio') || 'all')
  const [accountType, setAccountType] = useState('all')
  const [profilePage, setProfilePage] = useState(1)
  const [profileResult, setProfileResult] = useState<JsonRecord>({ items: [], total: 0, pageSize: 20, territories: [] })
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [profilesError, setProfilesError] = useState('')
  const [profileReload, setProfileReload] = useState(0)
  const [selectedProfile, setSelectedProfile] = useState<JsonRecord | null>(null)
  const [roleBusy, setRoleBusy] = useState<string | null>(null)
  useEffect(() => { let active = true; const timer = window.setTimeout(() => { setProfilesLoading(true); setProfilesError(''); getOfficialProfiles(profileQuery, territory, accountType, profilePage).then((value) => { if (active) setProfileResult(value as JsonRecord) }).catch(() => { if (active) setProfilesError('No se ha podido cargar el directorio de cuentas.') }).finally(() => { if (active) setProfilesLoading(false) }) }, 160); return () => { active = false; window.clearTimeout(timer) } }, [profileQuery, territory, accountType, profilePage, profileReload])
  const updateProfileFilter = (setter: (value: string) => void, value: string) => { setter(value); setProfilePage(1) }
  const toggleRole = async (profile: JsonRecord, field: 'isAdmin'|'isOfficial') => { setRoleBusy(`${profile.id}:${field}`); try { const result = await qocCommand<JsonRecord>('user.role.toggle', { profileId: profile.id, [field]: !Boolean(profile[field]), reason: `Cambio ${field} desde QOC` }); setSelectedProfile((current) => current && String(current.id) === String(profile.id) ? { ...current, isAdmin: result.is_admin, isOfficial: result.is_official } : current); setProfileReload((current) => current + 1); refresh() } finally { setRoleBusy(null) } }
  const profiles = (profileResult.items || []) as JsonRecord[]; const territories = (profileResult.territories || []) as string[]; const profileTotal = Number(profileResult.total || 0); const profilePageSize = Number(profileResult.pageSize || 20); const profilePages = Math.max(1, Math.ceil(profileTotal / profilePageSize))
  /* Legacy inline view retained temporarily below while the directory layout is split into readable pieces.
  return <><div className="section-tabs" role="tablist"><button className={tab === 'profiles' ? 'active' : ''} onClick={() => setTab('profiles')}>Perfiles</button><button className={tab === 'posts' ? 'active' : ''} onClick={() => setTab('posts')}>Publicaciones oficiales</button></div>{tab === 'profiles' ? <><div className="territory-toolbar"><label className="territory-search"><Search size={16}/><input value={profileQuery} onChange={(event) => updateProfileFilter(setProfileQuery, event.target.value)} placeholder="Buscar por nombre o barrio"/></label><label>Barrio<select value={territory} onChange={(event) => updateProfileFilter(setTerritory, event.target.value)}><option value="all">Todos</option>{territories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Tipo de cuenta<select value={accountType} onChange={(event) => updateProfileFilter(setAccountType, event.target.value)}><option value="all">Todas</option><option value="official">Oficiales</option><option value="admin">Administradores</option><option value="official_admin">Oficiales y administradores</option><option value="standard">Estándar</option></select></label></div><Panel title="Directorio de cuentas" action={`${profileTotal} perfiles`}>{profilesError ? <div className="territory-error"><CircleAlert size={18}/><span>{profilesError}</span><button className="secondary" onClick={() => setProfileReload((current) => current + 1)}>Reintentar</button></div> : profilesLoading ? <div className="territory-loading"><span className="spinner"/>Actualizando perfiles…</div> : <><div className="official-account-grid">{profiles.map((profile) => <article className="official-account-card" key={String(profile.id)}><div className="official-account-avatar">{profile.avatarUrl ? <img src={String(profile.avatarUrl)} alt=""/> : initials(String(profile.name))}</div><div className="official-account-copy"><h3>{String(profile.name)}{Boolean(profile.isOfficial) && <span className="verified-dot">✓</span>}</h3><p>{String(profile.territory)}</p><div>{Boolean(profile.isOfficial) && <span className="badge official">Oficial</span>}{Boolean(profile.isAdmin) && <span className="badge success">Admin</span>}{!Boolean(profile.isOfficial) && !Boolean(profile.isAdmin) && <span className="badge neutral">Cuenta estándar</span>}</div></div><button className="icon official-more" onClick={() => setSelectedProfile(profile)} title="Ver perfil"><MoreHorizontal size={20}/></button></article>)}</div><DirectoryPagination page={profilePage} total={profileTotal} pageSize={profilePageSize} pages={profilePages} onPage={setProfilePage}/></>}</Panel></> : <><div className="territory-toolbar"><label className="territory-search"><Search size={16}/><input value={postQuery} onChange={(event) => updatePostFilter(setPostQuery, event.target.value)} placeholder="Buscar por título, cuenta o resumen"/></label><label>Estado<select value={postStatus} onChange={(event) => updatePostFilter(setPostStatus, event.target.value)}><option value="all">Todos</option><option value="published">Publicadas</option><option value="draft">Borradores</option><option value="deleted">Eliminadas</option></select></label><label>Tipo<select value={postType} onChange={(event) => updatePostFilter(setPostType, event.target.value)}><option value="all">Todos</option><option value="announcement">Comunicado</option><option value="news">Noticia</option><option value="event">Evento</option><option value="urgent">Alerta</option></select></label></div><Panel title="Publicaciones oficiales" action={`${postTotal} publicaciones`}>{postsError ? <div className="territory-error"><CircleAlert size={18}/><span>{postsError}</span><button className="secondary" onClick={() => setPostReload((current) => current + 1)}>Reintentar</button></div> : postsLoading ? <div className="territory-loading"><span className="spinner"/>Actualizando publicaciones…</div> : <><div className="official-post-list">{posts.map((post) => <button className="official-post-row" key={String(post.id)} onClick={() => setSelectedPost(post)}><span className={`official-post-status ${String(post.status)}`}/><div><b>{String(post.title || 'Publicación sin título')}</b><small>{String(post.author)} · {officialPostTypeLabel(String(post.type))} · {dateTime(post.publishedAt)}</small></div><span className="badge">{officialPostStatusLabel(String(post.status))}</span><ChevronRight size={18}/></button>)}</div><DirectoryPagination page={postPage} total={postTotal} pageSize={postPageSize} pages={postPages} onPage={setPostPage}/></>}</Panel></>}</>{selectedProfile && <OfficialProfileModal profile={selectedProfile} busy={roleBusy} onToggle={toggleRole} close={() => setSelectedProfile(null)}/>} {selectedPost && <OfficialPostPreviewModal post={selectedPost} close={() => setSelectedPost(null)}/>}</>
*/
  return <>
    <OfficialProfilesDirectory query={profileQuery} territory={territory} accountType={accountType} territories={territories} profiles={profiles} total={profileTotal} page={profilePage} pageSize={profilePageSize} pages={profilePages} loading={profilesLoading} error={profilesError} onQuery={(value) => updateProfileFilter(setProfileQuery, value)} onTerritory={(value) => updateProfileFilter(setTerritory, value)} onType={(value) => updateProfileFilter(setAccountType, value)} onPage={setProfilePage} onRetry={() => setProfileReload((current) => current + 1)} onSelect={setSelectedProfile}/>
    {selectedProfile && <OfficialProfileModal profile={selectedProfile} busy={roleBusy} onToggle={toggleRole} close={() => setSelectedProfile(null)}/>} 
  </>
}

function OfficialProfilesDirectory({ query, territory, accountType, territories, profiles, total, page, pageSize, pages, loading, error, onQuery, onTerritory, onType, onPage, onRetry, onSelect }: { query: string; territory: string; accountType: string; territories: string[]; profiles: JsonRecord[]; total: number; page: number; pageSize: number; pages: number; loading: boolean; error: string; onQuery: (value: string) => void; onTerritory: (value: string) => void; onType: (value: string) => void; onPage: (value: number) => void; onRetry: () => void; onSelect: (profile: JsonRecord) => void }) {
  return <>
    <div className="territory-toolbar">
      <label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Buscar por nombre o barrio"/></label>
      <label>Barrio<select value={territory} onChange={(event) => onTerritory(event.target.value)}><option value="all">Todos</option>{territories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label>Tipo de cuenta<select value={accountType} onChange={(event) => onType(event.target.value)}><option value="all">Todas</option><option value="official">Oficiales</option><option value="admin">Administradores</option><option value="official_admin">Oficiales y administradores</option><option value="standard">Estándar</option></select></label>
    </div>
    <Panel title="Directorio de cuentas" action={`${total} perfiles`}>
      {error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={onRetry}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando perfiles…</div> : <>
        <div className="official-account-grid">{profiles.map((profile) => <article className="official-account-card" key={String(profile.id)}><div className="official-account-avatar">{profile.avatarUrl ? <img src={String(profile.avatarUrl)} alt=""/> : initials(String(profile.name))}</div><div className="official-account-copy"><h3>{String(profile.name)}{Boolean(profile.isOfficial) && <span className="verified-dot">✓</span>}</h3><p>{String(profile.territory)}</p><div>{Boolean(profile.isOfficial) && <span className="badge official">Oficial</span>}{Boolean(profile.isAdmin) && <span className="badge success">Admin</span>}{!Boolean(profile.isOfficial) && !Boolean(profile.isAdmin) && <span className="badge neutral">Cuenta estándar</span>}</div></div><button className="icon official-more" onClick={() => onSelect(profile)} title="Ver perfil"><MoreHorizontal size={20}/></button></article>)}</div>
        <DirectoryPagination page={page} total={total} pageSize={pageSize} pages={pages} onPage={onPage}/>
      </>}
    </Panel>
  </>
}

function OfficialPostsManager({ accounts, refresh }: { accounts: JsonRecord[]; refresh: () => void }) {
  const [mode, setMode] = useState<'list' | 'editor'>('list')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [language, setLanguage] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, pageSize: 20 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<JsonRecord | null>(null)
  const [pendingDelete, setPendingDelete] = useState<JsonRecord | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const openEditor = () => setMode('editor')
    window.addEventListener('qoc:new-official-post', openEditor)
    return () => window.removeEventListener('qoc:new-official-post', openEditor)
  }, [])

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      getOfficialPosts(query, status, type, language, page).then((value) => {
        if (active) setResult(value as JsonRecord)
      }).catch(() => {
        if (active) setError('No se han podido cargar las publicaciones oficiales.')
      }).finally(() => { if (active) setLoading(false) })
    }, 160)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, status, type, language, page, reload])

  const updateFilter = (setter: (value: string) => void, value: string) => { setter(value); setPage(1) }
  const remove = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await deleteOfficialPostGroup(String(pendingDelete.translationGroupId || pendingDelete.id))
      setPendingDelete(null); setSelected(null); setReload((value) => value + 1); refresh()
    } catch {
      setError('No se ha podido eliminar la publicación y sus traducciones. Inténtalo de nuevo.')
    } finally { setDeleting(false) }
  }
  if (mode === 'editor') return <><div className="editor-page-actions"><button className="secondary" onClick={() => setMode('list')}>Volver a publicaciones</button></div><OfficialEditorV2 accounts={accounts} refresh={refresh} onPublished={() => { setMode('list'); setReload((value) => value + 1) }}/></>

  const posts = (result.items || []) as JsonRecord[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 20)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <>
    <div className="official-posts-toolbar"><div><b>Publicaciones oficiales</b><span>Una fila reúne todas las versiones lingüísticas de una misma publicación.</span></div></div>
    <OfficialPostsDirectory query={query} status={status} type={type} language={language} posts={posts} total={total} page={page} pageSize={pageSize} pages={pages} loading={loading} error={error} onQuery={(value) => updateFilter(setQuery, value)} onStatus={(value) => updateFilter(setStatus, value)} onType={(value) => updateFilter(setType, value)} onLanguage={(value) => updateFilter(setLanguage, value)} onPage={setPage} onRetry={() => setReload((value) => value + 1)} onSelect={setSelected} onDelete={setPendingDelete}/>
    {selected && <OfficialPostPreviewModal post={selected} close={() => setSelected(null)}/>} 
    {pendingDelete && <Modal title="Eliminar publicación oficial" close={() => !deleting && setPendingDelete(null)}><div className="confirm-dialog"><p>Se eliminarán la publicación y todas sus versiones en otros idiomas. Esta acción deja de mostrarla en el muro oficial.</p><b>{String(pendingDelete.title || 'Publicación sin título')}</b><div className="form-actions"><button className="secondary" disabled={deleting} onClick={() => setPendingDelete(null)}>Cancelar</button><button className="danger" disabled={deleting} onClick={remove}><Trash2 size={16}/>{deleting ? 'Eliminando…' : 'Eliminar publicación'}</button></div></div></Modal>}
  </>
}

function OfficialPostsDirectory({ query, status, type, language, posts, total, page, pageSize, pages, loading, error, onQuery, onStatus, onType, onLanguage, onPage, onRetry, onSelect, onDelete }: { query: string; status: string; type: string; language: string; posts: JsonRecord[]; total: number; page: number; pageSize: number; pages: number; loading: boolean; error: string; onQuery: (value: string) => void; onStatus: (value: string) => void; onType: (value: string) => void; onLanguage: (value: string) => void; onPage: (value: number) => void; onRetry: () => void; onSelect: (post: JsonRecord) => void; onDelete?: (post: JsonRecord) => void }) {
  return <>
    <div className="territory-toolbar">
      <label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Buscar por título, cuenta o resumen"/></label>
      <label>Estado<select value={status} onChange={(event) => onStatus(event.target.value)}><option value="all">Todos</option><option value="published">Publicadas</option><option value="deleted">Eliminadas</option></select></label>
      <label>Tipo<select value={type} onChange={(event) => onType(event.target.value)}><option value="all">Todos</option><option value="announcement">Comunicado</option><option value="news">Noticia</option><option value="event">Evento</option><option value="urgent">Alerta</option></select></label>
      <label>Idioma<select value={language} onChange={(event) => onLanguage(event.target.value)}><option value="all">Todos</option><option value="es">Español</option><option value="fr">Francés</option><option value="en">Inglés</option></select></label>
    </div>
    <Panel title="Publicaciones oficiales" action={`${total} publicaciones`}>
      {error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={onRetry}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando publicaciones…</div> : <>
        <div className="official-post-list">{posts.map((post) => <article className="official-post-row" key={String(post.translationGroupId || post.id)}><button className="official-post-main" onClick={() => onSelect(post)}><span className={`official-post-status ${String(post.status)}`}/><div><b>{String(post.title || 'Publicación sin título')}</b><small>{String(post.author)} · {officialPostTypeLabel(String(post.type))} · {dateTime(post.publishedAt)}</small></div><span className="badge">{officialPostStatusLabel(String(post.status))}</span><span className="official-post-languages">{Array.isArray(post.languages) ? (post.languages as unknown[]).join(' · ') : String(post.language || 'es')}</span></button>{onDelete && <button className="icon official-post-delete" onClick={() => onDelete(post)} title="Eliminar publicación y traducciones"><Trash2 size={18}/></button>}</article>)}</div>
        <DirectoryPagination page={page} total={total} pageSize={pageSize} pages={pages} onPage={onPage}/>
      </>}
    </Panel>
  </>
}

function DirectoryPagination({ page, total, pageSize, pages, onPage }: { page: number; total: number; pageSize: number; pages: number; onPage: (page: number) => void }) { return <div className="territory-pagination"><span>Mostrando {total ? (page - 1) * pageSize + 1 : 0}–{Math.min(page * pageSize, total)} de {total}</span><div><button className="icon" disabled={page === 1} onClick={() => onPage(Math.max(1, page - 1))} title="Página anterior"><ChevronLeft size={18}/></button><b>Página {page} de {pages}</b><button className="icon" disabled={page >= pages} onClick={() => onPage(Math.min(pages, page + 1))} title="Página siguiente"><ChevronRight size={18}/></button></div></div> }

function OfficialProfileModal({ profile, busy, onToggle, close }: { profile: JsonRecord; busy: string | null; onToggle: (profile: JsonRecord, field: 'isAdmin'|'isOfficial') => void; close: () => void }) { const avatar = profile.avatarUrl ? <img src={String(profile.avatarUrl)} alt=""/> : initials(String(profile.name)); return <Modal title="Perfil de cuenta" close={close}><div className="official-profile-detail"><header><div className="official-profile-avatar">{avatar}</div><div><h3>{String(profile.name)}{Boolean(profile.isOfficial) && <span className="verified-dot">✓</span>}</h3><p>{String(profile.territory)}</p></div></header><dl><div><dt>Seguidores</dt><dd>{formatNumber(profile.followers)}</dd></div><div><dt>Siguiendo</dt><dd>{formatNumber(profile.following)}</dd></div><div><dt>Registro</dt><dd>{dateTime(profile.joinedAt)}</dd></div><div><dt>Último acceso</dt><dd>{dateTime(profile.lastLoginAt)}</dd></div></dl><div className="role-switches"><label><span><b>Cuenta oficial</b><small>Muestra el distintivo verificado y permite publicar en el muro oficial.</small></span><input type="checkbox" checked={Boolean(profile.isOfficial)} disabled={busy === `${profile.id}:isOfficial`} onChange={() => onToggle(profile, 'isOfficial')}/><i/></label><label><span><b>Administrador</b><small>Concede acceso operativo y capacidad de gestión de roles.</small></span><input type="checkbox" checked={Boolean(profile.isAdmin)} disabled={busy === `${profile.id}:isAdmin`} onChange={() => onToggle(profile, 'isAdmin')}/><i/></label></div></div></Modal> }

function officialPostTypeLabel(type: string) { return ({ announcement: 'Comunicado', news: 'Noticia', event: 'Evento', urgent: 'Alerta' } as Record<string, string>)[type] || type }
function officialPostStatusLabel(status: string) { return ({ published: 'Publicada', deleted: 'Eliminada' } as Record<string, string>)[status] || status }
function OfficialPostPreviewModal({ post, close }: { post: JsonRecord; close: () => void }) {
  const [reading, setReading] = useState(false)
  const mediaUrl = String(post.mediaUrl || '')
  const isVideo = String(post.mediaType || '') === 'video'
  const text = String(post.summary || String(post.contentHtml || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
  const contentHtml = String(post.contentHtml || '')
  return <><Modal title="Vista previa en el muro oficial" close={close}><div className="official-wall-preview-shell"><article className="official-wall-preview"><header><div className="official-wall-avatar">{post.authorAvatarUrl ? <img src={String(post.authorAvatarUrl)} alt=""/> : initials(String(post.author))}</div><div><b>{String(post.author)}<span className="verified-dot">✓</span></b><small>{String(post.territory || 'Ámbito nacional')} · {dateTime(post.publishedAt)}</small></div><span className="official-type">{officialPostTypeLabel(String(post.type))}</span></header>{mediaUrl && <div className="official-wall-media">{isVideo ? <><video src={mediaUrl} muted preload="metadata"/><i><Play size={26} fill="currentColor"/></i></> : <img src={mediaUrl} alt=""/>}</div>}<section><h2>{String(post.title || 'Publicación oficial')}</h2><i className="official-rule"/><p>{text}</p><button onClick={() => setReading(true)}>Leer más <ChevronRight size={14}/></button></section><aside><span>🔥<b>0</b></span><span>LIVE</span><span><Heart size={17}/><b>0</b></span><span><MessageCircle size={17}/><b>0</b></span><span><Share2 size={17}/></span></aside></article></div></Modal>{reading && <Modal title="Lectura completa" close={() => setReading(false)}><div className="moderation-full-content">{contentHtml ? <article className="rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichContent(contentHtml) }}/> : <article className="plain-full-content">{text}</article>}</div></Modal>}</>
}

function OfficialPreview({ post }: { post?: JsonRecord }) { return <article className="official-preview"><span className="badge official">Comunicado</span><h3>{String(post?.title || 'Una comunicación institucional clara')}</h3><div className="green-rule"/><p>{String(post?.summary || 'Esta vista previa muestra la estructura con la que el comunicado aparecerá en el muro oficial de Qüata.')}</p><button>Leer más <ExternalLink size={14}/></button></article> }

type OfficialDraft = { title: string; summary: string; postType: string; contentHtml: string; readMoreLabel: string; linkUrl: string; mediaUrl: string; mediaPreviewUrl?: string; mediaType: 'image' | 'video' | ''; isLive?: boolean }
const emptyOfficialDraft = (): OfficialDraft => ({ title: '', summary: '', postType: 'announcement', contentHtml: '<p></p>', readMoreLabel: 'read_more', linkUrl: '', mediaUrl: '', mediaType: '' })
const officialLanguages: Record<string, string> = { es: 'Español', fr: 'Français', en: 'English' }

function OfficialEditor({ accounts, refresh }: { accounts: JsonRecord[]; refresh: () => void }) {
  const [language, setLanguage] = useState('es')
  const [drafts, setDrafts] = useState<Record<string, OfficialDraft>>({ es: emptyOfficialDraft() })
  const [profileId, setProfileId] = useState(String(accounts[0]?.id || ''))
  const [busy, setBusy] = useState(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [pendingMedia, setPendingMedia] = useState<File | null>(null)
  const [notice, setNotice] = useState('')
  const draft = drafts[language] || emptyOfficialDraft()
  const updateDraft = (patch: Partial<OfficialDraft>) => setDrafts((current) => ({ ...current, [language]: { ...(current[language] || emptyOfficialDraft()), ...patch } }))
  const switchLanguage = (next: string) => { setDrafts((current) => current[next] ? current : { ...current, [next]: { ...drafts.es, contentHtml: '<p></p>' } }); setLanguage(next) }
  const generateTranslations = async () => {
    if (!draft.title.trim() || !plainRichText(draft.contentHtml).trim()) { setNotice('Completa el título y el contenido antes de generar las traducciones.'); return }
    setBusy(true); setNotice('Generando traducciones con DeepL…')
    try {
      const targets = Object.keys(officialLanguages).filter((item) => item !== language)
      const entries = await Promise.all(targets.map(async (target) => ({ target, texts: await translateOfficialTexts(language, target, [draft.title, draft.summary, draft.contentHtml]) })))
      setDrafts((current) => Object.fromEntries(entries.reduce((all, entry) => [...all, [entry.target, { ...draft, title: entry.texts[0], summary: entry.texts[1], contentHtml: entry.texts[2] }]], Object.entries(current))))
      setNotice('Traducciones generadas. Selecciona un idioma para revisarlo y editarlo.')
    } catch { setNotice('No se han podido generar las traducciones. Inténtalo de nuevo.') } finally { setBusy(false) }
  }
  const uploadMedia = async (file?: File, kind?: 'image' | 'video') => {
    if (!file) return
    setMediaBusy(true); setNotice('Subiendo archivo multimedia…')
    try { const media = await uploadOfficialMedia(file); updateDraft({ mediaUrl: media.url, mediaType: media.type }); setNotice('Archivo multimedia listo para la publicación.') }
    catch { setNotice('No se ha podido subir el archivo. Usa una imagen JPEG/PNG/WebP o un vídeo MP4/WebM/MOV de hasta 100 MB.') }
    finally { setMediaBusy(false) }
  }
  const publish = async () => {
    const variants = Object.entries(drafts).filter(([, item]) => item.title.trim() && plainRichText(item.contentHtml).trim()).map(([itemLanguage, item]) => ({ ...item, language: itemLanguage }))
    if (!profileId || !variants.length) { setNotice('Selecciona una cuenta oficial y completa el título y el contenido.'); return }
    setBusy(true); setNotice('Publicando en el muro oficial…')
    try { await createOfficialPostVariants(profileId, variants); setNotice('Publicación enviada al muro oficial.'); setDrafts({ es: emptyOfficialDraft() }); setLanguage('es'); refresh() }
    catch { setNotice('No se ha podido publicar la comunicación. Inténtalo de nuevo.') } finally { setBusy(false) }
  }
  return <div className="official-editor-layout"><Panel title="Nueva publicación oficial"><div className="official-editor-form"><div className="editor-language-tabs">{Object.entries(officialLanguages).map(([code, label]) => <button key={code} className={language === code ? 'active' : ''} onClick={() => switchLanguage(code)}>{label}{drafts[code] && code !== 'es' ? <span>✓</span> : null}</button>)}</div><label>Cuenta oficial<select value={profileId} onChange={(event) => setProfileId(event.target.value)} required>{accounts.map((account) => <option key={String(account.id)} value={String(account.id)}>{String(account.name)}</option>)}</select></label><label>Tipo de publicación<select value={draft.postType} onChange={(event) => updateDraft({ postType: event.target.value })}><option value="announcement">Comunicado</option><option value="news">Noticia</option><option value="event">Evento</option><option value="urgent">Alerta</option></select></label><label>Título<input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="Título claro y verificable" /></label><label>Descripción corta<textarea value={draft.summary} onChange={(event) => updateDraft({ summary: event.target.value })} placeholder="Resumen visible en la tarjeta" rows={3}/></label><div className="editor-two-columns"><label>Texto del enlace<select value={draft.readMoreLabel} onChange={(event) => updateDraft({ readMoreLabel: event.target.value })}><option value="read_more">Leer más</option><option value="more_information">Más información</option><option value="continue_reading">Seguir leyendo</option><option value="details">Detalles</option></select></label><label>Enlace informativo<input type="url" value={draft.linkUrl} onChange={(event) => updateDraft({ linkUrl: event.target.value })} placeholder="https://…" /></label></div><div className="editor-media"><b>Foto o vídeo</b><label className="file-picker"><Upload size={16}/><span>{mediaBusy ? 'Subiendo…' : 'Elegir archivo'}</span><input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" disabled={mediaBusy} onChange={(event) => uploadMedia(event.target.files?.[0])}/></label>{draft.mediaUrl && <button className="secondary" onClick={() => updateDraft({ mediaUrl: '', mediaType: '' })}>Quitar archivo</button>}</div><label>URL multimedia (opcional)<input type="url" value={draft.mediaUrl} onChange={(event) => updateDraft({ mediaUrl: event.target.value, mediaType: event.target.value ? draft.mediaType || 'image' : '' })} placeholder="https://…" /></label><RichOfficialEditor key={language} html={draft.contentHtml} onChange={(contentHtml) => updateDraft({ contentHtml })}/><label className="editor-check"><input type="checkbox" checked={draft.isLive} onChange={(event) => updateDraft({ isLive: event.target.checked })}/> Marcar como LIVE</label>{notice && <div className="form-error">{notice}</div>}<div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={generateTranslations}><Languages size={16}/>Generar traducciones</button><button type="button" className="primary" disabled={busy || mediaBusy} onClick={publish}>{busy ? 'Publicando…' : 'Publicar'}</button></div></div></Panel><Panel title="Vista previa en tiempo real"><OfficialDraftPreview draft={draft} language={language} account={accounts.find((account) => String(account.id) === profileId)} /></Panel></div>
}

function OfficialEditorV2({ accounts, refresh, onPublished }: { accounts: JsonRecord[]; refresh: () => void; onPublished?: () => void }) {
  const [language, setLanguage] = useState('es')
  const [drafts, setDrafts] = useState<Record<string, OfficialDraft>>({ es: emptyOfficialDraft() })
  const [profileId, setProfileId] = useState(String(accounts[0]?.id || ''))
  const [busy, setBusy] = useState(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [pendingMedia, setPendingMedia] = useState<File | null>(null)
  const [notice, setNotice] = useState('')
  const localPreviewUrls = useRef(new Set<string>())
  const draft = drafts[language] || emptyOfficialDraft()
  const updateDraft = (patch: Partial<OfficialDraft>) => setDrafts((current) => ({ ...current, [language]: { ...(current[language] || emptyOfficialDraft()), ...patch } }))
  useEffect(() => () => localPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url)), [])
  const clearDraftMedia = () => {
    if (draft.mediaPreviewUrl) {
      URL.revokeObjectURL(draft.mediaPreviewUrl)
      localPreviewUrls.current.delete(draft.mediaPreviewUrl)
    }
    updateDraft({ mediaUrl: '', mediaPreviewUrl: undefined, mediaType: '' })
  }
  const switchLanguage = (next: string) => {
    setDrafts((current) => current[next] ? current : { ...current, [next]: { ...drafts.es, contentHtml: '<p></p>' } })
    setLanguage(next)
  }
  const uploadEditedMedia = async (file: File, kind: 'image' | 'video') => {
    setMediaBusy(true); setNotice(kind === 'video' ? 'Subiendo vídeo a WordPress...' : 'Subiendo imagen a Supabase...')
    try {
      const media = await uploadOfficialMedia(file)
      if (draft.mediaPreviewUrl) {
        URL.revokeObjectURL(draft.mediaPreviewUrl)
        localPreviewUrls.current.delete(draft.mediaPreviewUrl)
      }
      const mediaPreviewUrl = URL.createObjectURL(file)
      localPreviewUrls.current.add(mediaPreviewUrl)
      updateDraft({ mediaUrl: media.url, mediaPreviewUrl, mediaType: kind })
      setPendingMedia(null)
      setNotice('Archivo multimedia listo para la publicación.')
    } catch { setNotice('No se ha podido subir el archivo. Usa una imagen JPEG/PNG/WebP o un vídeo MP4/WebM/MOV de hasta 100 MB.') }
    finally { setMediaBusy(false) }
  }
  const generateTranslations = async () => {
    if (!draft.title.trim() || !plainRichText(draft.contentHtml).trim()) { setNotice('Completa el título y el contenido antes de generar las traducciones.'); return }
    setBusy(true); setNotice('Generando traducciones con DeepL...')
    try {
      const targets = Object.keys(officialLanguages).filter((item) => item !== language)
      const entries = await Promise.all(targets.map(async (target) => ({ target, texts: await translateOfficialTexts(language, target, [draft.title, draft.summary, draft.contentHtml]) })))
      setDrafts((current) => Object.fromEntries(entries.reduce((all, entry) => [...all, [entry.target, { ...draft, title: entry.texts[0], summary: entry.texts[1], contentHtml: entry.texts[2] }]], Object.entries(current))))
      setNotice('Traducciones generadas. Selecciona un idioma para revisarlo y editarlo.')
    } catch { setNotice('No se han podido generar las traducciones. Inténtalo de nuevo.') }
    finally { setBusy(false) }
  }
  const publish = async () => {
    const variants = Object.entries(drafts).filter(([, item]) => item.title.trim() && plainRichText(item.contentHtml).trim()).map(([itemLanguage, { mediaPreviewUrl: _mediaPreviewUrl, ...item }]) => ({ ...item, language: itemLanguage }))
    if (!profileId || !variants.length) { setNotice('Selecciona una cuenta oficial y completa el título y el contenido.'); return }
    setBusy(true); setNotice('Publicando en el muro oficial...')
    try { await createOfficialPostVariants(profileId, variants); setNotice('Publicación enviada al muro oficial.'); setDrafts({ es: emptyOfficialDraft() }); setLanguage('es'); refresh(); onPublished?.() }
    catch { setNotice('No se ha podido publicar la comunicación. Inténtalo de nuevo.') }
    finally { setBusy(false) }
  }
  return <>
    <div className="official-editor-layout">
      <Panel title="Nueva publicación oficial">
        <div className="official-editor-form">
          <div className="editor-language-tabs">{Object.entries(officialLanguages).map(([code, label]) => <button key={code} className={language === code ? 'active' : ''} onClick={() => switchLanguage(code)}>{label}{drafts[code] && code !== 'es' ? <span>✓</span> : null}</button>)}</div>
          <label>Cuenta oficial<select value={profileId} onChange={(event) => setProfileId(event.target.value)} required>{accounts.map((account) => <option key={String(account.id)} value={String(account.id)}>{String(account.name)}</option>)}</select></label>
          <label>Tipo de publicación<select value={draft.postType} onChange={(event) => updateDraft({ postType: event.target.value })}><option value="announcement">Comunicado</option><option value="news">Noticia</option><option value="event">Evento</option><option value="urgent">Alerta</option></select></label>
          <label>Título<input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="Título claro y verificable" /></label>
          <label>Descripción corta<textarea value={draft.summary} onChange={(event) => updateDraft({ summary: event.target.value })} placeholder="Resumen visible en la tarjeta" rows={3}/></label>
          <div className="editor-two-columns"><label>Texto del enlace<select value={draft.readMoreLabel} onChange={(event) => updateDraft({ readMoreLabel: event.target.value })}><option value="read_more">Leer más</option><option value="more_information">Más información</option><option value="continue_reading">Seguir leyendo</option><option value="details">Detalles</option></select></label><label>Enlace informativo<input type="url" value={draft.linkUrl} onChange={(event) => updateDraft({ linkUrl: event.target.value })} placeholder="https://..." /></label></div>
          <div className="editor-media"><b>Foto o vídeo</b><label className="file-picker"><Upload size={16}/><span>{mediaBusy ? 'Subiendo...' : 'Elegir y editar archivo'}</span><input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" disabled={mediaBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) setPendingMedia(file) }}/></label>{draft.mediaUrl && <button className="secondary" onClick={clearDraftMedia}>Quitar archivo</button>}</div>
          <label>URL multimedia (opcional)<input type="url" value={draft.mediaUrl} onChange={(event) => updateDraft({ mediaUrl: event.target.value, mediaType: event.target.value ? draft.mediaType || 'image' : '' })} placeholder="https://..." /></label>
          <RichBlockEditor key={language} html={draft.contentHtml} onChange={(contentHtml) => updateDraft({ contentHtml })}/>
          {notice && <div className="form-error">{notice}</div>}
          <div className="form-actions"><button type="button" className="secondary" disabled={busy} onClick={generateTranslations}><Languages size={16}/>Generar traducciones</button><button type="button" className="primary" disabled={busy || mediaBusy} onClick={publish}>{busy ? 'Publicando...' : 'Publicar'}</button></div>
        </div>
      </Panel>
      <Panel title="Vista previa en tiempo real"><OfficialDraftPreview draft={draft} language={language} account={accounts.find((account) => String(account.id) === profileId)} /></Panel>
    </div>
    {pendingMedia && <OfficialMediaEditor file={pendingMedia} onCancel={() => setPendingMedia(null)} onSave={uploadEditedMedia}/>} 
  </>
}

function plainRichText(html: string) { return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() }
function RichOfficialEditor({ html, onChange }: { html: string; onChange: (html: string) => void }) { const ref = useRef<HTMLDivElement>(null); const format = (command: string, value?: string) => { ref.current?.focus(); document.execCommand(command, false, value); onChange(ref.current?.innerHTML || '') }; return <label className="rich-editor-label">Contenido completo<div className="rich-editor-toolbar"><button type="button" onClick={() => format('bold')} title="Negrita"><Bold size={16}/></button><button type="button" onClick={() => format('italic')} title="Cursiva"><Italic size={16}/></button><button type="button" onClick={() => format('underline')} title="Subrayado"><Underline size={16}/></button><button type="button" onClick={() => format('insertUnorderedList')} title="Lista"><List size={16}/></button><button type="button" onClick={() => { const url = window.prompt('URL del enlace'); if (url) format('createLink', url) }} title="Enlace"><Link size={16}/></button></div><div ref={ref} className="rich-editor-surface" contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: html }} onInput={(event) => onChange(event.currentTarget.innerHTML)}/></label> }
function officialReadMoreLabel(code: string, language: string) { const labels: Record<string, Record<string, string>> = { read_more: { es: 'Leer más', fr: 'Lire la suite', en: 'Read more' }, more_information: { es: 'Más información', fr: 'Plus d’informations', en: 'More information' }, continue_reading: { es: 'Seguir leyendo', fr: 'Continuer la lecture', en: 'Continue reading' }, details: { es: 'Detalles', fr: 'Détails', en: 'Details' } }; return labels[code]?.[language] || labels.read_more[language] || labels.read_more.es }
function OfficialDraftPreview({ draft, language, account }: { draft: OfficialDraft; language: string; account?: JsonRecord }) {
  const [reading, setReading] = useState(false)
  const media = draft.mediaPreviewUrl || draft.mediaUrl
  const summary = draft.summary || plainRichText(draft.contentHtml) || 'La descripción corta aparecerá aquí.'
  return <><div className="official-wall-preview-shell"><article className="official-wall-preview"><header><div className="official-wall-avatar">{account?.avatarUrl ? <img src={String(account.avatarUrl)} alt=""/> : initials(String(account?.name || 'Q'))}</div><div><b>{String(account?.name || 'Cuenta oficial')}<span className="verified-dot">✓</span></b><small>{String(account?.territory || 'Ámbito nacional')} · Ahora</small></div><span className="official-type">{officialPostTypeLabel(draft.postType)}</span></header>{media && <div className="official-wall-media">{draft.mediaType === 'video' ? <><video src={media} muted/><i><Play size={26} fill="currentColor"/></i></> : <img src={media} alt=""/>}</div>}<section><h2>{draft.title || 'Título de la publicación'}</h2><i className="official-rule"/><p>{summary}</p><button type="button" onClick={() => setReading(true)}>{officialReadMoreLabel(draft.readMoreLabel, language)} <ChevronRight size={14}/></button></section><aside><span>🔥<b>0</b></span><span>LIVE</span><span><Heart size={17}/><b>0</b></span><span><MessageCircle size={17}/><b>0</b></span><span><Share2 size={17}/></span></aside></article></div>{reading && <Modal title={officialReadMoreLabel(draft.readMoreLabel, language)} close={() => setReading(false)}><div className="moderation-full-content"><article className="rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichContent(draft.contentHtml) }}/></div></Modal>}</>
}

function UsersModule({ data, refresh }: { data: JsonRecord[]; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null); const toggle = async (row: JsonRecord, field: 'isAdmin'|'isOfficial') => { setBusy(String(row.id)); try { await qocCommand('user.role.toggle', { profileId: row.id, [field]: !Boolean(row[field]), reason: `Cambio ${field} desde QOC` }); refresh() } finally { setBusy(null) } }
  return <Panel title="Directorio de usuarios" action="Buscar"><DataTable rows={data} columns={[['name','Usuario'],['territory','Barrio'],['joinedAt','Registro'],['lastLoginAt','Último acceso']]} action={(row) => <span className="role-pills"><button disabled={busy === String(row.id)} className={row.isAdmin ? 'pill active' : 'pill'} onClick={() => toggle(row,'isAdmin')}>Admin</button><button disabled={busy === String(row.id)} className={row.isOfficial ? 'pill official' : 'pill'} onClick={() => toggle(row,'isOfficial')}>Oficial</button></span>} /></Panel>
}


function SupportModule({ data, refresh }: { data: JsonRecord[]; refresh: () => void }) { const [open, setOpen] = useState(false); return <><button className="primary floating-action" onClick={() => setOpen(true)}><Plus size={16}/>Abrir incidencia</button><Panel title="Centro de soporte"><DataTable rows={data} columns={[['id','#'],['subject','Asunto'],['priority','Prioridad'],['status','Estado'],['created_at','Creada']]} /></Panel>{open && <Modal title="Nueva incidencia" close={() => setOpen(false)}><TicketForm onDone={() => { setOpen(false); refresh() }}/></Modal>}</> }
function TicketForm({ onDone }: { onDone: () => void }) { const [busy,setBusy]=useState(false); const submit=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(true);try{await qocCommand('ticket.create',{subject:f.get('subject'),description:f.get('description'),priority:f.get('priority')});onDone()}finally{setBusy(false)}};return <form className="editor-form" onSubmit={submit}><label>Asunto<input name="subject" required/></label><label>Descripción<textarea name="description" rows={5}/></label><label>Prioridad<select name="priority"><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label><button className="primary" disabled={busy}>Crear incidencia</button></form> }

function AnalyticsModule({ scope, title, refreshSignal }: { scope: 'users' | 'content' | 'chat' | 'sos'; title: string; refreshSignal: () => void }) {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<JsonRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getAnalytics(scope, days).then((next) => { if (active) setData(next as JsonRecord) }).catch(() => { if (active) setError('No se han podido cargar las métricas de este ámbito.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [days, refreshSignal, scope])

  if (loading) return <div className="territory-loading"><span className="spinner"/>Actualizando métricas…</div>
  if (error || !data) return <div className="territory-error"><CircleAlert size={18}/><span>{error || 'No hay datos disponibles.'}</span></div>

  const kpis = (data.kpis || []) as JsonRecord[]
  const series = (data.series || []) as JsonRecord[]
  const period = <select className="analytics-period" value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option></select>
  const chart = scope === 'users'
    ? <LineChart data={series}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)}/><YAxis allowDecimals={false}/><Tooltip/><Line type="monotone" dataKey="registered" name="Altas" stroke="#f97316" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="total" name="Total acumulado" stroke="#2563eb" strokeWidth={2} dot={false}/></LineChart>
    : scope === 'content'
      ? <AreaChart data={series}><defs><linearGradient id="qoc-content-feed" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#f97316" stopOpacity=".4"/><stop offset="1" stopColor="#f97316" stopOpacity="0"/></linearGradient></defs><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)}/><YAxis allowDecimals={false}/><Tooltip/><Area type="monotone" dataKey="feed" name="Feed" stroke="#f97316" fill="url(#qoc-content-feed)"/><Area type="monotone" dataKey="official" name="Oficiales" stroke="#16a34a" fill="transparent"/></AreaChart>
      : scope === 'chat'
        ? <LineChart data={series}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)}/><YAxis allowDecimals={false}/><Tooltip/><Line type="monotone" dataKey="messages" name="Mensajes" stroke="#2563eb" strokeWidth={3} dot={false}/><Line type="monotone" dataKey="attachments" name="Adjuntos" stroke="#f97316" strokeWidth={2} dot={false}/></LineChart>
        : <AreaChart data={series}><defs><linearGradient id="qoc-sos-alerts" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#dc2626" stopOpacity=".35"/><stop offset="1" stopColor="#dc2626" stopOpacity="0"/></linearGradient></defs><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={(value) => String(value).slice(5)}/><YAxis allowDecimals={false}/><Tooltip/><Area type="monotone" dataKey="alerts" name="Alertas" stroke="#dc2626" fill="url(#qoc-sos-alerts)"/><Line type="monotone" dataKey="geolocated" name="Con ubicación" stroke="#2563eb" strokeWidth={2} dot={false}/></AreaChart>

  const detail = scope === 'users'
    ? <Panel title="Usuarios por barrio"><div className="analytics-detail-panel"><AnalyticsList rows={(data.territories || []) as JsonRecord[]} label="Usuarios" value="users"/></div></Panel>
    : scope === 'content'
      ? <Panel title="Autores más activos en el feed"><div className="analytics-detail-panel"><AnalyticsList rows={(data.authors || []) as JsonRecord[]} label="Publicaciones" value="posts"/></div></Panel>
      : scope === 'chat'
        ? <Panel title="Estados de entrega"><div className="analytics-detail-panel analytics-delivery"><Metric label="Entregados" value={(data.delivery as JsonRecord)?.delivered}/><Metric label="Leídos" value={(data.delivery as JsonRecord)?.read}/><Metric label="Pendientes" value={(data.delivery as JsonRecord)?.pending}/></div></Panel>
        : <Panel title="Últimas solicitudes SOS"><div className="analytics-detail-panel analytics-sos-list">{((data.recent || []) as JsonRecord[]).length ? ((data.recent || []) as JsonRecord[]).map((item, index) => <div key={`${String(item.at)}-${index}`}><span className={`severity ${item.hasLocation ? 'success' : 'warning'}`}/><b>{String(item.sender || 'Usuario')}</b><small>{dateTime(item.at)} · {item.hasLocation ? 'Ubicación disponible' : 'Sin ubicación'} · {formatNumber(item.sentCount)} destinatarios</small></div>) : <p className="muted">No hay alertas en el periodo.</p>}</div></Panel>

  return <>
    <div className="kpi-grid">{kpis.map((item) => <Metric key={String(item.label)} label={String(item.label)} value={item.value}/>)}</div>
    <Panel title={`Evolución · ${title}`} action={period}><div className="chart-wrap"><ResponsiveContainer width="100%" height={300}>{chart}</ResponsiveContainer></div></Panel>
    <div className="dashboard-grid">{detail}<Panel title="Lectura operativa"><div className="analytics-detail-panel"><p className="muted">{scope === 'users' ? 'Las altas y los accesos recientes muestran el crecimiento de la red por barrio.' : scope === 'content' ? 'Se distinguen las publicaciones del feed y del muro oficial. Las versiones traducidas de una misma publicación oficial se agrupan.' : scope === 'chat' ? 'Los estados se calculan a partir de los callbacks DELIVERED y READ registrados por los dispositivos.' : 'Una alerta se considera activa durante sus primeras 24 horas. Las coordenadas 0,0 no se consideran una ubicación válida.'}</p></div></Panel></div>
  </>
}

function formatBytes(value: unknown) {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function formatDurationMs(value: unknown) {
  const milliseconds = Number(value || 0)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 ms'
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`
  const days = hours / 24
  if (days < 7) return `${days.toFixed(days < 10 ? 1 : 0)} d`
  return `${(days / 7).toFixed(1)} sem`
}

function MonitoringModule({ refreshKey }: { refreshKey: number }) {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<JsonRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [serviceInfo, setServiceInfo] = useState<JsonRecord | null>(null)
  const probedRefreshKey = useRef<number | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      setLoading(true); setError('')
      if (probedRefreshKey.current !== refreshKey) {
        probedRefreshKey.current = refreshKey
        await runMonitoringProbe().catch(() => undefined)
      }
      try {
        const next = await getMonitoring(days)
        if (active) setData(next as JsonRecord)
      } catch {
        if (active) setError('No se han podido cargar las métricas técnicas.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [days, refreshKey])

  if (loading) return <div className="territory-loading"><span className="spinner"/>Cargando estado técnico…</div>
  if (error || !data) return <div className="territory-error"><CircleAlert size={18}/><span>{error || 'No hay datos de monitorización disponibles.'}</span></div>

  const latest = (data.latest || {}) as JsonRecord
  const history = (data.history || []) as JsonRecord[]
  const services = (data.services || []) as JsonRecord[]
  const tables = (data.tableHealth || []) as JsonRecord[]
  const queries = (data.queryHealth || []) as JsonRecord[]
  const statusLabel: Record<string, string> = { operational: 'Operativo', attention: 'Atención', unknown: 'Sin señal', unmonitored: 'Sin sonda' }

  return <>
    <div className="monitoring-summary">
      <div><span className={`monitoring-dot ${services.some((item) => item.status === 'attention') ? 'attention' : 'ok'}`}/><b>{services.some((item) => item.status === 'attention') ? 'Revisar señales operativas' : 'Monitorización operativa'}</b><small>Última captura: {latest.captured_at ? dateTime(latest.captured_at) : 'pendiente'}</small></div>
      <label>Periodo<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={1}>Últimas 24 h</option><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option></select></label>
    </div>
    <div className="kpi-grid monitoring-kpis">
      <Metric label="Conexiones activas" value={latest.active_connections}/>
      <Metric label="Push enviados · 24 h" value={latest.push_sent_24h}/>
      <Metric label="Errores push · 24 h" value={latest.push_errors_24h}/>
      <Metric label="Pendientes > 15 min" value={latest.pending_delivery_15m}/>
    </div>
    <Panel title="Estado de dependencias"><div className="monitoring-services">{services.map((service) => <button key={String(service.key)} onClick={() => setServiceInfo(service)}><span className={`monitoring-dot ${String(service.status)}`}/><span><b>{String(service.name)}</b><small>{statusLabel[String(service.status)] || 'Sin señal'}</small></span><Info size={16}/></button>)}</div></Panel>
    <Panel title="Mensajería y confirmaciones"><div className="chart-wrap"><ResponsiveContainer width="100%" height={280}><LineChart data={history}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="at" tickFormatter={(value) => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit' }).format(new Date(String(value)))} minTickGap={35}/><YAxis allowDecimals={false}/><Tooltip labelFormatter={(value) => dateTime(value)} /><Line type="monotone" dataKey="delivered" name="Entregados" stroke="#2563eb" strokeWidth={2.5} dot={false}/><Line type="monotone" dataKey="read" name="Leídos" stroke="#16a34a" strokeWidth={2.5} dot={false}/><Line type="monotone" dataKey="pendingDelivery" name="Pendientes" stroke="#ea580c" strokeWidth={2.5} dot={false}/><Line type="monotone" dataKey="pushErrors" name="Errores push" stroke="#dc2626" strokeWidth={2} dot={false}/></LineChart></ResponsiveContainer></div></Panel>
    <div className="dashboard-grid monitoring-grid">
      <Panel title="Capacidad y mantenimiento"><div className="monitoring-details"><div className="monitoring-capacity"><Metric label="Base de datos" value={formatBytes(latest.database_bytes)}/><Metric label="Tablas de usuario" value={formatBytes(latest.user_table_bytes)}/><Metric label="Filas pendientes de limpiar" value={latest.dead_rows}/><Metric label="Bloqueos acumulados" value={latest.deadlocks}/></div><div className="monitoring-table-list">{tables.map((table) => <div key={String(table.name)}><span><b>{String(table.name)}</b><small>{formatNumber(table.estimated_rows)} filas estimadas · {formatNumber(table.dead_rows)} muertas</small></span><strong>{formatBytes(table.total_bytes)}</strong></div>)}</div></div></Panel>
      <Panel title="Carga de consultas"><div className="monitoring-query-list">{queries.map((query, index) => <div key={`${String(query.family)}-${index}`}><span><b>{String(query.family)}</b><small>{formatNumber(query.calls)} ejecuciones · media {String(query.mean_ms)} ms</small></span><strong>{formatDurationMs(query.total_ms)}</strong></div>)}<p className="muted">Tiempo total acumulado desde el último reinicio de estadísticas. Las consultas se agrupan por familia técnica; el SQL no se expone en el panel.</p></div></Panel>
    </div>
    {serviceInfo && <Modal title={`Estado de ${String(serviceInfo.name)}`} close={() => setServiceInfo(null)}><div className="monitoring-service-modal"><span className={`monitoring-dot ${String(serviceInfo.status)}`}/><div><b>{statusLabel[String(serviceInfo.status)] || 'Sin señal'}</b><p>{String(serviceInfo.detail || '')}</p>{serviceInfo.status === 'unmonitored' && <small>Esta dependencia no se clasifica como disponible hasta que una sonda propia registre comprobaciones reales.</small>}</div></div></Modal>}
  </>
}

function AnalyticsList({ rows, label, value }: { rows: JsonRecord[]; label: string; value: string }) {
  return <div className="analytics-list">{rows.length ? rows.map((item, index) => <div key={`${String(item.name)}-${index}`}><span>{index + 1}</span><b>{String(item.name || 'Sin nombre')}</b><strong>{formatNumber(item[value])} <small>{label.toLowerCase()}</small></strong></div>) : <p className="muted">No hay datos suficientes para este desglose.</p>}</div>
}


function auditActionLabel(value: unknown) {
  const action = String(value || '')
  return ({
    'user.role.toggle': 'Cambio de rol',
    'moderation.remove_content': 'Retirada de contenido',
    'moderation.reviewing': 'Marcado en revisión',
    'moderation.update': 'Actualización de moderación',
  } as Record<string, string>)[action] || action.replaceAll('.', ' · ').replaceAll('_', ' ')
}

function auditEntityLabel(value: unknown) {
  return ({ profile: 'Perfil', ugc_report: 'Reporte de moderación' } as Record<string, string>)[String(value || '')] || String(value || '—').replaceAll('_', ' ')
}

function AuditModule({ refreshSignal }: { refreshSignal: () => void }) {
  const [query, setQuery] = useState('')
  const [action, setAction] = useState('all')
  const [entityType, setEntityType] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, page: 1, pageSize: 20, filters: {} })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      getAuditEvents(query, action, entityType, page).then((next) => { if (active) setResult(next as JsonRecord) }).catch(() => {
        if (active) setError('No se ha podido cargar el registro de auditoría.')
      }).finally(() => { if (active) setLoading(false) })
    }, 180)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, action, entityType, page, reload, refreshSignal])

  const items = ((result.items || []) as JsonRecord[]).map((item) => ({ ...item, actionLabel: auditActionLabel(item.action), entityLabel: auditEntityLabel(item.entityType) }))
  const filters = (result.filters || {}) as JsonRecord
  const actions = (filters.actions || []) as string[]
  const entities = (filters.entityTypes || []) as string[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 20)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const changeQuery = (value: string) => { setQuery(value); setPage(1) }
  const changeAction = (value: string) => { setAction(value); setPage(1) }
  const changeEntity = (value: string) => { setEntityType(value); setPage(1) }

  return <>
    <div className="territory-toolbar">
      <label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="Buscar por responsable, acción, entidad o nota" aria-label="Buscar en auditoría"/></label>
      <label>Acción<select value={action} onChange={(event) => changeAction(event.target.value)}><option value="all">Todas</option>{actions.map((item) => <option key={item} value={item}>{auditActionLabel(item)}</option>)}</select></label>
      <label>Entidad<select value={entityType} onChange={(event) => changeEntity(event.target.value)}><option value="all">Todas</option>{entities.map((item) => <option key={item} value={item}>{auditEntityLabel(item)}</option>)}</select></label>
    </div>
    <Panel title="Registro de auditoría" action={`${total} eventos`}>
      {error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando auditoría…</div> : <><DataTable rows={items} columns={[['actionLabel','Acción'],['entityLabel','Entidad'],['entityId','Identificador'],['actor','Responsable'],['reason','Nota'],['createdAt','Fecha']]} /><DirectoryPagination page={page} total={total} pageSize={pageSize} pages={pages} onPage={setPage}/></>}
    </Panel>
  </>
}

function PlatformModule({ data, mode, refreshKey }: { data: JsonRecord | null; mode: string; refreshKey: number }) {
  const safeData = data || {}
  if (mode === 'versiones') return <PlayVersionsModule fallbackVersions={(safeData.versions || {}) as JsonRecord} refreshKey={refreshKey} />
  return <div className="compliance-grid">{['Acceso con mínimo privilegio','Auditoría de acciones administrativas','Datos sensibles restringidos por RPC','Retención y exportaciones gobernadas','RLS habilitado en datos QOC','Secretos fuera del cliente'].map((item,index)=><Panel key={item} title={item}><span className={`compliance-state ${index===5?'attention':'ok'}`}>{index===5?'Revisar configuración':'Control activo'}</span><p className="muted">Consulta el registro de auditoría y la política asociada antes de modificar este control.</p></Panel>)}</div>
}

function ComplianceModule({ refreshKey }: { refreshKey: number }) {
  const navigate = useNavigate()
  const [data, setData] = useState<JsonRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getComplianceOverview().then((value) => { if (active) setData(value) }).catch(() => {
      if (active) setError('No se ha podido obtener el estado de seguridad y cumplimiento.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refreshKey])

  if (loading) return <div className="territory-loading"><span className="spinner"/>Comprobando controles y trazabilidad…</div>
  if (error || !data) return <div className="territory-error"><CircleAlert size={18}/><span>{error || 'No hay datos disponibles.'}</span></div>

  const rls = (data.rls || {}) as JsonRecord
  const privileges = (data.privilegedAccounts || {}) as JsonRecord
  const operationalData = (data.data || {}) as JsonRecord
  const integrations = (data.integrations || {}) as JsonRecord
  const unprotected = (rls.unprotected || []) as JsonRecord[]
  const activity = (data.activity || []) as JsonRecord[]
  const services = (integrations.services || []) as JsonRecord[]
  const coverage = Number(rls.totalTables || 0) ? Math.round((Number(rls.enabledTables || 0) / Number(rls.totalTables || 1)) * 100) : 0

  return <>
    <div className="info-banner compliance-intro"><Info size={18}/><div><b>Señales verificables, no declaraciones de cumplimiento</b><p>Este panel muestra el estado actual de los controles técnicos y de la trazabilidad. No expone secretos ni sustituye una auditoría legal.</p></div></div>
    <div className="kpi-grid">
      <Metric label="Cobertura RLS" value={`${coverage}%`}/>
      <Metric label="Tablas sin RLS" value={rls.disabledTables}/>
      <Metric label="Administradores activos" value={privileges.administrators}/>
      <Metric label="Casos de moderación abiertos" value={operationalData.openReports}/>
    </div>
    <div className="split-grid compliance-panels">
      <Panel title="Acceso a datos" action={<button className="secondary compact-action" onClick={() => navigate('/auditoria')}>Ver auditoría</button>}>
        <div className="compliance-body">
          <p><b>{formatNumber(rls.enabledTables)}</b> de {formatNumber(rls.totalTables)} tablas de aplicación tienen RLS habilitado.</p>
          {unprotected.length ? <div className="compliance-finding attention"><CircleAlert size={16}/><div><b>Excepciones pendientes de endurecimiento</b><span>{unprotected.map((item) => String(item.table)).join(', ')}</span></div></div> : <div className="compliance-finding ok"><Activity size={16}/><div><b>Sin tablas de aplicación sin RLS</b><span>La cobertura actual no muestra excepciones.</span></div></div>}
          <small className="muted">Las excepciones se registran para su revisión; este panel no modifica políticas por sí solo.</small>
        </div>
      </Panel>
      <Panel title="Accesos privilegiados" action={<button className="secondary compact-action" onClick={() => navigate('/usuarios')}>Gestionar usuarios</button>}>
        <div className="compliance-body role-summary"><p><b>{formatNumber(privileges.administrators)}</b> administradores y <b>{formatNumber(privileges.officialAccounts)}</b> cuentas oficiales entre {formatNumber(privileges.profiles)} perfiles.</p><small className="muted">Los cambios de rol se registran en auditoría.</small></div>
        <div className="timeline compact-timeline">{activity.length ? activity.slice(0, 4).map((item) => <div key={String(item.id)}><i/><div><b>{auditActionLabel(String(item.action || ''))}</b><small>{String(item.actor || 'Sistema')} · {dateTime(item.createdAt)}</small></div></div>) : <div className="no-activity">Sin actividad administrativa reciente.</div>}</div>
      </Panel>
    </div>
    <div className="split-grid compliance-panels">
      <Panel title="Datos y retención operativa">
        <div className="compliance-stats">
          <span><b>{formatNumber(operationalData.chatMessages)}</b> mensajes de chat visibles</span><span><b>{formatNumber(operationalData.deletedChatMessages)}</b> mensajes retirados</span><span><b>{formatNumber(operationalData.officialPosts)}</b> publicaciones oficiales activas</span><span><b>{formatNumber(operationalData.deletedOfficialPosts)}</b> publicaciones oficiales retiradas</span><span><b>{formatNumber(operationalData.attachments)}</b> adjuntos registrados</span><span><b>{formatNumber(operationalData.communityPosts)}</b> publicaciones de comunidad</span>
        </div>
      </Panel>
      <Panel title="Integraciones y evidencias" action={<button className="secondary compact-action" onClick={() => navigate('/monitorizacion')}>Ver monitorización</button>}>
        <div className="services compliance-services">{services.map((service) => <div key={String(service.key)}><span className={`status ${String(service.status || 'unknown')}`}/><b>{String(service.name)}</b><small>{String(service.status) === 'operational' ? 'Operativo' : String(service.status) === 'attention' ? 'Revisar' : 'Sin sonda'}</small></div>)}</div>
        <div className="compliance-timestamps"><span>Último snapshot técnico: <b>{dateTime(integrations.monitoringSnapshotAt)}</b></span><span>Caché de Google Play: <b>{dateTime(integrations.googlePlayCacheAt)}</b></span></div>
      </Panel>
    </div>
  </>
}

function lastVitalMetric(rows: JsonRecord[], key: string) {
  for (const row of [...rows].reverse()) {
    const metrics = (row.metrics || {}) as JsonRecord
    const value = metrics[key] ?? row[key]
    if (value !== undefined && value !== null) return String(value)
  }
  return 'Sin datos'
}

function PlayVersionsModule({ fallbackVersions, refreshKey }: { fallbackVersions: JsonRecord; refreshKey: number }) {
  const [data, setData] = useState<JsonRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getGooglePlayOverview().then((next) => { if (active) setData(next) }).catch(() => { if (active) setError('No se ha podido consultar Google Play.') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [refreshKey])

  if (loading) return <div className="territory-loading"><span className="spinner"/>Consultando Google Play…</div>
  if (error || !data) return <div className="territory-error"><CircleAlert size={18}/><span>{error || 'No hay datos de Google Play disponibles.'}</span></div>

  const tracks = (data.tracks || []) as JsonRecord[]
  const production = tracks.find((track) => track.track === 'production') || {}
  const release = ((production.releases || []) as JsonRecord[])[0] || {}
  const vitals = (data.vitals || {}) as JsonRecord
  const crashRows = (vitals.crash || []) as JsonRecord[]
  const anrRows = (vitals.anr || []) as JsonRecord[]
  const anomalies = (vitals.anomalies || []) as JsonRecord[]
  const app = (data.app || {}) as JsonRecord
  const versionCodes = (release.versionCodes || []) as unknown[]
  const releaseStatus = String(release.status || 'Sin publicación')

  return <>
    <div className="kpi-grid">
      <Metric label="Versión en producción" value={release.name || fallbackVersions.androidLatest || '—'}/>
      <Metric label="Version code" value={versionCodes[0] || '—'}/>
      <Metric label="Target SDK" value={fallbackVersions.targetSdk}/>
      <Metric label="Estado de publicación" value={releaseStatus === 'completed' ? 'Producción' : releaseStatus}/>
    </div>
    <div className="split-grid">
      <Panel title="Distribución en Google Play"><div className="checklist"><p><b>Aplicación:</b> {String(app.displayName || 'Qüata')} <span className="muted">({String(app.packageName || 'com.quata')})</span></p><p><b>Canal:</b> Producción</p><p><b>Última sincronización:</b> {dateTime(data.cachedAt || data.refreshedAt)}</p><p><b>Release notes:</b> {((release.releaseNotes || []) as unknown[]).length} idiomas disponibles</p></div></Panel>
      <Panel title="Android vitals"><div className="checklist"><p><b>Crash rate (7 días):</b> {lastVitalMetric(crashRows, 'crashRate7dUserWeighted')}</p><p><b>ANR rate (7 días):</b> {lastVitalMetric(anrRows, 'anrRate7dUserWeighted')}</p><p><b>Anomalías abiertas:</b> {formatNumber(anomalies.length)}</p><p className="muted">Google Play puede tardar hasta un día en publicar la muestra agregada.</p></div></Panel>
    </div>
    <Panel title="Tracks de distribución"><DataTable rows={tracks.map((track) => { const firstRelease = ((track.releases || []) as JsonRecord[])[0] || {}; return { track: track.track, version: firstRelease.name || '—', versionCode: ((firstRelease.versionCodes || []) as unknown[])[0] || '—', status: firstRelease.status || 'Sin publicación', releaseNotes: ((firstRelease.releaseNotes || []) as unknown[]).length } })} columns={[['track','Track'],['version','Versión'],['versionCode','Version code'],['status','Estado'],['releaseNotes','Idiomas de notas']]} /></Panel>
  </>
}

function CommunitiesModule() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [activity, setActivity] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, page: 1, pageSize: 20 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const updateFilter = (setter: (value: string) => void, value: string) => { setter(value); setPage(1) }

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      getCommunities(query, status, activity, page).then((value) => {
        if (alive) setResult(value as JsonRecord)
      }).catch(() => {
        if (alive) setError('No se ha podido cargar el directorio de comunidades.')
      }).finally(() => { if (alive) setLoading(false) })
    }, 180)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [query, status, activity, page, reload])

  const items = (result.items || []) as JsonRecord[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 20)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <>
    <div className="territory-toolbar">
      <label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => updateFilter(setQuery, event.target.value)} placeholder="Buscar por comunidad, ciudad o descripción"/></label>
      <label>Estado<select value={status} onChange={(event) => updateFilter(setStatus, event.target.value)}><option value="all">Todos</option><option value="active">Activas</option><option value="inactive">Inactivas</option></select></label>
      <label>Actividad<select value={activity} onChange={(event) => updateFilter(setActivity, event.target.value)}><option value="all">Toda</option><option value="recent">Con actividad reciente</option><option value="quiet">Sin actividad reciente</option></select></label>
    </div>
    <Panel title="Gestión territorial" action={`${total} comunidades`}>
      {error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Actualizando comunidades…</div> : <>
        <div className="table-wrap"><table><thead><tr><th>Comunidad</th><th>Ciudad</th><th>Miembros</th><th>Publicaciones</th><th>Última actividad</th><th>Estado</th></tr></thead><tbody>{items.length ? items.map((community) => <tr key={String(community.id)}><td><b>{String(community.name || 'Comunidad sin nombre')}</b><small className="community-description">{String(community.description || 'Sin descripción')}</small></td><td>{community.city ? String(community.city) : <span className="muted">—</span>}</td><td><button className="community-members-link" onClick={() => navigate(`/usuarios?barrio=${encodeURIComponent(String(community.name || ''))}`)} title={`Ver usuarios de ${String(community.name || 'esta comunidad')}`}>{formatNumber(community.memberCount)}</button></td><td>{formatNumber(community.postCount)}</td><td>{community.lastPostAt ? dateTime(community.lastPostAt) : <span className="muted">Sin publicaciones</span>}</td><td><span className={`badge ${community.isActive ? 'success' : 'neutral'}`}>{community.isActive ? 'Activa' : 'Inactiva'}</span></td></tr>) : <tr><td className="no-results" colSpan={6}>No hay comunidades para estos filtros.</td></tr>}</tbody></table></div>
        <DirectoryPagination page={page} total={total} pageSize={pageSize} pages={pages} onPage={setPage}/>
      </>}
    </Panel>
  </>
}

function mediaKindLabel(kind: string) { return ({ all: 'Todos', image: 'Imágenes', video: 'Vídeos', audio: 'Audio', document: 'Documentos', file: 'Otros archivos' } as Record<string, string>)[kind] || kind }
function fileSize(bytes: unknown) { const value = Number(bytes || 0); if (!Number.isFinite(value) || value <= 0) return 'Tamaño desconocido'; const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}` }
const mediaSizeCache: globalThis.Map<string, number | null> = new globalThis.Map<string, number | null>()

function useResolvedMediaSize(url: string, declaredSize: unknown) {
  const initialSize = Number(declaredSize || 0)
  const [size, setSize] = useState(Number.isFinite(initialSize) && initialSize > 0 ? initialSize : undefined)
  const [checking, setChecking] = useState(!size && Boolean(url))
  useEffect(() => {
    const knownSize = Number(declaredSize || 0)
    if (Number.isFinite(knownSize) && knownSize > 0) { setSize(knownSize); setChecking(false); return }
    if (!url) { setChecking(false); return }
    const cached = mediaSizeCache.get(url)
    if (cached !== undefined) { setSize(cached || undefined); setChecking(false); return }
    let active = true
    const controller = new AbortController()
    const readLength = (response: Response) => {
      const contentLength = Number(response.headers.get('content-length') || 0)
      const contentRange = response.headers.get('content-range') || ''
      const rangedLength = Number(contentRange.split('/').pop() || 0)
      return contentLength > 0 ? contentLength : rangedLength > 0 ? rangedLength : 0
    }
    const measure = async () => {
      try {
        let response = await fetch(url, { method: 'HEAD', signal: controller.signal })
        let measured = readLength(response)
        if (!measured) {
          response = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal })
          measured = readLength(response)
        }
        mediaSizeCache.set(url, measured || null)
        if (active) setSize(measured || undefined)
      } catch {
        mediaSizeCache.set(url, null)
      } finally {
        if (active) setChecking(false)
      }
    }
    void measure()
    return () => { active = false; controller.abort() }
  }, [declaredSize, url])
  return { size, checking }
}

function MediaLibraryModule() {
  const [library, setLibrary] = useState<'chat' | 'post_images' | 'post_videos'>('chat')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JsonRecord>({ items: [], total: 0, page: 1, pageSize: 24 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<JsonRecord | null>(null)

  useEffect(() => { setPage(1) }, [library, query, kind])
  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      setLoading(true); setError('')
      getMediaLibrary(library, query, kind, page).then((value) => {
        if (alive) setResult(value as JsonRecord)
      }).catch(() => {
        if (alive) setError('No se ha podido cargar la biblioteca multimedia.')
      }).finally(() => { if (alive) setLoading(false) })
    }, 180)
    return () => { alive = false; window.clearTimeout(timer) }
  }, [library, query, kind, page, reload])

  const items = (result.items || []) as JsonRecord[]
  const total = Number(result.total || 0)
  const pageSize = Number(result.pageSize || 24)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  return <>
    <div className="media-library-tabs" role="tablist" aria-label="Fuentes multimedia">
      <button role="tab" aria-selected={library === 'chat'} className={library === 'chat' ? 'active' : ''} onClick={() => setLibrary('chat')}>Adjuntos de chat</button>
      <button role="tab" aria-selected={library === 'post_images'} className={library === 'post_images' ? 'active' : ''} onClick={() => setLibrary('post_images')}>Imágenes de publicaciones</button>
      <button role="tab" aria-selected={library === 'post_videos'} className={library === 'post_videos' ? 'active' : ''} onClick={() => setLibrary('post_videos')}>Vídeos de publicaciones</button>
    </div>
    <div className="territory-toolbar media-library-toolbar">
      <label className="territory-search"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, extensión o tipo" /></label>
      {library === 'chat' && <label>Tipo<select value={kind} onChange={(event) => setKind(event.target.value)}>{['all', 'image', 'video', 'audio', 'document', 'file'].map((value) => <option key={value} value={value}>{mediaKindLabel(value)}</option>)}</select></label>}
    </div>
    <Panel title="Biblioteca multimedia" action={`${total} archivos`}>
      {error ? <div className="territory-error"><CircleAlert size={18}/><span>{error}</span><button className="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar</button></div> : loading ? <div className="territory-loading"><span className="spinner"/>Cargando archivos…</div> : items.length ? <><div className="media-library-grid">{items.map((item) => <MediaLibraryCard key={String(item.id)} item={item} onOpen={() => setSelected(item)} />)}</div><DirectoryPagination page={page} total={total} pageSize={pageSize} pages={pages} onPage={setPage}/></> : <div className="empty-state"><Image size={30}/><b>No hay archivos para este filtro</b><span>Prueba con otro nombre o tipo de archivo.</span></div>}
    </Panel>
    {selected && <MediaLibraryPreview item={selected} close={() => setSelected(null)} />}
  </>
}

function MediaLibraryCard({ item, onOpen }: { item: JsonRecord; onOpen: () => void }) {
  const kind = String(item.kind || 'file')
  const url = String(item.thumbnailUrl || item.url || '')
  const sizeSourceUrl = String(item.url || '')
  const resolvedSize = useResolvedMediaSize(sizeSourceUrl, item.sizeBytes)
  return <button className="media-library-card" onClick={onOpen}>
    <span className={`media-library-thumb ${kind}`}>{kind === 'image' && url ? <img src={url} alt=""/> : kind === 'video' && url ? <><video src={url} muted preload="metadata"/><i><Play size={24} fill="currentColor"/></i></> : kind === 'audio' ? <Activity size={31}/> : <FilePlus2 size={31}/>}</span>
    <span className="media-library-copy"><b title={String(item.name)}>{String(item.name || 'Archivo sin nombre')}</b><small>{mediaKindLabel(kind)} · {resolvedSize.size ? fileSize(resolvedSize.size) : resolvedSize.checking ? 'Calculando tamaño…' : 'Tamaño no publicado'}</small><small>{dateTime(item.createdAt)}</small></span>
  </button>
}

function MediaLibraryPreview({ item, close }: { item: JsonRecord; close: () => void }) {
  const kind = String(item.kind || 'file')
  const url = String(item.url || '')
  const mime = String(item.mimeType || '')
  const name = String(item.name || 'Archivo')
  const resolvedSize = useResolvedMediaSize(url, item.sizeBytes)
  const sizeLabel = resolvedSize.size ? fileSize(resolvedSize.size) : resolvedSize.checking ? 'Calculando tamaño…' : 'Tamaño no publicado'
  return <Modal title={name} close={close}><div className="media-preview-modal"><div className="media-preview-stage">{kind === 'image' && <img src={url} alt={name}/>} {kind === 'video' && <video src={url} controls autoPlay preload="metadata"/>} {kind === 'audio' && <div className="media-audio-preview"><Activity size={40}/><audio controls autoPlay><source src={url} type={mime}/></audio></div>} {kind === 'document' && mime === 'application/pdf' && <iframe src={url} title={name}/>} {(kind === 'file' || (kind === 'document' && mime !== 'application/pdf')) && <div className="media-file-preview"><FilePlus2 size={42}/><b>{name}</b><span>Este archivo se abrirá en una pestaña nueva.</span></div>}</div><footer><span>{mediaKindLabel(kind)} · {sizeLabel} · {dateTime(item.createdAt)}</span><a className="secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Abrir archivo</a></footer></div></Modal>
}

function CollectionModule({ meta, data }: { meta: ModuleMeta; data: unknown; session: QocSession }) { const rows=Array.isArray(data)?data:[]; return <><div className="info-banner"><meta.icon size={20}/><div><b>Módulo conectado a datos de Qüata</b><p>La vista utiliza la fuente disponible y mantiene preparada su ampliación operativa conforme a {meta.source}.</p></div></div><Panel title={meta.label}>{rows.length ? <DataTable rows={rows as JsonRecord[]} columns={autoColumns(rows as JsonRecord[])}/> : <div className="empty-state"><meta.icon size={30}/><b>Sin datos disponibles todavía</b><span>La estructura de este módulo está preparada para recibir los eventos e integraciones correspondientes.</span></div>}</Panel></> }

function Panel({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) { return <section className="panel"><header><h2>{title}</h2>{typeof action === 'string' ? <button className="panel-action">{action}<ChevronDown size={14}/></button> : action}</header>{children}</section> }
function Metric({ label, value }: { label:string; value:unknown }) { const numeric = Number(value); const rendered = typeof value === 'string' && !Number.isFinite(numeric) ? value : formatNumber(value); return <article className="kpi"><p>{label}</p><strong>{rendered}</strong><small>Datos agregados</small></article> }
function Timeline({ rows }: { rows: JsonRecord[] }) { return <div className="timeline">{rows.length?rows.slice(0,5).map((row)=><div key={String(row.id)}><i/><div><b>{String(row.title || row.message || 'Actividad de plataforma')}</b><small>{dateTime(row.at || row.createdAt)}</small></div></div>):<div className="empty-state"><Activity size={26}/><b>Sin actividad reciente</b></div>}</div> }
function MiniChart() { const points = [{x:'L',value:32},{x:'M',value:41},{x:'X',value:37},{x:'J',value:52},{x:'V',value:61},{x:'S',value:58},{x:'D',value:73}]; return <div className="chart-wrap"><ResponsiveContainer width="100%" height={190}><LineChart data={points}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="x"/><YAxis hide/><Tooltip/><Line type="monotone" dataKey="value" stroke="#f97316" strokeWidth={2} dot={false}/></LineChart></ResponsiveContainer></div> }
function UserGrowthChart({ data }: { data: JsonRecord[] }) { const formatDate = (value: unknown) => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' }).format(new Date(String(value))); return <div className="chart-wrap"><ResponsiveContainer width="100%" height={190}><LineChart data={data}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="date" tickFormatter={formatDate} minTickGap={26}/><YAxis hide domain={['dataMin - 1', 'dataMax + 1']}/><Tooltip labelFormatter={formatDate} formatter={(value) => [formatNumber(value), 'Usuarios']}/><Line type="monotone" dataKey="users" stroke="#f97316" strokeWidth={2} dot={false} activeDot={{ r: 4 }}/></LineChart></ResponsiveContainer></div> }
function DataTable({ rows, columns, action }: { rows: JsonRecord[] | null | undefined; columns: [string,string][]; action?: (row: JsonRecord)=>React.ReactNode }) { const safeRows = Array.isArray(rows) ? rows : []; return <div className="table-wrap"><table><thead><tr>{columns.map(([,label])=><th key={label}>{label}</th>)}{action&&<th>Acciones</th>}</tr></thead><tbody>{safeRows.length?safeRows.map((row,index)=><tr key={String(row.id || index)}>{columns.map(([key])=><td key={key}>{renderCell(row[key],key)}</td>)}{action&&<td>{action(row)}</td>}</tr>):<tr><td colSpan={columns.length+(action?1:0)} className="no-results">No hay datos para estos filtros.</td></tr>}</tbody></table></div> }
function moderationStatusLabel(status: string) { return ({ pending: 'Pendiente', reviewing: 'En revisión', removed: 'Contenido retirado', dismissed: 'Descartado' } as Record<string, string>)[status] || status.replaceAll('_', ' ') }
function renderCell(value: unknown, key: string) { if(value===null||value===undefined||value==='')return <span className="muted">—</span>; if(typeof value==='boolean')return <span className={`badge ${value?'success':'neutral'}`}>{value?'Activo':'No'}</span>; const dateKeys=new Set(['at','createdAt','updatedAt','publishedAt','joinedAt','reviewedAt','created_at','updated_at','published_at','joined_at','reviewed_at','deleted_at']); if(dateKeys.has(key)) return <span>{dateTime(value)}</span>; if(key==='status')return <span className="badge">{moderationStatusLabel(String(value))}</span>; if(key==='type'||key==='priority'||key==='language'||key==='locale')return <span className="badge">{String(value).replaceAll('_',' ')}</span>; if(typeof value==='object') return <span className="muted">Configurado</span>; return <span title={String(value)}>{String(value).length>46?`${String(value).slice(0,46)}…`:String(value)}</span> }
function autoColumns(rows: JsonRecord[]): [string,string][] { const first=rows[0]||{}; return Object.keys(first).slice(0,6).map((key)=>[key,key.replace(/([A-Z])/g,' $1').replace(/^./,(x)=>x.toUpperCase())]) }
function Modal({ title, close, children }: { title:string; close:()=>void; children:React.ReactNode }) { return <div className="modal-backdrop"><section className="modal"><header><h2>{title}</h2><button className="icon" onClick={close}><X size={18}/></button></header>{children}</section></div> }
function SkeletonPage(){return <div className="skeleton-grid">{Array.from({length:6},(_,i)=><div key={i} className="skeleton"/>)}</div>}
function ErrorPanel({retry}:{retry:()=>void}){return <div className="error-panel"><CircleAlert size={28}/><b>No se han podido cargar los datos</b><p>Comprueba la conexión o vuelve a intentarlo.</p><button className="secondary" onClick={retry}>Reintentar</button></div>}

export default App
