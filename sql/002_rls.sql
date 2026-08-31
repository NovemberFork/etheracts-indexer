-- All data is public chain data: anyone reads, only the indexer writes.
-- The indexer connects as the postgres role (direct connection), which bypasses RLS.
alter table events enable row level security;
alter table constants enable row level security;
alter table checkpoints enable row level security;
alter table recent_blocks enable row level security;

-- drop+create keeps this file idempotent: Postgres has no create policy if not exists.
drop policy if exists "events are publicly readable" on events;
create policy "events are publicly readable" on events for select using (true);
drop policy if exists "constants are publicly readable" on constants;
create policy "constants are publicly readable" on constants for select using (true);
-- checkpoints / recent_blocks get no policies: internal indexer state, API-invisible.
