create table if not exists events (
  id bigint generated always as identity primary key,
  contract text not null,
  block_number bigint not null,
  block_hash text not null,
  block_timestamp bigint not null,
  tx_hash text not null,
  event_index int not null,
  name text not null,
  payload jsonb not null,
  source text not null default 'chain'
);
create index if not exists events_name_idx on events (name);
create index if not exists events_block_idx on events (block_number);
create index if not exists events_token_idx on events ((payload ->> 'token_id'));

create table if not exists checkpoints (
  contract text primary key,
  block_number bigint not null,
  block_hash text not null
);

create table if not exists recent_blocks (
  contract text not null,
  block_number bigint not null,
  block_hash text not null,
  primary key (contract, block_number)
);

create table if not exists constants (
  key text primary key,
  value text not null
);

-- Latest owner + artifact per token.
create or replace view v_tokens with (security_invoker = true) as
with last_transfer as (
  select distinct on (payload ->> 'token_id')
    payload ->> 'token_id' as token_id,
    payload ->> 'to' as owner
  from events
  where name = 'Transfer'
  order by payload ->> 'token_id', block_number desc, id desc
),
last_artifact as (
  select distinct on (payload ->> 'token_id')
    payload ->> 'token_id' as token_id,
    payload ->> 'artifact_id' as artifact_id
  from events
  where name in ('ArtifactAssigned', 'ArtifactPreserved')
  order by payload ->> 'token_id', block_number desc, id desc
)
select t.token_id, t.owner, a.artifact_id
from last_transfer t
left join last_artifact a using (token_id);

-- Single-row collection state.
create or replace view v_collection with (security_invoker = true) as
select
  (select count(*) from v_tokens) as total_supply,
  (select value from constants where key = 'max_supply') as max_supply,
  (select payload ->> 'new_price' from events where name = 'MintPriceUpdated' order by block_number desc, id desc limit 1) as mint_price,
  (select payload ->> 'new_token' from events where name = 'MintTokenUpdated' order by block_number desc, id desc limit 1) as mint_token,
  (select (payload ->> 'enabled')::boolean from events where name = 'MintingStatusUpdated' order by block_number desc, id desc limit 1) as is_minting;

-- Current engraving data per (artifact, tag). Full history is just the events table.
create or replace view v_engravings with (security_invoker = true) as
select distinct on (payload ->> 'artifact_id', payload ->> 'tag')
  payload ->> 'artifact_id' as artifact_id,
  payload ->> 'tag' as tag,
  (payload ->> 'nonce')::int as nonce,
  payload ->> 'new_data' as data,
  block_number,
  tx_hash
from events
where name = 'ArtifactEngraved'
order by payload ->> 'artifact_id', payload ->> 'tag', block_number desc, id desc;
