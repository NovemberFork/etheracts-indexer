import type { RpcProvider } from "starknet";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { makeProvider, fetchRawEvents, chainBlockInfo } from "./chain.js";
import { decodeEvent } from "./decode.js";
import {
  makeDb,
  migrate,
  getCheckpoint,
  writeChunk,
  getRecentBlocks,
  rollbackTo,
  type Checkpoint,
  type StoredEvent,
} from "./db.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function repairReorg(
  provider: RpcProvider,
  pool: Pool,
  config: Config,
): Promise<Checkpoint> {
  for (const stored of await getRecentBlocks(pool, config.contractAddress)) {
    if ((await chainBlockInfo(provider, stored.blockNumber)).hash === stored.blockHash) {
      await rollbackTo(pool, config.contractAddress, stored);
      console.warn(`reorg: rolled back to block ${stored.blockNumber}`);
      return stored;
    }
  }
  throw new Error("reorg deeper than 100-block window; reset and resync");
}

async function syncTo(
  provider: RpcProvider,
  pool: Pool,
  config: Config,
  checkpoint: Checkpoint,
  target: number,
): Promise<Checkpoint> {
  if ((await chainBlockInfo(provider, checkpoint.blockNumber)).hash !== checkpoint.blockHash) {
    checkpoint = await repairReorg(provider, pool, config);
  }
  let from = checkpoint.blockNumber + 1;
  while (from <= target) {
    const to = Math.min(from + config.chunkBlocks - 1, target);
    const raw = await fetchRawEvents(provider, config.contractAddress, from, to);
    const infos = new Map<number, number>();
    await Promise.all(
      [...new Set(raw.map((e) => e.blockNumber))].map(async (b) =>
        infos.set(b, (await chainBlockInfo(provider, b)).timestamp),
      ),
    );
    const events: StoredEvent[] = [];
    let eventIndex = 0;
    let lastBlock = -1;
    for (const e of raw) {
      eventIndex = e.blockNumber === lastBlock ? eventIndex + 1 : 0;
      lastBlock = e.blockNumber;
      events.push({
        ...e,
        ...decodeEvent(e.keys, e.data),
        eventIndex,
        blockTimestamp: infos.get(e.blockNumber)!,
      });
    }
    const { hash } = await chainBlockInfo(provider, to);
    await writeChunk(pool, config.contractAddress, events, to, hash);
    console.log(`${from}-${to}: ${events.length} events`);
    checkpoint = { blockNumber: to, blockHash: hash };
    from = to + 1;
  }
  return checkpoint;
}

export async function runIndexer(config: Config): Promise<void> {
  const provider = makeProvider(config.rpcUrl);
  const pool = makeDb(config.databaseUrl);
  await migrate(pool);

  let checkpoint = await getCheckpoint(pool, config.contractAddress);
  if (!checkpoint) {
    checkpoint = {
      blockNumber: config.startBlock - 1,
      blockHash: (await chainBlockInfo(provider, config.startBlock - 1)).hash,
    };
    console.log(`genesis: starting at block ${config.startBlock}`);
  }

  while (true) {
    try {
      const latest = await provider.getBlockNumber();
      const target = latest - config.confirmations;
      if (checkpoint.blockNumber < target) {
        checkpoint = await syncTo(provider, pool, config, checkpoint, target);
      }
    } catch (err) {
      console.error("poll error:", err);
    }
    await sleep(config.pollMs);
  }
}
