import { readFileSync } from "node:fs";
import pino from "pino";

const config = JSON.parse(readFileSync("config/logger.json", "utf8"));
export const logger = pino(config);
