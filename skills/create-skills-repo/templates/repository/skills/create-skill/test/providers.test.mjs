import assert from "node:assert/strict";
import test from "node:test";
import {
  AZURE_API_VERSION,
  AZURE_MODEL,
  OPENAI_MODEL,
  OPENAI_ORIGIN,
  createStrictFetch,
  generateBuiltInArt,
  generatePlaceholder,
  generateWithAzureOpenAI,
  generateWithOpenAI,
  validateAzureEndpoint,
} from "../scripts/providers.mjs";
import { MAX_PNG_BYTES, validatePng } from "../scripts/png.mjs";

const encoded = generatePlaceholder().bytes.toString("base64");

function clientFactory(capture, response = { data: [{ b64_json: encoded }] }) {
  return (config) => {
    capture.config = config;
    return {
      images: {
        async generate(request) {
          capture.requests.push(request);
          return response;
        },
      },
    };
  };
}

test("provider constants and Azure endpoint validation are exact", () => {
  assert.equal(OPENAI_ORIGIN, "https://api.openai.com");
  assert.equal(OPENAI_MODEL, "gpt-image-2");
  assert.equal(AZURE_MODEL, "gpt-image-2");
  assert.equal(AZURE_API_VERSION, "2025-04-01-preview");
  assert.equal(
    validateAzureEndpoint("https://example-resource.openai.azure.com"),
    "https://example-resource.openai.azure.com",
  );
  for (const value of [
    "http://x.openai.azure.com",
    "https://openai.azure.com",
    "https://x.openai.azure.com/path",
    "https://x.openai.azure.com:443",
    "https://x.example.com",
  ]) {
    assert.throws(() => validateAzureEndpoint(value), /exact|valid HTTPS/);
  }
});

test("strict fetch permits one exact origin and refuses redirects", async () => {
  const calls = [];
  const strict = createStrictFetch(OPENAI_ORIGIN, async (input, init) => {
    calls.push({ input, init });
    return new Response("ok", { status: 200 });
  });
  assert.equal((await strict(`${OPENAI_ORIGIN}/v1/images`, { method: "POST" })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, "manual");
  await assert.rejects(() => strict("https://example.com/image"), /unexpected/);

  const redirecting = createStrictFetch(
    OPENAI_ORIGIN,
    async () => new Response(null, { status: 302, headers: { location: "https://example.com" } }),
  );
  await assert.rejects(() => redirecting(`${OPENAI_ORIGIN}/v1/images`), /redirect refused/);
});

test("OpenAI provider makes one configured request and validates bytes", async () => {
  const capture = { requests: [] };
  const result = await generateWithOpenAI({
    prompt: "A test prompt",
    apiKey: "test-key",
    clientFactory: clientFactory(capture),
  });
  validatePng(result.bytes);
  assert.equal(capture.config.baseURL, `${OPENAI_ORIGIN}/v1`);
  assert.equal(capture.config.maxRetries, 0);
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].size, "1024x1024");
  assert.equal(Object.hasOwn(capture.requests[0], "response_format"), false);
  assert.equal(result.provenance.provider, "openai");
  await assert.rejects(() => generateWithOpenAI({ prompt: "x", apiKey: "" }), /required/);
  await assert.rejects(
    () =>
      generateWithOpenAI({
        prompt: "x",
        apiKey: "test",
        clientFactory: clientFactory({ requests: [] }, { data: [] }),
      }),
    /b64_json/,
  );
  await assert.rejects(
    () =>
      generateWithOpenAI({
        prompt: "x",
        apiKey: "test",
        clientFactory: clientFactory(
          { requests: [] },
          { data: [{ b64_json: "A".repeat(4 * Math.ceil(MAX_PNG_BYTES / 3) + 1) }] },
        ),
      }),
    /exceeds the 12582912 byte limit/,
  );
});

test("Azure provider uses exact endpoint, keyless token provider, and no retries", async () => {
  const capture = { requests: [] };
  const result = await generateWithAzureOpenAI({
    prompt: "A test prompt",
    endpoint: "https://fixture.openai.azure.com",
    deployment: "gpt-image-2",
    credentialFactory: () => ({ getToken: async () => ({ token: "not-logged", expiresOnTimestamp: Date.now() + 60_000 }) }),
    clientFactory: clientFactory(capture),
  });
  validatePng(result.bytes);
  assert.equal(capture.config.endpoint, "https://fixture.openai.azure.com");
  assert.equal(capture.config.maxRetries, 0);
  assert.equal(capture.requests.length, 1);
  assert.equal(Object.hasOwn(capture.requests[0], "response_format"), false);
  assert.equal(result.provenance.apiVersion, AZURE_API_VERSION);
  await assert.rejects(
    () =>
      generateWithAzureOpenAI({
        prompt: "x",
        endpoint: "https://fixture.openai.azure.com",
        deployment: "../bad",
      }),
    /deployment/,
  );
});

test("built-in provider dispatcher never falls back", async () => {
  const placeholder = await generateBuiltInArt("placeholder", { prompt: "unused" });
  validatePng(placeholder.bytes);
  await assert.rejects(() => generateBuiltInArt("unknown", {}), /Unknown built-in/);
});
