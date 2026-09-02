-- Internal migrate() ledger. No policies: API-invisible, same as indexer_auth.
-- The indexer connects as postgres, which bypasses RLS.
alter table _migrations enable row level security;
