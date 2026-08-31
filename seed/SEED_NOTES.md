# Seed data — pre-upgrade history (blocks 3,588,187 → 14,121,413)

The indexer treats the upgrade block (14,121,414) as genesis. Everything before it comes from
this seed: real events normalized to the new shapes (`source: chain`), plus synthesized ghosts
for things the old contract never emitted (`source: ghost`).

Regenerate: `pnpm seed` — caches raw pulls in `seed/data/`, writes `seed/seed.sql`.
Apply: `psql "$DATABASE_URL" -f seed/seed.sql` (idempotent; replaces all pre-genesis rows).
After deleting pre-genesis rows, the seed sets `events_id_seq` from `max(id)` of any
remaining (post-genesis) rows — so a seed-only DB restarts at id 1, while mixed seed+live
data continues after live IDs (never collides; does not renumber live rows).
**Status: generated (with `block_timestamp`), validated, re-applied to Supabase.**

## How it's derived (no simulation, no guesswork)

| Data | Source |
|---|---|
| Transfers | real `Transfer` events |
| ArtifactAssigned / Preserved ghosts | `token_ids_to_artifact_ids` snapshots at every transfer block — diff = wipe vs save |
| Old-shape ArtifactEngraved → new shape | event data + artifact id from snapshots + nonce replay (old_data cross-checked per row) |
| Tag registry | the 5 deploy-day TagRegistered events, indices 1–5 |
| Admin setter ghosts | historical state reads bisected over the window (see below) |
| Initial 11 artifacts × 5 tags | `INITIAL_ENGRAVINGS` constants in v0.1.0 source |
| Constructor values | deploy tx calldata, cross-checked with state reads at deploy+1 |

Validation: replayed end-state equals on-chain state at block 14,121,413 — total_artifacts (158),
total_supply (111), official_tags (5), mint_price, mint_token, is_minting, contract_uri, and the
artifact id of all 111 tokens. Zero anomalies.

## Admin timeline (the interesting part)

The setters were never called from the owner account directly — they went through **SNIP-9
session-key txs** (a relayer submits, the owner account executes), so they were invisible to
tx scans. Historical state bisection found them all:

| Block | Change | Tx |
|---|---|---|
| 3,588,187 | deploy: price 666.67 STRK, token STRK, minting off | `0x680a47c8…` |
| 3,588,276 | price → 222.22 STRK | `0x21e39e67…` |
| 4,012,685 | price → 25,000,000 | `0xba8a47f8…` |
| 4,012,690 | token → USDC (`0x033068f6…`) | `0x69fcc78f…` |
| 4,012,701 | minting → on | `0x3716766e…` |

So the live price is 25 USDC (6 decimals). No mints ever happened after the constructor's 111 —
all 71 later transfers were secondary market / wallet moves (24 artifact-preserving, 47 wipes).

## Done

- [x] 182 Transfers (chain) + 182 assignment ghosts (158 Assigned / 24 Preserved)
- [x] 56 old-shape ArtifactEngraved normalized (chain) + 55 initial engravings (ghost)
- [x] 5 TagRegistered with indices 1–5 (chain)
- [x] Admin timeline ghosts: 3× MintPriceUpdated, 2× MintTokenUpdated, 2× MintingStatusUpdated, ContractURIUpdated, BaseURIUpdated
- [x] 1 Upgraded (Aug 29 v1.0.0, chain)
- [x] constants: max_supply = 1111
- [x] Applied to Supabase; views verified (v_collection: supply 111, 25 USDC, minting on)

## Needs input

| # | Question | What we know | Answer |
|---|----------|--------------|--------|
| 1 | Eyeball the admin timeline above — match your memory? | Found via state bisection, txs confirmed | |
