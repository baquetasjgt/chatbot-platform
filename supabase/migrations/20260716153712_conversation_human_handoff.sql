-- relevo humano por conversación: cuando human_handoff=true el bot no responde
-- y contesta una persona desde el panel. handoff_at marca la última actividad
-- humana, para una reactivación de seguridad si se olvida abierta.
alter table conversations add column if not exists human_handoff boolean not null default false;
alter table conversations add column if not exists handoff_at timestamptz;
create index if not exists idx_conversations_handoff on conversations (tenant_id) where human_handoff;
