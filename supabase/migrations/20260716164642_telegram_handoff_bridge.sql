-- puente de atención por Telegram: config por asistente + mapa mensaje↔conversación
-- tenants.handoff: { enabled, bot_token, chat_id, secret }
alter table tenants add column if not exists handoff jsonb not null default '{}'::jsonb;

-- cada aviso que mandamos a Telegram queda mapeado a su conversación, para que
-- cuando el dueño RESPONDA (reply) en Telegram sepamos a qué WhatsApp reenviar
create table if not exists handoff_bridge (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  tg_message_id bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_handoff_bridge_msg on handoff_bridge (tenant_id, tg_message_id);
alter table handoff_bridge enable row level security;
