-- Remote control + liveness for the Mac mini poller.
-- Phone writes via indexer_control(action, token); the poller only pulls.
-- No inbound ports. Token hash is not publicly readable.

create extension if not exists pgcrypto with schema extensions;

create table if not exists indexer_status (
  id int primary key default 1 check (id = 1),
  desired text not null default 'running' check (desired in ('running', 'paused')),
  mode text not null default 'stopped' check (mode in ('running', 'paused', 'stopped')),
  heartbeat_at timestamptz,
  last_error text,
  restart_nonce int not null default 0
);

create table if not exists indexer_auth (
  id int primary key default 1 check (id = 1),
  token_hash text not null
);

insert into indexer_status (id) values (1) on conflict (id) do nothing;

alter table indexer_status enable row level security;
alter table indexer_auth enable row level security;

drop policy if exists "status is publicly readable" on indexer_status;
create policy "status is publicly readable" on indexer_status for select using (true);
-- indexer_auth: no policies. postgres (the poller) and this definer function only.

create or replace function indexer_control(p_action text, p_token text)
returns indexer_status
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  expected text;
  row indexer_status;
begin
  if p_action not in ('pause', 'resume', 'restart') then
    raise exception 'bad action';
  end if;
  select token_hash into expected from indexer_auth where id = 1;
  if expected is null
     or expected <> encode(digest(convert_to(p_token, 'utf8'), 'sha256'), 'hex') then
    raise exception 'denied';
  end if;
  if p_action = 'pause' then
    update indexer_status set desired = 'paused' where id = 1 returning * into row;
  elsif p_action = 'resume' then
    update indexer_status set desired = 'running' where id = 1 returning * into row;
  else
    update indexer_status
      set desired = 'running', restart_nonce = restart_nonce + 1
      where id = 1
      returning * into row;
  end if;
  return row;
end;
$$;

revoke all on function indexer_control(text, text) from public;
grant execute on function indexer_control(text, text) to anon, authenticated;
