create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  email text,
  phone text,
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

alter table clients enable row level security;
alter table projects enable row level security;

alter table tenants add column project_id uuid references projects(id) on delete set null;

with c as (
  insert into clients (name, notes)
  values ('FISIOEXPO', 'Cliente cero. Salón profesional de fisioterapia, IFEMA Madrid.')
  returning id
), p as (
  insert into projects (client_id, name, description)
  select id, 'Chatbot web', 'Asistente RAG con captura de leads para fisioexpo.es' from c
  returning id
)
update tenants set project_id = (select id from p) where slug = 'fisioexpo';
