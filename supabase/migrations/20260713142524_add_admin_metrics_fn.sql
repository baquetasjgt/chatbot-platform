create or replace function admin_metrics()
returns table(tenant_id uuid, conversations bigint, questions bigint, unanswered bigint, leads bigint)
language sql stable
as $$
  select
    t.id,
    (select count(*) from conversations c
      where c.tenant_id = t.id and c.created_at >= date_trunc('month', now())),
    (select count(*) from messages m
      where m.tenant_id = t.id and m.role = 'user' and m.created_at >= date_trunc('month', now())),
    (select count(*) from messages m
      where m.tenant_id = t.id and m.role = 'assistant' and m.was_answered = false
        and m.created_at >= date_trunc('month', now())),
    (select count(*) from leads l
      where l.tenant_id = t.id and l.created_at >= date_trunc('month', now()))
  from tenants t;
$$;
