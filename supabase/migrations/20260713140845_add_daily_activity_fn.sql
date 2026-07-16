create or replace function daily_activity(p_tenant_id uuid, p_days int default 30)
returns table(day date, n bigint)
language sql stable
as $$
  select d::date as day, count(m.id) as n
  from generate_series(
    date_trunc('day', now()) - (p_days - 1) * interval '1 day',
    date_trunc('day', now()),
    interval '1 day'
  ) d
  left join messages m
    on m.tenant_id = p_tenant_id
   and m.role = 'user'
   and m.created_at >= d
   and m.created_at < d + interval '1 day'
  group by 1
  order by 1;
$$;
