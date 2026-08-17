---
id: 2026-08-17-decision-enforcement-profile-exposes-mem-update-not-mem-delete
scope: team
type: decision
status: validated
anchor:
  paths:
    - packages/mcp/src/server.ts
    - packages/mcp/src/tools/mem-delete.ts
    - packages/mcp/src/tools/mem-update.ts
  symbols:
    - ENFORCEMENT_PROFILE_TOOLS
    - MAINTENANCE_PROFILE_TOOLS
    - memDelete
tags:
  - mcp
  - tool-profile
  - surface
  - safety
created_at: '2026-08-17T14:26:39.486Z'
expires_when: null
verified_at: null
stale_reason: null
related_ids: []
last_read_at: null
revision_count: 0
requires_human_approval: false
validated_by: auto
---
## The default MCP profile exposes `mem_update` but deliberately NOT `mem_delete`

The `enforcement` profile (the default, 13 → 14 tools) was create-only for memories: it shipped
`mem_save` but no way to correct what was written. That was a real defect, not just a cosmetic gap —
`mem_save` rejects a duplicate body with the message *"use mem_update to modify"*, so the agent was
pointed at a tool it could not call. Its only escape was to write a near-duplicate memory, which
pollutes the corpus that everything else ranks over.

**Decided:** add `mem_update` to `ENFORCEMENT_PROFILE_TOOLS` (removed from the maintenance list,
which spreads enforcement, to avoid a duplicate entry).

**Decided against:** adding `mem_delete` alongside it, even though it would close the same
"lifecycle incomplete" complaint more fully. Two reasons:

1. `memDelete` (`packages/mcp/src/tools/mem-delete.ts`) does an unconditional `unlink` — no
   confirmation, no archive, no undo.
2. Deleting a memory that carries a **block sensor** silently removes enforcement. Hivelore has a
   whole gate for exactly this (`sensor-weakened` surfaces a *deleted block-sensor memory*), so
   handing every agent an unguarded delete by default would contradict the product's own doctrine.

Deletion stays a maintenance-profile operation, i.e. a human-initiated one.

**Do not use usage logs to argue about a non-exposed tool.** `.ai/.usage/tool-usage.jsonl` shows
`mem_update` at zero calls, but that is circular — it was never offered. The v0.32.0 surface-reduction
bar (see [[2026-07-02-decision-surface-reduction-one-verb-per-job]]) applies to *removing* tools that
were available and unused; it does not license keeping a needed tool hidden.

**Trigger:** found via the Glama listing audit — Server Coherence scored *Completeness 2/5* citing
"`mem_save` even references a `mem_update` that is not present". The scoring was the messenger; the
dangling reference was the actual bug.
