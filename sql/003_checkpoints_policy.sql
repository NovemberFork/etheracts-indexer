-- Last-indexed block is public chain data; exposing it lets the admin page show liveness.
drop policy if exists "publicly readable" on checkpoints;
create policy "publicly readable" on checkpoints for select using (true);
