-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: respaldo semestral de fotos (liberar espacio)
--   · Fotos de casos FINALIZADOS hace más de 6 meses: el Administrador las descarga
--     a la computadora (ZIP con fotos por propiedad y caso + Excel) y luego se borran
--     de Supabase. El texto de los reportes y su bitácora se queda siempre en el sistema.
--   · El caso muestra cuántas fotos se archivaron y en qué fecha.
--   · Recordatorio al Administrador (campana y celular) todos los días a las 8:05 a. m.
--     mientras haya fotos pendientes, máximo una vez por semana.
--   · No toca casos abiertos ni las fotos de "Claves de caja".
-- Fecha: 2026-11-10 · YA APLICADO en el proyecto ama-llaves.
-- =====================================================================

-- 1) Columnas nuevas en los reportes y registro de respaldos ---------------
alter table public.reportes add column if not exists fotos_archivadas integer not null default 0;
alter table public.reportes add column if not exists fotos_respaldo_en timestamptz;

create table if not exists public.respaldos (
  id bigint generated always as identity primary key,
  usuario_id uuid references public.perfiles(id),
  creado_en timestamptz not null default now(),
  casos integer not null,
  fotos integer not null,
  bytes bigint,
  archivo text
);
alter table public.respaldos enable row level security;
drop policy if exists respaldos_ver on public.respaldos;
create policy respaldos_ver on public.respaldos for select to authenticated using (public.mi_rol() = 'admin');
revoke insert, update, delete, truncate on public.respaldos from anon, authenticated;

alter table public.notificaciones drop constraint if exists notificaciones_tipo_chk;
alter table public.notificaciones add constraint notificaciones_tipo_chk check (tipo in ('reporte','clave','ocupacion','respaldo'));

-- 2) El Administrador puede borrar fotos de reportes (solo desde el respaldo) --
drop policy if exists fotos_borrar_admin on storage.objects;
create policy fotos_borrar_admin on storage.objects for delete to authenticated
  using (bucket_id = 'fotos-reportes' and public.mi_rol() = 'admin');

-- 3) ¿Qué falta respaldar? -------------------------------------------------
create or replace function public.respaldo_pendiente(p_meses integer default 6)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $f$
declare v jsonb;
begin
  if auth.uid() is not null and coalesce(public.mi_rol(), '') <> 'admin' then raise exception 'Solo el Administrador puede hacer el respaldo'; end if;
  if p_meses is null or p_meses < 1 then raise exception 'Periodo no válido'; end if;
  select jsonb_build_object(
           'casos', count(distinct r.id),
           'fotos', count(o.name),
           'bytes', coalesce(sum((o.metadata->>'size')::bigint), 0),
           'ids',   coalesce(jsonb_agg(distinct r.id), '[]'::jsonb),
           'mas_viejo', min(r.cerrado_en))
    into v
    from public.reportes r
    cross join lateral unnest(r.fotos) as p(path)
    join storage.objects o on o.bucket_id = 'fotos-reportes' and o.name = p.path
   where r.estado = 'listo' and r.cerrado_en < now() - make_interval(months => p_meses);
  return v;
end $f$;

-- 4) Después de borrar las fotos: se anotan en cada caso ---------------------
--    Solo cuenta las fotos que ya no existen en Supabase (si algo falló, se puede repetir)
create or replace function public.respaldo_registrar(p_ids bigint[], p_bytes bigint, p_archivo text)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare v_fotos int := 0; v_casos int := 0; r record; v_quedan text[]; v_quitadas int;
begin
  if coalesce(public.mi_rol(), '') <> 'admin' then raise exception 'Solo el Administrador puede hacer el respaldo'; end if;
  for r in select id, fotos from public.reportes
            where id = any(p_ids) and estado = 'listo' and cardinality(fotos) > 0 for update loop
    v_quedan := array(select p from unnest(r.fotos) p
                       where exists (select 1 from storage.objects o where o.bucket_id = 'fotos-reportes' and o.name = p));
    v_quitadas := cardinality(r.fotos) - cardinality(v_quedan);
    if v_quitadas > 0 then
      update public.reportes set fotos = v_quedan, fotos_archivadas = fotos_archivadas + v_quitadas,
             fotos_respaldo_en = now() where id = r.id;
      v_fotos := v_fotos + v_quitadas; v_casos := v_casos + 1;
    end if;
  end loop;
  if v_fotos > 0 then
    insert into public.respaldos (usuario_id, casos, fotos, bytes, archivo)
    values (auth.uid(), v_casos, v_fotos, p_bytes, left(p_archivo, 200));
  end if;
  return v_fotos;
end $f$;

-- 5) Recordatorio diario (8:05 a. m.), máximo una vez por semana --------------
create or replace function public.respaldo_recordar()
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare v jsonb; v_n int; v_mb text;
begin
  if auth.uid() is not null then raise exception 'No autorizado'; end if;   -- solo la tarea programada
  v := public.respaldo_pendiente(6);
  if coalesce((v->>'fotos')::int, 0) = 0 then return 0; end if;
  if exists (select 1 from public.notificaciones where tipo = 'respaldo' and creado_en > now() - interval '7 days') then return 0; end if;
  v_mb := to_char(greatest((v->>'bytes')::numeric / 1048576, 0.1), 'FM9990.0');
  insert into public.notificaciones (usuario_id, reporte_id, numero_caso, propiedad_nombre, mensaje, tipo)
  select p.id, null, '📦 Respaldo pendiente', null,
         'Hay ' || (v->>'fotos') || ' fotos de ' || (v->>'casos') || ' casos finalizados hace más de 6 meses (' || v_mb
         || ' MB). Toque aquí y presione "Descargar respaldo" para guardarlas en la computadora y liberar espacio.',
         'respaldo'
    from public.perfiles p where p.activo and p.rol = 'admin';
  get diagnostics v_n = row_count;
  return v_n;
end $f$;

revoke execute on function public.respaldo_pendiente(integer) from public, anon;
grant execute on function public.respaldo_pendiente(integer) to authenticated;
revoke execute on function public.respaldo_registrar(bigint[], bigint, text) from public, anon;
grant execute on function public.respaldo_registrar(bigint[], bigint, text) to authenticated;
revoke execute on function public.respaldo_recordar() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'respaldo-recordatorio';
select cron.schedule('respaldo-recordatorio', '5 14 * * *', $$select public.respaldo_recordar()$$);   -- 8:05 a. m. Costa Rica

notify pgrst, 'reload schema';
