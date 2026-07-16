alter table clients add column if not exists portal_enabled boolean not null default true;
alter table tenants add column if not exists panel_enabled boolean not null default true;
alter table tenants add column if not exists panel_features jsonb not null default '{}'::jsonb;
alter table tenants add column if not exists features jsonb not null default '{}'::jsonb;
