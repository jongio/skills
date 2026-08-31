# Art and provenance

Every art path returns one 1024x1024 PNG Buffer plus non-secret provenance. Providers never write
files directly.

## Built-in network boundaries

| Provider | Allowed origin | Model | Redirects | Retries |
| --- | --- | --- | --- | --- |
| Azure OpenAI | Exact configured `https://<resource>.openai.azure.com` origin | `gpt-image-2` | Disabled | Zero |
| OpenAI Images | Exact `https://api.openai.com` origin | `gpt-image-2` by default | Disabled | Zero |
| Placeholder | None | `deterministic-local-v1` | Not applicable | Not applicable |

Azure uses `DefaultAzureCredential` and the Cognitive Services scope. OpenAI uses
`OPENAI_API_KEY`. Credential values never enter action previews or provenance.

## Custom workflows

Custom means any user-described provider and delivery workflow. It is not a shell-command hook.
The agent converts the description into exact non-secret tool, API, browser, attachment, storage,
or human handoff steps and obtains single-use approval. The resulting file must be delivered inside
the repository as a regular file. The CLI does not follow symlinks or accept absolute paths.

## PNG acceptance

The validator enforces:

- PNG signature and bounded total size.
- One 13-byte IHDR first and an empty IEND last.
- At least one consecutive IDAT sequence.
- CRC for every chunk and complete chunk bounds.
- Exactly 1024x1024 pixels.
- Valid color type and bit depth.
- Standard compression and filtering with no interlace.
- A bounded zlib stream with the exact raster length and valid row filters.
- No trailing bytes.
- No ancillary or metadata chunks.

Any failure rejects the entire result before either thumbnail path changes. There is no image
repair, conversion, retry, or provider fallback.

## Provenance

When `docs/thumbnail-prompts.md` exists, each accepted image records its exact prompt, provider,
model or method, endpoint origin when relevant, delivery description, and SHA-256 digest. Fields
whose names suggest tokens, passwords, cookies, authorization, secrets, or API keys are rejected.
