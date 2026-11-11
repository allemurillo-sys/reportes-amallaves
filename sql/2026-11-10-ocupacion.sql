-- =====================================================================
-- Reportes Ama de Llaves · Home Vacations CR
-- Cambio: sección "Ocupación" (reemplaza el Excel "Reporte_Limpieza")
--   · Tablero por día y por propiedad: Estado (- / OCUPADA / SALE / SUCIA / REVISAR),
--     Entrada (- / LIBRE / ENTRA / BLOQUEADA), noches, pax y nota  → lo llena Operaciones
--   · Estado de limpieza (Lista / Sucia / Pendiente / Bloqueada) → lo marca el personal
--     de ama de llaves cuando pasa por la propiedad (con nota opcional)
--   · Historial automático de cada cambio
--   · Propiedades: grupo (ej. "Apartamentos", "Hormigas House"), orden y si salen en el tablero
--   · Permisos nuevos (editables en Mantenimiento › Autorizaciones):
--       ocupacion_ver       → ver el tablero (todos)
--       ocupacion_editar    → llenar el tablero (Operaciones)
--       ocupacion_limpieza  → marcar el estado de limpieza (Ama de llaves, Supervisora, Mucama)
-- Fecha: 2026-11-10 · PENDIENTE de aplicar (esperando aprobación de Allen).
-- =====================================================================

-- 1) Permisos -----------------------------------------------------------
insert into public.permisos_catalogo (clave, grupo, nombre, orden, fijo) values
  ('ocupacion_ver',      'permiso', 'Ocupación: ver el tablero del día', 270, 'admin'),
  ('ocupacion_editar',   'permiso', 'Ocupación: llenar el tablero (estado, entrada, noches y pax)', 280, 'admin'),
  ('ocupacion_limpieza', 'permiso', 'Ocupación: marcar el estado de limpieza (lista, sucia, pendiente, bloqueada)', 290, 'admin')
on conflict (clave) do nothing;

insert into public.permisos_rol (rol, clave, permitido) values
  ('ama_llaves','ocupacion_ver',true), ('supervisora','ocupacion_ver',true),
  ('operaciones','ocupacion_ver',true), ('mucama','ocupacion_ver',true),
  ('ama_llaves','ocupacion_editar',false), ('supervisora','ocupacion_editar',false),
  ('operaciones','ocupacion_editar',true), ('mucama','ocupacion_editar',false),
  ('ama_llaves','ocupacion_limpieza',true), ('supervisora','ocupacion_limpieza',true),
  ('operaciones','ocupacion_limpieza',false), ('mucama','ocupacion_limpieza',true)
on conflict (rol, clave) do nothing;

create or replace function public.puede_ocupacion()
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select public.tengo('ocupacion_ver') or public.tengo('ocupacion_editar') or public.tengo('ocupacion_limpieza')
$f$;

-- 2) Propiedades: grupo, orden y si aparecen en el tablero ----------------
alter table public.propiedades add column if not exists grupo text;
alter table public.propiedades add column if not exists orden integer;
alter table public.propiedades add column if not exists en_ocupacion boolean not null default true;
alter table public.propiedades drop constraint if exists propiedades_grupo_chk;
alter table public.propiedades add constraint propiedades_grupo_chk check (grupo is null or length(grupo) <= 40);

-- 3) Tablas -------------------------------------------------------------
create table if not exists public.ocupacion (
  fecha date not null,
  propiedad_id bigint not null references public.propiedades(id) on delete cascade,
  estado  text not null default '-' check (estado  in ('-','OCUPADA','SALE','SUCIA','REVISAR')),
  entrada text not null default '-' check (entrada in ('-','LIBRE','ENTRA','BLOQUEADA')),
  noches smallint check (noches is null or noches between 0 and 365),
  pax    smallint check (pax is null or pax between 0 and 99),
  nota   text check (nota is null or length(nota) <= 200),
  actualizado_por uuid references public.perfiles(id),
  actualizado_en  timestamptz,
  limpieza text check (limpieza is null or limpieza in ('lista','sucia','pendiente','bloqueada')),
  limpieza_nota text check (limpieza_nota is null or length(limpieza_nota) <= 200),
  limpieza_por uuid references public.perfiles(id),
  limpieza_en  timestamptz,
  primary key (fecha, propiedad_id)
);
create index if not exists ocupacion_prop_idx on public.ocupacion(propiedad_id, fecha desc);

create table if not exists public.ocupacion_historial (
  id bigint generated always as identity primary key,
  fecha date not null,
  propiedad_id bigint,
  propiedad_nombre text,
  usuario_id uuid references public.perfiles(id),
  tipo text not null check (tipo in ('tablero','limpieza','copia')),
  detalle text,
  creado_en timestamptz not null default now()
);
create index if not exists ocupacion_hist_idx on public.ocupacion_historial(fecha, propiedad_id, creado_en desc);

alter table public.ocupacion enable row level security;
alter table public.ocupacion_historial enable row level security;
drop policy if exists ocupacion_ver on public.ocupacion;
create policy ocupacion_ver on public.ocupacion for select to authenticated using (public.puede_ocupacion());
drop policy if exists ocupacion_hist_ver on public.ocupacion_historial;
create policy ocupacion_hist_ver on public.ocupacion_historial for select to authenticated using (public.puede_ocupacion());
revoke insert, update, delete, truncate on public.ocupacion, public.ocupacion_historial from anon, authenticated;

-- 4) Funciones (la app solo escribe por aquí) -----------------------------
create or replace function public.ocupacion_hoy()
returns date language sql stable as $f$ select (now() at time zone 'America/Costa_Rica')::date $f$;

-- Operaciones: guardar una fila del tablero
create or replace function public.ocupacion_guardar(p_fecha date, p_propiedad bigint, p_estado text, p_entrada text,
                                                    p_noches integer, p_pax integer, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_det text[] := '{}'; v_prop text;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el tablero de ocupación'; end if;
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

  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, nota, actualizado_por, actualizado_en)
  values (p_fecha, p_propiedad, p_estado, p_entrada, p_noches, p_pax, p_nota, auth.uid(), now())
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, nota = excluded.nota, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'tablero', array_to_string(v_det, ' · '));
end $f$;

-- Ama de llaves / Supervisora / Mucama: estado de limpieza (solo el día de hoy, Admin cualquier día)
create or replace function public.ocupacion_limpieza(p_fecha date, p_propiedad bigint, p_estado text, p_nota text)
returns void language plpgsql security definer set search_path to 'public' as $f$
declare v_old public.ocupacion; v_prop text;
begin
  if not public.tengo('ocupacion_limpieza') then raise exception 'No tiene permiso para marcar el estado de limpieza'; end if;
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
    limpieza_por = excluded.limpieza_por, limpieza_en = excluded.limpieza_en;

  insert into public.ocupacion_historial (fecha, propiedad_id, propiedad_nombre, usuario_id, tipo, detalle)
  values (p_fecha, p_propiedad, v_prop, auth.uid(), 'limpieza',
          'Limpieza: ' || coalesce(initcap(v_old.limpieza), 'Sin marcar') || ' → ' || coalesce(initcap(p_estado), 'Sin marcar')
          || coalesce(' · ' || p_nota, ''));
end $f$;

-- Operaciones: copiar el tablero de un día a otro (no toca el estado de limpieza)
create or replace function public.ocupacion_copiar(p_desde date, p_hasta date)
returns integer language plpgsql security definer set search_path to 'public' as $f$
declare n integer;
begin
  if not public.tengo('ocupacion_editar') then raise exception 'No tiene permiso para llenar el tablero de ocupación'; end if;
  insert into public.ocupacion as o (fecha, propiedad_id, estado, entrada, noches, pax, nota, actualizado_por, actualizado_en)
  select p_hasta, propiedad_id, estado, entrada, noches, pax, nota, auth.uid(), now()
  from public.ocupacion where fecha = p_desde and (estado <> '-' or entrada <> '-' or noches is not null or pax is not null or nota is not null)
  on conflict (fecha, propiedad_id) do update set estado = excluded.estado, entrada = excluded.entrada, noches = excluded.noches,
    pax = excluded.pax, nota = excluded.nota, actualizado_por = excluded.actualizado_por, actualizado_en = excluded.actualizado_en;
  get diagnostics n = row_count;
  insert into public.ocupacion_historial (fecha, usuario_id, tipo, detalle)
  values (p_hasta, auth.uid(), 'copia', 'Tablero copiado del ' || to_char(p_desde, 'DD/MM/YYYY') || ' (' || n || ' propiedades)');
  return n;
end $f$;

-- Último estado de limpieza conocido de cada propiedad antes de una fecha (se muestra como referencia)
create or replace function public.ocupacion_ultima_limpieza(p_fecha date)
returns table (propiedad_id bigint, fecha date, limpieza text, limpieza_por uuid, limpieza_en timestamptz)
language sql stable security definer set search_path to 'public' as $f$
  select distinct on (o.propiedad_id) o.propiedad_id, o.fecha, o.limpieza, o.limpieza_por, o.limpieza_en
  from public.ocupacion o
  where public.puede_ocupacion() and o.fecha < p_fecha and o.fecha >= p_fecha - 30 and o.limpieza is not null
  order by o.propiedad_id, o.fecha desc
$f$;

revoke execute on function public.ocupacion_guardar(date,bigint,text,text,integer,integer,text) from anon;
revoke execute on function public.ocupacion_limpieza(date,bigint,text,text) from anon;
revoke execute on function public.ocupacion_copiar(date,date) from anon;
revoke execute on function public.ocupacion_ultima_limpieza(date) from anon;

-- 5) Tiempo real: el tablero se actualiza solo en todas las pantallas -------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ocupacion') then
    alter publication supabase_realtime add table public.ocupacion;
  end if;
end $$;

-- 6) Orden y grupos iniciales (como en el Excel; se cambian en Mantenimiento › Propiedades)
update public.propiedades p set orden = v.o, grupo = v.g from (values
  ('Villa Mandala',10,null),('Villa tropical',20,null),('Villa Arthur',30,null),('Villa Graceland',40,null),
  ('Villa Foresta',60,null),('Villa Ensueño',70,null),('Villa Harmony',80,null),('Villa Paraíso',90,null),
  ('CH1',110,'Apartamentos'),('CH2',120,'Apartamentos'),('Sueños 1',130,'Apartamentos'),('Sueños 2',140,'Apartamentos'),
  ('Sueños 3',150,'Apartamentos'),('Sueños 4',160,'Apartamentos'),('Sueños 5',170,'Apartamentos'),
  ('Fonda 1',180,'Apartamentos'),('Fonda 2',190,'Apartamentos'),('Yaras 5',200,'Apartamentos'),('Yaras 6',210,'Apartamentos'),
  ('Villa Ohana',220,'Apartamentos'),('Casa Luis',230,'Apartamentos'),('Azul 1',260,'Apartamentos'),('Azul 2',270,'Apartamentos'),
  ('Luba',320,'Apartamentos')
) as v(n,o,g) where p.nombre = v.n and p.orden is null;
