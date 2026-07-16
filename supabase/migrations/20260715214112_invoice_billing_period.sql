-- Periodo de facturación por factura (una factura por producto facturable).
alter table public.invoices add column if not exists period_start date;
alter table public.invoices add column if not exists period_end date;
