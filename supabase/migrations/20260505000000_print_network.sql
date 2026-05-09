create table if not exists public.printer_devices (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  host text not null,
  printer_name text not null,
  display_name text,
  driver text,
  is_default boolean not null default false,
  status text not null default 'offline' check (status in ('online', 'offline')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, printer_name)
);

create table if not exists public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('order', 'teste', 'reprint')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'error')),
  printer_id uuid references public.printer_devices(id) on delete set null,
  printer_target text,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  locked_at timestamptz,
  printed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_printer_devices_agent_status
  on public.printer_devices (agent_id, status, last_seen_at desc);

create index if not exists idx_print_jobs_pending
  on public.print_jobs (status, attempts, created_at)
  where status = 'pending';

alter table public.printer_devices enable row level security;
alter table public.print_jobs enable row level security;

drop policy if exists "service_role manages printer_devices" on public.printer_devices;
create policy "service_role manages printer_devices"
  on public.printer_devices
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop policy if exists "service_role manages print_jobs" on public.print_jobs;
create policy "service_role manages print_jobs"
  on public.print_jobs
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
