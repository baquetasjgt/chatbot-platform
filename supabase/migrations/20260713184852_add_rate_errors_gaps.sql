-- limitador de peticiones por IP (ventana de 1 minuto)
create unlogged table rate_events (
  ip text not null,
  bucket timestamptz not null,
  n int not null default 1,
  primary key (ip, bucket)
);
alter table rate_events enable row level security;

create or replace function check_rate(p_ip text, p_limit int default 20)
returns boolean language plpgsql as $$
declare cur int;
begin
  delete from rate_events where bucket < now() - interval '5 minutes';
  insert into rate_events (ip, bucket, n)
  values (p_ip, date_trunc('minute', now()), 1)
  on conflict (ip, bucket) do update set n = rate_events.n + 1
  returning n into cur;
  return cur <= p_limit;
end $$;

-- registro de errores del motor
create table error_log (
  id uuid primary key default gen_random_uuid(),
  route text not null default '',
  message text not null default '',
  created_at timestamptz not null default now()
);
alter table error_log enable row level security;
create index error_log_created_idx on error_log (created_at desc);

-- preguntas sin respuesta agrupadas (para la auto-mejora y los informes)
create or replace function unanswered_questions(p_tenant_id uuid, p_days int default 30)
returns table(q text, n bigint)
language sql stable as $$
  select u.content, count(*)
  from messages a
  join lateral (
    select content from messages m2
    where m2.conversation_id = a.conversation_id
      and m2.role = 'user' and m2.created_at < a.created_at
    order by m2.created_at desc limit 1
  ) u on true
  where a.tenant_id = p_tenant_id
    and a.role = 'assistant'
    and a.was_answered = false
    and a.created_at > now() - make_interval(days => p_days)
  group by u.content
  order by count(*) desc
  limit 15;
$$;
