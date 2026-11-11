-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: Ocupación — bitácora, aviso de "Lista", alertas de ingreso y cierre diario
--   · ocupacion_dia: quién de Operaciones creó el tablero, cuándo se archivó y las alertas enviadas
--   · Aviso a recepción (permiso aviso_ingreso_lista → Operaciones) cuando una propiedad que
--     ENTRA hoy queda marcada como Lista
--   · Alertas a todos (permiso alerta_ingresos) a las 14:00, 14:30 y 15:00 si hay propiedades
--     que entran hoy y no están Listas (hora de ingreso: 15:00)
--   · 20:15: el tablero del día se archiva y queda en solo lectura (nadie puede editarlo)
--   Horarios de Costa Rica (UTC-6, sin horario de verano) → pg_cron trabaja en UTC
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================

-- 1) Permisos -----------------------------------------------------------
insert into public.permisos_catalogo (clave, grupo, nombre, orden, fijo) values
  ('aviso_ingreso_lista', 'permiso', 'Ocupación: aviso cuando una propiedad que entra hoy queda Lista', 300, null),
  ('alerta_ingresos',     'permiso', 'Ocupación: alertas de 14:00, 14:30 y 15:00 si hay ingresos que no están Listos', 310, null)
on conflict (clave) do nothing;
insert into public.permisos_rol (rol, clave, permitido) values
  ('admin','aviso_ingreso_lista',false), ('ama_llaves','aviso_ingreso_lista',false), ('supervisora','aviso_ingreso_lista',false),
  ('operaciones','aviso_ingreso_lista',true), ('mucama','aviso_ingreso_lista',false),
  ('admin','alerta_ingresos',true), ('ama_llaves','alerta_ingresos',true), ('supervisora','alerta_ingresos',true),
  ('operaciones','alerta_ingresos',true), ('mucama','alerta_ingresos',true)
on conflict (rol, clave) do nothing;

-- 2) Datos del día ------------------------------------------------------
create table if not exists public.ocupacion_dia (
  fecha date primary key,
  creado_por uuid references public.perfiles(id),
  creado_en timestamptz,
  archivado_en timestamptz,
  resumen jsonb,
  alerta_1400 timestamptz,
  alerta_1430 timestamptz,
  alerta_1500 timestamptz
);
alter table public.ocupacion_dia enable row level security;
drop policy if exists ocupacion_dia_ver on public.ocupacion_dia;
create policy ocupacion_dia_ver on public.ocupacion_dia for select to authenticated using (public.puede_ocupacion());
revoke insert, update, delete, truncate on public.ocupacion_dia from anon, authenticated;

alter table public.ocupacion_historial drop constraint if exists ocupacion_historial_tipo_check;
alter table public.ocupacion_historial add constraint ocupacion_historial_tipo_check
  check (tipo in ('tablero','limpieza','copia','creado','archivo','aviso','alerta'));

alter table public.notificaciones drop constraint if exists notificaciones_tipo_chk;
alter table public.notificaciones add constraint notificaciones_tipo_chk check (tipo in ('reporte','clave','ocupacion'));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ocupacion_dia') then
    alter publication supabase_realtime add table public.ocupacion_dia;
  end if;
end $$;

-- 3) ¿El tablero de ese día ya está cerrado? -----------------------------
--    Días anteriores, o el día de hoy desde las 20:15, o si ya se archivó
create or replace function public.ocupacion_cerrada(p_fecha date)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select p_fecha < public.ocupacion_hoy()
      or (p_fecha = public.ocupacion_hoy() and (now() at time zone 'America/Costa_Rica')::time >= time '20:15')
      or exists (select 1 from public.ocupacion_dia d where d.fecha = p_fecha and d.archivado_en is not null)
$f$;

-- Marca quién de Operaciones creó el tablero del día (la primera vez que se llena)
create or replace function public.ocupacion_marcar_creador(p_fecha date)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_n int;
begin
  insert into public.ocupacion_dia (fecha, creado_por, creado_en) values (p_fecha, auth.uid(), now())
  on conflict (fecha) do update set creado_por = excluded.creado_por, creado_en = excluded.creado_en
    where public.ocupacion_dia.creado_por is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.ocupacion_historial (fecha, usuario_id, tipo, detalle) values (p_fecha, auth.uid(), 'creado', 'Creó el tablero del día');
  end if;
end $f$;

-- 4) Guardar (Operaciones) — ahora respeta el cierre y registra al creador --------------
create or replace function public.ocupacion_guardar(p_fecha date, p_propiedad bigint, p_estado text, p_entrada text,
                                                    p_noches integer, p_pax integer, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_det text[] := '{}'; v_prop text;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el tablero de ocupación'; end if;
  if public.ocupacion_cerrada(p_fecha) then raise exception 'Este tablero ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  select nombre into v_prop from public.propiedades where id = p_propiedad;
  if v_prop is null then raise exception 'La propiedad no existe'; end if;
  p_nota := nullif(trim(coalesce(p_nota, '')), '');
  select * into v_old from public.ocupacion where fecha = p_fecha and propiedad_id = p_propiedad;

  if coalesce(v_old.estado, '-') is distinct from p_estado then v_det := v_det || ('Estado: ' || coalesce(v_old.estado, '-') || ' → ' || p_estado); end if;
  if coalesce(v_old.entrada, '-') is distinct from p_entrada then v_det := v_det || ('Entrada: ' || coalesce(v_old.entrada, '-') || ' → ' || p_entrada); end if;
  if v_old.noches is distinct from p_noches then v_det := v_det || ('Noches: ' || coalesce(v_old.noches::text, '—') || ' → ' || coalesce(p_noches::text, '—')); end if;
  if v_old.pax is distinct from p_pax then v_det := v_det || ('Pax: ' || coalesce(v_old.pax::text, '—') || ' → ' || coalesce(p_pax::text, '—')); end if;
  if v_old.nota is distinct from p_nota then v_det := v_det || ('Nota: ' || coalesce(p_nota, '(borrada)')); end if;
  if array_length(v_det, 1) is null then return; end if;

  perform public.ocupacion_marcar_creador(p_fecha);
  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, nota, actualizado_por, actualizado_en)
  values (p_fecha, p_propiedad, p_estado, p_entrada, p_noches, p_pax, p_nota, auth.uid(), now())
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, nota = excluded.nota, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'tablero', array_to_string(v_det, ' · '));
end $f$;

-- 5) Estado de limpieza — respeta el cierre y avisa a recepción cuando un ingreso queda Listo ---
create or replace function public.ocupacion_limpieza(p_fecha date, p_propiedad bigint, p_estado text, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_new public.ocupacion; v_prop text; v_actor text; v_n int;
begin
  if not public.tengo('ocupacion_limpieza') then raise exception 'No tiene permiso para marcar el estado de limpieza'; end if;
  if public.ocupacion_cerrada(p_fecha) then raise exception 'Este tablero ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  if p_fecha <> public.ocupacion_hoy() and coalesce(public.mi_rol(), '') <> 'admin' then
    raise exception 'El estado de limpieza solo se puede marcar en el día de hoy';
  end if;
  select nombre into v_prop from public.propiedades where id = p_propiedad;
  if v_prop is null then raise exception 'La propiedad no existe'; end if;
  p_nota := nullif(trim(coalesce(p_nota, '')), '');
  select * into v_old from public.ocupacion where fecha = p_fecha and propiedad_id = p_propiedad;
  if v_old.limpieza is not distinct from p_estado and v_old.limpieza_nota is not distinct from p_nota then return; end if;

  insert into public.ocupacion as o (fecha, propiedad_id, limpieza, limpieza_nota, limpieza_por, limpieza_en)
  values (p_fecha, p_propiedad, p_estado, p_nota, auth.uid(), now())
  on conflict (fecha, propiedad_id) do update set limpieza = excluded.limpieza, limpieza_nota = excluded.limpieza_nota,
    limpieza_por = excluded.limpieza_por, limpieza_en = excluded.limpieza_en
  returning * into v_new;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'limpieza',
          'Limpieza: ' || coalesce(initcap(v_old.limpieza), 'Sin marcar') || ' → ' || coalesce(initcap(p_estado), 'Sin marcar')
          || coalesce(' · ' || p_nota, ''));

  -- Aviso a recepción: la propiedad entra hoy y ya quedó Lista
  if p_estado = 'lista' and v_old.limpieza is distinct from 'lista' and v_new.entrada = 'ENTRA'
     and p_fecha = public.ocupacion_hoy() then
    select nombre into v_actor from public.perfiles where id = auth.uid();
    insert into public.notificaciones (usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo)
    select p.id, null, '✅ Lista para el ingreso', v_prop,
           v_prop || ' ya está lista para el ingreso de hoy (3:00 p. m.) — marcada por ' || coalesce(v_actor, '—')
           || ' a las ' || to_char(now() at time zone 'America/Costa_Rica', 'FMHH12:MI')
           || case when extract(hour from now() at time zone 'America/Costa_Rica') < 12 then ' a. m.' else ' p. m.' end,
           'ocupacion'
      from public.perfiles p
     where p.activo and p.id is distinct from auth.uid() and public.permiso_de(p.id, 'aviso_ingreso_lista');
    get diagnostics v_n = row_count;
    if v_n > 0 then
      insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, tipo, detalle)
      values (p_fecha, p_propiedad, v_prop, 'aviso', 'Aviso a recepción: lista para el ingreso (' || v_n || ' persona(s))');
    end if;
  end if;
end $f$;

-- 6) Copiar del día anterior — respeta el cierre y registra al creador -----
create or replace function public.ocupacion_copiar(p_desde date, p_hasta date)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare n integer;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el tablero de ocupación'; end if;
  if public.ocupacion_cerrada(p_hasta) then raise exception 'Este tablero ya está archivado (se cierra a las 8:15 p. m.) y no se puede editar'; end if;
  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, nota, actualizado_por, actualizado_en)
  select p_hasta, propiedad_id, estado, entrada, noches, pax, nota, auth.uid(), now()
  from public.ocupacion where fecha = p_desde and (estado <> '-' or entrada <> '-' or noches is not null or pax is not null or nota is not null)
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, nota = excluded.nota, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;
  get diagnostics n = row_count;
  if n > 0 then perform public.ocupacion_marcar_creador(p_hasta); end if;
  insert into public.ocupacion_historial (fecha, usuario_id, tipo, detalle)
  values (p_hasta, auth.uid(), 'copia', 'Tablero copiado del ' || to_char(p_desde, 'DD/MM/YYYY') || ' (' || n || ' propiedades)');
  return n;
end $f$;

-- 7) Alertas de ingreso (14:00, 14:30 y 15:00) ---------------------------
--    Solo si hay propiedades que ENTRAN hoy y no están Listas. Nunca se repite la misma alerta.
create or replace function public.ocupacion_alerta_ingresos(p_hora text)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare v_hoy date := public.ocupacion_hoy(); v_lista text; v_cant int; v_msg text; v_tit text; v_n int; v_ya timestamptz;
begin
  if p_hora not in ('14:00','14:30','15:00') then raise exception 'Hora no válida'; end if;
  -- Si quien llama es una persona (no la tarea programada), solo el administrador puede dispararla
  if auth.uid() is not null and coalesce(public.mi_rol(), '') <> 'admin' then raise exception 'No autorizado'; end if;

  insert into public.ocupacion_dia (fecha) values (v_hoy) on conflict (fecha) do nothing;
  select case p_hora when '14:00' then alerta_1400 when '14:30' then alerta_1430 else alerta_1500 end
    into v_ya from public.ocupacion_dia where fecha = v_hoy;
  if v_ya is not null then return 0; end if;

  select count(*), string_agg(p.nombre || ' (' || coalesce(initcap(o.limpieza), 'sin marcar') || ')', ', ' order by p.orden nulls last, p.nombre)
    into v_cant, v_lista
    from public.ocupacion o join public.propiedades p on p.id = o.propiedad_id
   where o.fecha = v_hoy and o.entrada = 'ENTRA' and o.limpieza is distinct from 'lista';
  if v_cant = 0 then return 0; end if;

  v_tit := case p_hora when '14:00' then '⚠️ Ingresos: falta 1 hora'
                       when '14:30' then '⚠️ Ingresos: faltan 30 minutos'
                       else '🚨 Hora de ingreso (3:00 p. m.)' end;
  v_msg := v_cant || case when v_cant = 1 then ' propiedad entra hoy y aún no está lista: ' else ' propiedades entran hoy y aún no están listas: ' end || v_lista;

  insert into public.notificaciones (usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo)
  select p.id, null, v_tit, null, left(v_msg, 900), 'ocupacion'
    from public.perfiles p where p.activo and public.permiso_de(p.id, 'alerta_ingresos');
  get diagnostics v_n = row_count;

  update public.ocupacion_dia set
    alerta_1400 = case when p_hora = '14:00' then now() else alerta_1400 end,
    alerta_1430 = case when p_hora = '14:30' then now() else alerta_1430 end,
    alerta_1500 = case when p_hora = '15:00' then now() else alerta_1500 end
  where fecha = v_hoy;
  insert into public.ocupacion_historial (fecha, tipo, detalle)
  values (v_hoy, 'alerta', 'Alerta de las ' || p_hora || ' enviada a ' || v_n || ' persona(s): ' || v_msg);
  return v_n;
end $f$;

-- 8) Cierre diario (20:15): archiva el tablero y guarda el resumen ----------
create or replace function public.ocupacion_archivar()
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_hoy date := public.ocupacion_hoy(); r record;
begin
  if auth.uid() is not null then raise exception 'No autorizado'; end if;   -- solo la tarea programada
  insert into public.ocupacion_dia (fecha) values (v_hoy) on conflict (fecha) do nothing;
  for r in select d.fecha from public.ocupacion_dia d where d.fecha <= v_hoy and d.archivado_en is null loop
    update public.ocupacion_dia set archivado_en = now(), resumen = (
      select jsonb_build_object(
        'ocupadas',    count(*) filter (where estado = 'OCUPADA'),
        'entradas',    count(*) filter (where entrada = 'ENTRA'),
        'salidas',     count(*) filter (where estado = 'SALE'),
        'libres',      count(*) filter (where entrada = 'LIBRE'),
        'bloqueadas',  count(*) filter (where entrada = 'BLOQUEADA'),
        'pax',         coalesce(sum(pax), 0),
        'listas',      count(*) filter (where limpieza = 'lista'),
        'sucias',      count(*) filter (where limpieza = 'sucia'),
        'pendientes',  count(*) filter (where limpieza = 'pendiente'),
        'bloqueadas_limpieza', count(*) filter (where limpieza = 'bloqueada'),
        'ingresos_no_listos',  count(*) filter (where entrada = 'ENTRA' and limpieza is distinct from 'lista'))
      from public.ocupacion where fecha = r.fecha)
    where fecha = r.fecha;
    insert into public.ocupacion_historial (fecha, tipo, detalle)
    values (r.fecha, 'archivo', 'Tablero archivado (cierre de las 8:15 p. m.). Queda en solo lectura.');
  end loop;
end $f$;

revoke execute on function public.ocupacion_alerta_ingresos(text) from anon;
revoke execute on function public.ocupacion_archivar() from anon, authenticated;
revoke execute on function public.ocupacion_marcar_creador(date) from anon, authenticated;

-- 9) Tareas programadas (UTC = Costa Rica + 6 h) -------------------------
select cron.unschedule(jobname) from cron.job where jobname in ('ocupacion-alerta-1400','ocupacion-alerta-1430','ocupacion-alerta-1500','ocupacion-cierre-2015');
select cron.schedule('ocupacion-alerta-1400', '0 20 * * *',  $$select public.ocupacion_alerta_ingresos('14:00')$$);
select cron.schedule('ocupacion-alerta-1430', '30 20 * * *', $$select public.ocupacion_alerta_ingresos('14:30')$$);
select cron.schedule('ocupacion-alerta-1500', '0 21 * * *',  $$select public.ocupacion_alerta_ingresos('15:00')$$);
select cron.schedule('ocupacion-cierre-2015', '15 2 * * *',  $$select public.ocupacion_archivar()$$);
