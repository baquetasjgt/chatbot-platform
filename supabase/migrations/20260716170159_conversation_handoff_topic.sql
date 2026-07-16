-- modo Temas: cada conversación se refleja en un Tema (message_thread_id) del grupo
alter table conversations add column if not exists handoff_topic bigint;
create index if not exists idx_conversations_htopic on conversations (tenant_id, handoff_topic) where handoff_topic is not null;
