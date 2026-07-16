import type { LucideIcon } from 'lucide-react'
import {
  Activity, BellRing, BookOpenCheck, Bot, Building2, ChartNoAxesCombined, CircleHelp,
  FileBarChart, Flag, Gauge, Globe2, Languages, LayoutDashboard, MessageSquareWarning,
  MonitorCog, Network, RadioTower, Scale, Settings2, ShieldAlert, ShieldCheck, Siren,
  UsersRound, Workflow,
} from 'lucide-react'

export type ModuleMeta = { slug: string; label: string; description: string; source: string; group: string; icon: LucideIcon; dataKey?: string }

export const modules: ModuleMeta[] = [
  { slug: 'dashboard', label: 'Resumen ejecutivo', description: 'Situación, actividad y prioridades', source: '06_Dashboard_ejecutivo.md', group: 'Operaciones', icon: LayoutDashboard, dataKey: 'overview' },
  { slug: 'sos', label: 'Centro SOS', description: 'Alertas, asignación y respuesta', source: '07_Centro_de_Control_SOS.md', group: 'Operaciones', icon: Siren, dataKey: 'sos' },
  { slug: 'territorios', label: 'Gestión territorial', description: 'Barrios, comunidades y responsables', source: '09_Gestion_territorial.md', group: 'Operaciones', icon: Globe2 },
  { slug: 'moderacion', label: 'Moderación', description: 'Reportes y decisiones de contenido', source: '11_Moderacion_y_reportes.md', group: 'Contenido', icon: ShieldAlert, dataKey: 'moderation' },
  { slug: 'oficiales', label: 'Cuentas oficiales', description: 'Perfiles, miembros y permisos', source: '12_Cuentas_oficiales_y_roles_institucionales.md', group: 'Contenido', icon: Building2, dataKey: 'official' },
  { slug: 'editor-oficial', label: 'Publicaciones oficiales', description: 'Publicación, revisión y traducción', source: '13_Editor_web_de_publicaciones_oficiales.md', group: 'Contenido', icon: FileBarChart, dataKey: 'official' },
  { slug: 'biblioteca', label: 'Biblioteca multimedia', description: 'Adjuntos, documentos y activos', source: '14_Biblioteca_multimedia_y_documentos.md', group: 'Contenido', icon: BookOpenCheck, dataKey: 'media' },
  { slug: 'comunidades', label: 'Comunidades y barrios', description: 'Actividad y salud comunitaria', source: '15_Gestion_de_comunidades_y_barrios.md', group: 'Contenido', icon: Network, dataKey: 'communities' },
  { slug: 'usuarios', label: 'Usuarios y acceso', description: 'Identidades, roles y estados', source: '16_Gestion_de_usuarios.md', group: 'Contenido', icon: UsersRound, dataKey: 'users' },
  { slug: 'campanas', label: 'Campañas', description: 'Comunicación, audiencias y envíos', source: '17_Centro_de_notificaciones_y_campanas.md', group: 'Comunicación', icon: BellRing, dataKey: 'campaigns' },
  { slug: 'analitica-usuarios', label: 'Analítica de usuarios', description: 'Crecimiento y retención', source: '18_Analitica_de_usuarios_y_retencion.md', group: 'Analítica', icon: ChartNoAxesCombined, dataKey: 'analytics' },
  { slug: 'analitica-contenido', label: 'Analítica de contenido', description: 'Feed y muro oficial', source: '19_Analitica_de_contenido_y_muro_oficial.md', group: 'Analítica', icon: Activity, dataKey: 'analytics' },
  { slug: 'analitica-chat', label: 'Analítica de chat', description: 'Entrega, lectura y comunidades', source: '20_Analitica_de_chat_y_comunidades.md', group: 'Analítica', icon: MessageSquareWarning, dataKey: 'analytics' },
  { slug: 'analitica-sos', label: 'Analítica SOS', description: 'SLA y respuesta operativa', source: '21_Analitica_SOS_y_respuesta_operativa.md', group: 'Analítica', icon: Gauge, dataKey: 'analytics' },
  { slug: 'traduccion', label: 'Centro de traducción', description: 'Cola, revisión y proveedores', source: '22_Centro_de_traduccion.md', group: 'Plataforma', icon: Languages, dataKey: 'translations' },
  { slug: 'monitorizacion', label: 'Monitorización', description: 'Salud técnica y dependencias', source: '23_Monitorizacion_tecnica.md', group: 'Plataforma', icon: MonitorCog, dataKey: 'overview' },
  { slug: 'auditoria', label: 'Auditoría', description: 'Trazabilidad administrativa', source: '24_Auditoria_y_trazabilidad.md', group: 'Plataforma', icon: Scale, dataKey: 'audit' },
  { slug: 'soporte', label: 'Soporte', description: 'Incidencias y atención operativa', source: '25_Soporte_e_incidencias.md', group: 'Plataforma', icon: CircleHelp, dataKey: 'support' },
  { slug: 'configuracion', label: 'Configuración', description: 'Límites, integraciones y flags', source: '26_Configuracion_general.md', group: 'Plataforma', icon: Settings2, dataKey: 'platform' },
  { slug: 'versiones', label: 'Versiones', description: 'Android, despliegues y compatibilidad', source: '27_Gestion_de_versiones_y_actualizaciones.md', group: 'Plataforma', icon: Workflow, dataKey: 'platform' },
  { slug: 'cumplimiento', label: 'Privacidad y cumplimiento', description: 'Seguridad, retención y controles', source: '28_Privacidad_seguridad_y_cumplimiento.md', group: 'Plataforma', icon: ShieldCheck, dataKey: 'platform' },
  { slug: 'roadmap', label: 'Roadmap', description: 'Fases y evolución de la plataforma', source: '29_Roadmap_y_fases_de_implementacion.md', group: 'Plataforma', icon: Flag },
  { slug: 'automatizacion', label: 'Automatización', description: 'Procesos y capacidades futuras', source: '29_Roadmap_y_fases_de_implementacion.md', group: 'Plataforma', icon: Bot },
  { slug: 'realtime', label: 'Realtime', description: 'Canales y estado de conexiones', source: '23_Monitorizacion_tecnica.md', group: 'Plataforma', icon: RadioTower, dataKey: 'overview' },
]

export const moduleBySlug = (slug?: string) => modules.find((item) => item.slug === slug) || modules[0]
