create extension if not exists vector;
create extension if not exists pgcrypto;

-- Un cliente = un tenant. Toda la config del bot vive aquí, no en el código.
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  active boolean not null default true,
  system_prompt text not null default '',
  model text not null default 'claude-sonnet-4-6',
  welcome_message text not null default '¡Hola! ¿En qué puedo ayudarte?',
  suggested_questions jsonb not null default '[]'::jsonb,
  primary_color text not null default '#111111',
  allowed_domains text[] not null default '{}',
  handoff_email text,
  lead_webhook_url text,
  monthly_message_limit int not null default 5000,
  created_at timestamptz not null default now()
);

-- Claves públicas del widget. Rotables y revocables sin tocar el tenant.
create table public.tenant_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  public_key text unique not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.tenant_keys(tenant_id);

-- Fuentes de conocimiento (URLs, PDFs, FAQ pegado a mano).
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  source_type text not null default 'url',
  source_url text,
  title text,
  content text not null,
  content_hash text,
  indexed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.documents(tenant_id);
create unique index documents_tenant_source_uidx
  on public.documents(tenant_id, source_url) where source_url is not null;

-- Trozos vectorizados. tenant_id denormalizado a propósito: filtra antes de buscar.
create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  content text not null,
  embedding vector(1024),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index on public.chunks(tenant_id);
create index chunks_embedding_idx on public.chunks
  using hnsw (embedding vector_cosine_ops);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id text not null,
  page_url text,
  lang text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index on public.conversations(tenant_id, created_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  sources jsonb not null default '[]'::jsonb,
  input_tokens int,
  output_tokens int,
  was_answered boolean,
  created_at timestamptz not null default now()
);
create index on public.messages(conversation_id, created_at);
create index on public.messages(tenant_id, created_at desc);

-- El producto de verdad.
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  kind text not null default 'general',
  name text,
  email text,
  phone text,
  company text,
  message text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'nuevo',
  created_at timestamptz not null default now()
);
create index on public.leads(tenant_id, created_at desc);

-- Búsqueda semántica acotada al tenant. Nunca se cruzan datos entre clientes.
create or replace function public.match_chunks(
  p_tenant_id uuid,
  p_embedding vector(1024),
  p_match_count int default 6,
  p_min_similarity float default 0.25
)
returns table (id uuid, content text, similarity float, source_url text, title text)
language sql stable
set search_path = public
as $$
  select c.id,
         c.content,
         1 - (c.embedding <=> p_embedding) as similarity,
         d.source_url,
         d.title
  from public.chunks c
  join public.documents d on d.id = c.document_id
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
    and 1 - (c.embedding <=> p_embedding) > p_min_similarity
  order by c.embedding <=> p_embedding
  limit p_match_count;
$$;

alter table public.tenants enable row level security;
alter table public.tenant_keys enable row level security;
alter table public.documents enable row level security;
alter table public.chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.leads enable row level security;
