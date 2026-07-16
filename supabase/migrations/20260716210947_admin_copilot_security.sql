create or replace function public.admin_match_chunks(
  p_embedding vector,
  p_match_count integer default 12,
  p_min_similarity double precision default 0.2
)
returns table(
  id uuid,
  tenant_id uuid,
  tenant_name text,
  project_id uuid,
  project_name text,
  client_id uuid,
  client_name text,
  document_id uuid,
  content text,
  similarity double precision,
  source_url text,
  title text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id,
    t.id,
    t.name,
    p.id,
    p.name,
    cl.id,
    cl.name,
    d.id,
    c.content,
    1 - (c.embedding <=> p_embedding) as similarity,
    d.source_url,
    d.title
  from public.chunks c
  join public.documents d on d.id = c.document_id
  join public.tenants t on t.id = c.tenant_id
  left join public.projects p on p.id = t.project_id
  left join public.clients cl on cl.id = p.client_id
  where c.embedding is not null
    and 1 - (c.embedding <=> p_embedding) > greatest(0, least(p_min_similarity, 1))
  order by c.embedding <=> p_embedding
  limit greatest(1, least(p_match_count, 30));
$$;

alter function public.match_chunks(uuid, vector, integer, double precision) set search_path = public;
alter function public.monthly_messages(uuid) set search_path = public;
alter function public.daily_activity(uuid, integer) set search_path = public;
alter function public.admin_metrics() set search_path = public;
alter function public.check_rate(text, integer) set search_path = public;
alter function public.unanswered_questions(uuid, integer) set search_path = public;

revoke execute on function public.admin_match_chunks(vector, integer, double precision) from public, anon, authenticated;
revoke execute on function public.match_chunks(uuid, vector, integer, double precision) from public, anon, authenticated;
revoke execute on function public.monthly_messages(uuid) from public, anon, authenticated;
revoke execute on function public.daily_activity(uuid, integer) from public, anon, authenticated;
revoke execute on function public.admin_metrics() from public, anon, authenticated;
revoke execute on function public.check_rate(text, integer) from public, anon, authenticated;
revoke execute on function public.unanswered_questions(uuid, integer) from public, anon, authenticated;

grant execute on function public.admin_match_chunks(vector, integer, double precision) to service_role;
grant execute on function public.match_chunks(uuid, vector, integer, double precision) to service_role;
grant execute on function public.monthly_messages(uuid) to service_role;
grant execute on function public.daily_activity(uuid, integer) to service_role;
grant execute on function public.admin_metrics() to service_role;
grant execute on function public.check_rate(text, integer) to service_role;
grant execute on function public.unanswered_questions(uuid, integer) to service_role;

create index if not exists handoff_bridge_conversation_idx
  on public.handoff_bridge(conversation_id);
