-- Borrado suave e independiente por lado (admin vs panel del cliente).
-- Borrar en un panel no afecta al otro; no se pierde el dato.
alter table public.leads add column if not exists hidden_admin boolean not null default false;
alter table public.leads add column if not exists hidden_client boolean not null default false;
alter table public.conversations add column if not exists hidden_client boolean not null default false;

create index if not exists leads_visible_admin_idx on public.leads(tenant_id) where hidden_admin = false;
create index if not exists leads_visible_client_idx on public.leads(tenant_id) where hidden_client = false;
