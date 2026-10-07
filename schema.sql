create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','pro')),
  scans_used integer not null default 0 check (scans_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  source text not null default 'scan' check (source in ('scan','manual')),
  product_name text,
  safe_grams numeric,
  verdict text,
  limiting text,
  nutrients jsonb not null default '{}'::jsonb,
  analysis jsonb not null default '{}'::jsonb
);

create table if not exists public.durva_chats (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  title text not null default 'Durva chat',
  messages jsonb not null default '[]'::jsonb
);

create table if not exists public.durva_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  title text not null,
  details text,
  due_date date,
  completed boolean not null default false
);

create index if not exists scans_user_created_idx on public.scans(user_id, created_at desc);
create index if not exists durva_tasks_user_created_idx on public.durva_tasks(user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.scans enable row level security;
alter table public.durva_chats enable row level security;
alter table public.durva_tasks enable row level security;

-- Users can only read their own records. Writes for privileged fields such as scans_used/plan
-- are intentionally kept server-side; the public client does not get update policies.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());

drop policy if exists scans_select_own on public.scans;
create policy scans_select_own on public.scans for select to authenticated using (user_id = auth.uid());
drop policy if exists scans_delete_own on public.scans;
create policy scans_delete_own on public.scans for delete to authenticated using (user_id = auth.uid());

drop policy if exists chats_select_own on public.durva_chats;
create policy chats_select_own on public.durva_chats for select to authenticated using (user_id = auth.uid());

drop policy if exists tasks_select_own on public.durva_tasks;
create policy tasks_select_own on public.durva_tasks for select to authenticated using (user_id = auth.uid());
drop policy if exists tasks_insert_own on public.durva_tasks;
create policy tasks_insert_own on public.durva_tasks for insert to authenticated with check (user_id = auth.uid());
drop policy if exists tasks_update_own on public.durva_tasks;
create policy tasks_update_own on public.durva_tasks for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists tasks_delete_own on public.durva_tasks;
create policy tasks_delete_own on public.durva_tasks for delete to authenticated using (user_id = auth.uid());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.increment_scan_if_available(p_user uuid, p_free_limit integer)
returns table(ok boolean, scans_used integer, plan text)
language plpgsql
security definer set search_path = public
as $$
declare r public.profiles;
begin
  select * into r from public.profiles where id = p_user for update;
  if not found then
    insert into public.profiles(id) values (p_user) returning * into r;
  end if;
  if r.plan = 'pro' or r.scans_used < p_free_limit then
    update public.profiles set scans_used = scans_used + case when r.plan = 'pro' then 0 else 1 end, updated_at = now()
    where id = p_user returning * into r;
    return query select true, r.scans_used, r.plan;
  end if;
  return query select false, r.scans_used, r.plan;
end;
$$;
revoke all on function public.increment_scan_if_available(uuid, integer) from public;
revoke all on function public.increment_scan_if_available(uuid, integer) from anon;
revoke all on function public.increment_scan_if_available(uuid, integer) from authenticated;
grant execute on function public.increment_scan_if_available(uuid, integer) to service_role;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
