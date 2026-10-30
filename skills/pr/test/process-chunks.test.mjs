import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const bundle = pathToFileURL(path.join(root, "extensions", "github-client.mjs")).href;

for (const skill of ["pr", "ci-hound"]) {
  for (const boundary of ["credential", "response-body"]) {
    test(`${skill} CLI exits its chunk with a genuinely pending SDK ${boundary} and drains final events`, { timeout: 15000 }, async () => {
      const fixtureRoot = path.join(root, ".watch-process-fixtures");
      mkdirSync(fixtureRoot, { recursive: true });
      const home = mkdtempSync(path.join(fixtureRoot, `${skill}-`));
      const marker = path.join(home, "credential-pid");
      const operationStarted = path.join(home, "operation-started");
      const bin = path.join(home, "bin");
      const executable = path.join(bin, process.platform === "win32" ? "gh.exe" : "gh");
      const eventsFile = path.join(home, "events.jsonl");
      let child;
      let requests = 0;
      const server = createServer((_request, response) => {
        requests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      });
      const alive = (pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      try {
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        mkdirSync(bin);
        try { linkSync(process.execPath, executable); }
        catch { copyFileSync(process.execPath, executable); }
        writeFileSync(path.join(home, "auth"),
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000);`);
        const daemon = path.join(root, "skills", skill, "scripts",
          skill === "pr" ? "pr-watch-daemon.mjs" : "ci-hound-daemon.mjs");
        const shim = path.join(home, "sdk.mjs");
        writeFileSync(shim, `
          export { createEventWriter, githubHost, httpDetails, runGh } from ${JSON.stringify(bundle)};
          import { createGitHubClient as actual } from ${JSON.stringify(bundle)};
          import { writeFileSync } from "node:fs";
          export const createGitHubClient = () => {
            writeFileSync(${JSON.stringify(operationStarted)}, String(Date.now()));
            return actual({ baseUrl: "http://127.0.0.1:${server.address().port}", env: process.env });
          };
        `);
        const loader = path.join(home, "loader.mjs");
        writeFileSync(loader, `
          import { registerHooks } from "node:module";
          registerHooks({ resolve(specifier, context, next) {
            if (specifier === "./lib/github-client.mjs" && context.parentURL === ${JSON.stringify(pathToFileURL(daemon).href)})
              return { url: ${JSON.stringify(pathToFileURL(shim).href)}, shortCircuit: true };
            return next(specifier, context);
          } });
        `);
        const args = ["--import", pathToFileURL(loader).href, daemon, "watch", "--repo", "fixture/repo",
          "--max-wait-sec", "2", "--events-file", eventsFile,
          ...(skill === "pr" ? ["--pr", "1", "--head", "a".repeat(40)]
            : ["--config-file", path.join(home, "config.json")])];
        const env = {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
          GH_HOST: "github.com", GH_CONFIG_DIR: path.join(home, "gh-config"),
          GH_TOKEN: boundary === "response-body" ? "fixture-token" : "",
          GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "",
          COPILOT_HOME: path.join(home, "copilot"), LOCALAPPDATA: path.join(home, "localappdata"),
          TEMP: home, TMP: home, NO_PROXY: "*", no_proxy: "*", CI_HOUND_NO_ALERT: "1",
        };
        const start = Date.now();
        let stdout = "", stderr = "";
        child = spawn(process.execPath, args, { cwd: home, env, windowsHide: true });
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const status = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI process did not drain within six seconds")); }, 6000);
          child.on("error", (error) => { clearTimeout(timeout); reject(error); });
          child.on("close", (code) => { clearTimeout(timeout); resolve(code); });
        });
        const elapsed = Date.now() - start;
        assert.equal(status, 0, `${stderr}\n${stdout}`);
        assert.ok(elapsed < 4000, `two-second chunk must exit before the four-second host ceiling (${elapsed}ms)`);
        const operationElapsed = Date.now() - Number(readFileSync(operationStarted, "utf8"));
        assert.ok(operationElapsed < 2500, `pending SDK work and process drain must fit the chunk plus 500ms shutdown margin (${operationElapsed}ms)`);
        assert.match(stdout, /WATCH_CHUNK_TIMEOUT/);
        const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(events.at(-1).type, "WATCH_CHUNK_TIMEOUT", "final event is durably drained before process close");
        if (boundary === "credential") {
          assert.ok(existsSync(marker), "a real credential child must have started and remained pending");
          assert.equal(alive(Number(readFileSync(marker, "utf8"))), false, "credential child must not outlive the chunk");
          assert.equal(requests, 0);
        } else {
          assert.ok(requests > 0, "the real SDK must reach a genuinely pending response body");
        }
      } finally {
        if (child && child.exitCode === null && !child.signalCode) child.kill();
        if (existsSync(marker)) {
          const pid = Number(readFileSync(marker, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0 && alive(pid)) {
            if (process.platform === "win32") {
              spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
                `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p.Path -eq '${executable.replaceAll("'", "''")}'){Stop-Process -Id ${pid} -Force}`],
              { windowsHide: true, timeout: 10000 });
            } else process.kill(pid, "SIGTERM");
          }
        }
        server.closeAllConnections();
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        rmSync(home, { recursive: true, force: true });
        if (readdirSync(fixtureRoot).length === 0) rmSync(fixtureRoot, { recursive: true });
      }
    });
  }
}
