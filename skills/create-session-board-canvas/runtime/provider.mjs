import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function acquireProvider(sessionId) {
  if (typeof sessionId !== "string" || !/^[\w-]{1,128}$/.test(sessionId)) throw new Error("Trusted extension SESSION_ID is required");
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\copilot-progress-${key}` :
    process.platform === "linux" ? `\0copilot-progress-${key}` : join(tmpdir(), `copilot-progress-${key}.sock`);
  const server = createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen(address, () => resolve({
      close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
    }));
  });
}
