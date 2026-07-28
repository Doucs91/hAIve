# Module: embeddings (`@hivelore/embeddings`)

Optional, fully-offline semantic ranking. Wraps Transformers.js (`Xenova/bge-small-en-v1.5`, 384 dims).

## Purpose
Local embeddings for semantic memory ranking and code search — no network at runtime after the
one-time model download.

## Conventions specific to this module
- Exposes the `EmbedderLike` interface (`model`, `dimension`, `encode`) so tests inject a deterministic
  `FakeEmbedder` instead of downloading the model. Lazy-loads the pipeline on first use.
- Must ship **bundled** with `@hivelore/cli` and `@hivelore/mcp` (not a bare peer dep) or global installs
  silently lose semantic ranking and `code_search`.

## Gotchas
- `tsup` `external` for `@xenova/transformers` + `onnxruntime` is mandatory; otherwise tsup inlines them
  and the CLI bundle explodes past 5MB.
- `indexer.rebuildIndex()` reuses an entry when the SHA-256 of `id + tags*2 + body` is unchanged.
