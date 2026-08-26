import pino from "pino";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../config/logger.json", import.meta.url)));

// pino-pretty is never statically imported here — it is only ever loaded by
// pino itself, by name, through the transport target in config/logger.json.
export const logger = pino(config);
