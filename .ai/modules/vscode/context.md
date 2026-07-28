# Module: vscode (VS Code extension)

Surfaces Hivelore memories inline (tree view, code lens, status bar, briefing panel) and a Strategic
Cockpit over the CLI's observability. Versioned independently — **not** part of the npm lockstep.

## Conventions specific to this module
- **All Hivelore CLI invocations go through `runHaive()`** (`harnessHealth.ts`) — never raw `child_process`
  (`cp.exec`/`cp.spawn`/`cp.execFile`). `runHaive` is the single place that shells out; it centralizes
  the configured binary, cwd/root resolution, and error handling.
- Register every disposable (`vscode.window.createTreeView`, `registerCommand`, `onDid*`) in
  `ctx.subscriptions`, or it leaks across extension reloads.
- Normalize paths with `.replace(/\\/g, "/")` before comparing a `Uri.fsPath` to a memory anchor path
  (Windows back-slashes otherwise never match).

## Internals
- `extension.ts` wires providers; memories are read via `MemoryStore` (`memoryReader.ts`) — the extension
  does not parse frontmatter itself. `runHaive` lives in `harnessHealth.ts`.
