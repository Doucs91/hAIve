/**
 * Recap compaction — keep the auto-generated session recap from dominating the briefing head.
 *
 * The MCP server auto-saves a minimal recap on exit (goal = "Auto-captured session (N tool calls)",
 * body = a raw tool-call/file dump). It's low signal, yet get_briefing shows the freshest recap's
 * full body at the very top of every briefing. A human/post_task recap (with a real Discoveries
 * section) is far richer. This module detects an auto recap and compresses it to its useful core
 * (the Discoveries, if any) so it informs without crowding. Pure, unit-tested.
 */

/**
 * True when a recap body looks auto-generated (vs. a human/post_task recap). Auto recaps come in a
 * couple of shapes, all low-signal: the session-tracker's "Auto-captured session (N tool calls)" and
 * the run-wrapper's "Edited N files across M tool calls". The common tell is a raw tool-call count.
 */
export function isAutoRecap(body: string): boolean {
  return (
    /Auto-captured session/i.test(body) ||
    /\bEdited \d+ files? across \d+ tool calls?/i.test(body) ||
    /\b\d+ tool calls?\b/i.test(body)
  );
}

/**
 * Return a compact version of an auto recap body: a one-line header (the Goal line) plus the
 * Discoveries section when it carries real content (e.g. detected failures). Non-auto recaps are
 * returned unchanged.
 */
export function compactAutoRecapBody(body: string, maxChars = 600): string {
  if (!isAutoRecap(body)) return body;

  // Header = the Goal line if present, else the auto-captured marker, else a generic label.
  const goalMatch = body.match(/##+\s*Goal[^\n]*\n+([^\n]+)/i);
  const callsMatch = body.match(/Auto-captured session \(([^)]+)\)/i);
  const header = goalMatch?.[1]?.trim()
    ? `_${goalMatch[1].trim()}_`
    : callsMatch
      ? `_Auto-captured session (${callsMatch[1]})._`
      : "_Auto-captured session._";

  // Pull the Discoveries / surprises section if present and non-trivial.
  const discMatch = body.match(/##+\s*Discoveries[^\n]*\n([\s\S]*?)(?=\n##+\s|\n*$)/i);
  const discovery = discMatch?.[1]?.trim() ?? "";
  const trivialDiscovery =
    discovery === "" ||
    /^no (new memories|surprising)/i.test(discovery) ||
    /No new memories saved this session\.?$/i.test(discovery);

  if (trivialDiscovery) {
    return `${header}\n\n_No notable discoveries captured. Run post_task / \`mem_session_end\` for a richer recap._`;
  }
  const trimmed = discovery.length > maxChars ? discovery.slice(0, maxChars) + "…" : discovery;
  return `${header}\n\n**Discoveries:**\n${trimmed}`;
}

/**
 * The excerpt of a recap that belongs at the TOP of every briefing: only what the next session must
 * act on — the goal in one line and the next steps.
 *
 * A full human/post_task recap (goal + accomplished + discoveries + next steps) ran ~3000 tokens and
 * was re-emitted at the head of EVERY briefing, so a session with five briefings paid five times to
 * re-read a wall the agent had just written (field report 2026-09-01 §5.6). The full body stays in
 * the corpus — reachable with `mem_get <id>` — this only trims what the briefing head carries. Auto
 * recaps still route through {@link compactAutoRecapBody}. Pure.
 */
export function recapBriefingExcerpt(body: string, maxChars = 700): string {
  if (isAutoRecap(body)) return compactAutoRecapBody(body);
  const section = (name: RegExp): string =>
    body.match(name)?.[1]?.trim() ?? "";
  const goal = section(/##+\s*Goal[^\n]*\n+([\s\S]*?)(?=\n##+\s|\n*$)/i);
  const next = section(/##+\s*Next steps?[^\n]*\n([\s\S]*?)(?=\n##+\s|\n*$)/i);
  // A free-form recap with no structured sections is its own point — return it (bounded).
  if (!goal && !next) return body.length > maxChars ? body.slice(0, maxChars).trimEnd() + "…" : body;
  const parts: string[] = [];
  if (goal) parts.push(`_${goal.split("\n")[0]!.trim()}_`);
  parts.push(next ? `**Next steps:**\n${next}` : "_No next steps recorded — `mem_get <id>` for the full recap._");
  let out = parts.join("\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + "…";
  return out;
}
