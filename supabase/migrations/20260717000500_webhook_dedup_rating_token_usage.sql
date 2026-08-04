-- Recuperada del esquema de producción y de Cloudflare Worker v148.
-- La versión 20260717000500 ya consta como aplicada en Supabase.

-- Deduplicación de entregas de webchat y webhooks de WhatsApp/Telegram.
create table public.processed_updates (
  provider text not null,
  update_id text not null,
  created_at timestamptz not null default now(),
  primary key (provider, update_id)
);

alter table public.processed_updates enable row level security;
create index processed_updates_created_idx
  on public.processed_updates (created_at);

revoke all on table public.processed_updates from public, anon, authenticated;
grant all on table public.processed_updates to service_role;

-- Valoración opcional de las respuestas del asistente: útil/no útil.
alter table public.messages
  add column rating smallint check (rating in (-1, 1));

-- Uso mensual agregado para el panel de costes del administrador.
create or replace function public.admin_token_usage(
  p_month date default date_trunc('month', now())::date
)
returns table (
  tenant_id uuid,
  input_tokens bigint,
  output_tokens bigint,
  questions bigint
)
language sql
stable
set search_path = public
as $$
  select m.tenant_id,
         coalesce(sum(m.input_tokens), 0)::bigint,
         coalesce(sum(m.output_tokens), 0)::bigint,
         (count(*) filter (where m.role = 'user'))::bigint
  from public.messages m
  where m.created_at >= date_trunc('month', p_month::timestamptz)
    and m.created_at < date_trunc('month', p_month::timestamptz) + interval '1 month'
  group by m.tenant_id;
$$;

revoke all on function public.admin_token_usage(date) from public, anon, authenticated;
grant execute on function public.admin_token_usage(date) to service_role;