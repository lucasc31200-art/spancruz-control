# SPANCRUZ CONTROL — Integración segura del Manager

Esta rama contiene **solo los cambios de Supabase**. No se debe conectar todavía a la publicación automática de Cloudflare: los repositorios no contienen el frontend completo aprobado.

## Trabajo aplicado a Supabase

- Migración: autorización de administrador pendiente de confirmación de correo, cuota inicial de 500, contador y funciones habilitadas.
- Función Edge protegida: `spancruz-manager`, con validación de token y permiso administrativo en base de datos. Acciones: `list_agents`, `invite_agent`, `update_agent`.
- No se creó la cuenta principal en Auth y no se ha enviado ninguna invitación hasta ahora.
- `sc_licenses.correos_cupo` define un límite administrativo; el motor de envío debe **hacer cumplir** ese límite mediante operación transaccional antes del lanzamiento. No usar el número de la tabla como prueba de que se bloquean envíos.
- Gmail OAuth y las 36 plantillas aún necesitan integrar y probar el frontend.
- Aún no hay pruebas end-to-end de sesiones reales; no publicar como producción funcional.

## Acceso inicial — paso manual obligatorio

En el Dashboard de **Supabase** del proyecto `spblhzczuqfwffoxuflx`:
1. Authentication > Users > Add user > Invite user, con el correo autorizado `lucasc31200@gmail.com`. No usar contraseñas temporales en el chat.
2. El titular abre el correo e inicia la confirmación/configuración de contraseña. Si la invitación redirige a una URL incorrecta, configurar el Site URL y Redirect URLs en Authentication > URL Configuration antes de reenviarla.
3. Comprobar en SQL, tras confirmar el correo: `select u.email,u.email_confirmed_at,r.role,m.activo from auth.users u join public.user_roles r on r.user_id=u.id join public.sc_members m on m.id=u.id where lower(u.email)='lucasc31200@gmail.com';` — debería ser admin/true.
4. Probar función con JWT real y observar resultados. No usar credenciales de service role en el navegador.

## Publicación

No desplegar el frontend hasta recuperar y respaldar la versión `bf442b7f` de Cloudflare y enlazar el Manager real al sistema autenticado.
