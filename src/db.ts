import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { DecodedEvent, RawEvent } from "./decode.js";

export type StoredEvent = RawEvent &
  DecodedEvent & { eventIndex: number; blockTimestamp: number };

export interface Checkpoint {
  blockNumber: number;
  blockHash: string;
}

export const makeDb = (url: string) => new Pool({ connectionString: url });

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = path.resolve(import.meta.dirname, "../sql");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const applied = await pool.query(
      "select 1 from _migrations where name = $1",
      [file],
    );
    if (applied.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
      console.log(`migration applied: ${file}`);
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function getCheckpoint(
  pool: Pool,
  contract: string,
): Promise<Checkpoint | null> {
  const res = await pool.query(
    "select block_number, block_hash from checkpoints where contract = $1",
    [contract],
  );
  if (!res.rowCount) return null;
  return {
    blockNumber: Number(res.rows[0].block_number),
    blockHash: res.rows[0].block_hash,
  };
}

export async function writeChunk(
  pool: Pool,
  contract: string,
  events: StoredEvent[],
  toBlock: number,
  toHash: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const e of events) {
      await client.query(
        "insert into events (contract, block_number, block_hash, block_timestamp, tx_hash, event_index, name, payload) values ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          contract,
          e.blockNumber,
          e.blockHash,
          e.blockTimestamp,
          e.txHash,
          e.eventIndex,
          e.name,
          JSON.stringify(e.payload),
        ],
      );
    }
    await client.query(
      "insert into recent_blocks (contract, block_number, block_hash) values ($1,$2,$3) on conflict (contract, block_number) do update set block_hash = excluded.block_hash",
      [contract, toBlock, toHash],
    );
    await client.query(
      "delete from recent_blocks where contract = $1 and block_number < $2",
      [contract, toBlock - 100],
    );
    await client.query(
      "insert into checkpoints (contract, block_number, block_hash) values ($1,$2,$3) on conflict (contract) do update set block_number = excluded.block_number, block_hash = excluded.block_hash",
      [contract, toBlock, toHash],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function getRecentBlocks(
  pool: Pool,
  contract: string,
): Promise<Checkpoint[]> {
  const res = await pool.query(
    "select block_number, block_hash from recent_blocks where contract = $1 order by block_number desc",
    [contract],
  );
  return res.rows.map((r) => ({
    blockNumber: Number(r.block_number),
    blockHash: r.block_hash,
  }));
}

export async function rollbackTo(
  pool: Pool,
  contract: string,
  block: Checkpoint,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "delete from events where contract = $1 and block_number > $2",
      [contract, block.blockNumber],
    );
    await client.query(
      "delete from recent_blocks where contract = $1 and block_number > $2",
      [contract, block.blockNumber],
    );
    await client.query(
      "update checkpoints set block_number = $2, block_hash = $3 where contract = $1",
      [contract, block.blockNumber, block.blockHash],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
