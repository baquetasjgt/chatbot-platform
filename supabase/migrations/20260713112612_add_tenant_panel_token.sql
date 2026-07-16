alter table tenants
  add column panel_token text not null unique
  default 'pt_' || encode(gen_random_bytes(16), 'hex');

comment on column tenants.panel_token is
  'Token del panel de cliente (/panel?token=...). Se comparte con el cliente; rotar = update a un valor nuevo.';
