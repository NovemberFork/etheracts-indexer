import { RpcProvider } from "starknet";
import { SELECTOR_LIST, type RawEvent } from "./decode.js";

export const makeProvider = (rpcUrl: string) =>
  new RpcProvider({ nodeUrl: rpcUrl });

export async function fetchRawEvents(
  provider: RpcProvider,
  address: string,
  fromBlock: number,
  toBlock: number,
): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  let token: string | undefined;
  do {
    const page = await provider.getEvents({
      address,
      from_block: { block_number: fromBlock },
      to_block: { block_number: toBlock },
      keys: [SELECTOR_LIST],
      chunk_size: 1000,
      continuation_token: token,
    });
    for (const e of page.events) {
      events.push({
        blockNumber: e.block_number,
        blockHash: e.block_hash,
        txHash: e.transaction_hash,
        keys: e.keys,
        data: e.data,
      });
    }
    token = page.continuation_token ?? undefined;
  } while (token);
  return events;
}

export interface BlockInfo {
  hash: string;
  timestamp: number;
}

export async function chainBlockInfo(
  provider: RpcProvider,
  blockNumber: number,
): Promise<BlockInfo> {
  const block = await provider.getBlock(blockNumber);
  const hash = "block_hash" in block ? block.block_hash : undefined;
  if (!hash) throw new Error(`block ${blockNumber} pending`);
  return { hash, timestamp: block.timestamp };
}
