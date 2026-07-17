# Qüata Operations Center

Panel web interno para la operación, moderación y gestión editorial de Qüata. Comparte las identidades, perfiles, comunidades, conversaciones, publicaciones y recursos de la aplicación Android mediante Supabase, sin exponer credenciales administrativas en el navegador.

## Funcionalidad

### Acceso y cuenta

- Inicio de sesión con las mismas credenciales telefónicas que Qüata, a través de `quata-auth-bridge`.
- Recuperación de contraseña mediante la pregunta de seguridad existente.
- Sesión web de 15 minutos de inactividad, renovada con cada interacción y compatible con una sesión simultánea en la app Android.
- Acceso diferenciado para administradores y cuentas oficiales: las cuentas oficiales pueden entrar para gestionar exclusivamente sus propias publicaciones.
- Panel **Mi cuenta**: nombre, barrio, teléfono, imagen de perfil con recorte fijo 1:1, contraseña y pregunta/respuesta de seguridad.

### Operaciones

- **Resumen ejecutivo** con indicadores compactos de SOS, moderación, actividad, usuarios, contenido, servicios, versiones y seguridad; cada bloque enlaza a su sección operativa.
- **Centro SOS** basado en los mensajes SOS reales de las conversaciones de chat: histórico de las últimas 50 alertas, estados activos, agrupación geográfica, mapa navegable, zoom contextual, detalle individual, enlace a Google Maps y lectura del hilo completo.
- El visor de hilos SOS interpreta los shortcodes de emergencia y permite abrir adjuntos de imagen, vídeo, audio y documentos.
- **Gestión territorial** con comunidades y barrios, búsqueda, filtros, paginación y acceso directo a los usuarios de cada barrio.
- **Usuarios y acceso** con búsqueda, filtros territoriales y por tipo de cuenta, orden de perfiles verificados, métricas reales de seguidores/siguiendo y controles de administrador/cuenta oficial para operadores autorizados.

### Moderación y contenido

- Cola de moderación de reportes reales de publicaciones del feed, publicaciones oficiales, comentarios y mensajes de chat, incluidos sus adjuntos.
- Búsqueda, filtros, paginación, políticas de moderación y un panel de caso con una vista previa adaptada a cada tipo de contenido.
- Acciones auditables para descartar, marcar en revisión o retirar contenido. Las respuestas de comentarios retirados se preservan mediante marcadores `[DELETED]` para mantener la jerarquía.
- Las vistas previas abren multimedia en una pestaña y permiten leer los textos completos, incluido el HTML enriquecido del muro oficial.
- **Biblioteca multimedia** con pestañas para adjuntos de chat, imágenes de publicaciones y vídeos de publicaciones; incorpora miniaturas, reproducción/visualización, filtros, búsqueda, paginación y cálculo de tamaño al cargar los recursos.

### Publicaciones oficiales

- Directorio de cuentas oficiales y listado editorial agrupado: una fila por publicación aunque tenga variantes de idioma.
- Filtros por idioma, búsqueda, actualización y eliminación atómica de todas las traducciones de una publicación.
- Editor oficial completo, tanto para administradores como para la cuenta oficial propietaria:
  - Tipo de publicación, título, resumen, enlace localizado de “Leer más”, enlace externo y publicaciones con o sin multimedia.
  - Editor de bloques enriquecidos con encabezados, formato de texto, listas, tareas, citas, avisos informativos y reordenación de bloques.
  - Vista previa en tiempo real fiel al muro oficial de Android.
  - Generación y edición de variantes en español, inglés y francés mediante DeepL.
  - Flujo rápido y avanzado compatible con el modelo de publicaciones de la app.
- Editor multimedia web para imágenes y vídeos: recorte, rotación, volteo, silencio, relación 9:16 y línea temporal de vídeo con rango máximo de 90 segundos. La transformación usa MediaBunny y los vídeos se publican mediante el mismo almacenamiento WordPress usado por Qüata.

### Analítica, plataforma y cumplimiento

- Cuadros de **analítica de usuarios, contenido, chat y SOS** alimentados por métricas reales de Supabase.
- **Monitorización** de Supabase, consultas, Realtime, capacidad, mantenimiento, bloqueos, WordPress multimedia y uso de DeepL. Los tiempos acumulados se presentan en unidades legibles.
- **Auditoría** paginada, filtrable y buscable de operaciones del QOC.
- **Versiones** conectada a Google Play: tracks, versiones, notas, distribución y Android vitals. Los datos se almacenan en caché en Supabase y se refrescan dos veces al día.
- **Privacidad y cumplimiento** enfocado en señales operativas de seguridad, cobertura RLS y mantenimiento. El endurecimiento integral de RLS queda planificado como una fase separada.

## Arquitectura

- React 19, TypeScript y Vite.
- Supabase Auth, PostgREST, Realtime, Storage, RPC y Edge Functions.
- React Query, React Router, Recharts, Leaflet, Lucide y MediaBunny.
- WordPress como almacenamiento de vídeo de publicaciones, igual que la aplicación Android.
- Google Play Android Developer API y Google Play Developer Reporting API para las métricas de distribución.

## Edge Functions

Las funciones propias del dashboard están en [supabase/functions](./supabase/functions):

- `qoc-account`: lectura y actualización segura de la cuenta del operador, incluida la imagen de perfil.
- `qoc-deepl-translate`: traducción editorial con DeepL.
- `qoc-google-play`: sincronización de datos de Google Play hacia la caché de Supabase.
- `qoc-monitoring-probe`: sondas de Supabase, WordPress y DeepL.

La autenticación y recuperación de contraseña utilizan también la función compartida `quata-auth-bridge` del proyecto Android.

## Base de datos

Las migraciones están en [supabase/migrations](./supabase/migrations). Cubren el modelo del QOC, permisos de RPC, analítica, SOS, territorios, moderación, perfiles oficiales, publicaciones multilingües, biblioteca multimedia, monitorización, auditoría, caché de Google Play, cumplimiento y resumen ejecutivo.

La interfaz consume RPC y Edge Functions autenticadas. Las operaciones sensibles se validan en backend y dejan rastro de auditoría. No se incluyen en el repositorio contraseñas de PostgreSQL, claves de servicios ni credenciales de proveedores externos.

## Desarrollo local

1. Instala dependencias:

   ```powershell
   npm install
   ```

2. Crea `.env` a partir de `.env.example` con la URL pública y la clave anónima de Supabase.

3. Inicia el servidor:

   ```powershell
   npm run dev -- --port 4174
   ```

4. Abre `http://127.0.0.1:4174/`.

Para generar producción:

```powershell
npm run build
```

## Verificación

```powershell
npm run build
$env:QOC_TEST_PASSWORD = '<contraseña de una cuenta autorizada>'
node scripts/qoc-web-smoke.cjs
```

El smoke test inicia sesión contra el puente de Qüata y comprueba el acceso a los módulos. Los scripts de validación SQL son transaccionales cuando procede y no deben contener secretos en texto plano.

## Alcance pendiente

- La revisión y endurecimiento completo de las políticas RLS se realizará en una fase posterior, con validación de compatibilidad para la app Android y las versiones legacy.
- Las sondas y sincronizaciones requieren que los secretos de proveedores estén configurados exclusivamente en Supabase Edge Functions o en el entorno de despliegue, nunca en variables `VITE_`.

## Material de producto

La carpeta local `instructions/` contiene el material de producto original y está ignorada por Git. El mapeo de sus documentos de implementación se conserva en [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
