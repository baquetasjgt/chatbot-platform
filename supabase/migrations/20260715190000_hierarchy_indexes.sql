create index if not exists projects_client_idx on public.projects(client_id);
create index if not exists tenants_project_idx on public.tenants(project_id);
create index if not exists invoices_client_idx on public.invoices(client_id);
create index if not exists chunks_document_idx on public.chunks(document_id);
create index if not exists leads_conversation_idx on public.leads(conversation_id);