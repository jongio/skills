import {
  MAX_PNG_BYTES,
  assertValidPng,
  encodeDeterministicPlaceholderPng,
} from "./png.mjs";

export const OPENAI_ORIGIN = "https://api.openai.com";
export const AZURE_API_VERSION = "2025-04-01-preview";
export const AZURE_MODEL = "gpt-image-2";
export const OPENAI_MODEL = "gpt-image-2";

export function validateAzureEndpoint(value) {
  if (typeof value !== "string" || /^https:\/\/[^/]+:\d+(?:\/|$)/i.test(value)) {
    throw new Error("AZURE_OPENAI_ENDPOINT must be a valid HTTPS URL without an explicit port");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AZURE_OPENAI_ENDPOINT must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/i.test(url.hostname)
  ) {
    throw new Error("Azure OpenAI endpoint must be an exact https://<resource>.openai.azure.com origin");
  }
  return url.origin;
}

export function createStrictFetch(expectedOrigin, fetchImpl = globalThis.fetch) {
  const origin = new URL(expectedOrigin).origin;
  return async (input, init = {}) => {
    const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (requestUrl.origin !== origin) {
      throw new Error(`Refusing request to unexpected image provider origin ${requestUrl.origin}`);
    }
    const response = await fetchImpl(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Image provider redirect refused with HTTP ${response.status}`);
    }
    return response;
  };
}

function decodeImageResponse(response) {
  const encoded = response?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("Image provider response did not contain data[0].b64_json");
  }
  const maxEncodedBytes = 4 * Math.ceil(MAX_PNG_BYTES / 3);
  if (encoded.length > maxEncodedBytes) {
    throw new Error(`Image provider response exceeds the ${MAX_PNG_BYTES} byte limit`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) throw new Error("Image provider returned empty base64 image data");
  return assertValidPng(bytes);
}

export async function generateWithOpenAI(options) {
  const {
    prompt,
    apiKey = process.env.OPENAI_API_KEY,
    model = OPENAI_MODEL,
    fetchImpl = globalThis.fetch,
    clientFactory,
  } = options;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const factory = clientFactory ?? (async (config) => {
    const { default: OpenAI } = await import("openai");
    return new OpenAI(config);
  });
  const client = await factory({
    apiKey,
    baseURL: `${OPENAI_ORIGIN}/v1`,
    fetch: createStrictFetch(OPENAI_ORIGIN, fetchImpl),
    maxRetries: 0,
    timeout: 240_000,
  });
  const response = await client.images.generate({
    model,
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "high",
  });
  return {
    bytes: decodeImageResponse(response),
    provenance: { provider: "openai", model, endpoint: OPENAI_ORIGIN },
  };
}

export async function generateWithAzureOpenAI(options) {
  const {
    prompt,
    endpoint = process.env.AZURE_OPENAI_ENDPOINT,
    deployment = AZURE_MODEL,
    fetchImpl = globalThis.fetch,
    credentialFactory,
    clientFactory,
  } = options;
  const origin = validateAzureEndpoint(endpoint);
  if (deployment !== AZURE_MODEL) {
    throw new Error(`Azure OpenAI built-in art requires the ${AZURE_MODEL} deployment`);
  }
  const identity = await import("@azure/identity");
  const credential = credentialFactory
    ? credentialFactory()
    : new identity.DefaultAzureCredential();
  const tokenProvider = identity.getBearerTokenProvider(
    credential,
    "https://cognitiveservices.azure.com/.default",
  );
  const factory = clientFactory ?? (async (config) => {
    const { AzureOpenAI } = await import("openai");
    return new AzureOpenAI(config);
  });
  const client = await factory({
    endpoint: origin,
    apiVersion: AZURE_API_VERSION,
    deployment,
    azureADTokenProvider: tokenProvider,
    fetch: createStrictFetch(origin, fetchImpl),
    maxRetries: 0,
    timeout: 240_000,
  });
  const response = await client.images.generate({
    model: deployment,
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "high",
  });
  return {
    bytes: decodeImageResponse(response),
    provenance: {
      provider: "azure-openai",
      model: AZURE_MODEL,
      deployment,
      endpoint: origin,
      apiVersion: AZURE_API_VERSION,
    },
  };
}

export function generatePlaceholder() {
  return {
    bytes: encodeDeterministicPlaceholderPng(),
    provenance: { provider: "placeholder", model: "deterministic-local-v1" },
  };
}

export async function generateBuiltInArt(provider, options) {
  if (provider === "azure-openai") return generateWithAzureOpenAI(options);
  if (provider === "openai") return generateWithOpenAI(options);
  if (provider === "placeholder") return generatePlaceholder();
  throw new Error(`Unknown built-in art provider: ${provider}`);
}
