import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, File,
  FileImage, Film, MapPin, MessageSquareText, Play, Search, ShieldCheck, UserRoundSearch, X,
} from 'lucide-react'
import {
  getCitizenSecurityAudit,
  getCitizenSecurityConfig,
  getCitizenSecurityConversation,
  getCitizenSecurityConversations,
  getCitizenSecurityMedia,
  getCitizenSecurityTimeline,
  openCitizenSecurityMedia,
  openCitizenSecurityProfile,
  resolveCitizenSecurityLocations,
  searchCitizenSecurityUsers,
} from '../lib/api'
import { EvidencePoint, GoogleEvidenceMap } from './GoogleEvidenceMap'

type Json = Record<string, unknown>
type Tab = 'summary' | 'chats' | 'trace' | 'media' | 'audit'

const asRows = (value: unknown) => Array.isArray(value) ? value as Json[] : []
const text = (value: unknown, fallback = '') => String(value ?? fallback)
const number = (value: unknown) => Number(value || 0)
const dateTime = (value: unknown) => {
  const date = new Date(text(value))
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Sin fecha'
}
const initials = (value: unknown) => text(value, 'U').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
const formatBytes = (value: unknown) => {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Tamaño no disponible'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
const dateBoundary = (value: string, end = false) => value
  ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`).toISOString()
  : ''

function readableEvidencePreview(event: Json) {
  const preview = text(event.preview).trim()
  if (text(event.sourceType) !== 'SOS_LOCATION' || !preview.startsWith('[SOS:')) {
    return preview || 'Sin texto de origen'
  }

  const fields = new Map(
    preview.slice(5, preview.endsWith(']') ? -1 : undefined)
      .split(';')
      .map((part) => {
        const separator = part.indexOf('=')
        return separator > 0 ? [part.slice(0, separator), part.slice(separator + 1)] : [part, '']
      }),
  )
  const name = fields.get('name')?.trim()
  const kind = fields.get('kind')
  if (kind === 'alert') {
    return name
      ? `${name} envió una solicitud de ayuda mediante SOS.`
      : 'Solicitud de ayuda enviada mediante SOS.'
  }
  if (kind === 'location_update') {
    return name
      ? `Se recibió una actualización de la ubicación SOS de ${name}.`
      : 'Se recibió una actualización de ubicación SOS.'
  }
  return 'Información registrada por el sistema SOS.'
}

const sourceLabels: Record<string, string> = {
  PROFILE_NEIGHBORHOOD: 'Barrio declarado',
  SOS_LOCATION: 'Ubicación SOS',
  POST_MANUAL_LOCATION_TEXT: 'Texto geográfico de publicación',
}
const reliabilityLabels: Record<string, string> = {
  HIGH: 'Alta',
  MEDIUM: 'Media',
  LOW: 'Baja',
  CONTEXT_ONLY: 'Solo contextual',
}
const actionLabels: Record<string, string> = {
  USER_SEARCH: 'Búsqueda de usuario',
  PROFILE_OPEN: 'Apertura de perfil',
  CONVERSATION_LIST_VIEW: 'Listado de conversaciones',
  CONVERSATION_OPEN: 'Conversación abierta',
  MESSAGE_SEARCH: 'Búsqueda en mensajes',
  LOCATION_TIMELINE_VIEW: 'Cronología consultada',
  MEDIA_LIST_VIEW: 'Evidencias consultadas',
  MEDIA_SIGNED_URL_CREATED: 'Archivo abierto',
  AUDIT_PROFILE_VIEW: 'Auditoría del perfil consultada',
  AUDIT_GLOBAL_VIEW: 'Auditoría global consultada',
}

function Loading({ label = 'Consultando datos auditados...' }: { label?: string }) {
  return <div className="security-loading"><span className="spinner"/>{label}</div>
}

function ErrorState({ message }: { message: string }) {
  return <div className="security-error"><CircleAlert size={19}/><span>{message}</span></div>
}

function ProfileAvatar({ profile, large = false }: { profile: Json; large?: boolean }) {
  const avatar = text(profile.avatarUrl)
  return <span className={`security-avatar ${large ? 'large' : ''}`}>
    {avatar ? <img src={avatar} alt=""/> : initials(profile.displayName)}
  </span>
}

export function CitizenSecurityModule() {
  const [config, setConfig] = useState<Json | null>(null)
  const [query, setQuery] = useState('')
  const [reason, setReason] = useState('')
  const [page, setPage] = useState(1)
  const [results, setResults] = useState<Json | null>(null)
  const [profileData, setProfileData] = useState<Json | null>(null)
  const [tab, setTab] = useState<Tab>('summary')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [globalAudit, setGlobalAudit] = useState(false)

  useEffect(() => {
    getCitizenSecurityConfig().then(setConfig).catch(() => setError('No se ha podido verificar el acceso al módulo.'))
  }, [])

  useEffect(() => {
    if (profileData || globalAudit) return
    const normalized = query.trim()
    if (normalized.length < 2) { setResults(null); return }
    const controller = window.setTimeout(() => {
      setLoading(true); setError('')
      searchCitizenSecurityUsers(normalized, page, reason)
        .then(setResults)
        .catch(() => setError('No se ha podido completar la búsqueda. Comprueba tus permisos e inténtalo de nuevo.'))
        .finally(() => setLoading(false))
    }, 400)
    return () => window.clearTimeout(controller)
  }, [query, page, reason, profileData, globalAudit])

  const openProfile = async (userId: string) => {
    setLoading(true); setError('')
    try {
      setProfileData(await openCitizenSecurityProfile(userId, reason))
      setTab('summary')
    } catch {
      setError('No se ha podido abrir el perfil solicitado.')
    } finally { setLoading(false) }
  }

  if (error && !config) return <ErrorState message={error}/>
  if (!config) return <Loading label="Verificando autorización..."/>
  if (!config.directAccessDemo) return <ErrorState message="El acceso directo de demostración está desactivado."/>

  if (globalAudit) return <SecurityAudit targetUserId={null} reason={reason} close={() => setGlobalAudit(false)}/>
  if (!profileData) {
    const rows = asRows(results?.items)
    const total = number(results?.total)
    return <div className="security-module">
      <section className="security-hero">
        <div className="security-hero-icon"><ShieldCheck size={25}/></div>
        <div>
          <span>Acceso controlado</span>
          <h2>Consulta histórica con trazabilidad obligatoria</h2>
          <p>Localiza un perfil y consulta comunicaciones y evidencias de ubicación relacionadas dentro de Qüata.</p>
        </div>
        <button className="secondary" onClick={() => setGlobalAudit(true)}>Ver auditoría global</button>
      </section>
      <section className="panel security-search-panel">
        <div className="security-audit-notice"><ShieldCheck size={18}/><div><b>Todos los accesos quedan registrados</b><span>Las búsquedas, aperturas de perfiles, chats, evidencias y archivos generan un identificador de petición auditable.</span></div></div>
        <div className="security-search-grid">
          <label><span>Buscar perfil</span><div className="security-search-input"><Search size={18}/><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="Nombre, teléfono o identificador interno" autoComplete="off"/></div></label>
          <label><span>Motivo operativo <small>(opcional en modo demo)</small></span><input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={220} placeholder="Contexto breve de la consulta"/></label>
        </div>
        {loading && <Loading label="Buscando perfiles..."/>}
        {!loading && query.trim().length < 2 && <div className="security-search-empty"><UserRoundSearch size={34}/><b>Introduce al menos dos caracteres</b><span>La búsqueda vacía nunca devuelve el directorio completo.</span></div>}
        {!loading && query.trim().length >= 2 && rows.length === 0 && <div className="security-search-empty"><Search size={30}/><b>Sin coincidencias</b><span>Prueba con otro nombre, teléfono o identificador.</span></div>}
        {!loading && rows.length > 0 && <div className="security-results">
          {rows.map((row) => <button key={text(row.userId)} onClick={() => openProfile(text(row.userId))}>
            <ProfileAvatar profile={row}/>
            <span><b>{text(row.displayName)}</b><small>{text(row.neighborhood, 'Sin barrio declarado')} · {text(row.maskedPhone)}</small></span>
            <span className={`badge ${text(row.accountStatus) === 'active' ? 'success' : 'neutral'}`}>{text(row.accountStatus, 'Sin estado')}</span>
            <ChevronRight size={18}/>
          </button>)}
          <Pagination page={page} pageSize={20} total={total} setPage={setPage}/>
        </div>}
      </section>
    </div>
  }

  const profile = (profileData.profile || {}) as Json
  const targetUserId = text(profile.userId)
  return <div className="security-module">
    <button className="security-back" onClick={() => { setProfileData(null); setResults(null); setQuery('') }}><ArrowLeft size={17}/>Volver al buscador</button>
    <section className="panel security-profile-head">
      <ProfileAvatar profile={profile} large/>
      <div className="security-profile-title"><span>Perfil consultado</span><h2>{text(profile.displayName)}</h2><p>{text(profile.neighborhood, 'Sin barrio declarado')} · Alta {dateTime(profile.registeredAt)}</p></div>
      <dl><div><dt>Teléfono</dt><dd>{text(profile.phone, 'No disponible')}</dd></div><div><dt>Estado</dt><dd>{text(profile.accountStatus, 'Sin estado')}</dd></div><div><dt>ID interno</dt><dd>{targetUserId}</dd></div></dl>
    </section>
    <nav className="security-tabs" aria-label="Secciones del perfil">
      {([
        ['summary', 'Resumen'],
        ['chats', 'Historial de chats'],
        ['trace', 'Rastreo de personas'],
        ['media', 'Evidencias'],
        ['audit', 'Auditoría'],
      ] as Array<[Tab, string]>).map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
    </nav>
    {tab === 'summary' && <SecuritySummary data={profileData}/>}
    {tab === 'chats' && <SecurityChats targetUserId={targetUserId} reason={reason}/>}
    {tab === 'trace' && <SecurityTrace targetUserId={targetUserId} reason={reason}/>}
    {tab === 'media' && <SecurityMedia targetUserId={targetUserId} reason={reason}/>}
    {tab === 'audit' && <SecurityAudit targetUserId={targetUserId} reason={reason}/>}
    <div className="security-watermark">DEMO · Consulta auditada · {new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date())}</div>
  </div>
}

function SecuritySummary({ data }: { data: Json }) {
  const summary = (data.summary || {}) as Json
  const cards = [
    ['Conversaciones', summary.conversationCount],
    ['Mensajes enviados', summary.messagesSent],
    ['Mensajes recibidos', summary.messagesReceived],
    ['Alertas SOS', summary.sosEventCount],
    ['Publicaciones', summary.communityPostCount],
    ['Archivos relacionados', summary.mediaCount],
  ]
  return <div className="security-summary">
    <div className="security-kpis">{cards.map(([label, value]) => <article key={text(label)}><span>{text(label)}</span><b>{number(value).toLocaleString('es-ES')}</b></article>)}</div>
    <section className="panel security-evidence-range"><header><h2>Disponibilidad de evidencias</h2></header><div><p><span>Primera evidencia conservada</span><b>{dateTime(summary.firstEvidenceAt)}</b></p><p><span>Última evidencia conservada</span><b>{dateTime(summary.lastEvidenceAt)}</b></p><p><span>Alcance</span><b>Datos históricos almacenados por Qüata</b></p></div></section>
  </div>
}

function SecurityChats({ targetUserId, reason }: { targetUserId: string; reason: string }) {
  const [data, setData] = useState<Json | null>(null)
  const [selected, setSelected] = useState<Json | null>(null)
  const [conversation, setConversation] = useState<Json | null>(null)
  const [messages, setMessages] = useState<Json[]>([])
  const [type, setType] = useState('ALL')
  const [recipientQuery, setRecipientQuery] = useState('')
  const [debouncedRecipient, setDebouncedRecipient] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [query, setQuery] = useState('')
  const [conversationPage, setConversationPage] = useState(1)
  const [messagePage, setMessagePage] = useState(1)
  const [listLoading, setListLoading] = useState(true)
  const [messageLoading, setMessageLoading] = useState(false)
  const [error, setError] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)
  const restoreHeight = useRef<number | null>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedRecipient(recipientQuery.trim())
      setConversationPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [recipientQuery])

  useEffect(() => {
    let active = true
    setListLoading(true); setError('')
    getCitizenSecurityConversations(targetUserId, {
      type,
      participantQuery: debouncedRecipient,
      dateFrom: dateBoundary(dateFrom),
      dateTo: dateBoundary(dateTo, true),
      page: conversationPage,
      reason,
    })
      .then((value) => { if (active) setData(value) })
      .catch(() => { if (active) setError('No se han podido cargar las conversaciones.') })
      .finally(() => { if (active) setListLoading(false) })
    return () => { active = false }
  }, [targetUserId, type, debouncedRecipient, dateFrom, dateTo, conversationPage, reason])

  useEffect(() => {
    if (!selected) { setConversation(null); setMessages([]); return }
    let active = true
    const timer = window.setTimeout(() => {
      setMessageLoading(true); setError('')
      getCitizenSecurityConversation(targetUserId, text(selected.conversationId), {
        query,
        dateFrom: dateBoundary(dateFrom),
        dateTo: dateBoundary(dateTo, true),
        page: messagePage,
        reason,
      })
        .then((value) => {
          if (!active) return
          const incoming = asRows(value.messages)
          setConversation(value)
          setMessages((current) => messagePage === 1 ? incoming : [...incoming, ...current])
          window.requestAnimationFrame(() => {
            const container = messagesRef.current
            if (!container) return
            if (restoreHeight.current != null) {
              container.scrollTop += container.scrollHeight - restoreHeight.current
              restoreHeight.current = null
            } else if (messagePage === 1 && !query) {
              container.scrollTop = container.scrollHeight
            }
          })
        })
        .catch(() => { if (active) setError('No se ha podido abrir la conversación.') })
        .finally(() => { if (active) setMessageLoading(false) })
    }, query ? 350 : 0)
    return () => { active = false; window.clearTimeout(timer) }
  }, [targetUserId, selected, query, dateFrom, dateTo, messagePage, reason])

  const conversations = asRows(data?.items)
  const totalMessages = number(conversation?.total)
  const loadOlder = () => {
    if (messageLoading || messages.length >= totalMessages || !messagesRef.current) return
    restoreHeight.current = messagesRef.current.scrollHeight
    setMessagePage((value) => value + 1)
  }
  const chooseConversation = (row: Json) => {
    setSelected(row)
    setConversation(null)
    setMessages([])
    setMessagePage(1)
    setQuery('')
  }
  return <div className="security-chat-page">
    <section className="panel security-filter-bar security-chat-filters">
      <label className="security-person-filter"><span>Destinatarios</span><span className="security-search-input"><Search size={15}/><input value={recipientQuery} onChange={(event) => setRecipientQuery(event.target.value)} placeholder="Buscar destinatario"/></span></label>
      <label><span>Tipo</span><select value={type} onChange={(event) => { setType(event.target.value); setConversationPage(1) }}><option value="ALL">Todas</option><option value="private">Individuales</option><option value="group">Grupales</option><option value="community">Comunidades</option><option value="sos">SOS</option></select></label>
      <label><span>Desde</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setConversationPage(1); setMessagePage(1); setMessages([]) }}/></label>
      <label><span>Hasta</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setConversationPage(1); setMessagePage(1); setMessages([]) }}/></label>
      {(recipientQuery || type !== 'ALL' || dateFrom || dateTo) && <button className="secondary" onClick={() => { setRecipientQuery(''); setDebouncedRecipient(''); setType('ALL'); setDateFrom(''); setDateTo(''); setConversationPage(1); setMessagePage(1); setMessages([]) }}>Limpiar filtros</button>}
    </section>
    <section className="panel security-chat-shell">
    <div className="security-conversation-list">
      <header><div><h3>Destinatarios</h3><span>{number(data?.total)} conversaciones</span></div></header>
      {listLoading ? <Loading label="Cargando conversaciones..."/> : <div>{conversations.map((row) => <button key={text(row.conversationId)} className={text(selected?.conversationId) === text(row.conversationId) ? 'active' : ''} onClick={() => chooseConversation(row)}>
        <MessageSquareText size={18}/><span><b>{text(row.title)}</b><small>{text(row.participantsPreview)}</small><em>{text(row.lastMessagePreview, 'Sin mensajes')}</em></span><time>{dateTime(row.lastMessageAt)}</time>
      </button>)}</div>}
      <Pagination page={conversationPage} pageSize={30} total={number(data?.total)} setPage={setConversationPage}/>
    </div>
    <div className="security-message-view">
      {!selected && <div className="security-chat-empty"><MessageSquareText size={35}/><b>Selecciona una conversación</b><span>Los mensajes se solicitarán y auditarán al abrirla.</span></div>}
      {selected && <><header><div><h3>{text(selected.title)}</h3><span>{number(conversation?.total)} mensajes</span></div><div className="security-search-input"><Search size={16}/><input value={query} onChange={(event) => { setQuery(event.target.value); setMessagePage(1); setMessages([]) }} placeholder="Buscar dentro de esta conversación"/></div></header>
        {error && <ErrorState message={error}/>}
        {!error && <div ref={messagesRef} className="security-messages" onScroll={(event) => { if (event.currentTarget.scrollTop <= 48) loadOlder() }}>
          {messageLoading && messagePage > 1 && <div className="security-message-page-loader"><span className="spinner"/>Cargando mensajes anteriores...</div>}
          {messageLoading && messagePage === 1 && <Loading/>}
          {messages.map((message) => <article key={text(message.messageId)} className={message.deleted ? 'deleted' : ''}>
          <div><span className="security-mini-avatar">{initials(message.authorDisplayName)}</span><b>{text(message.authorDisplayName)}</b><time>{dateTime(message.sentAt)}</time></div>
          <p>{text(message.text, 'Mensaje sin texto')}</p>
          {asRows(message.attachments).map((attachment) => <MediaOpenButton key={text(attachment.mediaId)} targetUserId={targetUserId} media={attachment} reason={reason}/>)}
          {Boolean(message.location) && <span className="security-message-location"><MapPin size={14}/>Mensaje vinculado a una evidencia SOS</span>}
        </article>)}
          {!messageLoading && messages.length < totalMessages && <button className="security-load-older" onClick={loadOlder}>Cargar mensajes anteriores</button>}
        </div>}</>}
    </div>
    <aside className="security-conversation-info">
      <h3>Información</h3>
      {selected ? <><dl><dt>ID</dt><dd>{text(selected.conversationId)}</dd><dt>Tipo</dt><dd>{text(selected.conversationType)}</dd><dt>Participantes</dt><dd>{text(selected.participantsPreview)}</dd><dt>Mensajes del perfil</dt><dd>{number(selected.targetUserMessageCount)}</dd><dt>Adjuntos</dt><dd>{selected.hasAttachments ? 'Sí' : 'No'}</dd><dt>SOS / ubicación</dt><dd>{selected.hasLocation ? 'Sí' : 'No'}</dd></dl><p>Los resultados se ordenan por fecha e identificador para mantener una paginación estable.</p></> : <p>Abre una conversación para consultar su contexto.</p>}
    </aside>
  </section>
  </div>
}

function SecurityTrace({ targetUserId, reason }: { targetUserId: string; reason: string }) {
  const [data, setData] = useState<Json | null>(null)
  const [onlyCoordinates, setOnlyCoordinates] = useState(false)
  const [source, setSource] = useState('ALL')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [selected, setSelected] = useState<Json | null>(null)
  const [inferences, setInferences] = useState<Record<string, Json>>({})
  const [resolvingPlaces, setResolvingPlaces] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getCitizenSecurityTimeline(targetUserId, {
      onlyCoordinates,
      sources: source === 'ALL' ? undefined : [source],
      dateFrom: dateBoundary(dateFrom),
      dateTo: dateBoundary(dateTo, true),
      reason,
    }).then((value) => { if (active) setData(value) })
      .catch(() => { if (active) setError('No se ha podido construir la cronología.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [targetUserId, onlyCoordinates, source, dateFrom, dateTo, reason])

  const events = asRows(data?.events)
  useEffect(() => {
    const evidenceIds = events
      .filter((event) => event.latitude == null && text(event.placeLabel))
      .map((event) => text(event.evidenceId))
      .slice(0, 30)
    if (!evidenceIds.length) {
      setInferences({})
      return
    }
    let active = true
    setResolvingPlaces(true)
    resolveCitizenSecurityLocations(targetUserId, evidenceIds, reason)
      .then((value) => {
        if (!active) return
        setInferences(Object.fromEntries(
          [
            ...asRows(value.resolved).map((item) => ({ ...item, ambiguous: false } as Json)),
            ...asRows(value.ambiguous).map((item) => ({ ...item, ambiguous: true } as Json)),
          ].map((item) => [text(item.evidenceId), item]),
        ))
      })
      .catch(() => { if (active) setInferences({}) })
      .finally(() => { if (active) setResolvingPlaces(false) })
    return () => { active = false }
  }, [data, targetUserId, reason])

  const exactPoints = useMemo(() => events.filter((event) =>
    event.latitude !== null && event.latitude !== undefined
    && event.longitude !== null && event.longitude !== undefined
    && Number.isFinite(Number(event.latitude)) && Number.isFinite(Number(event.longitude)),
  ), [data])
  const mapPoints = useMemo<EvidencePoint[]>(() => [
    ...exactPoints.map((event) => ({
      evidenceId: text(event.evidenceId),
      latitude: Number(event.latitude),
      longitude: Number(event.longitude),
      label: text(event.placeLabel, sourceLabels[text(event.sourceType)]),
      accuracyMeters: number(event.accuracyMeters),
      inferred: false,
    })),
    ...Object.values(inferences).map((inference) => ({
      evidenceId: text(inference.evidenceId),
      latitude: Number(inference.latitude),
      longitude: Number(inference.longitude),
      label: text(inference.resolvedLabel),
      confidence: Number(inference.confidence),
      inferred: true,
      ambiguous: Boolean(inference.ambiguous),
    })),
  ], [exactPoints, inferences])
  const segments = useMemo(() => exactPoints.slice(0, -1).flatMap((event, index) => {
    const next = exactPoints[index + 1]
    const delta = Math.abs(new Date(text(event.observedAt)).getTime() - new Date(text(next.observedAt)).getTime())
    if (delta > 72 * 60 * 60 * 1000) return []
    const start = mapPoints.find((point) => point.evidenceId === text(event.evidenceId))
    const end = mapPoints.find((point) => point.evidenceId === text(next.evidenceId))
    return start && end ? [[start, end] as [EvidencePoint, EvidencePoint]] : []
  }), [exactPoints, mapPoints])
  const selectEvidence = useCallback((evidenceId: string) => {
    const match = events.find((event) => text(event.evidenceId) === evidenceId)
    if (match) setSelected(match)
  }, [events])
  const selectedInference = selected ? inferences[text(selected.evidenceId)] : null
  const selectedCoordinates = useMemo(() => {
    if (!selected) return null
    const latitude = selected.latitude == null ? Number(selectedInference?.latitude) : Number(selected.latitude)
    const longitude = selected.longitude == null ? Number(selectedInference?.longitude) : Number(selected.longitude)
    return Number.isFinite(latitude) && Number.isFinite(longitude) && !(latitude === 0 && longitude === 0)
      ? { latitude, longitude }
      : null
  }, [selected, selectedInference])
  const selectedWarnings = selected
    ? asRows(selected.warnings).filter((warning) =>
      !(selectedInference && /no se geocodifica|no se dibuja|no se muestra como punto/i.test(text(warning))),
    )
    : []

  if (loading) return <Loading/>
  if (error) return <ErrorState message={error}/>
  return <div className="security-trace">
    <div className="security-trace-notice"><MapPin size={18}/><span>{text(data?.notice)}</span></div>
    <section className="panel security-map-panel">
      <GoogleEvidenceMap
        points={mapPoints}
        segments={segments}
        focusedEvidenceId={text(selected?.evidenceId)}
        onSelect={selectEvidence}
      />
      <div className="security-map-legend"><span><i className="high"/>Punto observado</span><span><i className="inferred"/>Inferencia fiable</span><span><i className="ambiguous"/>Coincidencia ambigua</span><span><i className="line"/>Secuencia temporal, no ruta</span></div>
      {resolvingPlaces && <div className="security-map-resolving"><span className="spinner"/>Resolviendo etiquetas con Google Maps...</div>}
    </section>
    <section className="panel security-trace-list">
      <header><div><h2>Cronología de evidencias</h2><span>{events.length} eventos</span></div><div><select value={source} onChange={(event) => setSource(event.target.value)}><option value="ALL">Todas las fuentes</option>{Object.entries(sourceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label><input type="checkbox" checked={onlyCoordinates} onChange={(event) => setOnlyCoordinates(event.target.checked)}/>Solo con coordenadas</label></div></header>
      <div className="security-trace-date-filters"><label><span>Desde</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)}/></label><label><span>Hasta</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)}/></label>{(dateFrom || dateTo) && <button className="secondary" onClick={() => { setDateFrom(''); setDateTo('') }}>Limpiar</button>}</div>
      <div>{events.map((event) => <button key={text(event.evidenceId)} className={text(selected?.evidenceId) === text(event.evidenceId) ? 'active' : ''} onClick={() => setSelected(event)}>
        <span className={`security-source-dot ${text(event.reliability).toLowerCase()}`}/><span><b>{sourceLabels[text(event.sourceType)] || text(event.sourceType)}</b><small>{text(event.placeLabel, 'Sin lugar asociado')} · {dateTime(event.observedAt || event.receivedAt)}</small></span><span className="badge neutral">{text(event.reliability)}</span>
      </button>)}</div>
    </section>
    <section className="panel security-evidence-detail">
      <header><h2>Detalle de evidencia</h2></header>
      {selected ? <div>
        <h3>{sourceLabels[text(selected.sourceType)] || text(selected.sourceType)}</h3>
        <p>{readableEvidencePreview(selected)}</p>
        <dl>
          <dt>Etiqueta de localización</dt><dd>{text(selected.placeLabel, 'No publicada')}</dd>
          <dt>Observado</dt><dd>{dateTime(selected.observedAt)}</dd>
          <dt>Recibido por Qüata</dt><dd>{dateTime(selected.receivedAt)}</dd>
          <dt>Coordenadas</dt><dd className="security-coordinate-value">
            <span>{selected.latitude == null ? selectedInference ? `${selectedInference.latitude}, ${selectedInference.longitude} (inferidas)` : 'No disponibles' : `${selected.latitude}, ${selected.longitude}`}</span>
            {selectedCoordinates && <a
              className="security-map-link"
              href={`https://www.google.com/maps/search/?api=1&query=${selectedCoordinates.latitude},${selectedCoordinates.longitude}`}
              target="_blank"
              rel="noreferrer"
              title="Ver en Google Maps"
            ><ExternalLink size={13}/>Ver en Google Maps</a>}
          </dd>
          <dt>Precisión</dt><dd>{number(selected.accuracyMeters) ? `${number(selected.accuracyMeters)} m` : 'No disponible'}</dd>
          <dt>Fiabilidad del origen</dt><dd>{reliabilityLabels[text(selected.reliability)] || text(selected.reliability)}</dd>
          {selectedInference && <>
            <dt>Confianza geográfica</dt>
            <dd>{(Number(selectedInference.confidence) * 100).toFixed(0)}% · {selectedInference.ambiguous ? 'Coincidencia ambigua' : 'Alta'}</dd>
          </>}
          <dt>Resolución geográfica</dt><dd>{selected.latitude != null
            ? 'Punto aportado por la evidencia'
            : resolvingPlaces
              ? 'Intentando resolver la etiqueta...'
              : selectedInference
                ? `${text(selectedInference.resolvedLabel)} · confianza ${(Number(selectedInference.confidence) * 100).toFixed(0)}%${selectedInference.ambiguous ? ' · ambigua' : ''}`
                : 'Sin coincidencia geográfica verificable'}</dd>
        </dl>
        {selectedInference && <div className={`security-warning ${selectedInference.ambiguous ? 'ambiguous' : ''}`}>
          <b>{selectedInference.ambiguous ? 'Coincidencia geográfica ambigua' : 'Ubicación inferida por Google Maps'}</b>
          <span>La etiqueta publicada coincide con {text(selectedInference.resolvedLabel)}. Es una inferencia contextual, no una posición confirmada de la persona.</span>
        </div>}
        {selectedWarnings.length > 0 && <div className="security-warning">{selectedWarnings.map((warning, index) => <span key={index}>{text(warning)}</span>)}</div>}
      </div> : <div className="security-search-empty"><MapPin size={29}/><b>Selecciona una evidencia</b><span>Mapa y cronología están sincronizados.</span></div>}
    </section>
  </div>
}

function SecurityMedia({ targetUserId, reason }: { targetUserId: string; reason: string }) {
  const [data, setData] = useState<Json | null>(null)
  const [origin, setOrigin] = useState('ALL')
  const [mediaKind, setMediaKind] = useState('ALL')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Json | null>(null)
  const [openingId, setOpeningId] = useState('')
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getCitizenSecurityMedia(targetUserId, {
      origin,
      mediaKind,
      dateFrom: dateBoundary(dateFrom),
      dateTo: dateBoundary(dateTo, true),
      page,
      reason,
    })
      .then((value) => { if (active) setData(value) })
      .catch(() => { if (active) setError('No se han podido cargar las evidencias multimedia.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [targetUserId, origin, mediaKind, dateFrom, dateTo, page, reason])

  const preview = async (media: Json) => {
    const mediaId = text(media.mediaId)
    setOpeningId(mediaId)
    try {
      const resolved = await openCitizenSecurityMedia(targetUserId, mediaId, reason)
      setSelected({ ...media, ...resolved })
    } catch {
      setError('No se ha podido abrir la evidencia seleccionada.')
    } finally {
      setOpeningId('')
    }
  }

  if (loading) return <Loading/>
  if (error) return <ErrorState message={error}/>
  const rows = asRows(data?.items)
  return <><section className="panel security-media-panel">
    <header><div><h2>Evidencias multimedia</h2><span>La previsualización integrada se habilita después de registrar el acceso.</span></div></header>
    <div className="security-filter-bar">
      <label><span>Origen</span><select value={origin} onChange={(event) => { setOrigin(event.target.value); setPage(1) }}><option value="ALL">Todos</option><option value="CHAT">Chat</option><option value="POST">Publicaciones</option></select></label>
      <label><span>Tipo de archivo</span><select value={mediaKind} onChange={(event) => { setMediaKind(event.target.value); setPage(1) }}><option value="ALL">Todos</option><option value="IMAGE">Imágenes</option><option value="VIDEO">Vídeos</option><option value="AUDIO">Audio</option><option value="DOCUMENT">Documentos</option><option value="FILE">Otros archivos</option></select></label>
      <label><span>Desde</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1) }}/></label>
      <label><span>Hasta</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1) }}/></label>
      {(origin !== 'ALL' || mediaKind !== 'ALL' || dateFrom || dateTo) && <button className="secondary" onClick={() => { setOrigin('ALL'); setMediaKind('ALL'); setDateFrom(''); setDateTo(''); setPage(1) }}>Limpiar filtros</button>}
    </div>
    <div className="security-media-grid">{rows.map((media) => <article key={text(media.mediaId)}>
      <button className={`security-media-thumb ${text(media.mediaKind).toLowerCase()}`} onClick={() => preview(media)} disabled={openingId === text(media.mediaId)} aria-label={`Previsualizar ${text(media.fileName, 'archivo')}`}>
        {openingId === text(media.mediaId) ? <span className="spinner"/> : text(media.mediaKind) === 'IMAGE' ? <FileImage/> : text(media.mediaKind) === 'VIDEO' ? <><Film/><i><Play size={17} fill="currentColor"/></i></> : text(media.mediaKind) === 'AUDIO' ? <Activity/> : <File/>}
      </button>
      <div><span className="badge neutral">{text(media.origin)}</span><h3>{text(media.fileName, 'Archivo')}</h3><p>{dateTime(media.uploadedAt)} · {formatBytes(media.sizeBytes)}</p><small>No existe análisis EXIF persistido para este archivo.</small></div>
      <button className="secondary security-open-media" onClick={() => preview(media)} disabled={openingId === text(media.mediaId)}>{openingId === text(media.mediaId) ? <span className="spinner"/> : <ExternalLink size={15}/>}Previsualizar</button>
    </article>)}</div>
    {!rows.length && <div className="security-search-empty"><FileImage size={31}/><b>Sin evidencias multimedia</b><span>No hay archivos relacionados con los filtros seleccionados.</span></div>}
    <Pagination page={page} pageSize={24} total={number(data?.total)} setPage={setPage}/>
  </section>
  {selected && <SecurityMediaPreview media={selected} close={() => setSelected(null)}/>}
  </>
}

function SecurityMediaPreview({ media, close }: { media: Json; close: () => void }) {
  const url = text(media.url)
  const mime = text(media.mimeType)
  const kind = text(media.mediaKind) || (mime.startsWith('image') ? 'IMAGE' : mime.startsWith('video') ? 'VIDEO' : mime.startsWith('audio') ? 'AUDIO' : mime === 'application/pdf' ? 'DOCUMENT' : 'FILE')
  const name = text(media.fileName, 'Evidencia multimedia')
  return <div className="modal-backdrop security-media-preview-backdrop">
    <section className="modal security-media-preview-modal">
      <header><div><h2>{name}</h2><span>Acceso registrado en auditoría</span></div><button className="icon" onClick={close} aria-label="Cerrar"><X size={18}/></button></header>
      <div className="media-preview-stage">
        {kind === 'IMAGE' && <img src={url} alt={name}/>}
        {kind === 'VIDEO' && <video src={url} controls autoPlay preload="metadata"/>}
        {kind === 'AUDIO' && <div className="media-audio-preview"><Activity size={40}/><audio src={url} controls autoPlay/></div>}
        {kind === 'DOCUMENT' && mime === 'application/pdf' && <iframe src={url} title={name}/>}
        {(kind === 'FILE' || (kind === 'DOCUMENT' && mime !== 'application/pdf')) && <div className="media-file-preview"><File size={42}/><b>{name}</b><span>Este formato se abre con el visor del navegador o la aplicación asociada.</span></div>}
      </div>
      <footer><span>{dateTime(media.uploadedAt)} · {formatBytes(media.sizeBytes)}</span><a className="secondary" href={url} target="_blank" rel="noreferrer"><ExternalLink size={15}/>Abrir en otra pestaña</a></footer>
    </section>
  </div>
}

function MediaOpenButton({ targetUserId, media, reason }: { targetUserId: string; media: Json; reason: string }) {
  const [opening, setOpening] = useState(false)
  const [selected, setSelected] = useState<Json | null>(null)
  const open = async () => {
    setOpening(true)
    try {
      const resolved = await openCitizenSecurityMedia(targetUserId, text(media.mediaId), reason)
      setSelected({ ...media, fileName: text(media.fileName || media.name, 'Adjunto'), ...resolved })
    } finally {
      setOpening(false)
    }
  }
  return <>{<button className="secondary security-open-media" onClick={open} disabled={opening}>{opening ? <span className="spinner"/> : <ExternalLink size={15}/>}Previsualizar adjunto</button>}{selected && <SecurityMediaPreview media={selected} close={() => setSelected(null)}/>}</>
}

function SecurityAudit({ targetUserId, reason, close }: { targetUserId: string | null; reason: string; close?: () => void }) {
  const [data, setData] = useState<Json | null>(null)
  const [page, setPage] = useState(1)
  const [action, setAction] = useState('')
  const [personQuery, setPersonQuery] = useState('')
  const [debouncedPerson, setDebouncedPerson] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedPerson(personQuery.trim())
      setPage(1)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [personQuery])
  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    getCitizenSecurityAudit(targetUserId, {
      page,
      action,
      personQuery: debouncedPerson,
      dateFrom: dateBoundary(dateFrom),
      dateTo: dateBoundary(dateTo, true),
      reason,
    })
      .then((value) => { if (active) setData(value) })
      .catch(() => { if (active) setError('No se ha podido consultar el registro de auditoría.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [targetUserId, page, action, debouncedPerson, dateFrom, dateTo, reason])
  const rows = asRows(data?.items)
  return <div className="security-audit-page">
    {close && <button className="security-back" onClick={close}><ArrowLeft size={17}/>Volver a Seguridad ciudadana</button>}
    <section className="panel">
      <header><div><h2>{targetUserId ? 'Auditoría del perfil' : 'Auditoría global del módulo'}</h2><span>Registro inmutable de accesos sensibles</span></div></header>
      <div className="security-filter-bar audit">
        <label className="security-person-filter"><span>Persona u operador</span><span className="security-search-input"><Search size={15}/><input value={personQuery} onChange={(event) => setPersonQuery(event.target.value)} placeholder="Buscar por nombre"/></span></label>
        <label><span>Acción</span><select value={action} onChange={(event) => { setAction(event.target.value); setPage(1) }}><option value="">Todas las acciones</option>{Object.entries(actionLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label><span>Desde</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => { setDateFrom(event.target.value); setPage(1) }}/></label>
        <label><span>Hasta</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => { setDateTo(event.target.value); setPage(1) }}/></label>
        {(personQuery || action || dateFrom || dateTo) && <button className="secondary" onClick={() => { setPersonQuery(''); setDebouncedPerson(''); setAction(''); setDateFrom(''); setDateTo(''); setPage(1) }}>Limpiar filtros</button>}
      </div>
      {loading && <Loading/>}{error && <ErrorState message={error}/>}
      {!loading && !error && <div className="table-wrap"><table><thead><tr><th>Fecha</th><th>Operador</th>{!targetUserId && <th>Perfil</th>}<th>Acción</th><th>Recurso</th><th>Request ID</th><th>Resultado</th></tr></thead><tbody>{rows.map((row) => <tr key={text(row.id)}><td>{dateTime(row.occurredAt)}</td><td>{text(row.actorDisplayName)}</td>{!targetUserId && <td>{text(row.targetDisplayName, 'Sin objetivo')}</td>}<td>{actionLabels[text(row.action)] || text(row.action)}</td><td>{text(row.resourceType)} {text(row.resourceId)}</td><td><code>{text(row.requestId)}</code></td><td><span className={`badge ${row.success ? 'success' : 'neutral'}`}>{row.success ? 'Correcto' : 'Error'}</span></td></tr>)}</tbody></table></div>}
      <Pagination page={page} pageSize={25} total={number(data?.total)} setPage={setPage}/>
    </section>
  </div>
}

function Pagination({ page, pageSize, total, setPage }: { page: number; pageSize: number; total: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  return <div className="security-pagination"><span>{total.toLocaleString('es-ES')} resultados · Página {page} de {pages}</span><button disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16}/></button><button disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight size={16}/></button></div>
}
