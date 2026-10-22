import { fileURLToPath } from "node:url";
import { runVersionCommand } from "../skills/create-skill/scripts/versioning.mjs";

try {
  const result = runVersionCommand(fileURLToPath(new URL("..", import.meta.url)), process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "drift") process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
