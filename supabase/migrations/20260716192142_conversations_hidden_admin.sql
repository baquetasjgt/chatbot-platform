alter table conversations add column if not exists hidden_admin boolean not null default false;
create index if not exists idx_leads_hidden_both on leads (hidden_admin, hidden_client);
