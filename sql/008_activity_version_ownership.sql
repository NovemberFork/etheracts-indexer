-- Logical activity feed: one row per mint / wipe-transfer / save-transfer / engrave.
-- Save transfers are ArtifactPreserved only (paired Transfer is omitted).
-- Wipe transfers and mints come from Transfer rows without a matching preserve.
create or replace view v_activity with (security_invoker = true) as
select
  e.id,
  e.block_number,
  e.block_timestamp,
  e.tx_hash,
  e.event_index,
  e.source,
  'save-transfer'::text as kind,
  e.payload ->> 'token_id' as token_id,
  e.payload ->> 'from' as from_addr,
  e.payload ->> 'to' as to_addr,
  null::text as tag,
  null::text as data
from events e
where e.name = 'ArtifactPreserved'

union all

select
  e.id,
  e.block_number,
  e.block_timestamp,
  e.tx_hash,
  e.event_index,
  e.source,
  case
    when coalesce(e.payload ->> 'from', '0x0') in ('0x0', '0') then 'mint'
    else 'transfer'
  end as kind,
  e.payload ->> 'token_id' as token_id,
  e.payload ->> 'from' as from_addr,
  e.payload ->> 'to' as to_addr,
  null::text as tag,
  null::text as data
from events e
where e.name = 'Transfer'
  and not exists (
    select 1
    from events p
    where p.name = 'ArtifactPreserved'
      and p.tx_hash = e.tx_hash
      and p.payload ->> 'token_id' = e.payload ->> 'token_id'
  )

union all

select
  e.id,
  e.block_number,
  e.block_timestamp,
  e.tx_hash,
  e.event_index,
  e.source,
  'engrave'::text as kind,
  e.payload ->> 'token_id' as token_id,
  null::text as from_addr,
  null::text as to_addr,
  e.payload ->> 'tag' as tag,
  e.payload ->> 'new_data' as data
from events e
where e.name = 'ArtifactEngraved';

create index if not exists events_tx_token_idx
  on events (tx_hash, ((payload ->> 'token_id')));

-- Collection snapshot: add on-chain version + contract owner from events.
create or replace view v_collection with (security_invoker = true) as
select
  (select count(*) from v_tokens) as total_supply,
  (select value from constants where key = 'max_supply') as max_supply,
  (select payload ->> 'new_price' from events where name = 'MintPriceUpdated' order by block_number desc, id desc limit 1) as mint_price,
  (select payload ->> 'new_token' from events where name = 'MintTokenUpdated' order by block_number desc, id desc limit 1) as mint_token,
  (select (payload ->> 'enabled')::boolean from events where name = 'MintingStatusUpdated' order by block_number desc, id desc limit 1) as is_minting,
  (select (payload ->> 'new_version')::int from events where name = 'VersionUpdated' order by block_number desc, id desc limit 1) as version,
  (select payload ->> 'new_owner' from events where name = 'OwnershipTransferred' order by block_number desc, id desc limit 1) as owner;

-- Historical VersionUpdated ghosts (contract only started emitting these after v3+).
-- v1: constructor wrote version=1 on deploy (no event).
-- v2/v3: upgrades emitted Upgraded only; synthesize VersionUpdated beside those txs.
insert into events (contract, block_number, block_hash, block_timestamp, tx_hash, event_index, name, payload, source)
select *
from (
  values
    (
      '0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740',
      3588187::bigint,
      '0x2f572cfb3c47d56edb3e0983f3ea9477e366d3c443e7f4b0d96e6cef270828e',
      1763156682::bigint,
      '0x680a47c83d9463071d653e7bba2aa1b14bfcf11b31f78c5c427c300572e43f1',
      9990,
      'VersionUpdated',
      '{"old_version":0,"new_version":1}'::jsonb,
      'ghost'
    ),
    (
      '0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740',
      14069160::bigint,
      '0x494220695349684d2f763457449b8854fcf303913a805aee8c4aeae60f656fb',
      1788045121::bigint,
      '0x3d63750191f2497012eaa6be925e2c432ad6da51ad15bfe064472098c3bde24',
      9990,
      'VersionUpdated',
      '{"old_version":1,"new_version":2}'::jsonb,
      'ghost'
    ),
    (
      '0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740',
      14121414::bigint,
      '0x40f6cd3a4f8cd7e17ac1021800213a9fb5e8cf93e9a4746ae273dae200b6029',
      1788132923::bigint,
      '0x792eb8f9f58bac6d092ad454907fb53ef63c38cd3ebe5cd12233f093167d45',
      9990,
      'VersionUpdated',
      '{"old_version":2,"new_version":3}'::jsonb,
      'ghost'
    ),
    -- First upgrade *to* the VersionUpdated-emitting class still runs the old
    -- upgrade_contract, so this bump never emitted VersionUpdated on-chain.
    (
      '0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740',
      14260638::bigint,
      '0x7fbeb521c020b3ee59114ea00c64c5c5a67e82d44cb06b3a8e0be83ccab5ef',
      1788370204::bigint,
      '0x386947ce56ffdc3ac5365cf975b2f296e6050625886b78f2a2d49a491a80cf7',
      9990,
      'VersionUpdated',
      '{"old_version":3,"new_version":4}'::jsonb,
      'ghost'
    )
) as v(contract, block_number, block_hash, block_timestamp, tx_hash, event_index, name, payload, source)
where not exists (
  select 1 from events e
  where e.name = 'VersionUpdated'
    and e.tx_hash = v.tx_hash
    and (e.payload ->> 'new_version') = (v.payload ->> 'new_version')
);

-- Deploy-time ownership (OZ Ownable initializer). Not previously indexed.
insert into events (contract, block_number, block_hash, block_timestamp, tx_hash, event_index, name, payload, source)
select
  '0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740',
  3588187,
  '0x2f572cfb3c47d56edb3e0983f3ea9477e366d3c443e7f4b0d96e6cef270828e',
  1763156682,
  '0x680a47c83d9463071d653e7bba2aa1b14bfcf11b31f78c5c427c300572e43f1',
  9991,
  'OwnershipTransferred',
  '{"previous_owner":"0x0","new_owner":"0x280dcce9a73506ce6b5a1e605e8082b4c3ecb408d18e556968b7e8aac44cf2d"}'::jsonb,
  'ghost'
where not exists (
  select 1 from events e
  where e.name = 'OwnershipTransferred'
    and e.tx_hash = '0x680a47c83d9463071d653e7bba2aa1b14bfcf11b31f78c5c427c300572e43f1'
);
