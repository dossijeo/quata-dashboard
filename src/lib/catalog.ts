import type { LucideIcon } from 'lucide-react'
import {
  Activity, BookOpenCheck, ChartNoAxesCombined, CircleHelp,
  FileBarChart, Gauge, LayoutDashboard, MessageSquareWarning,
  MonitorCog, Network, Scale, ShieldAlert, ShieldCheck, Siren,
  UsersRound, Workflow,
} from 'lucide-react'

export type ModuleMeta = { slug: string; label: string; description: string; source: string; group: string; icon: LucideIcon; dataKey?: string }

export const modules: ModuleMeta[] = [
  { slug: 'dashboard', label: 'Resumen ejecutivo', description: 'Situación, actividad y prioridades', source: '06_Dashboard_ejecutivo.md', group: 'Operaciones', icon: LayoutDashboard },
  { slug: 'sos', label: 'Centro SOS', description: 'Alertas, asignación y respuesta', source: '07_Centro_de_Control_SOS.md', group: 'Operaciones', icon: Siren, dataKey: 'sos' },
  { slug: 'territorios', label: 'Gestión territorial', description: 'Barrios, comunidades, actividad y miembros', source: '15_Gestion_de_comunidades_y_barrios.md', group: 'Operaciones', icon: Network },
  { slug: 'moderacion', label: 'Moderación', description: 'Reportes y decisiones de contenido', source: '11_Moderacion_y_reportes.md', group: 'Contenido', icon: ShieldAlert, dataKey: 'moderation' },
  { slug: 'usuarios', label: 'Usuarios y acceso', description: 'Perfiles, roles y permisos de plataforma', source: '12_Cuentas_oficiales_y_roles_institucionales.md', group: 'Operaciones', icon: UsersRound, dataKey: 'official' },
  { slug: 'editor-oficial', label: 'Publicaciones oficiales', description: 'Publicación, revisión y traducción', source: '13_Editor_web_de_publicaciones_oficiales.md', group: 'Contenido', icon: FileBarChart, dataKey: 'official' },
  { slug: 'biblioteca', label: 'Biblioteca multimedia', description: 'Adjuntos, documentos y activos', source: '14_Biblioteca_multimedia_y_documentos.md', group: 'Contenido', icon: BookOpenCheck },
  { slug: 'analitica-usuarios', label: 'Analítica de usuarios', description: 'Crecimiento y retención', source: '18_Analitica_de_usuarios_y_retencion.md', group: 'Analítica', icon: ChartNoAxesCombined },
  { slug: 'analitica-contenido', label: 'Analítica de contenido', description: 'Feed y muro oficial', source: '19_Analitica_de_contenido_y_muro_oficial.md', group: 'Analítica', icon: Activity },
  { slug: 'analitica-chat', label: 'Analítica de chat', description: 'Entrega, lectura y comunidades', source: '20_Analitica_de_chat_y_comunidades.md', group: 'Analítica', icon: MessageSquareWarning },
  { slug: 'analitica-sos', label: 'Analítica SOS', description: 'SLA y respuesta operativa', source: '21_Analitica_SOS_y_respuesta_operativa.md', group: 'Analítica', icon: Gauge },
  { slug: 'monitorizacion', label: 'Monitorización', description: 'Salud técnica y dependencias', source: '23_Monitorizacion_tecnica.md', group: 'Plataforma', icon: MonitorCog },
  { slug: 'auditoria', label: 'Auditoría', description: 'Trazabilidad administrativa', source: '24_Auditoria_y_trazabilidad.md', group: 'Plataforma', icon: Scale },
  { slug: 'soporte', label: 'Soporte', description: 'Incidencias y atención operativa', source: '25_Soporte_e_incidencias.md', group: 'Plataforma', icon: CircleHelp, dataKey: 'support' },
  { slug: 'versiones', label: 'Versiones', description: 'Android, despliegues y compatibilidad', source: '27_Gestion_de_versiones_y_actualizaciones.md', group: 'Plataforma', icon: Workflow, dataKey: 'platform' },
  { slug: 'cumplimiento', label: 'Seguridad y cumplimiento', description: 'Acceso a datos, trazabilidad y evidencias operativas', source: '28_Privacidad_seguridad_y_cumplimiento.md', group: 'Plataforma', icon: ShieldCheck },
]

export const moduleBySlug = (slug?: string) => modules.find((item) => item.slug === slug) || modules[0]
