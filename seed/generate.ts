import fs from "node:fs";
import path from "node:path";
import { RpcProvider, hash } from "starknet";
import {
  SELECTORS,
  hex,
  u256,
  bytesToString,
  byteArrayToString,
} from "../src/decode.js";

const CONTRACT =
  "0x03d7811b831bfb98d3c3ac9d7dcc28b43445c35afc82a931d5c06ebc2804f740";
const WINDOW_START = 3_588_187; // deploy block
const WINDOW_END = 14_121_414; // upgrade block (exclusive)
const DEPLOY_TX =
  "0x680a47c83d9463071d653e7bba2aa1b14bfcf11b31f78c5c427c300572e43f1";

const DATA_DIR = path.resolve(import.meta.dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const provider = new RpcProvider({
  nodeUrl:
    process.env.RPC_URL ??
    "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_8",
});

const cachePath = (name: string) => path.join(DATA_DIR, name);
const loadCache = (name: string) =>
  fs.existsSync(cachePath(name))
    ? JSON.parse(fs.readFileSync(cachePath(name), "utf8"))
    : null;
const saveCache = (name: string, data: unknown) =>
  fs.writeFileSync(cachePath(name), JSON.stringify(data, null, 2));

// Historical state read at a block. The contract's setters were called via SNIP-9
// session-key txs (invisible to tx scans), so state reads are the ground truth.
const readAt = (entrypoint: string, block: number, calldata: string[] = []) =>
  provider.callContract({ contractAddress: CONTRACT, entrypoint, calldata }, block);

const readU256At = async (entrypoint: string, block: number) =>
  u256(...((await readAt(entrypoint, block)) as [string, string]));

// ---------- stage 1: every event the contract ever emitted pre-upgrade ----------

interface RawEvent {
  block: number;
  tx: string;
  keys: string[];
  data: string[];
}

async function pullEvents(): Promise<RawEvent[]> {
  const cached = loadCache("events.json");
  if (cached) return cached;

  const all: RawEvent[] = [];
  const CHUNK = 100_000;
  for (let from = WINDOW_START; from < WINDOW_END; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, WINDOW_END - 1);
    let token: string | undefined;
    do {
      const page = await provider.getEvents({
        address: CONTRACT,
        from_block: { block_number: from },
        to_block: { block_number: to },
        chunk_size: 1000,
        continuation_token: token,
      });
      for (const e of page.events) {
        all.push({
          block: e.block_number,
          tx: e.transaction_hash,
          keys: e.keys,
          data: e.data,
        });
      }
      token = page.continuation_token ?? undefined;
    } while (token);
    console.log(`events ${from}-${to}: running total ${all.length}`);
  }
  saveCache("events.json", all);
  return all;
}

interface BlockInfo {
  hash: string;
  timestamp: number;
}

async function blockInfos(blocks: number[]): Promise<Map<number, BlockInfo>> {
  const cached = loadCache("block_infos.json") ?? {};
  const map = new Map<number, BlockInfo>(
    Object.entries(cached).map(([k, v]) => [Number(k), v as BlockInfo]),
  );
  for (const b of blocks) {
    if (map.has(b)) continue;
    const block = await provider.getBlock(b);
    if (!("block_hash" in block) || !block.block_hash)
      throw new Error(`block ${b} pending`);
    map.set(b, { hash: block.block_hash, timestamp: block.timestamp });
  }
  saveCache("block_infos.json", Object.fromEntries(map));
  return map;
}

// ---------- stage 2: empirical artifact-assignment snapshots ----------

// token_ids_to_artifact_ids for every minted token, at each block that has a
// transfer. Diffing consecutive snapshots classifies every transfer as
// wipe (artifact changed -> Assigned) or save (unchanged -> Preserved).
async function artifactSnapshots(
  events: RawEvent[],
): Promise<{ snaps: Map<number, Map<string, string>>; mintedBy: (b: number) => string[] }> {
  const cached = loadCache("snapshots.json");
  let snaps: Map<number, Map<string, string>>;
  const transferBlocks = [
    ...new Set(
      events.filter((e) => e.keys[0] === SELECTORS.Transfer).map((e) => e.block),
    ),
  ].sort((a, b) => a - b);

  const mintedBy = (b: number) => {
    let n = 0;
    for (const e of events) {
      if (e.block > b) break;
      if (e.keys[0] === SELECTORS.Transfer && BigInt(e.keys[1]) === 0n) n++;
    }
    return Array.from({ length: n }, (_, i) => String(i + 1));
  };

  if (cached) {
    snaps = new Map(
      Object.entries(cached).map(([k, v]) => [
        Number(k),
        new Map(Object.entries(v as Record<string, string>)),
      ]),
    );
  } else {
    snaps = new Map();
    for (const b of [WINDOW_START, ...transferBlocks]) {
      const ids = mintedBy(b);
      const res = await readAt(
        "token_ids_to_artifact_ids",
        b,
        [String(ids.length), ...ids.flatMap((id) => [id, "0"])],
      );
      const m = new Map<string, string>();
      for (let i = 0; i < ids.length; i++) m.set(ids[i], hex(res[1 + i]));
      snaps.set(b, m);
    }
    saveCache(
      "snapshots.json",
      Object.fromEntries([...snaps].map(([k, v]) => [k, Object.fromEntries(v)])),
    );
  }
  console.log(`stage 2: artifact snapshots at ${snaps.size} blocks`);
  return { snaps, mintedBy };
}

// snapshot of the last transfer block <= b (or the deploy snapshot)
function snapAt(snaps: Map<number, Map<string, string>>, b: number): Map<string, string> {
  let best: Map<string, string> | undefined;
  for (const [block, m] of snaps) {
    if (block > b) break;
    best = m;
  }
  if (!best) throw new Error(`no snapshot for block ${b}`);
  return best;
}

// ---------- stage 3: admin-state changes via iterative bisection ----------

interface StateChange {
  entrypoint: string;
  block: number;
  from: string;
  to: string;
  tx: string | null;
}

async function findStateChanges(
  entrypoint: string,
  read: (block: number) => Promise<string>,
): Promise<StateChange[]> {
  const changes: StateChange[] = [];
  let lo = WINDOW_START;
  let current = await read(WINDOW_START);
  const end = await read(WINDOW_END - 1);
  while (current !== end) {
    // first block in (lo, WINDOW_END) whose value differs from current
    let hi = WINDOW_END - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if ((await read(mid)) === current) lo = mid;
      else hi = mid;
    }
    const next = await read(hi);
    changes.push({ entrypoint, block: hi, from: current, to: next, tx: null });
    current = next;
    lo = hi;
  }
  return changes;
}

// The setters were called via SNIP-9 outside-execution txs: the contract address
// sits inside the calldata of a tx sent by a relayer to the owner account.
async function findChangeTx(block: number): Promise<string | null> {
  const b = await provider.getBlockWithTxs(block);
  for (const tx of b.transactions) {
    if (tx.type !== "INVOKE" || !("calldata" in tx)) continue;
    if ((tx.calldata as string[]).some((f) => BigInt(f) === BigInt(CONTRACT)))
      return tx.transaction_hash;
  }
  return null;
}

async function adminChanges(): Promise<StateChange[]> {
  const cached = loadCache("admin_changes.json");
  if (cached) return cached;

  const changes: StateChange[] = [];
  changes.push(...(await findStateChanges("mint_price", readU256At.bind(null, "mint_price"))));
  changes.push(
    ...(await findStateChanges("mint_token", async (b) => hex((await readAt("mint_token", b))[0]))),
  );
  changes.push(
    ...(await findStateChanges("is_minting", async (b) =>
      BigInt((await readAt("is_minting", b))[0]) !== 0n ? "true" : "false",
    )),
  );
  changes.push(
    ...(await findStateChanges("contract_uri", async (b) =>
      byteArrayToString(await readAt("contract_uri", b)),
    )),
  );
  // base_uri has no getter; token_uri(1) is base_uri + "1" while supply >= 1
  changes.push(
    ...(await findStateChanges("base_uri", async (b) =>
      byteArrayToString(await readAt("token_uri", b, ["1", "0"])),
    )),
  );

  for (const c of changes) c.tx = await findChangeTx(c.block);
  saveCache("admin_changes.json", changes);
  for (const c of changes) {
    console.log(
      `stage 3: ${c.entrypoint} ${c.from.slice(0, 40)} -> ${c.to.slice(0, 40)} at block ${c.block} (tx ${c.tx?.slice(0, 14) ?? "NOT FOUND"}…)`,
    );
  }
  return changes;
}

// ---------- stage 4: replay ----------

interface SeedRow {
  block: number;
  tx: string;
  name: string;
  payload: Record<string, unknown>;
  source: "chain" | "ghost";
}

// Cursor for the old-shape ArtifactEngraved data layout:
// [token_id.lo, token_id.hi, old.tag, old.Bytes..., new.tag, new.Bytes...]
class Cursor {
  constructor(
    private data: string[],
    private at = 0,
  ) {}
  next(): string {
    return this.data[this.at++];
  }
  u256(): string {
    return u256(this.next(), this.next());
  }
  bytes(): string {
    const size = Number(this.next());
    const count = Number(this.next());
    const end = this.at + count;
    const out = bytesToString([
      String(size),
      String(count),
      ...this.data.slice(this.at, end),
    ]);
    this.at = end;
    return out;
  }
  byteArray(): string {
    const words = Number(this.next());
    const end = this.at + words;
    const pending = this.data[end];
    const pendingLen = this.data[end + 1];
    const out = byteArrayToString([
      String(words),
      ...this.data.slice(this.at, end),
      pending,
      pendingLen,
    ]);
    this.at = end + 2;
    return out;
  }
  rest(): string[] {
    return this.data.slice(this.at);
  }
}

const TAGS = ["TITLE", "MESSAGE", "URL", "X_HANDLE", "GITHUB_HANDLE"];
const TITLES = [
  "The Southpaw",
  "Hello, Milkyway",
  "Exoplants",
  "Type III Civilizations",
  "Primates On A Rock Paying Taxes",
  "Stuck In A Matrix",
  "Awareness",
  "...",
  "Free The Nip",
  "Binary",
  "<3",
];
const tagFelt = (tag: string) =>
  "0x" + BigInt("0x" + Buffer.from(tag, "utf8").toString("hex")).toString(16);

async function replay(
  events: RawEvent[],
  snaps: Map<number, Map<string, string>>,
  admin: StateChange[],
): Promise<{ rows: SeedRow[]; anomalies: string[] }> {
  const rows: SeedRow[] = [];
  const anomalies: string[] = [];

  // constructor args from the deploy tx (UDC deployContract call)
  const deployTx = await provider.getTransaction(DEPLOY_TX);
  if (!("calldata" in deployTx)) throw new Error("deploy tx has no calldata");
  const udcData = (deployTx.calldata as string[]).slice(4); // [1, udc, sel, len, ...data]
  const c = new Cursor(udcData);
  c.next(); // class hash
  c.next(); // salt
  c.next(); // unique
  c.next(); // ctor args length
  const ctor = new Cursor(c.rest());
  ctor.next(); // owner
  ctor.byteArray(); // name
  ctor.byteArray(); // symbol
  const baseUri = ctor.byteArray();
  const contractUri = ctor.byteArray();

  const push = (
    block: number,
    tx: string,
    name: string,
    payload: Record<string, unknown>,
    source: "chain" | "ghost",
  ) => rows.push({ block, tx, name, payload, source });

  // constructor-state ghosts happened first inside the deploy tx
  push(WINDOW_START, DEPLOY_TX, "MintTokenUpdated", { old_token: "0x0", new_token: hex((await readAt("mint_token", WINDOW_START + 1))[0]) }, "ghost");
  push(WINDOW_START, DEPLOY_TX, "MintPriceUpdated", { old_price: "0", new_price: await readU256At("mint_price", WINDOW_START + 1) }, "ghost");
  push(WINDOW_START, DEPLOY_TX, "MintingStatusUpdated", { enabled: BigInt((await readAt("is_minting", WINDOW_START + 1))[0]) !== 0n }, "ghost");
  push(WINDOW_START, DEPLOY_TX, "ContractURIUpdated", { new_uri: byteArrayToString(await readAt("contract_uri", WINDOW_START + 1)) }, "ghost");
  push(WINDOW_START, DEPLOY_TX, "BaseURIUpdated", { new_uri: baseUri }, "ghost");

  // admin-change ghosts at their change blocks
  const ADMIN_EVENT: Record<string, string> = {
    mint_price: "MintPriceUpdated",
    mint_token: "MintTokenUpdated",
    is_minting: "MintingStatusUpdated",
    contract_uri: "ContractURIUpdated",
    base_uri: "BaseURIUpdated",
  };
  for (const ch of admin) {
    if (!ch.tx) anomalies.push(`block ${ch.block}: no tx found for ${ch.entrypoint} change`);
    const payload =
      ch.entrypoint === "mint_price"
        ? { old_price: ch.from, new_price: ch.to }
        : ch.entrypoint === "mint_token"
          ? { old_token: ch.from, new_token: ch.to }
          : ch.entrypoint === "is_minting"
            ? { enabled: ch.to === "true" }
            : ch.entrypoint === "contract_uri"
              ? { new_uri: ch.to }
              : { new_uri: ch.to.endsWith("1") ? ch.to.slice(0, -1) : ch.to }; // token_uri(1) minus id
    push(ch.block, ch.tx ?? "0x0", ADMIN_EVENT[ch.entrypoint], payload, "ghost");
  }

  // replay state for engraving nonces/content
  const tagNonce = new Map<string, number>();
  const content = new Map<string, string>(); // "artifact:tag:nonce" -> data
  const registry = new Map<number, string>();
  let initialGhostsDone = false;

  for (const e of events) {
    const sel = e.keys[0];
    if (sel === SELECTORS.Transfer) {
      const from = hex(e.keys[1]);
      const to = hex(e.keys[2]);
      const tokenId = u256(e.keys[3], e.keys[4]);
      push(e.block, e.tx, "Transfer", { from, to, token_id: tokenId }, "chain");

      const before = snapAt(snaps, Math.max(e.block - 1, WINDOW_START)).get(tokenId);
      const after = snapAt(snaps, e.block).get(tokenId);
      if (!after) {
        anomalies.push(`${e.block} tx ${e.tx}: token ${tokenId} missing from snapshot`);
        continue;
      }
      if (from === "0x0" || before !== after) {
        push(e.block, e.tx, "ArtifactAssigned", { token_id: tokenId, artifact_id: after, previous_artifact_id: from === "0x0" ? "0x0" : before }, "ghost");
      } else {
        push(e.block, e.tx, "ArtifactPreserved", { token_id: tokenId, artifact_id: after, from, to }, "ghost");
      }

      // initial engravings ran at the end of the constructor, after the 111 mints
      if (!initialGhostsDone && e.block === WINDOW_START && tokenId === "111") {
        initialGhostsDone = true;
        const s0 = snapAt(snaps, WINDOW_START);
        for (let i = 1; i <= 11; i++) {
          const artifactId = s0.get(String(i))!;
          const values: Record<string, string> = {
            TITLE: TITLES[i - 1],
            MESSAGE: "",
            URL: "https://novemberfork.io",
            X_HANDLE: "DegenDeveloper",
            GITHUB_HANDLE: "NovemberFork",
          };
          for (const tag of TAGS) {
            const felt = tagFelt(tag);
            const key = `${artifactId}:${felt}`;
            const nonce = (tagNonce.get(key) ?? 0) + 1;
            tagNonce.set(key, nonce);
            content.set(`${key}:${nonce}`, values[tag]);
            push(WINDOW_START, DEPLOY_TX, "ArtifactEngraved", { token_id: String(i), artifact_id: artifactId, tag: felt, nonce, new_data: values[tag] }, "ghost");
          }
        }
      }
    } else if (sel === SELECTORS.ArtifactEngraved) {
      const cur = new Cursor(e.data);
      const tokenId = cur.u256();
      const oldTag = cur.next();
      const oldData = cur.bytes();
      const newTag = cur.next();
      const newData = cur.bytes();
      if (oldTag !== newTag) anomalies.push(`${e.block} tx ${e.tx}: tag changed mid-engrave?`);

      const artifactId = snapAt(snaps, e.block).get(tokenId);
      if (!artifactId) {
        anomalies.push(`${e.block} tx ${e.tx}: engrave for unknown token ${tokenId}`);
        continue;
      }
      const key = `${artifactId}:${newTag}`;
      const nonce = (tagNonce.get(key) ?? 0) + 1;
      const expectedOld = content.get(`${key}:${nonce - 1}`) ?? "";
      if (expectedOld !== oldData) {
        anomalies.push(
          `${e.block} tx ${e.tx}: old_data mismatch on ${key} nonce ${nonce}: chain says ${JSON.stringify(oldData)}, replay has ${JSON.stringify(expectedOld)}`,
        );
      }
      tagNonce.set(key, nonce);
      content.set(`${key}:${nonce}`, newData);
      push(e.block, e.tx, "ArtifactEngraved", { token_id: tokenId, artifact_id: artifactId, tag: hex(newTag), nonce, new_data: newData }, "chain");
    } else if (sel === SELECTORS.TagRegistered) {
      const index = registry.size + 1;
      registry.set(index, e.data[0]);
      push(e.block, e.tx, "TagRegistered", { index, new_tag: hex(e.data[0]) }, "chain");
    } else if (sel === SELECTORS.TagReregistered) {
      const oldTag = e.data[0];
      const newTag = e.data[1];
      const index = [...registry.entries()].find(([, t]) => BigInt(t) === BigInt(oldTag))?.[0];
      if (!index) {
        anomalies.push(`${e.block} tx ${e.tx}: reregister of unknown tag ${oldTag}`);
        continue;
      }
      registry.set(index, newTag);
      push(e.block, e.tx, "TagReregistered", { index, old_tag: hex(oldTag), new_tag: hex(newTag) }, "chain");
    } else if (sel === SELECTORS.Upgraded) {
      push(e.block, e.tx, "Upgraded", { class_hash: hex(e.data[0]) }, "chain");
    }
    // OwnershipTransferred (deploy init), Approval*: not indexed by the poller, skip
  }

  rows.sort((a, b) => a.block - b.block);
  return { rows, anomalies };
}

// ---------- stage 5: validate replayed end-state against the chain ----------

async function validate(rows: SeedRow[]): Promise<string[]> {
  const issues: string[] = [];
  const at = WINDOW_END - 1;

  const assigned = rows.filter((r) => r.name === "ArtifactAssigned").length;
  const totalArtifacts = Number((await readAt("total_artifacts", at))[0]);
  if (totalArtifacts !== assigned)
    issues.push(`total_artifacts: chain ${totalArtifacts} vs replay ${assigned}`);

  const minted = rows.filter((r) => r.name === "Transfer" && r.payload.from === "0x0").length;
  if ((await readU256At("total_supply", at)) !== String(minted))
    issues.push(`total_supply: chain ${await readU256At("total_supply", at)} vs replay ${minted}`);

  const tagCount = Number((await readAt("official_tags", at))[0]);
  if (tagCount !== 5) issues.push(`official_tags: chain has ${tagCount}, expected 5`);

  const last = (name: string) => [...rows].reverse().find((r) => r.name === name);
  if ((await readU256At("mint_price", at)) !== String(last("MintPriceUpdated")?.payload.new_price))
    issues.push("mint_price mismatch");
  if (hex((await readAt("mint_token", at))[0]) !== last("MintTokenUpdated")?.payload.new_token)
    issues.push("mint_token mismatch");
  if ((BigInt((await readAt("is_minting", at))[0]) !== 0n) !== Boolean(last("MintingStatusUpdated")?.payload.enabled))
    issues.push("is_minting mismatch");
  if (byteArrayToString(await readAt("contract_uri", at)) !== last("ContractURIUpdated")?.payload.new_uri)
    issues.push("contract_uri mismatch");

  // final artifact id of every token
  const seedArtifacts = new Map(
    rows
      .filter((r) => r.name === "ArtifactAssigned" || r.name === "ArtifactPreserved")
      .map((r) => [String(r.payload.token_id), String(r.payload.artifact_id)]),
  );
  const ids = [...seedArtifacts.keys()].sort((a, b) => Number(a) - Number(b));
  const res = await readAt("token_ids_to_artifact_ids", at, [
    String(ids.length),
    ...ids.flatMap((id) => [id, "0"]),
  ]);
  for (let i = 0; i < ids.length; i++) {
    if (BigInt(res[1 + i]) !== BigInt(seedArtifacts.get(ids[i])!))
      issues.push(`token ${ids[i]} artifact: chain ${res[1 + i]} vs seed ${seedArtifacts.get(ids[i])}`);
  }

  return issues;
}

// ---------- stage 6: emit seed.sql ----------

function emitSql(rows: SeedRow[], infos: Map<number, BlockInfo>): string {
  const perBlock = new Map<number, number>();
  const values = rows.map((r) => {
    const idx = perBlock.get(r.block) ?? 0;
    perBlock.set(r.block, idx + 1);
    const info = infos.get(r.block)!;
    const payload = JSON.stringify(r.payload).replaceAll("'", "''");
    return `  ('${CONTRACT}', ${r.block}, '${info.hash}', ${info.timestamp}, '${r.tx}', ${idx}, '${r.name}', '${payload}', '${r.source}')`;
  });
  const inserts: string[] = [];
  for (let i = 0; i < values.length; i += 100) {
    inserts.push(`insert into events (contract, block_number, block_hash, block_timestamp, tx_hash, event_index, name, payload, source) values
${values.slice(i, i + 100).join(",\n")};`);
  }
  return `-- Etheracts pre-upgrade seed, blocks ${WINDOW_START}-${WINDOW_END - 1}. Generated by seed/generate.ts — do not edit by hand.
-- DELETE does not reset identity sequences; setval below restarts at 1 when only seed
-- rows remain, or continues after max(id) when live post-genesis events exist.
begin;
delete from events where block_number < ${WINDOW_END};
select setval(
  pg_get_serial_sequence('events', 'id'),
  coalesce((select max(id) from events), 1),
  (select max(id) from events) is not null
);
delete from constants where key = 'max_supply';
insert into constants (key, value) values ('max_supply', '1111');
${inserts.join("\n")}
commit;
`;
}

// ---------- run ----------

const events = await pullEvents();
console.log(`stage 1: ${events.length} events`);

const { snaps } = await artifactSnapshots(events);
const admin = await adminChanges();

const { rows, anomalies } = await replay(events, snaps, admin);
console.log(`stage 4: ${rows.length} seed rows (${rows.filter((r) => r.source === "ghost").length} ghost)`);

const issues = await validate(rows);
const infos = await blockInfos([...new Set(rows.map((r) => r.block))]);
fs.writeFileSync(path.resolve(import.meta.dirname, "seed.sql"), emitSql(rows, infos));
console.log(`stage 5: seed.sql written`);

if (anomalies.length || issues.length) {
  console.log("\nNEEDS INPUT:");
  for (const a of [...anomalies, ...issues]) console.log(`  - ${a}`);
} else {
  console.log("\nall checks passed — replay matches on-chain state at the upgrade block");
}
