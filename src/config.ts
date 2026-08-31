const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

export interface ChainConfig {
  rpcUrl: string;
  contractAddress: string;
  startBlock: number;
}

export interface Config extends ChainConfig {
  databaseUrl: string;
  confirmations: number;
  pollMs: number;
  chunkBlocks: number;
}

export function loadChainConfig(): ChainConfig {
  return {
    rpcUrl: required("RPC_URL"),
    contractAddress: required("CONTRACT_ADDRESS"),
    startBlock: Number(required("START_BLOCK")),
  };
}

export function loadConfig(): Config {
  return {
    ...loadChainConfig(),
    databaseUrl: required("DATABASE_URL"),
    confirmations: Number(process.env.CONFIRMATIONS ?? "2"),
    pollMs: Number(process.env.POLL_MS ?? "5000"),
    chunkBlocks: Number(process.env.CHUNK_BLOCKS ?? "1000"),
  };
}
