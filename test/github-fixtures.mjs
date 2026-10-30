function parseRetryAfterHeader(rawVal) {
  if (!rawVal) return null;
  const trimmed = String(rawVal).trim();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return null;
}

export function parseHttpResponse(raw) {
  let remaining = String(raw || "").replace(/\r\n/g, "\n");
  let lastHeaderBlock = "";
  while (/^HTTP\/[\d.]+\s+\d{3}\b/.test(remaining)) {
    const splitIndex = remaining.indexOf("\n\n");
    if (splitIndex === -1) {
      lastHeaderBlock = remaining;
      remaining = "";
      break;
    }
    lastHeaderBlock = remaining.slice(0, splitIndex);
    remaining = remaining.slice(splitIndex + 2).trimStart();
  }
  if (!lastHeaderBlock) {
    return {
      status: 200,
      etag: "",
      rateLimitRemaining: null,
      rateLimitReset: null,
      retryAfterSec: null,
      bodyText: remaining,
    };
  }
  const bodyText = remaining.trim();
  const statusMatch = lastHeaderBlock.match(/^HTTP\/[\d.]+\s+(\d{3})/m);
  const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 200;
  const etagMatch = lastHeaderBlock.match(/^etag:\s*(.+)$/im);
  const etag = etagMatch ? etagMatch[1].trim() : "";
  const remMatch = lastHeaderBlock.match(/^x-ratelimit-remaining:\s*(\d+)\s*$/im);
  const rateLimitRemaining = remMatch ? Number.parseInt(remMatch[1], 10) : null;
  const resetMatch = lastHeaderBlock.match(/^x-ratelimit-reset:\s*(\d+)\s*$/im);
  const rateLimitReset = resetMatch ? Number.parseInt(resetMatch[1], 10) : null;
  const retryMatch = lastHeaderBlock.match(/^retry-after:\s*(.+)$/im);
  const retryAfterSec = retryMatch ? parseRetryAfterHeader(retryMatch[1]) : null;
  return { status, etag, rateLimitRemaining, rateLimitReset, retryAfterSec, bodyText };
}

export function parseGhApiArgs(ghArgs) {
  if (!Array.isArray(ghArgs) || ghArgs[0] !== "api") {
    return null;
  }
  let includeHeaders = false;
  let method = "";
  const headers = {};
  let endpoint = "";
  const rawFields = {};
  const typedFields = {};

  for (let i = 1; i < ghArgs.length; i += 1) {
    const token = ghArgs[i];
    if (token === "-i" || token === "--include") {
      includeHeaders = true;
    } else if ((token === "-X" || token === "--method") && ghArgs[i + 1]) {
      method = String(ghArgs[++i]).toUpperCase();
    } else if ((token === "-H" || token === "--header") && ghArgs[i + 1]) {
      const rawHeader = String(ghArgs[++i]);
      const colonIdx = rawHeader.indexOf(":");
      if (colonIdx <= 0) return null;
      headers[rawHeader.slice(0, colonIdx).trim()] = rawHeader.slice(colonIdx + 1).trim();
    } else if ((token === "-f" || token === "--raw-field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      rawFields[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if ((token === "-F" || token === "--field") && ghArgs[i + 1]) {
      const pair = String(ghArgs[++i]);
      const eqIdx = pair.indexOf("=");
      if (eqIdx <= 0) return null;
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      if (val.startsWith("@")) return null;
      if (/^-?\d+$/.test(val)) {
        typedFields[key] = Number.parseInt(val, 10);
      } else if (val === "true" || val === "false") {
        typedFields[key] = val === "true";
      } else if (val === "null") {
        typedFields[key] = null;
      } else {
        typedFields[key] = val;
      }
    } else if (token.startsWith("-")) {
      return null;
    } else if (!endpoint) {
      endpoint = token;
    } else {
      return null;
    }
  }

  if (!endpoint) {
    return null;
  }

  if (endpoint === "graphql") {
    const query = rawFields.query ?? typedFields.query;
    if (typeof query !== "string" || !query) {
      return null;
    }
    const variables = { ...rawFields, ...typedFields };
    delete variables.query;
    return {
      url: "https://api.github.com/graphql",
      method: method || "POST",
      includeHeaders,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables }),
    };
  }

  if (Object.keys(rawFields).length > 0 || Object.keys(typedFields).length > 0) {
    return null;
  }

  const normalizedEndpoint = endpoint.replace(/^\/+/, "");
  const url = /^https?:\/\//i.test(endpoint)
    ? endpoint
    : `https://api.github.com/${normalizedEndpoint}`;
  return {
    url,
    method: method || "GET",
    includeHeaders,
    headers,
    body: undefined,
  };
}


export function fixtureRequest(execute) {
  if (!execute) return undefined;
  return async (request) => {
    let args;
    if (request.kind === "graphql") {
      args = ["api", "graphql", ...Object.entries(request.variables).flatMap(([key,value]) => ["-F", key + "=" + value]), "-f", "query=" + request.query];
    } else if (request.kind === "reviewer") {
      args = ["pr", "edit", String(request.pr), "-R", request.repo, request.remove ? "--remove-reviewer" : "--add-reviewer", "@copilot"];
    } else {
      args = ["api", ...(request.conditional ? ["-i"] : []), ...(request.method ? ["-X", request.method] : []), request.endpoint,
        ...Object.entries(request.headers || {}).flatMap(([key,value]) => ["-H", key + ": " + value])];
    }
    const result = await execute(args);
    if (!result) return result;
    const meta = parseHttpResponse(result.stdout || "");
    let data = null, error = result.stderr;
    try { data = meta.bodyText ? JSON.parse(meta.bodyText) : null; } catch(e) { error ||= e.message; }
    const values = result.httpMeta || {};
    return { ok: Boolean(result.ok) && !error, data, error,
      status: values.status ?? meta.status,
      headers: Object.fromEntries(Object.entries({
        etag: values.etag || meta.etag,
        "x-ratelimit-remaining": values.rateLimitRemaining ?? meta.rateLimitRemaining,
        "x-ratelimit-reset": values.rateLimitReset ?? meta.rateLimitReset,
        "retry-after": values.retryAfter ?? meta.retryAfterSec,
      }).filter(([,value]) => value !== null && value !== undefined && value !== "")),
    };
  };
}
