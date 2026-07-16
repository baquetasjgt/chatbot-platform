create or replace function monthly_messages(p_tenant_id uuid)
returns bigint
language sql stable
as $$
  select count(*)
  from messages
  where tenant_id = p_tenant_id
    and role = 'user'
    and created_at >= date_trunc('month', now());
$$;
