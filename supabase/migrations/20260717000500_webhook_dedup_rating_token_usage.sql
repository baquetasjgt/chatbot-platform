-- Dedup de webhooks entrantes: Meta y Telegram reintentan la entrega si no ven
-- un 200 (o simplemente reenvían). Solo la PRIMERA inserción de cada update
-- procesa; los reintentos chocan con la clave primaria y se descartan.
create table if not exists public.processed_updates (
  provider text not null,
  update_id text not null,
  created_at timestamptz not null default now(),
  primary key (provider, update_id)
);
alter table public.processed_updates enable row level security;
create index if not exists processed_updates_created_idx on public.processed_updates (created_at);

-- Feedback del visitante sobre cada respuesta del bot: 1 = útil, -1 = no útil.
alter table public.messages add column if not exists rating smallint check (rating in (-1, 1));

-- Uso de tokens por bot y mes (para el control de coste/beneficio del admin).
create or replace function public.admin_token_usage(p_month date default (date_trunc('month', now()))::date)
returns table(tenant_id uuid, input_tokens bigint, output_tokens bigint, questions bigint)
language sql stable
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
revoke execute on function public.admin_token_usage(date) from public, anon, authenticated;
grant execute on function public.admin_token_usage(date) to service_role;
