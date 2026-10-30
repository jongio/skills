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
      const credentialLiveAtAbort = path.join(home, "credential-live-at-abort.json");
      const operationStarted = path.join(home, "operation-started");
      const operationSettled = path.join(home, "operation-settled");
      const credentialClosed = path.join(home, "credential-closed");
      const bin = path.join(home, "bin");
      const executable = path.join(bin, process.platform === "win32" ? "gh.exe" : "gh");
      const eventsFile = path.join(home, "events.jsonl");
      let child;
      let requests = 0;
      let bodyClosedAt;
      let resolveBodyClosed;
      const bodyClosed = new Promise((resolve) => { resolveBodyClosed = resolve; });
      const responses = new Set();
      const server = createServer((_request, response) => {
        requests += 1;
        responses.add(response);
        response.once("close", () => {
          responses.delete(response);
          if (responses.size === 0) {
            bodyClosedAt = Date.now();
            resolveBodyClosed();
          }
        });
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
          `setInterval(()=>{},1000);`);
        const daemon = path.join(root, "skills", skill, "scripts",
          skill === "pr" ? "pr-watch-daemon.mjs" : "ci-hound-daemon.mjs");
        const shim = path.join(home, "sdk.mjs");
        writeFileSync(shim, `
          export { createEventWriter, githubHost, httpDetails, runGh } from ${JSON.stringify(bundle)};
          import { createGitHubClient as actual } from ${JSON.stringify(bundle)};
          import { writeFileSync } from "node:fs";
          export const createGitHubClient = () => {
            writeFileSync(${JSON.stringify(operationStarted)}, String(Date.now()));
            const client = actual({ baseUrl: "http://127.0.0.1:${server.address().port}", env: process.env });
            return {
              ...client,
              async cacheScope(...args) {
                try { return await client.cacheScope(...args); }
                finally { writeFileSync(${JSON.stringify(operationSettled)}, String(Date.now())); }
              },
              async request(...args) {
                try { return await client.request(...args); }
                finally { writeFileSync(${JSON.stringify(operationSettled)}, String(Date.now())); }
              },
            };
          };
        `);
        const loader = path.join(home, "loader.mjs");
        writeFileSync(loader, `
          import childProcess from "node:child_process";
          import { registerHooks, syncBuiltinESMExports } from "node:module";
          import { writeFileSync } from "node:fs";
          const execFile = childProcess.execFile;
          childProcess.execFile = function(command, args, options, callback) {
            const credential = command === "gh" && args[0] === "auth";
            let child;
            const onAbort = () => {
              if (child?.pid && child.exitCode === null) {
                try {
                  process.kill(child.pid, 0);
                  writeFileSync(${JSON.stringify(credentialLiveAtAbort)}, JSON.stringify({ pid: child.pid, at: Date.now() }));
                } catch {}
              }
            };
            if (credential) options.signal.addEventListener("abort", onAbort, { once: true });
            child = execFile.call(this, command, args, options, callback);
            if (credential) {
              child.once("spawn", () => writeFileSync(${JSON.stringify(marker)}, String(child.pid)));
              child.once("close", () => {
                options.signal.removeEventListener("abort", onAbort);
                writeFileSync(${JSON.stringify(credentialClosed)}, String(Date.now()));
              });
            }
            return child;
          };
          syncBuiltinESMExports();
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
        const operationStartedAt = Number(readFileSync(operationStarted, "utf8"));
        const operationElapsed = Number(readFileSync(operationSettled, "utf8")) - operationStartedAt;
        assert.ok(operationElapsed < 2500, `pending SDK work must settle within the chunk plus 500ms shutdown margin (${operationElapsed}ms)`);
        assert.match(stdout, /WATCH_CHUNK_TIMEOUT/);
        const events = readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(events.at(-1).type, "WATCH_CHUNK_TIMEOUT", "final event is durably drained before process close");
        if (boundary === "credential") {
          assert.ok(existsSync(marker), "the real credential child must have emitted its OS spawn event");
          assert.ok(existsSync(credentialLiveAtAbort), "the credential child must still be alive when its SDK operation is aborted");
          const pid = Number(readFileSync(marker, "utf8"));
          const liveAtAbort = JSON.parse(readFileSync(credentialLiveAtAbort, "utf8"));
          assert.equal(liveAtAbort.pid, pid, "the same OS-launched credential child must be alive at operation abort");
          assert.ok(liveAtAbort.at >= operationStartedAt, "live PID observation belongs to the actual SDK operation");
          const credentialElapsed = Number(readFileSync(credentialClosed, "utf8")) - operationStartedAt;
          assert.ok(credentialElapsed < 2500, `credential child and stdio must close within the SDK shutdown bound (${credentialElapsed}ms)`);
          assert.equal(alive(pid), false, "credential child must not outlive the chunk");
          assert.equal(requests, 0);
        } else {
          assert.ok(requests > 0, "the real SDK must reach a genuinely pending response body");
          let timeout;
          try {
            await Promise.race([
              bodyClosed,
              new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error("SDK response body did not close within its shutdown bound")),
                  Math.max(1, operationStartedAt + 2500 - Date.now()));
              }),
            ]);
          } finally {
            clearTimeout(timeout);
          }
          assert.equal(responses.size, 0, "all SDK response bodies must close before fixture cleanup");
          const bodyElapsed = bodyClosedAt - operationStartedAt;
          assert.ok(bodyElapsed < 2500, `response body must close within the SDK shutdown bound (${bodyElapsed}ms)`);
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
