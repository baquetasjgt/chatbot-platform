alter table tenants
  add column provider text not null default 'anthropic'
  check (provider in ('anthropic', 'google'));

comment on column tenants.provider is
  'Proveedor de generación: anthropic (Claude) o google (Gemini). El campo model se interpreta según este proveedor.';
