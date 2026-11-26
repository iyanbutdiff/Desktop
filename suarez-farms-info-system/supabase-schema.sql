create table if not exists public.suarez_farms_state (
  id text primary key check (id = 'main'),
  revision bigint not null default 0,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.suarez_farms_state enable row level security;
revoke all on public.suarez_farms_state from anon, authenticated;
grant all on public.suarez_farms_state to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('suarez-farms-public', 'suarez-farms-public', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('suarez-farms-private', 'suarez-farms-private', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
