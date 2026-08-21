import type { LoadedMemory } from "./loader.js";
import type { MemoryFrontmatter } from "./types.js";
import { computeImpact, compareImpact, summarizeImpact, type ImpactSummary, type ImpactScore } from "./impact.js";
import { isRetiredMemory } from "./memory-lifecycle.js";
import { DECAY_DAYS, getUsage, isDecaying, type UsageIndex } from "./usage.js";
import {
  computePreventionTrend,
  computeRecurrence,
  type PreventionEvent,
  type PreventionTrend,
  type RecurrenceReport,
} from "./prevention.js";
import { computeGatePrecision, type GatePrecision } from "./gate-precision.js";
import type { AntiPatternGate } from "./config.js";

/**
 * Observability rollup — the "is the corpus healthy and earning its keep?" view.
 *
 * Hivelore already has the pieces (impact scoring, usage tracking, sensors, retirement,
 * decay) but no single non-interactive snapshot that an agent, a CI job, or a human
 * can read in one shot. `hivelore stats` only covers
 * tool-call volume. This module aggregates the full picture deterministically so the
 * CLI can print it (or emit JSON). Pure: no I/O, unit-tested in `test/dashboard.test.ts`.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DashboardOptions {
  /** How many rows to include in each "top" list. Default 10. */
  top?: number;
  /** Dormancy window for impact scoring. Defaults to impact's own default. */
  dormantDays?: number;
  now?: Date;
  /** Prevention event log (from `loadPreventionEvents`) — powers the trend + recurrence rollups. */
  preventionEvents?: PreventionEvent[];
  /** Configured anti-pattern gate — lets the gate-precision rollup suggest tightening/loosening. */
  antiPatternGate?: AntiPatternGate;
}

export interface ImpactRow {
  id: string;
  score: number;
  tier: ImpactScore["tier"];
  signals: string[];
  prune_candidate: boolean;
}

export interface SensorRow {
  id: string;
  severity: "warn" | "block";
  last_fired: string;
}

export interface DormantRow {
  id: string;
  last_read_at: string | null;
  age_days: number;
}

export interface PreventionRow {
  id: string;
  type: string;
  prevented_count: number;
  last_prevented_at: string | null;
}

export interface DashboardReport {
  generated_at: string;
  inventory: {
    /** Policy corpus size (excludes session_recap). */
    total: number;
    session_recaps: number;
    active: number;
    retired: number;
    by_scope: Record<string, number>;
    by_type: Record<string, number>;
    by_status: Record<string, number>;
  };
  /** OUTCOME measurement: prevention events = times a memory's sensor/anti-pattern fired on a real
   *  diff, intercepting a known mistake. Distinct from retrieval (reads) — demonstrated value. */
  prevention: {
    total_events: number;
    memories_with_catches: number;
    top: PreventionRow[];
    /** Catch volume over time (from the prevention event log). */
    trend: PreventionTrend;
    /** Lessons re-introduced after capture (caught on >= 2 distinct days). */
    recurrence: RecurrenceReport;
  };
  /** Inferential-gate signal quality: are catches real (useful) or noise (rejected)? + tuning hint. */
  gate_precision: GatePrecision;
  impact: ImpactSummary & { top: ImpactRow[] };
  sensors: {
    total: number;
    warn: number;
    block: number;
    autogen: number;
    fired: number;
    recently_fired: SensorRow[];
  };
  health: {
    stale: number;
    retired: number;
    /** Validated decision/gotcha/architecture memories with no anchor paths or symbols. */
    anchorless: number;
    /** Memories awaiting review (draft/proposed). */
    pending: number;
    prune_candidates: number;
  };
  decay: {
    decay_days: number;
    decaying: number;
    top_dormant: DormantRow[];
  };
  corpus: {
    /** Number of memory files (policy corpus, excludes session_recap). */
    memory_files: number;
    body_chars: number;
    /** Rough token estimate (~chars/4) — how heavy the corpus is to inject. */
    est_tokens: number;
  };
}

function isAnchorless(fm: MemoryFrontmatter): boolean {
  if (!["decision", "gotcha", "architecture"].includes(fm.type)) return false;
  if (fm.status !== "validated") return false;
  return fm.anchor.paths.length === 0 && fm.anchor.symbols.length === 0;
}

function inc(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Build the full observability rollup from the loaded corpus + usage index. Pure. */
export function buildDashboard(
  memories: LoadedMemory[],
  usage: UsageIndex,
  options: DashboardOptions = {},
): DashboardReport {
  const now = options.now ?? new Date();
  const top = options.top ?? 10;

  const inventory = {
    total: 0,
    session_recaps: 0,
    active: 0,
    retired: 0,
    by_scope: {} as Record<string, number>,
    by_type: {} as Record<string, number>,
    by_status: {} as Record<string, number>,
  };

  const impactScores: ImpactScore[] = [];
  const impactRows: ImpactRow[] = [];
  const sensorRows: SensorRow[] = [];
  let sensorTotal = 0;
  let sensorWarn = 0;
  let sensorBlock = 0;
  let sensorAutogen = 0;
  let sensorFired = 0;
  let stale = 0;
  let retired = 0;
  let anchorless = 0;
  let pending = 0;
  let decaying = 0;
  let bodyChars = 0;
  const dormantRows: DormantRow[] = [];
  let preventionEvents = 0;
  const preventionRows: PreventionRow[] = [];

  for (const { memory } of memories) {
    const fm = memory.frontmatter;

    if (fm.type === "session_recap") {
      inventory.session_recaps += 1;
      continue;
    }

    inventory.total += 1;
    inc(inventory.by_scope, fm.scope);
    inc(inventory.by_type, fm.type);
    inc(inventory.by_status, fm.status);
    bodyChars += memory.body.length;

    const isRetired = isRetiredMemory(fm, memory.body, now);
    if (isRetired) {
      inventory.retired += 1;
      retired += 1;
    } else {
      inventory.active += 1;
    }
    if (fm.status === "stale") stale += 1;
    if (isAnchorless(fm)) anchorless += 1;
    if (fm.status === "draft" || fm.status === "proposed") pending += 1;

    // ── Sensors ──
    if (fm.sensor) {
      sensorTotal += 1;
      if (fm.sensor.severity === "block") sensorBlock += 1;
      else sensorWarn += 1;
      if (fm.sensor.autogen) sensorAutogen += 1;
      if (fm.sensor.last_fired) {
        sensorFired += 1;
        sensorRows.push({ id: fm.id, severity: fm.sensor.severity, last_fired: fm.sensor.last_fired });
      }
    }

    // ── Impact ──
    const memUsage = getUsage(usage, fm.id);
    const impact = computeImpact(fm, memUsage, {
      now,
      ...(options.dormantDays !== undefined ? { dormantDays: options.dormantDays } : {}),
    });
    impactScores.push(impact);
    impactRows.push({
      id: fm.id,
      score: impact.score,
      tier: impact.tier,
      signals: impact.signals,
      prune_candidate: impact.pruneCandidate,
    });

    // ── Prevention (outcome) ──
    if (memUsage.prevented_count > 0) {
      preventionEvents += memUsage.prevented_count;
      preventionRows.push({
        id: fm.id,
        type: fm.type,
        prevented_count: memUsage.prevented_count,
        last_prevented_at: memUsage.last_prevented_at,
      });
    }

    // ── Decay ──
    if (isDecaying(memUsage, fm.created_at)) decaying += 1;
    if (impact.tier === "dormant") {
      const anchor = memUsage.last_read_at ?? fm.created_at;
      const ageDays = Math.floor((now.getTime() - new Date(anchor).getTime()) / MS_PER_DAY);
      dormantRows.push({ id: fm.id, last_read_at: memUsage.last_read_at, age_days: ageDays });
    }
  }

  impactRows.sort((a, b) =>
    compareImpact(
      { score: a.score, tier: a.tier, signals: a.signals, pruneCandidate: a.prune_candidate },
      { score: b.score, tier: b.tier, signals: b.signals, pruneCandidate: b.prune_candidate },
    ),
  );
  sensorRows.sort((a, b) => b.last_fired.localeCompare(a.last_fired));
  dormantRows.sort((a, b) => b.age_days - a.age_days);
  const eventLog = options.preventionEvents ?? [];
  const recurrence = computeRecurrence(eventLog);

  return {
    generated_at: now.toISOString(),
    inventory,
    prevention: {
      total_events: preventionEvents,
      memories_with_catches: preventionRows.length,
      top: preventionRows
        .sort((a, b) => b.prevented_count - a.prevented_count)
        .slice(0, top),
      trend: computePreventionTrend(eventLog, now),
      recurrence: {
        ...recurrence,
        top: recurrence.top.slice(0, top),
      },
    },
    gate_precision: computeGatePrecision(
      eventLog,
      usage,
      options.antiPatternGate ?? "anchored",
    ),
    impact: { ...summarizeImpact(impactScores), top: impactRows.slice(0, top) },
    sensors: {
      total: sensorTotal,
      warn: sensorWarn,
      block: sensorBlock,
      autogen: sensorAutogen,
      fired: sensorFired,
      recently_fired: sensorRows.slice(0, top),
    },
    health: {
      stale,
      retired,
      anchorless,
      pending,
      prune_candidates: impactScores.filter((s) => s.pruneCandidate).length,
    },
    decay: {
      decay_days: DECAY_DAYS,
      decaying,
      top_dormant: dormantRows.slice(0, top),
    },
    corpus: {
      memory_files: inventory.total,
      body_chars: bodyChars,
      est_tokens: Math.round(bodyChars / 4),
    },
  };
}
