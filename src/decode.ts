import { hash } from "starknet";

export interface RawEvent {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  keys: string[];
  data: string[];
}

export interface DecodedEvent {
  name: string;
  payload: Record<string, unknown>;
}

// Cairo enum events: keys[0] is the variant selector, #[key] fields follow in
// keys, everything else is in data. u256 occupies two felts (low, high).
export const SELECTORS = {
  Transfer: hash.getSelectorFromName("Transfer"),
  ArtifactEngraved: hash.getSelectorFromName("ArtifactEngraved"),
  ArtifactAssigned: hash.getSelectorFromName("ArtifactAssigned"),
  ArtifactPreserved: hash.getSelectorFromName("ArtifactPreserved"),
  TagRegistered: hash.getSelectorFromName("TagRegistered"),
  TagReregistered: hash.getSelectorFromName("TagReregistered"),
  MintPriceUpdated: hash.getSelectorFromName("MintPriceUpdated"),
  MintTokenUpdated: hash.getSelectorFromName("MintTokenUpdated"),
  MintingStatusUpdated: hash.getSelectorFromName("MintingStatusUpdated"),
  ContractURIUpdated: hash.getSelectorFromName("ContractURIUpdated"),
  BaseURIUpdated: hash.getSelectorFromName("BaseURIUpdated"),
  Upgraded: hash.getSelectorFromName("Upgraded"),
} as const;

export const SELECTOR_LIST = Object.values(SELECTORS);

export const hex = (felt: string): string => "0x" + BigInt(felt).toString(16);

export const u256 = (low: string, high: string): string =>
  (BigInt(low) + (BigInt(high) << 128n)).toString();

const feltBytes = (felt: string, byteLength: number): Buffer =>
  Buffer.from(BigInt(felt).toString(16).padStart(byteLength * 2, "0"), "hex");

// alexandria Bytes: [size, chunk_count, ...u128 chunks]
export const bytesToString = (data: string[]): string => {
  const size = Number(data[0]);
  const count = Number(data[1]);
  const parts = [];
  for (let i = 0; i < count; i++) parts.push(feltBytes(data[2 + i], 16));
  return Buffer.concat(parts).subarray(0, size).toString("utf8");
};

// ByteArray: [word_count, ...bytes31 words, pending_word, pending_word_len]
export const byteArrayToString = (data: string[]): string => {
  const wordCount = Number(data[0]);
  const parts = [];
  for (let i = 0; i < wordCount; i++) parts.push(feltBytes(data[1 + i], 31));
  const pendingLength = Number(data[wordCount + 2]);
  if (pendingLength > 0)
    parts.push(feltBytes(data[wordCount + 1], pendingLength));
  return Buffer.concat(parts).toString("utf8");
};

export function decodeEvent(keys: string[], data: string[]): DecodedEvent {
  switch (keys[0]) {
    case SELECTORS.Transfer:
      return {
        name: "Transfer",
        payload: {
          from: hex(keys[1]),
          to: hex(keys[2]),
          token_id: u256(keys[3], keys[4]),
        },
      };
    case SELECTORS.ArtifactEngraved:
      return {
        name: "ArtifactEngraved",
        payload: {
          token_id: u256(keys[1], keys[2]),
          artifact_id: hex(keys[3]),
          tag: hex(keys[4]),
          nonce: Number(data[0]),
          new_data: bytesToString(data.slice(1)),
        },
      };
    case SELECTORS.ArtifactAssigned:
      return {
        name: "ArtifactAssigned",
        payload: {
          token_id: u256(keys[1], keys[2]),
          artifact_id: hex(keys[3]),
          previous_artifact_id: hex(data[0]),
        },
      };
    case SELECTORS.ArtifactPreserved:
      return {
        name: "ArtifactPreserved",
        payload: {
          token_id: u256(keys[1], keys[2]),
          artifact_id: hex(keys[3]),
          from: hex(data[0]),
          to: hex(data[1]),
        },
      };
    case SELECTORS.TagRegistered:
      return {
        name: "TagRegistered",
        payload: { index: Number(data[0]), new_tag: hex(data[1]) },
      };
    case SELECTORS.TagReregistered:
      return {
        name: "TagReregistered",
        payload: {
          index: Number(data[0]),
          old_tag: hex(data[1]),
          new_tag: hex(data[2]),
        },
      };
    case SELECTORS.MintPriceUpdated:
      return {
        name: "MintPriceUpdated",
        payload: {
          old_price: u256(data[0], data[1]),
          new_price: u256(data[2], data[3]),
        },
      };
    case SELECTORS.MintTokenUpdated:
      return {
        name: "MintTokenUpdated",
        payload: { old_token: hex(data[0]), new_token: hex(data[1]) },
      };
    case SELECTORS.MintingStatusUpdated:
      return {
        name: "MintingStatusUpdated",
        payload: { enabled: BigInt(data[0]) !== 0n },
      };
    case SELECTORS.ContractURIUpdated:
      return {
        name: "ContractURIUpdated",
        payload: { new_uri: byteArrayToString(data) },
      };
    case SELECTORS.BaseURIUpdated:
      return {
        name: "BaseURIUpdated",
        payload: { new_uri: byteArrayToString(data) },
      };
    case SELECTORS.Upgraded:
      return { name: "Upgraded", payload: { class_hash: hex(data[0]) } };
    default:
      throw new Error(`Unknown event selector: ${keys[0]}`);
  }
}
