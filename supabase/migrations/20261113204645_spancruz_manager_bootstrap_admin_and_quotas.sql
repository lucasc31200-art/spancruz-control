-- Sin credenciales. Migración aplicada a Supabase el 13-11-2026.
-- El administrador se concede una sola vez a la cuenta que confirme el correo aprobado.
create table if not exists spancruz_private.manager_admin_invites (
  email text primary key,
  claimed_user_id uuid unique references auth.users(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
revoke all on spancruz_private.manager_admin_invites from public, anon, authenticated;
insert into spancruz_private.manager_admin_invites (email)
values ('lucasc31200@gmail.com')
on conflict (email) do nothing;

create or replace function spancruz_private.promote_confirmed_manager()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  approved_email text;
begin
  if new.email_confirmed_at is null or new.email is null then
    return new;
  end if;

  update spancruz_private.manager_admin_invites i
  set claimed_user_id = new.id,
      claimed_at = now()
  where i.email = lower(new.email)
    and i.claimed_user_id is null
  returning i.email into approved_email;

  if approved_email is not null then
    update public.user_roles
       set role = 'admin'
     where user_id = new.id;
    if not found then
      raise exception 'SPANCRUZ admin grant failed: user role missing';
    end if;

    update public.sc_members
       set activo = true
     where id = new.id;
    if not found then
      raise exception 'SPANCRUZ admin grant failed: member missing';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function spancruz_private.promote_confirmed_manager() from public, anon, authenticated;

drop trigger if exists spancruz_z_admin_bootstrap on auth.users;
create trigger spancruz_z_admin_bootstrap
after insert or update of email, email_confirmed_at on auth.users
for each row
execute function spancruz_private.promote_confirmed_manager();

alter table public.sc_licenses
  add column if not exists correos_cupo integer not null default 500
     check (correos_cupo between 0 and 1000000);
alter table public.sc_licenses
  add column if not exists correos_enviados integer not null default 0
     check (correos_enviados >= 0);
alter table public.sc_licenses
  add column if not exists funciones jsonb not null
  default '{"plantillas":true,"destinatarios":true,"campanas":false,"gmail":false}'::jsonb
  check (jsonb_typeof(funciones) = 'object');
