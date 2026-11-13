import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const ALLOWED_ORIGIN = "https://frosty-base-cbf6.lucasc31200.workers.dev";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

function readKey(name: string, legacy: string): string {
  try {
    const value = JSON.parse(Deno.env.get(name) ?? "{}");
    if (typeof value.default === "string") return value.default;
  } catch { /* legacy key fallback */ }
  return Deno.env.get(legacy) ?? "";
}

const SECRET = readKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const admin = SUPABASE_URL && SECRET
  ? createClient(SUPABASE_URL, SECRET, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  : null;

const emailValid = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const uuidValid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isoDateValid = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(new Date(v + "T12:00:00Z").getTime());
const quotaValid = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000000;
const FEATURE_KEYS = ["plantillas", "destinatarios", "campanas", "gmail"] as const;
function validateFeatures(input: unknown): Record<string, boolean> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  if (Object.keys(o).some(k => !FEATURE_KEYS.includes(k as typeof FEATURE_KEYS[number]))) return null;
  if (Object.values(o).some(v => typeof v !== "boolean")) return null;
  return o as Record<string, boolean>;
}

function reply(payload: unknown, status = 200, origin = ""): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      ...(origin === ALLOWED_ORIGIN ? { "Access-Control-Allow-Origin": ALLOWED_ORIGIN } : {}),
    },
  });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";
  if (origin && origin !== ALLOWED_ORIGIN) return reply({ error: "Origen no permitido" }, 403, origin);
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Max-Age": "3600",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST") return reply({ error: "Método no permitido" }, 405, origin);
  if (!admin) return reply({ error: "Función sin configuración de servidor" }, 503, origin);

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) return reply({ error: "Inicia sesión primero" }, 401, origin);

  try {
    const { data: auth, error: authError } = await admin.auth.getUser(match[1]);
    const user = auth?.user;
    if (authError || !user || !user.email_confirmed_at || user.is_anonymous) {
      return reply({ error: "Sesión no válida o correo sin confirmar" }, 401, origin);
    }

    const [{ data: role, error: roleError }, { data: member, error: memberError }] = await Promise.all([
      admin.from("user_roles").select("role").eq("user_id", user.id).maybeSingle(),
      admin.from("sc_members").select("activo").eq("id", user.id).maybeSingle(),
    ]);
    if (roleError || memberError) return reply({ error: "No se pudo validar el permiso" }, 503, origin);
    if (role?.role !== "admin" || member?.activo !== true) {
      return reply({ error: "Solo el administrador puede realizar esta acción" }, 403, origin);
    }

    const bodyText = await request.text();
    if (bodyText.length > 16000) return reply({ error: "Solicitud demasiado grande" }, 413, origin);
    let body: Record<string, unknown>;
    try { body = JSON.parse(bodyText); } catch { return reply({ error: "JSON inválido" }, 400, origin); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply({ error: "Datos inválidos" }, 400, origin);
    }

    if (body.action === "list_agents") {
      const page = typeof body.page === "number" && Number.isInteger(body.page) && body.page >= 0 && body.page <= 1000
        ? body.page : 0;
      const { data: members, error } = await admin.from("sc_members")
        .select("id,email,nombre,activo,created_at")
        .order("created_at", { ascending: false }).range(page * 50, page * 50 + 49);
      if (error) return reply({ error: "No se pudieron consultar los agentes" }, 500, origin);
      const ids = (members ?? []).map((m: { id: string }) => m.id);
      const licenses = ids.length
        ? await admin.from("sc_licenses")
          .select("usuario_id,correos,correos_hasta,correos_cupo,correos_enviados,funciones")
          .in("usuario_id", ids)
        : { data: [], error: null };
      if (licenses.error) return reply({ error: "No se pudieron consultar las licencias" }, 500, origin);
      const byId = new Map((licenses.data ?? []).map((l: { usuario_id: string }) => [l.usuario_id, l]));
      return reply({
        agents: (members ?? []).map((m: { id: string }) => ({
          ...m, license: byId.get(m.id) ?? null,
        })),
        page,
      }, 200, origin);
    }

    if (body.action === "invite_agent") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!emailValid(email) || name.length < 1 || name.length > 120) {
        return reply({ error: "Nombre o correo inválidos" }, 400, origin);
      }
      if (email === "lucasc31200@gmail.com") {
        return reply({ error: "La cuenta principal no puede ser creada como agente" }, 409, origin);
      }
      const { data: invitation, error: inviteError } =
        await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: name } });
      if (inviteError || !invitation?.user?.id) {
        return reply({ error: "No se pudo enviar la invitación; revisa si ya existe la cuenta y la configuración de correo" }, 409, origin);
      }
      const id = invitation.user.id;
      const [{ error: memberUpdateError }, { error: licenseUpdateError }] = await Promise.all([
        admin.from("sc_members").update({ nombre: name, activo: false }).eq("id", id),
        admin.from("sc_licenses").update({
          correos: false, correos_cupo: 500, correos_enviados: 0,
          funciones: { plantillas: true, destinatarios: true, campanas: false, gmail: false },
        }).eq("usuario_id", id),
      ]);
      if (memberUpdateError || licenseUpdateError) {
        return reply({ error: "Invitación emitida, pero falta revisar la configuración del agente" }, 500, origin);
      }
      await admin.from("sc_activity").insert({
        usuario_id: id, actor_id: user.id, entidad: "agente",
        accion: "invitado", registro_id: id,
      });
      return reply({ invited: true, id, email, active: false, needs_activation: true }, 201, origin);
    }

    if (body.action === "update_agent") {
      if (!uuidValid(body.user_id)) return reply({ error: "Identificador inválido" }, 400, origin);
      const id = body.user_id;
      if (id === user.id) return reply({ error: "Esta acción no permite modificar el administrador principal" }, 403, origin);
      const { data: otherRole } = await admin.from("user_roles").select("role").eq("user_id", id).maybeSingle();
      if (otherRole?.role === "admin") return reply({ error: "No se modifican otras cuentas administrativas aquí" }, 403, origin);
      const { data: target } = await admin.from("sc_members").select("id").eq("id", id).maybeSingle();
      if (!target) return reply({ error: "Agente no encontrado" }, 404, origin);

      const memberChanges: Record<string, unknown> = {};
      const licenseChanges: Record<string, unknown> = {};
      if (typeof body.name === "string") {
        if (!body.name.trim() || body.name.trim().length > 120) return reply({ error: "Nombre inválido" }, 400, origin);
        memberChanges.nombre = body.name.trim();
      }
      if (typeof body.active === "boolean") memberChanges.activo = body.active;
      if (typeof body.emails_enabled === "boolean") licenseChanges.correos = body.emails_enabled;
      if (body.email_limit !== undefined) {
        if (!quotaValid(body.email_limit)) return reply({ error: "Cupo inválido" }, 400, origin);
        licenseChanges.correos_cupo = body.email_limit;
      }
      if (body.expires_on !== undefined) {
        if (body.expires_on !== null && !isoDateValid(body.expires_on)) {
          return reply({ error: "Fecha inválida" }, 400, origin);
        }
        licenseChanges.correos_hasta = body.expires_on;
      }
      if (body.features !== undefined) {
        const features = validateFeatures(body.features);
        if (!features) return reply({ error: "Funciones inválidas" }, 400, origin);
        // Preserve current toggles when only some features are provided.
        const { data: current, error: currentError } = await admin.from("sc_licenses")
          .select("funciones").eq("usuario_id", id).single();
        if (currentError) return reply({ error: "Licencia inexistente" }, 404, origin);
        licenseChanges.funciones = { ...current.funciones, ...features };
      }
      if (Object.keys(memberChanges).length === 0 && Object.keys(licenseChanges).length === 0) {
        return reply({ error: "Indica algún cambio" }, 400, origin);
      }
      if (Object.keys(memberChanges).length > 0) {
        const { error } = await admin.from("sc_members").update(memberChanges).eq("id", id);
        if (error) return reply({ error: "No se pudo actualizar el agente" }, 500, origin);
      }
      if (Object.keys(licenseChanges).length > 0) {
        const { error } = await admin.from("sc_licenses").update(licenseChanges).eq("usuario_id", id);
        if (error) return reply({ error: "No se pudo actualizar la licencia" }, 500, origin);
      }
      await admin.from("sc_activity").insert({
        usuario_id: id, actor_id: user.id, entidad: "agente",
        accion: "actualizado", registro_id: id,
      });
      return reply({ updated: true, user_id: id }, 200, origin);
    }

    return reply({ error: "Acción no admitida" }, 400, origin);
  } catch {
    return reply({ error: "Error interno del Manager" }, 500, origin);
  }
});
