# Module: mcp (`@hivelore/mcp`)

Policy-aware MCP server built on `@modelcontextprotocol/sdk` (stdio). Bundled into the CLI.

## Purpose
Exposes the coding-agent harness to MCP clients: `get_briefing`, the `mem_*` tools, `propose_sensor`,
`pre_commit_check`, and the `bootstrap_repo` / `bootstrap_project` / `post_task` prompts.

## Conventions specific to this module
- Tool implementations under `src/tools/` are **pure async functions `(input, ctx)`** returning
  JSON-serializable results, so they unit-test without stdio. `server.ts` is thin registration glue.
  Prompts live under `src/prompts/`.
- **Never log to stdout** — it is the JSON-RPC channel; diagnostics go to stderr.
- Tool output is LLM-facing API: keep field names stable; add human fields (`why`, `hints`, `notice`,
  `setup_warnings`) that reduce agent guesswork.
- Adding a tool: drop a file in `src/tools/`, register in `server.ts` (≈3 lines), mirror in CLI if user-facing.

## Internals
- `get_briefing` is the entry point: project context + ranked memories + breadcrumbs + `action_required`
  (the STOP protocol, including `__bootstrap_required__`). Breadcrumbs are **pointers, not body copies**.
