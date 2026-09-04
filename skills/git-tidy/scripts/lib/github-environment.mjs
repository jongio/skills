import path from "node:path";

const GITHUB_ENV_KEYS = Object.freeze([
  "APPDATA",
  "GH_CONFIG_DIR",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_PROXY",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

export function createGitHubEnvironment(ghPath, gitPath, env = process.env) {
  if (
    !path.isAbsolute(ghPath) ||
    !path.isAbsolute(gitPath) ||
    ghPath.includes("\0") ||
    gitPath.includes("\0") ||
    env === null ||
    typeof env !== "object" ||
    Array.isArray(env)
  ) {
    throw new TypeError("trusted gh and git paths plus an environment are required");
  }
  const normalized = new Map(
    Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const result = Object.fromEntries(GITHUB_ENV_KEYS.flatMap((key) =>
    normalized.has(key) ? [[key, normalized.get(key)]] : []));
  result.PATH = [...new Set([path.dirname(ghPath), path.dirname(gitPath)])]
    .join(path.delimiter);
  return Object.freeze({
    ...result,
    GH_PAGER: "cat",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    PAGER: "cat",
  });
}
