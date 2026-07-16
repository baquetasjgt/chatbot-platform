create or replace function unanswered_questions(p_tenant_id uuid, p_days int default 30)
returns table(q text, n bigint)
language sql stable as $$
  select u.content, count(*)
  from messages a
  join lateral (
    select content from messages m2
    where m2.conversation_id = a.conversation_id
      and m2.role = 'user' and m2.created_at <= a.created_at
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
