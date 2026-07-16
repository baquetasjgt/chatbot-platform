alter table clients add column portal_password_hash text;
alter table clients add column payment_method jsonb not null default '{}';

create table invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  number text not null,
  concept text not null default '',
  amount_cents integer not null,
  currency text not null default 'EUR',
  issued_at date not null default current_date,
  status text not null default 'pendiente' check (status in ('pendiente', 'pagada')),
  pdf_path text,
  created_at timestamptz not null default now()
);

alter table invoices enable row level security;

insert into storage.buckets (id, name, public)
values ('facturas', 'facturas', false)
on conflict (id) do nothing;

comment on table invoices is
  'Facturas manuales por cliente; el PDF vive en el bucket privado facturas y se sirve vía el Worker con sesión de portal.';
