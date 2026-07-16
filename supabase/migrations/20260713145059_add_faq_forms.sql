create table faq_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  token text not null unique default 'ft_' || encode(gen_random_bytes(16), 'hex'),
  questions jsonb not null default '[]',
  status text not null default 'pendiente',
  created_at timestamptz not null default now(),
  submitted_at timestamptz
);

alter table faq_forms enable row level security;

comment on table faq_forms is
  'Formularios de preguntas frecuentes: la IA propone preguntas, el cliente las responde vía /faq?token= y al enviar se indexan en el bot.';
