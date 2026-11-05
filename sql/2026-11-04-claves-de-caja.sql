-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: sección "Claves de caja" (Self check-in)
--   · Cajas de seguridad por propiedad (máximo 2 activas), clave de 4 números
--   · Foto de ubicación (espacio privado "fotos-claves")
--   · Historial permanente y automático de cada cambio
--   · Permisos nuevos (editables en Mantenimiento › Autorizaciones):
--       claves_cambiar      → ver y cambiar claves (todos los roles)
--       claves_administrar  → agregar/editar/archivar propiedades, cajas y fotos
--                             (Operaciones, Ama de llaves, Admin)
--       campana_claves      → aviso (campana y celular) cuando cambia una clave (todos)
--   · Los avisos nunca incluyen la clave (no queda visible en la pantalla bloqueada)
-- Fecha: 2026-11-04 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Permisos
-- ---------------------------------------------------------------------
insert into public.permisos_catalogo (clave, grupo, nombre, orden, fijo) values
  ('claves_cambiar',     'permiso', 'Claves de caja: ver y cambiar las claves', 240, 'admin'),
  ('claves_administrar', 'permiso', 'Claves de caja: agregar, editar y archivar propiedades, cajas y fotos', 250, 'admin'),
  ('campana_claves',     'permiso', 'Campana: aviso cuando se cambia una clave de caja', 260, null)
on conflict (clave) do nothing;

insert into public.permisos_rol (rol, clave, permitido) values
  ('ama_llaves','claves_cambiar',true), ('supervisora','claves_cambiar',true),
  ('operaciones','claves_cambiar',true), ('mucama','claves_cambiar',true),
  ('ama_llaves','claves_administrar',true), ('operaciones','claves_administrar',true),
  ('supervisora','claves_administrar',false), ('mucama','claves_administrar',false),
  ('admin','campana_claves',true), ('ama_llaves','campana_claves',true), ('supervisora','campana_claves',true),
  ('operaciones','campana_claves',true), ('mucama','campana_claves',true)
on conflict (rol, clave) do nothing;

create or replace function public.puede_claves()
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select public.tengo('claves_cambiar') or public.tengo('claves_administrar')
$f$;


-- ---------------------------------------------------------------------
-- 2) Tablas
-- ---------------------------------------------------------------------
create table if not exists public.claves_cajas (
  id bigint generated always as identity primary key,
  propiedad_id bigint not null references public.propiedades(id) on delete cascade,
  nombre text not null check (length(trim(nombre)) between 1 and 60),
  ubicacion text check (ubicacion is null or length(ubicacion) <= 200),
  clave text not null check (clave ~ '^[0-9]{4}$'),
  foto text,
  activa boolean not null default true,
  creado_en timestamptz not null default now(),
  creado_por uuid references public.perfiles(id),
  clave_cambiada_en timestamptz not null default now(),
  clave_cambiada_por uuid references public.perfiles(id),
  actualizado_en timestamptz not null default now()
);
create index if not exists claves_cajas_prop_idx on public.claves_cajas(propiedad_id);

-- Historial: sin relación obligatoria con la caja o la propiedad, para que nunca se pierda
create table if not exists public.claves_historial (
  id bigint generated always as identity primary key,
  caja_id bigint,
  propiedad_id bigint,
  propiedad_nombre text,
  caja_nombre text,
  usuario_id uuid references public.perfiles(id),
  accion text not null check (accion in ('caja_creada','clave_cambiada','caja_editada','foto_agregada',
          'foto_cambiada','foto_quitada','caja_archivada','caja_restaurada','caja_eliminada')),
  valor_anterior text,
  valor_nuevo text,
  motivo text,
  creado_en timestamptz not null default now()
);
create index if not exists claves_hist_caja_idx on public.claves_historial(caja_id, creado_en desc);
create index if not exists claves_hist_prop_idx on public.claves_historial(propiedad_id, creado_en desc);

-- Solo lectura desde la app: todo cambio pasa por las funciones de abajo
alter table public.claves_cajas enable row level security;
alter table public.claves_historial enable row level security;
drop policy if exists claves_cajas_ver on public.claves_cajas;
create policy claves_cajas_ver on public.claves_cajas for select to authenticated using (public.puede_claves());
drop policy if exists claves_historial_ver on public.claves_historial;
create policy claves_historial_ver on public.claves_historial for select to authenticated using (public.puede_claves());
revoke insert, update, delete, truncate on public.claves_cajas, public.claves_historial from anon, authenticated;


-- ---------------------------------------------------------------------
-- 3) Avisos: la campana acepta avisos que no son de un reporte
-- ---------------------------------------------------------------------
alter table public.notificaciones alter column reporte_id drop not null;
alter table public.notificaciones add column if not exists tipo text not null default 'reporte';
alter table public.notificaciones add column if not exists caja_id bigint;
alter table public.notificaciones drop constraint if exists notificaciones_tipo_chk;
alter table public.notificaciones add constraint notificaciones_tipo_chk check (tipo in ('reporte','clave'));


-- ---------------------------------------------------------------------
-- 4) Registro automático de cada cambio (no se puede saltar)
-- ---------------------------------------------------------------------
create or replace function public.tg_claves_historial()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare v_prop text; v_uid uuid := auth.uid();
        v_motivo text := nullif(trim(coalesce(current_setting('claves.motivo', true), '')), '');
begin
  if tg_op = 'DELETE' then
    v_prop := coalesce((select nombre from public.propiedades where id = old.propiedad_id),
                       (select propiedad_nombre from public.claves_historial where caja_id = old.id order by id desc limit 1));
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_anterior)
    values (old.id, old.propiedad_id, v_prop, old.nombre, v_uid, 'caja_eliminada', old.clave);
    return old;
  end if;

  select nombre into v_prop from public.propiedades where id = new.propiedad_id;

  if tg_op = 'INSERT' then
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_nuevo, motivo)
    values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid, 'caja_creada', new.clave, v_motivo);
    if new.foto is not null then
      insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_nuevo)
      values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid, 'foto_agregada', new.foto);
    end if;
    return new;
  end if;

  if new.clave is distinct from old.clave then
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_anterior, valor_nuevo, motivo)
    values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid, 'clave_cambiada', old.clave, new.clave, v_motivo);
  end if;
  if new.nombre is distinct from old.nombre or new.ubicacion is distinct from old.ubicacion then
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_anterior, valor_nuevo)
    values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid, 'caja_editada',
            old.nombre || coalesce(' · ' || old.ubicacion, ''), new.nombre || coalesce(' · ' || new.ubicacion, ''));
  end if;
  if new.foto is distinct from old.foto then
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, valor_anterior, valor_nuevo)
    values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid,
            case when old.foto is null then 'foto_agregada' when new.foto is null then 'foto_quitada' else 'foto_cambiada' end,
            old.foto, new.foto);
  end if;
  if new.activa is distinct from old.activa then
    insert into public.claves_historial(caja_id, propiedad_id, propiedad_nombre, caja_nombre, usuario_id, accion, motivo)
    values (new.id, new.propiedad_id, v_prop, new.nombre, v_uid,
            case when new.activa then 'caja_restaurada' else 'caja_archivada' end, v_motivo);
  end if;
  return new;
end $f$;

drop trigger if exists claves_historial_reg on public.claves_cajas;
create trigger claves_historial_reg after insert or update or delete on public.claves_cajas
  for each row execute function public.tg_claves_historial();

-- Aviso a todos (campana y celular) cuando se cambia una clave o se agrega una caja. Sin la clave.
create or replace function public.tg_claves_notificar()
returns trigger language plpgsql security definer set search_path to 'public' as $f$
declare v_actor text; v_msg text;
begin
  if new.accion not in ('clave_cambiada', 'caja_creada') then return new; end if;
  select nombre into v_actor from public.perfiles where id = new.usuario_id;
  v_msg := case new.accion
             when 'clave_cambiada' then 'Se cambió la clave de ' || coalesce(new.caja_nombre, 'la caja')
             else 'Nueva caja de llaves: ' || coalesce(new.caja_nombre, '') end
           || coalesce(' (' || left(new.motivo, 100) || ')', '')
           || ' — ' || coalesce(v_actor, 'Sistema');
  insert into public.notificaciones(usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo, caja_id)
  select p.id, null, 'Clave de caja', new.propiedad_nombre, v_msg, 'clave', new.caja_id
    from public.perfiles p
   where p.activo
     and p.id is distinct from new.usuario_id
     and public.permiso_de(p.id, 'campana_claves')
     and (public.permiso_de(p.id, 'claves_cambiar') or public.permiso_de(p.id, 'claves_administrar'));
  return new;
end $f$;

drop trigger if exists claves_notificar on public.claves_historial;
create trigger claves_notificar after insert on public.claves_historial
  for each row execute function public.tg_claves_notificar();


-- ---------------------------------------------------------------------
-- 5) Funciones que usa la página
-- ---------------------------------------------------------------------
-- Cambiar la clave (todos los que tienen el permiso)
create or replace function public.claves_cambiar(p_caja bigint, p_clave text, p_motivo text default null)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare c public.claves_cajas;
begin
  if not public.puede_claves() then raise exception 'Su usuario no puede cambiar claves de caja'; end if;
  p_clave := trim(coalesce(p_clave, ''));
  if p_clave !~ '^[0-9]{4}$' then raise exception 'La clave debe tener exactamente 4 números'; end if;
  select * into c from public.claves_cajas where id = p_caja for update;
  if not found then raise exception 'La caja no existe'; end if;
  if not c.activa then raise exception 'Esta caja está archivada'; end if;
  if c.clave = p_clave then raise exception 'La clave nueva es igual a la actual'; end if;
  perform set_config('claves.motivo', left(coalesce(trim(p_motivo), ''), 200), true);
  update public.claves_cajas
     set clave = p_clave, clave_cambiada_en = now(), clave_cambiada_por = auth.uid(), actualizado_en = now()
   where id = p_caja;
  perform set_config('claves.motivo', '', true);
end $f$;

-- Agregar una caja (p_id vacío) o editar su nombre/ubicación
create or replace function public.claves_guardar_caja(p_id bigint, p_propiedad bigint, p_nombre text,
                                                       p_ubicacion text default null, p_clave text default null)
returns bigint language plpgsql security definer set search_path to 'public' as $f$
declare v_id bigint; v_max int := 2; c public.claves_cajas;
begin
  if not public.tengo('claves_administrar') then
    raise exception 'Solo Operaciones, Ama de llaves y Administración pueden agregar o editar cajas';
  end if;
  p_nombre := trim(coalesce(p_nombre, ''));
  p_ubicacion := nullif(trim(coalesce(p_ubicacion, '')), '');
  if p_nombre = '' then raise exception 'Escriba el nombre o ubicación de la caja (por ejemplo: Entrada principal)'; end if;
  if length(p_nombre) > 60 then raise exception 'El nombre de la caja es muy largo (máximo 60 letras)'; end if;

  if p_id is null then
    if not exists (select 1 from public.propiedades where id = p_propiedad) then
      raise exception 'Seleccione una propiedad válida';
    end if;
    p_clave := trim(coalesce(p_clave, ''));
    if p_clave !~ '^[0-9]{4}$' then raise exception 'La clave debe tener exactamente 4 números'; end if;
    perform 1 from public.propiedades where id = p_propiedad for update;
    if (select count(*) from public.claves_cajas where propiedad_id = p_propiedad and activa) >= v_max then
      raise exception 'Esta propiedad ya tiene % cajas activas', v_max;
    end if;
    if exists (select 1 from public.claves_cajas where propiedad_id = p_propiedad and activa and lower(nombre) = lower(p_nombre)) then
      raise exception 'Esta propiedad ya tiene una caja con ese nombre';
    end if;
    insert into public.claves_cajas(propiedad_id, nombre, ubicacion, clave, creado_por, clave_cambiada_por)
    values (p_propiedad, p_nombre, p_ubicacion, p_clave, auth.uid(), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  select * into c from public.claves_cajas where id = p_id for update;
  if not found then raise exception 'La caja no existe'; end if;
  if exists (select 1 from public.claves_cajas where propiedad_id = c.propiedad_id and activa and id <> p_id
             and lower(nombre) = lower(p_nombre)) then
    raise exception 'Esta propiedad ya tiene una caja con ese nombre';
  end if;
  update public.claves_cajas set nombre = p_nombre, ubicacion = p_ubicacion, actualizado_en = now() where id = p_id;
  return p_id;
end $f$;

-- Poner, cambiar o quitar (p_path vacío) la foto de ubicación
create or replace function public.claves_foto(p_caja bigint, p_path text)
returns void language plpgsql security definer set search_path to 'public' as $f$
begin
  if not public.tengo('claves_administrar') then
    raise exception 'Solo Operaciones, Ama de llaves y Administración pueden cambiar la foto';
  end if;
  p_path := nullif(trim(coalesce(p_path, '')), '');
  if p_path is not null and (p_path !~ '^cajas/[0-9]+/[A-Za-z0-9._-]+$'
      or not exists (select 1 from storage.objects where bucket_id = 'fotos-claves' and name = p_path)) then
    raise exception 'La foto no se subió correctamente. Intente de nuevo';
  end if;
  update public.claves_cajas set foto = p_path, actualizado_en = now() where id = p_caja;
  if not found then raise exception 'La caja no existe'; end if;
end $f$;

-- Archivar o restaurar una caja (no se borra: conserva su historial)
create or replace function public.claves_archivar(p_caja bigint, p_activa boolean, p_motivo text default null)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare c public.claves_cajas; v_max int := 2;
begin
  if not public.tengo('claves_administrar') then
    raise exception 'Solo Operaciones, Ama de llaves y Administración pueden archivar cajas';
  end if;
  select * into c from public.claves_cajas where id = p_caja for update;
  if not found then raise exception 'La caja no existe'; end if;
  if c.activa = p_activa then return; end if;
  if p_activa then
    perform 1 from public.propiedades where id = c.propiedad_id for update;
    if (select count(*) from public.claves_cajas where propiedad_id = c.propiedad_id and activa) >= v_max then
      raise exception 'Esta propiedad ya tiene % cajas activas. Archive una antes de restaurar esta', v_max;
    end if;
  end if;
  perform set_config('claves.motivo', left(coalesce(trim(p_motivo), ''), 200), true);
  update public.claves_cajas set activa = p_activa, actualizado_en = now() where id = p_caja;
  perform set_config('claves.motivo', '', true);
end $f$;

-- Quitar una propiedad de la sección: archiva todas sus cajas
create or replace function public.claves_archivar_propiedad(p_propiedad bigint, p_motivo text default null)
returns int language plpgsql security definer set search_path to 'public' as $f$
declare n int;
begin
  if not public.tengo('claves_administrar') then
    raise exception 'Solo Operaciones, Ama de llaves y Administración pueden quitar propiedades de la sección';
  end if;
  perform set_config('claves.motivo', left(coalesce(trim(p_motivo), ''), 200), true);
  update public.claves_cajas set activa = false, actualizado_en = now() where propiedad_id = p_propiedad and activa;
  get diagnostics n = row_count;
  perform set_config('claves.motivo', '', true);
  return n;
end $f$;

revoke execute on function public.puede_claves() from public, anon;
revoke execute on function public.claves_cambiar(bigint, text, text) from public, anon;
revoke execute on function public.claves_guardar_caja(bigint, bigint, text, text, text) from public, anon;
revoke execute on function public.claves_foto(bigint, text) from public, anon;
revoke execute on function public.claves_archivar(bigint, boolean, text) from public, anon;
revoke execute on function public.claves_archivar_propiedad(bigint, text) from public, anon;
revoke execute on function public.tg_claves_historial() from public, anon, authenticated;
revoke execute on function public.tg_claves_notificar() from public, anon, authenticated;
grant execute on function public.puede_claves() to authenticated;
grant execute on function public.claves_cambiar(bigint, text, text) to authenticated;
grant execute on function public.claves_guardar_caja(bigint, bigint, text, text, text) to authenticated;
grant execute on function public.claves_foto(bigint, text) to authenticated;
grant execute on function public.claves_archivar(bigint, boolean, text) to authenticated;
grant execute on function public.claves_archivar_propiedad(bigint, text) to authenticated;


-- ---------------------------------------------------------------------
-- 6) Fotos de ubicación: espacio privado, máximo 1 MB por foto
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos-claves', 'fotos-claves', false, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists claves_fotos_subir on storage.objects;
create policy claves_fotos_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos-claves' and public.tengo('claves_administrar'));
drop policy if exists claves_fotos_ver on storage.objects;
create policy claves_fotos_ver on storage.objects for select to authenticated
  using (bucket_id = 'fotos-claves' and public.puede_claves());


-- ---------------------------------------------------------------------
-- 7) Cambios en tiempo real (la lista se actualiza sola en todos los celulares)
-- ---------------------------------------------------------------------
do $f$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'claves_cajas') then
    alter publication supabase_realtime add table public.claves_cajas;
  end if;
end $f$;

notify pgrst, 'reload schema';
