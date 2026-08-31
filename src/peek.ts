import { loadChainConfig } from "./config.js";
import { makeProvider, fetchRawEvents } from "./chain.js";
import { decodeEvent } from "./decode.js";

const [from, to] = process.argv.slice(2).map(Number);
if (!from || !to || from > to) {
  console.error("usage: pnpm peek <fromBlock> <toBlock>");
  process.exit(1);
}

const config = loadChainConfig();
const provider = makeProvider(config.rpcUrl);
const raw = await fetchRawEvents(provider, config.contractAddress, from, to);

for (const e of raw) {
  let decoded;
  try {
    decoded = decodeEvent(e.keys, e.data);
  } catch {
    decoded = { name: "unparsed", payload: { keys: e.keys, data: e.data } };
  }
  console.log(JSON.stringify({ block: e.blockNumber, tx: e.txHash, ...decoded }));
}
console.error(`${raw.length} events in blocks ${from}-${to}`);
