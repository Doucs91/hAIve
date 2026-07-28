# Module: core (`@hivelore/core`)

Pure domain layer — the only package with no CLI, MCP transport, or network concerns.

## Purpose
Owns schemas, parsing/serialization, path resolution, the memory loader, ranking/scoring,
sensors, eval math, code-map structures, and bootstrap-state. Everything else builds on it.

## Conventions specific to this module
- `schema.ts` is the single source of truth for memory frontmatter (zod). Everything parses through it.
- When adding quality logic, put the **pure deterministic function here first**, then orchestrate I/O
  in cli/mcp (e.g. `assessBootstrapState`, `runSensors`, `computeImpact`, `scoreRetrievalCase`).
- No I/O beyond the loader; **never import `@hivelore/cli` or `@hivelore/mcp`** from core.
- ESM only; import `.ts` source files with `.js` extensions.

## Gotchas
- `gray-matter` parses YAML dates as `Date`; the `IsoDateString` zod helper normalizes both. It also
  refuses to serialize `undefined` — `serializeMemory` strips undefined recursively.
- Sensor generation lives in `sensor-suggest.ts`; prefer returning `null` over a brittle/inverted sensor.
