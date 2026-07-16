# Qüata Operations Center

Dashboard React para la gestión operativa, institucional y de gobierno de Qüata. Reutiliza las identidades de Supabase, los perfiles, comunidades, publicaciones, SOS, chat y reportes de la aplicación Android.

## Incluido

- Inicio de sesión con las mismas credenciales de Qüata mediante `quata-auth-bridge`.
- Control de acceso QOC: administradores existentes y roles administrativos extensibles por ámbito.
- Resumen ejecutivo, Centro SOS, mapa operativo, territorios y videowall.
- Moderación de denuncias reales de publicaciones, comentarios, mensajes de chat y perfiles.
- Cuentas oficiales, gestión de usuarios, editor web de publicaciones oficiales y biblioteca multimedia.
- Campañas, soporte, traducción, analítica, monitorización, auditoría, configuración, versiones, cumplimiento y roadmap.
- Tema claro/oscuro, navegación responsive, búsqueda global, estados de carga, error y vacío.

## Desarrollo

```powershell
npm install
npm run dev
```

La aplicación se sirve por defecto en `http://127.0.0.1:4173`. Si el puerto está ocupado, Vite selecciona el siguiente disponible.

La configuración pública usa los valores de `.env.example`. Las claves de servicio, credenciales de base de datos y secretos no se incluyen ni se necesitan en el navegador.

## Supabase

Las migraciones del QOC están en [supabase/migrations](./supabase/migrations):

- `20260716_0001_qoc_operations_center.sql`: RBAC, auditoría, campañas, soporte, traducción, configuración, flags y modelo de lectura QOC.
- `20260716_0002_qoc_editorial_commands.sql`: acciones editoriales para crear o retirar publicaciones oficiales sin alterar el contrato de la aplicación Android.

La interfaz accede únicamente a los RPCs autenticados `qoc_session`, `qoc_module_data` y `qoc_command`. Las tablas QOC no tienen políticas de acceso directo desde navegador.

## Verificación

```powershell
npm run build
$env:QOC_TEST_PASSWORD = '<contraseña de una cuenta administradora>'
node scripts/qoc-web-smoke.cjs
```

El smoke test inicia sesión contra el puente de Qüata y comprueba el acceso QOC y los módulos conectados. Los scripts SQL de `scripts/` realizan validaciones transaccionales y revierten sus cambios.

## Especificación

La carpeta local `instructions/` contiene el material de producto original y está ignorada por Git. El mapeo de los 30 documentos al producto se conserva en [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).
