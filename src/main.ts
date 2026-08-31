import dns from "node:dns";
import { loadConfig } from "./config.js";
import { runIndexer } from "./indexer.js";

// Prefer IPv4 — Docker Desktop often has no IPv6 route to Supabase.
dns.setDefaultResultOrder("ipv4first");

runIndexer(loadConfig()).catch((err) => {
  console.error(err);
  process.exit(1);
});
