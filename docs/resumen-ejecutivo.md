# Contrato del resumen ejecutivo

El resumen ejecutivo es una vista de situación, no una segunda versión de cada módulo. Cada bloque debe responder a una pregunta operativa en pocos segundos y enlazar a la sección que contiene el detalle.

| Área | Señal compacta | Contexto útil | Profundizar |
| --- | --- | --- | --- |
| Centro SOS | Alertas durante las últimas 24 horas | Última alerta y alertas con ubicación válida | Centro SOS |
| Moderación | Casos pendientes o en revisión | Fecha y tipo del caso más reciente | Moderación |
| Usuarios y acceso | Perfiles, altas y actividad reciente | Administradores y cuentas oficiales | Usuarios y acceso |
| Gestión territorial | Comunidades activas | Miembros y actividad comunitaria | Gestión territorial |
| Publicaciones oficiales | Publicaciones visibles y creadas recientemente | Última publicación publicada | Publicaciones oficiales |
| Biblioteca / chat | Mensajes recientes y entrega confirmada | Adjuntos creados recientemente | Analítica de chat / Biblioteca multimedia |
| Analítica | Serie compacta de crecimiento de usuarios | Catorce puntos como máximo | Analítica de usuarios |
| Monitorización | Estado de base de datos, Realtime, Firebase y servicios externos | Snapshot técnico y errores push recientes | Monitorización |
| Versiones | Versión y version code de producción | Momento de la última sincronización con Google Play | Versiones |
| Seguridad | Cobertura RLS y número de excepciones | Tablas pendientes de endurecimiento | Seguridad y cumplimiento |
| Auditoría | Últimas acciones administrativas | Actor, entidad y fecha | Auditoría |

## Reglas de diseño

- No se muestran secretos, datos personales innecesarios ni métricas sin fuente verificable.
- Una alerta se muestra solo si permite actuar: SOS reciente, moderación abierta, error de servicio, entrega pendiente o excepción RLS.
- Las series se limitan a un número fijo de puntos para que sigan siendo legibles a medida que crece el histórico.
- Cada tarjeta conserva una única acción de navegación; las decisiones y operaciones se realizan en el módulo especializado.
