-- Restart was a process.exit() for a supervisor we don't actually run.
-- Pause/resume stay; a stale phone UI that still sends 'restart' is a no-op.

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
  if p_action not in ('pause', 'resume') then
    raise exception 'bad action';
  end if;
  select token_hash into expected from indexer_auth where id = 1;
  if expected is null
     or expected <> encode(digest(convert_to(p_token, 'utf8'), 'sha256'), 'hex') then
    raise exception 'denied';
  end if;
  update indexer_status
    set desired = case when p_action = 'pause' then 'paused' else 'running' end
    where id = 1
    returning * into row;
  return row;
end;
$$;
