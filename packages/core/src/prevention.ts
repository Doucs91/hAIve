/**
 * Prevention event log — the time-series behind Hivelore's OUTCOME metric.
 *
 * `usage.json` keeps a cumulative `prevented_count` per memory (cheap, drives impact). This log
 * keeps one append-only record PER catch, with a timestamp, so we can answer questions a counter
 * can't: how is prevention trending over time, and which lessons keep getting re-introduced after
 * capture (recurrence). Lives in `.ai/.cache/` (gitignored telemetry) — never committed, never
 * churns a release.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { LoadedMemory } from "./loader.js";
import type { HaivePaths } from "./paths.js";
import {
  getUsage,
  loadUsageIndex,
  recordPrevention,
  saveUsageIndex,
  type UsageIndex,
} from "./usage.js";

export type PreventionSource = "sensor" | "anti-pattern";

export interface PreventionEvent {
  /** ISO timestamp of the catch. */
  at: string;
  /** Memory id whose lesson fired. */
  id: string;
  /** Which gate path recorded it. */
  source: PreventionSource;
  /** Optional detail for receipts; absent on logs written before v0.35.0. */
  kind?: "regex" | "ast" | "shell" | "test";
  stage?: "pre-commit" | "pre-push" | "ci" | "manual";
  exit_code?: number;
}

export type PreventionEventDetail = Pick<PreventionEvent, "kind" | "stage" | "exit_code">;

export function preventionLogPath(paths: HaivePaths): string {
  return path.join(paths.haiveDir, ".cache", "prevention-log.jsonl");
}

/** Append one catch to the log. Best-effort, creates the dir on demand. */
export async function appendPreventionEvent(paths: HaivePaths, event: PreventionEvent): Promise<void> {
  const file = preventionLogPath(paths);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + "\n", "utf8");
}

/**
 * THE single recorder for "a documented lesson intercepted a real mistake". Every gate path —
 * the installed git-hook gate (`enforce check`), the standalone `hivelore sensors check`, and the
 * `anti_patterns_check` MCP tool — funnels its fired memory ids through here so prevention is
 * recorded once and identically, not bolted onto each entry point (it used to leak: the git-hook
 * gate blocked but never recorded — see the harness-positioning gotcha).
 *
 * Bumps `prevented_count` in usage.json (debounced per memory via {@link recordPrevention}) AND
 * appends one timestamped event per NEW catch to the prevention log. Best-effort: a telemetry
 * write must never break a commit, so failures are swallowed. Returns the ids actually recorded
 * (i.e. not debounced), so callers can report "caught for you" without re-counting.
 */
export async function recordPreventionHits(
  paths: HaivePaths,
  firedIds: string[],
  source: PreventionSource,
  now: Date = new Date(),
  details: Record<string, PreventionEventDetail> = {},
): Promise<string[]> {
  const unique = [...new Set(firedIds)].filter(Boolean);
  if (unique.length === 0) return [];
  const usage = await loadUsageIndex(paths).catch(() => null);
  if (!usage) return [];
  const recordedIds: string[] = [];
  for (const id of unique) {
    if (recordPrevention(usage, id, now.getTime())) recordedIds.push(id);
  }
  if (recordedIds.length === 0) return [];
  await saveUsageIndex(paths, usage).catch(() => { /* best-effort telemetry */ });
  const at = now.toISOString();
  for (const id of recordedIds) {
    await appendPreventionEvent(paths, { at, id, source, ...details[id] }).catch(() => { /* best-effort */ });
  }
  return recordedIds;
}

export interface PreventionReceiptRow {
  at: string;
  id: string;
  title: string;
  source: PreventionSource;
  kind: "regex" | "ast" | "shell" | "test" | null;
  stage: "pre-commit" | "pre-push" | "ci" | "manual" | null;
  exit_code: number | null;
  message: string | null;
  /** Incident provenance from the sensor frontmatter — the behaviour-harness link, when present. */
  incident: string | null;
  /** The oracle was proven RED on the incident state at arming time (red_ref replay). */
  red_proven: boolean;
  /**
   * How strong the evidence is that this block prevented a REAL bug (not just a documented preference):
   *   - `proven`     — a red-proven oracle: the mistake is demonstrably a real incident (RED replay).
   *   - `incident`   — carries an incident reference (a linked prod issue), but not RED-replayed.
   *   - `documented` — a validated lesson with no incident proof (a team convention/preference).
   */
  evidence: "proven" | "incident" | "documented";
}

export interface PreventionReceipt {
  generated_at: string;
  since: string;
  window_days: number;
  total: number;
  previous_total: number;
  prevented_count_total: number;
  /** Evidence breakdown of the window's preventions — how many blocked a demonstrably-real incident. */
  by_evidence: { proven: number; incident: number; documented: number };
  trend: PreventionTrend;
  events: PreventionReceiptRow[];
}

/** Stable, deterministic aggregation used by the CLI and the CI PR comment. */
export function buildPreventionReceipt(
  events: PreventionEvent[],
  memories: LoadedMemory[],
  usage: UsageIndex,
  options: { since: Date; now?: Date },
): PreventionReceipt {
  const now = options.now ?? new Date();
  const sinceMs = options.since.getTime();
  const nowMs = now.getTime();
  const windowMs = Math.max(1, nowMs - sinceMs);
  const previousSince = sinceMs - windowMs;
  const byId = new Map(memories.map((m) => [m.memory.frontmatter.id, m]));
  const current = events.filter((e) => {
    const at = Date.parse(e.at);
    return Number.isFinite(at) && at >= sinceMs && at <= nowMs;
  });
  const previousTotal = events.filter((e) => {
    const at = Date.parse(e.at);
    return Number.isFinite(at) && at >= previousSince && at < sinceMs;
  }).length;
  const rows = current
    .map((event): PreventionReceiptRow => {
      const loaded = byId.get(event.id);
      const sensor = loaded?.memory.frontmatter.sensor;
      return {
        at: event.at,
        id: event.id,
        title: titleFromMemory(loaded) || event.id,
        source: event.source,
        kind: event.kind ?? sensor?.kind ?? (event.source === "sensor" ? "regex" : null),
        stage: event.stage ?? null,
        exit_code: event.exit_code ?? null,
        message: sensor?.message ?? null,
        incident: sensor?.incident ?? null,
        red_proven: sensor?.red_proven === true,
        evidence: sensor?.red_proven === true ? "proven" : sensor?.incident ? "incident" : "documented",
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
  const byEvidence = {
    proven: rows.filter((r) => r.evidence === "proven").length,
    incident: rows.filter((r) => r.evidence === "incident").length,
    documented: rows.filter((r) => r.evidence === "documented").length,
  };
  const preventedCountTotal = Object.values(usage.by_id)
    .reduce((sum, item) => sum + (item.prevented_count ?? 0), 0);
  return {
    generated_at: now.toISOString(),
    since: options.since.toISOString(),
    window_days: Math.max(1, Math.round(windowMs / MS_PER_DAY)),
    total: rows.length,
    previous_total: previousTotal,
    prevented_count_total: preventedCountTotal,
    by_evidence: byEvidence,
    trend: computePreventionTrend(events, now),
    events: rows,
  };
}

export function renderPreventionReceipt(receipt: PreventionReceipt): string {
  const lines = [
    `Hivelore prevention receipt — last ${receipt.window_days} days`,
    `  ${receipt.total} repeat mistake${receipt.total === 1 ? "" : "s"} refused before ${receipt.total === 1 ? "it" : "they"} reached review.`,
  ];
  if (receipt.total > 0) {
    // Evidence honesty: separate blocks that stopped a DEMONSTRABLY-real incident (red-proven, or an
    // incident-linked lesson) from blocks that only enforced a documented preference. This is the
    // empirical claim the whole pitch rests on — grade it, never inflate it.
    const e = receipt.by_evidence;
    lines.push(`  Evidence: ${e.proven} red-proven · ${e.incident} incident-linked · ${e.documented} documented-only.`);
  }
  for (const row of receipt.events) {
    const kind = row.kind ? `${row.kind} sensor` : row.source;
    const exit = row.exit_code === null ? "" : `, exit ${row.exit_code}`;
    const stage = row.stage ? ` — caught at ${row.stage}` : "";
    const incident = row.incident ? `  ↩ incident: ${row.incident}` : "";
    const red = row.red_proven ? "  ✓ RED-proven" : "";
    lines.push(`  ✗→✓ ${row.at.slice(0, 10)}  ${row.id.padEnd(32)} (${kind}${exit}${stage})${incident}${red}`);
  }
  lines.push(
    `  Trend: ${receipt.total} this window vs ${receipt.previous_total} previous window ` +
    `(${receipt.total <= receipt.previous_total ? "recurrences declining" : "recurrences rising"}).`,
  );
  return lines.join("\n");
}

/**
 * Attribution footer for shared receipts — the growth loop. Every time a team pastes proof of
 * prevented mistakes into Slack or a PR, the artifact names the tool that produced it. Kept as one
 * constant so the CLI `--share` output and the CI PR comment carry identical wording.
 */
export const HIVELORE_ATTRIBUTION =
  "🛡️ Generated by [Hivelore](https://github.com/Doucs91/hivelore) — the deterministic policy gate for agent-written code.";

/**
 * Markdown rendering of the receipt for `hivelore stats receipt --share` and the CI PR comment —
 * ready to paste into Slack or a review. Includes incident provenance and the attribution footer.
 * An empty window is NOT a dead end: it renders a forward CTA (turn an incident into a guardrail),
 * so the receipt is useful on day one, before any prevention has been recorded.
 */
export function renderPreventionReceiptShare(receipt: PreventionReceipt): string {
  const lines: string[] = [`### 🛡️ Hivelore prevention receipt — last ${receipt.window_days} days`, ""];
  if (receipt.total === 0) {
    lines.push(
      "No repeat mistakes reached review in this window.",
      "",
      "Turn a past incident into a guardrail so it can never come back:",
      "`hivelore memory tried … --sensor-command \"<your test>\"` (add `--incident <ref>` to link the incident it guards).",
    );
  } else {
    lines.push(
      `**${receipt.total} repeat mistake${receipt.total === 1 ? "" : "s"} refused before ${receipt.total === 1 ? "it" : "they"} reached review.**`,
      "",
    );
    for (const row of receipt.events) {
      const kind = row.kind ? `${row.kind} sensor` : row.source;
      const exit = row.exit_code === null ? "" : `, exit ${row.exit_code}`;
      const stage = row.stage ? ` — caught at ${row.stage}` : "";
      const incident = row.incident ? ` ↩ incident: ${row.incident}` : "";
      lines.push(`- ✗→✓ \`${row.at.slice(0, 10)}\` **${row.title}** (${kind}${exit}${stage})${incident}`);
    }
    lines.push(
      "",
      `_Trend: ${receipt.total} this window vs ${receipt.previous_total} previous window ` +
      `(${receipt.total <= receipt.previous_total ? "recurrences declining" : "recurrences rising"})._`,
    );
  }
  lines.push("", `<sub>${HIVELORE_ATTRIBUTION}</sub>`);
  return lines.join("\n");
}

/** Stable marker the CI job greps for to update its own comment instead of posting a new one. */
export const PREVENTION_RECEIPT_MARKER = "<!-- haive:prevention-receipt -->";

export interface PreventionCommentFinding {
  code?: string;
  message?: string;
  memory_ids?: string[];
  file?: string;
  /** The exact source line that matched — what makes the receipt actionable rather than a tally. */
  matched_line?: string;
}

/**
 * Full PR-comment body: marker + what fired on THIS pull request + the rolling receipt.
 *
 * This used to be assembled by a multi-line `jq -nr` program embedded in the generated
 * `hivelore-enforcement.yml`. Its literal newlines terminated the surrounding YAML scalar, so the
 * workflow every user got from `hivelore init` did not parse and GitHub refused to run it at all
 * ("This run likely failed because of a workflow file issue"). Rendering the body here means the
 * generated YAML holds a plain command and never a program — the defect class cannot come back.
 */
export function renderPreventionComment(
  receipt: PreventionReceipt,
  findings: PreventionCommentFinding[] = [],
): string {
  const fired = findings.filter((f) => f.code === "sensor-block" || f.code === "sensor-warn");
  const lines = [PREVENTION_RECEIPT_MARKER, "", "## Hivelore prevention receipt", ""];
  if (fired.length === 0) {
    lines.push("No documented sensor fired on this PR.", "");
  } else {
    lines.push("### Fired on this PR", "");
    for (const f of fired) {
      // Name the pattern AND where it fired: "score 40%" is not actionable, `file:line` is.
      const where = f.file ? ` — \`${f.file}\`` : "";
      lines.push(`- **${f.memory_ids?.[0] ?? "sensor"}**${where} — ${f.message ?? "sensor fired"}`);
      if (f.matched_line) lines.push(`  \`\`\`\n  ${f.matched_line}\n  \`\`\``);
    }
    lines.push("");
  }
  lines.push(renderPreventionReceiptShare(receipt));
  return lines.join("\n");
}

/** Read all catch events (skips malformed lines). */
export async function loadPreventionEvents(paths: HaivePaths): Promise<PreventionEvent[]> {
  const file = preventionLogPath(paths);
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8").catch(() => "");
  const events: PreventionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as PreventionEvent;
      if (e && typeof e.at === "string" && typeof e.id === "string") events.push(e);
    } catch {
      // skip a corrupt line rather than fail the whole read
    }
  }
  return events;
}

// ── Pure analytics over the event log ───────────────────────────────────────

export interface PreventionTrend {
  /** Catches in the last 7 days. */
  last_7d: number;
  /** Catches in the last 30 days. */
  last_30d: number;
  /** Catch counts per ISO week, oldest → newest, for the last N weeks (default 6). */
  weekly: number[];
}

const MS_PER_DAY = 86_400_000;

export function computePreventionTrend(
  events: PreventionEvent[],
  now: Date = new Date(),
  weeks = 6,
): PreventionTrend {
  const nowMs = now.getTime();
  let last7 = 0;
  let last30 = 0;
  const weekly = new Array<number>(weeks).fill(0);
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    const ageDays = (nowMs - t) / MS_PER_DAY;
    if (ageDays < 0) continue;
    if (ageDays <= 7) last7 += 1;
    if (ageDays <= 30) last30 += 1;
    const weekIdx = weeks - 1 - Math.floor(ageDays / 7);
    if (weekIdx >= 0 && weekIdx < weeks) weekly[weekIdx] = (weekly[weekIdx] ?? 0) + 1;
  }
  return { last_7d: last7, last_30d: last30, weekly };
}

export interface RecurrenceRow {
  id: string;
  /** Total catches for this memory. */
  catches: number;
  /** Number of distinct UTC days the lesson fired — the recurrence signal. */
  distinct_days: number;
  last_at: string;
}

export interface RecurrenceReport {
  /**
   * Memories whose lesson was caught on >= 2 distinct days — i.e. the mistake was RE-INTRODUCED
   * after it had already been captured and caught once. A high count means a recurring problem the
   * team keeps reintroducing (the guardrail is earning its keep, and the root cause may need a
   * stronger fix than a memory).
   */
  recurring_count: number;
  top: RecurrenceRow[];
}

export function computeRecurrence(events: PreventionEvent[]): RecurrenceReport {
  const byId = new Map<string, { catches: number; days: Set<string>; last: string }>();
  for (const e of events) {
    const cur = byId.get(e.id) ?? { catches: 0, days: new Set<string>(), last: e.at };
    cur.catches += 1;
    cur.days.add(e.at.slice(0, 10));
    if (e.at > cur.last) cur.last = e.at;
    byId.set(e.id, cur);
  }
  const rows: RecurrenceRow[] = [];
  for (const [id, v] of byId) {
    if (v.days.size >= 2) {
      rows.push({ id, catches: v.catches, distinct_days: v.days.size, last_at: v.last });
    }
  }
  rows.sort((a, b) => b.distinct_days - a.distinct_days || b.catches - a.catches);
  return { recurring_count: rows.length, top: rows };
}

export interface BriefingProofLineOptions {
  /** End of the reporting window. Defaults to now. */
  now?: Date;
  /** Window size in days. Defaults to 30 ("this month" in product copy). */
  days?: number;
}

/**
 * Coordination point for Lot C: turn prevention events into one compact proof line
 * suitable for get_briefing, without coupling this lot to the MCP tool.
 */
export function briefingProofLine(
  events: PreventionEvent[],
  options: BriefingProofLineOptions = {},
): string | null {
  const now = options.now ?? new Date();
  const days = options.days ?? 30;
  const since = now.getTime() - days * MS_PER_DAY;
  let count = 0;
  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    if (t >= since && t <= now.getTime()) count += 1;
  }
  if (count === 0) return null;
  return `This harness prevented ${count} repeated mistake${count === 1 ? "" : "s"} in the last ${days} days.`;
}

export interface CaughtForYouOptions {
  /** Only include events at or after this instant. */
  since?: string | Date;
  /** Only include events at or before this instant. Defaults to now. */
  now?: Date;
  /** Max rows in the summary. Defaults to 5. */
  limit?: number;
}

export interface CaughtForYouRow {
  id: string;
  title: string;
  source: PreventionSource;
  catches: number;
  previous_count: number;
  current_count: number;
  last_at: string;
}

export interface CaughtForYouSummary {
  total_catches: number;
  since: string | null;
  until: string;
  rows: CaughtForYouRow[];
}

function titleFromMemory(loaded: LoadedMemory | undefined): string {
  if (!loaded) return "";
  for (const line of loaded.memory.body.split("\n")) {
    const heading = /^#+\s*(.+)$/.exec(line.trim());
    if (heading) return heading[1]!.trim().slice(0, 96);
  }
  for (const line of loaded.memory.body.split("\n")) {
    const t = line.trim();
    if (t) return t.replace(/^[-*]\s*/, "").slice(0, 96);
  }
  return "";
}

function sourceRank(source: PreventionSource): number {
  return source === "anti-pattern" ? 0 : 1;
}

/** Build the end-of-session "caught for you" scene from prevention events. Pure. */
export function summarizeCaughtForYou(
  events: PreventionEvent[],
  memories: LoadedMemory[],
  usage: UsageIndex,
  options: CaughtForYouOptions = {},
): CaughtForYouSummary {
  const until = options.now ?? new Date();
  const sinceMs =
    options.since === undefined
      ? null
      : options.since instanceof Date
        ? options.since.getTime()
        : Date.parse(options.since);
  const untilMs = until.getTime();
  const byIdSource = new Map<string, { id: string; source: PreventionSource; catches: number; last_at: string }>();

  for (const e of events) {
    const t = Date.parse(e.at);
    if (!Number.isFinite(t)) continue;
    if (sinceMs !== null && Number.isFinite(sinceMs) && t < sinceMs) continue;
    if (t > untilMs) continue;
    const key = `${e.id}\0${e.source}`;
    const current = byIdSource.get(key) ?? { id: e.id, source: e.source, catches: 0, last_at: e.at };
    current.catches += 1;
    if (e.at > current.last_at) current.last_at = e.at;
    byIdSource.set(key, current);
  }

  const memoryById = new Map(memories.map((m) => [m.memory.frontmatter.id, m]));
  const rows = [...byIdSource.values()]
    .map((row): CaughtForYouRow => {
      const current = getUsage(usage, row.id).prevented_count;
      const previous = Math.max(0, current - row.catches);
      return {
        id: row.id,
        title: titleFromMemory(memoryById.get(row.id)) || row.id,
        source: row.source,
        catches: row.catches,
        previous_count: previous,
        current_count: current,
        last_at: row.last_at,
      };
    })
    .sort((a, b) => b.last_at.localeCompare(a.last_at) || sourceRank(a.source) - sourceRank(b.source))
    .slice(0, options.limit ?? 5);

  return {
    total_catches: [...byIdSource.values()].reduce((sum, row) => sum + row.catches, 0),
    since: sinceMs !== null && Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    until: until.toISOString(),
    rows,
  };
}

/** Render a compact human-readable block for CLI/session recaps. */
export function renderCaughtForYou(summary: CaughtForYouSummary): string | null {
  if (summary.total_catches === 0 || summary.rows.length === 0) return null;
  const lines = [
    `Caught for you: ${summary.total_catches} prevented repeat${summary.total_catches === 1 ? "" : "s"} ${summary.since ? "this session" : "in recorded history"}.`,
  ];
  for (const row of summary.rows) {
    const gate = row.source === "anti-pattern" ? "Blocked" : "Caught";
    lines.push(
      `- ${gate}: ${row.title} (${row.id}). Prevention ${row.previous_count}->${row.current_count}.`,
    );
  }
  return lines.join("\n");
}
