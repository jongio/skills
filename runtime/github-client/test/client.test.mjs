import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { apiBaseUrl, createGitHubClient, httpDetails } from "../client.mjs";

async function fixture(t, handler, options = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    calls.push({ url: req.url, auth: req.headers.authorization, body, headers: req.headers });
    handler(req, res, calls.length);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}${options.apiPath || ""}`;
  const client = createGitHubClient({ baseUrl, env: { GH_TOKEN: "fixture-token", NO_PROXY: "*" }, ...options });
  t.after(async () => {
    server.closeAllConnections();
    await client.close();
    await new Promise((done) => server.close(done));
  });
  return { client, calls, baseUrl };
}
const json = (res, status, value, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};

test("read redirects stay on the API host; writes and credential overrides are refused", async (t) => {
  const { client, calls } = await fixture(t, (req, res) => {
    if (req.url === "/user") return json(res, 200, { id: 1 });
    res.writeHead(302, { location: req.url === "/external" ? "https://unrelated.example/user" : "/user" });
    res.end();
  });
  assert.equal((await client.request({ endpoint: "alias" })).ok, true);
  assert.equal(calls.length, 2);
  assert.equal((await client.request({ endpoint: "alias", method: "POST" })).ok, false);
  assert.equal(calls.length, 3);
  assert.equal((await client.request({ endpoint: "external" })).ok, false);
  assert.ok(calls.every((call) => call.url !== "https://unrelated.example/user"));
  await assert.rejects(client.request({ endpoint: "user", headers: { Host: "unrelated.example" } }), /cannot be overridden/);
});

test("enterprise REST and GraphQL use distinct documented API paths and enterprise credentials", async (t) => {
  const { client, calls } = await fixture(t, (_req, res) => json(res, 200, { data: {} }), {
    apiPath: "/api/v3", host: "github.enterprise",
    env: { GH_ENTERPRISE_TOKEN: "enterprise-token", GH_TOKEN: "wrong-public-token", NO_PROXY: "*" },
  });
  assert.equal((await client.request({ endpoint: "user" })).ok, true);
  assert.equal((await client.request({ kind: "graphql", query: "{ viewer { login } }" })).ok, true);
  assert.deepEqual(calls.map((call) => call.url), ["/api/v3/user", "/api/graphql"]);
  assert.ok(calls.every((call) => call.auth === "token enterprise-token"));
});

test("native REST/GraphQL results retain headers, conditional reads, and credential scope", async (t) => {
  const { client, calls } = await fixture(t, (req, res) => {
    if (req.headers["if-none-match"]) { res.writeHead(304, { etag: '"one"' }); res.end(); }
    else json(res, 200, { data: { viewer: { login: "fixture" } } }, { etag: '"one"', "x-ratelimit-remaining": "12" });
  });
  const first = await client.request({ endpoint: "repos/fixture/repo" });
  assert.equal(first.ok, true);
  assert.equal(httpDetails(first).rateLimitRemaining, 12);
  const second = await client.request({ endpoint: "repos/fixture/repo", headers: { "if-none-match": first.headers.etag } });
  assert.equal(second.status, 304);
  assert.equal(second.ok, true);
  assert.equal(second.error, null);
  assert.equal(first.cacheScope, second.cacheScope);
  const gql = await client.request({ kind: "graphql", query: "query($name:String!) { viewer { login } }", variables: { name: "fixture" } });
  assert.equal(gql.budget, "graphql");
  assert.deepEqual(JSON.parse(calls[2].body).variables, { name: "fixture" });
});

test("gh credentials refresh once on 401, while environment credentials never switch accounts", async (t) => {
  let lookups = 0;
  const { client, calls } = await fixture(t, (_req, res, index) => {
    json(res, index === 1 ? 401 : 200, index === 1 ? { message: "Bad credentials" } : { id: 1 });
  }, { env: { NO_PROXY: "*" }, run: async () => ({ ok: true, stdout: ++lookups === 1 ? "old-token" : "new-token" }) });
  assert.equal((await client.request({ endpoint: "user", headers: { "If-None-Match": '"old-account"' } })).ok, true);
  assert.equal(lookups, 2);
  assert.equal(calls[0].headers["if-none-match"], '"old-account"');
  assert.equal(calls[1].headers["if-none-match"], undefined);
  assert.deepEqual(calls.map((c) => c.auth), ["token old-token", "token new-token"]);
  const staticFixture = await fixture(t, (_req, res) => json(res, 401, { message: "Bad credentials" }), {
    run: () => { throw new Error("must not run gh"); },
  });
  assert.equal((await staticFixture.client.request({ endpoint: "user" })).status, 401);
  assert.equal(staticFixture.calls.length, 1);
});

test("only safe reads retry; writes and GraphQL mutations are not replayed", async (t) => {
  const { client, calls } = await fixture(t, (_req, res) => json(res, 503, { message: "Unavailable" }));
  await client.request({ endpoint: "repos/fixture/repo" });
  assert.equal(calls.length, 2);
  await client.request({ endpoint: "repos/fixture/repo/actions/runs/1/cancel", method: "POST" });
  assert.equal(calls.length, 3);
  await client.request({ kind: "graphql", query: "# comment\nmutation { changeSomething { id } }" });
  assert.equal(calls.length, 4);
});

test("rate limits and partial GraphQL errors are structured, without hidden sleeping", async (t) => {
  const { client, calls } = await fixture(t, (_req, res) => json(res, 403, { message: "secondary rate limit" }, {
    "retry-after": "300", "x-ratelimit-remaining": "100",
  }));
  const result = await client.request({ endpoint: "user" });
  assert.equal(result.rateLimited, true);
  assert.equal(httpDetails(result).retryAfterSec, 300);
  assert.equal(calls.length, 1);
  const gqlFixture = await fixture(t, (_req, res) => json(res, 200, {
    data: { repository: null }, errors: [{ message: "Not found" }],
  }));
  assert.equal((await gqlFixture.client.request({ kind: "graphql", query: "{ viewer { login } }" })).ok, false);
});

test("deadlines cover response body consumption and external cancellation", async (t) => {
  const { client } = await fixture(t, (_req, res) => { res.writeHead(200); res.write("{"); }, { timeoutMs: 100 });
  const start = Date.now();
  const result = await client.request({ endpoint: "user" });
  assert.equal(result.ok, false);
  assert.match(result.error, /deadline|cancelled/);
  assert.ok(Date.now() - start < 2000);
  const abort = new AbortController();
  abort.abort();
  assert.equal((await client.request({ endpoint: "user" }, { signal: abort.signal })).ok, false);
});

test("host boundaries, enterprise roots and cache identities are explicit", async (t) => {
  assert.equal(apiBaseUrl("github.example"), "https://github.example/api/v3");
  assert.equal(apiBaseUrl("company.ghe.com"), "https://api.company.ghe.com");
  const { client, calls } = await fixture(t, (_req, res) => json(res, 200, {}));
  await assert.rejects(client.request({ endpoint: "https://other.example/user" }), /configured API host/);
  assert.equal(calls.length, 0);
  const other = await fixture(t, (_req, res) => json(res, 200, {}), {
    env: { GH_TOKEN: "different-token", NO_PROXY: "*" },
  });

  assert.notEqual(await client.cacheScope(), await other.client.cacheScope());
  await client.close();
  await assert.rejects(client.request({ endpoint: "user" }), /closed/);
});

test("configured HTTP proxies are used without forwarding authorization to unrelated hosts", async (t) => {
  let tunnels = 0;
  const proxy = createServer((req, res) => {
    tunnels++;
    const remote = httpRequest(req.url, { method: req.method, headers: { ...req.headers, connection: "close" } }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    remote.on("error", () => res.destroy());
    req.pipe(remote);
  });
  const sockets = new Set();
  proxy.on("connect", (req, socket, head) => {
    tunnels++;
    const [host, port] = req.url.split(":");
    const remote = connect(Number(port), host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      socket.pipe(remote);
      remote.pipe(socket);
    });
    sockets.add(socket); sockets.add(remote);
    remote.on("error", () => socket.destroy());
    socket.on("error", () => remote.destroy());
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => proxy.close(done));
  });
  const { client } = await fixture(t, (_req, res) => json(res, 200, { id: 1 }), {
    env: { GH_TOKEN: "fixture-token", HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "" },
    timeoutMs: 2000,
  });
  assert.equal((await client.request({ endpoint: "user" })).ok, true);
  assert.equal(tunnels, 1);
});

test("secondary-account fallback stays on its host without changing the active gh account", async (t) => {
  const commands = [];
  const { client } = await fixture(t, (req, res) => {
    json(res, 200, req.headers.authorization.includes("secondary") ? { data: { repository: { name: "repo" } } }
      : { errors: [{ message: "Could not resolve to a Repository" }] });
  }, {
    env: { NO_PROXY: "*" }, secondaryAccounts: true,
    run: async (args) => {
      commands.push(args);
      return { ok: true, stdout: args[1] === "status"
        ? JSON.stringify({ hosts: { "github.com": [{ active: false, login: "secondary" }] } })
        : args.includes("--user") ? "secondary-token" : "active-token" };
    },
  });
  assert.equal((await client.request({ kind: "graphql", query: "{ repository { name } }" })).ok, true);
  assert.ok(commands.every((args) => args.includes("github.com")));
  assert.ok(commands.every((args) => !args.includes("switch")));
});

test("public-family tokens are bound to the selected GHE host or github.com", async (t) => {
  for (const variable of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    for (const host of ["one.ghe.com", "two.ghe.com", "github.com"]) {
      const lookups = [];
      const { client, calls } = await fixture(t, (_req, res) => json(res, 200, {}), {
        host, env: { GH_HOST: "one.ghe.com", [variable]: "one-host-token", NO_PROXY: "*" },
        run: async (args) => { lookups.push(args); return { ok: true, stdout: "host-specific-token" }; },
      });
      assert.equal((await client.request({ endpoint: "user" })).ok, true);
      assert.equal(calls[0].auth, host === "one.ghe.com" ? "token one-host-token" : "token host-specific-token");
      assert.equal(lookups.length, host === "one.ghe.com" ? 0 : 1);
      assert.ok(lookups.every((args) => args.includes(host)));
    }
  }
});

test("secondary credentials remain target-scoped and invalidate when the primary identity changes", async (t) => {
  let primaryLookups = 0;
  let rejectPrimary = false;
  const { client, calls } = await fixture(t, (req, res) => {
    const owner = JSON.parse(calls.at(-1).body).variables?.owner;
    if (rejectPrimary && req.headers.authorization === "token primary-1") {
      rejectPrimary = false;
      return json(res, 401, { message: "Bad credentials" });
    }
    json(res, 200, owner === "private" && !req.headers.authorization.includes("secondary")
      ? { errors: [{ message: "Could not resolve to a Repository" }] }
      : { data: { repository: { name: "repo" } } });
  }, {
    env: { NO_PROXY: "*" }, secondaryAccounts: true,
    run: async (args) => ({ ok: true, stdout: args[1] === "status"
      ? JSON.stringify({ hosts: { "github.com": [{ active: false, login: "secondary" }] } })
      : args.includes("--user") ? "secondary-token" : `primary-${++primaryLookups}` }),
  });
  const target = "https://github.com/private/repo/pull/1";
  const input = { kind: "graphql", query: "query($owner:String!){repository(owner:$owner){name}}", variables: { owner: "private" } };
  const primary = await client.cacheScope();
  const first = await client.request(input, { target });
  assert.equal(first.ok, true);
  assert.notEqual(first.cacheScope, primary);
  assert.equal(await client.cacheScope({ target }), first.cacheScope);
  const before = calls.length;
  assert.equal((await client.request(input, { target })).ok, true);
  assert.equal(calls.length, before + 1, "reuse the selected credential without repeating the failed primary read");
  assert.equal(calls.at(-1).auth, "token secondary-token");
  assert.equal(await client.cacheScope({ target: "another-target" }), primary);
  rejectPrimary = true;
  assert.equal((await client.request({ ...input, variables: { owner: "public" } }, { target: "another-target" })).ok, true);
  assert.equal(calls.at(-1).auth, "token primary-2");
  assert.equal(await client.cacheScope({ target }), await client.cacheScope(), "primary replacement invalidates old target associations");
});

test("unavailable secondary credentials do not block a later account, but cancellation stops lookup", async (t) => {
  for (const cancel of [false, true]) {
    const abort = new AbortController();
    const users = [];
    const { client, calls } = await fixture(t, (req, res) => {
      json(res, 200, req.headers.authorization.includes("working")
        ? { data: { repository: { name: "repo" } } }
        : { errors: [{ message: "Could not resolve to a Repository" }] });
    }, {
      env: { NO_PROXY: "*" }, secondaryAccounts: true,
      run: async (args) => {
        if (args[1] === "status") return { ok: true, stdout: JSON.stringify({ hosts: {
          "github.com": [{ active: false, login: "unavailable" }, { active: false, login: "working" }],
        } }) };
        const user = args[args.indexOf("--user") + 1];
        if (!args.includes("--user")) return { ok: true, stdout: "primary-token" };
        users.push(user);
        if (user === "unavailable") {
          if (cancel) abort.abort();
          return { ok: false, stdout: "" };
        }
        return { ok: true, stdout: "working-token" };
      },
    });
    const result = await client.request({ kind: "graphql", query: "{ repository { name } }" }, { signal: abort.signal });
    assert.equal(result.ok, !cancel);
    assert.deepEqual(users, cancel ? ["unavailable"] : ["unavailable", "working"]);
    assert.equal(calls.length, cancel ? 1 : 2);
    if (cancel) assert.match(result.error, /cancelled|deadline/);
  }
});
