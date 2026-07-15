create table if not exists public.project_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  provider text not null check (provider in ('web','whatsapp','telegram','google_drive','email','webhook','crm','calendar','zapier_make')),
  category text not null check (category in ('channel','knowledge','sales','communication','calendar')),
  name text not null,
  status text not null default 'pending' check (status in ('pending','connected','paused','error')),
  settings jsonb not null default '{}'::jsonb,
  assigned_tenant_ids uuid[] not null default '{}'::uuid[],
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, provider, name)
);

alter table public.project_integrations enable row level security;

create index if not exists project_integrations_project_idx
  on public.project_integrations(project_id, category, status);

comment on table public.project_integrations is
  'Integraciones configuradas por proyecto. No almacena secretos sin cifrar; el Worker usa service_role.';
