import { loadConfig } from "./config.js";
import { runIndexer } from "./indexer.js";

runIndexer(loadConfig()).catch((err) => {
  console.error(err);
  process.exit(1);
});
