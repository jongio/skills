const clients = new Map();
export function gitHubEnvironmentForHost(host, env = process.env) {
  host = String(host).toLowerCase();
  const selected = { ...env };
  if (host !== "github.com" && !host.endsWith(".ghe.com") &&
      host !== String(env.GH_HOST || "github.com").toLowerCase()) {
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete selected[name];
  }
  return selected;
}
export function requestedGitHubEnvironment(env = process.env) {
  const names = [...new Set(String(env.COPILOT_STATUSLINE_TOKEN_ENV || "").split(",").map((name) => name.trim()).filter(Boolean))].sort();
  const allowed = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
  if (names.some((name) => !allowed.has(name))) throw new Error("COPILOT_STATUSLINE_TOKEN_ENV must name supported GitHub token variables only");
  return names;
}
async function client(host) {
  if (!clients.has(host)) clients.set(host, import("./github-client.mjs").then(({ createGitHubClient }) =>
    createGitHubClient({ host, env: gitHubEnvironmentForHost(host), secondaryAccounts: true })));
  return clients.get(host);
}

export const statuslineGitHub = {
  async request(input, host = "github.com", options = {}) {
    return (await client(host)).request(input, options);
  },
  async cacheScope(host = "github.com", options = {}) {
    return (await client(host)).cacheScope(options);
  },
  async close() {
    for (const pending of clients.values()) await (await pending).close();
    clients.clear();
  },
};
