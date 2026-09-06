import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HaivePaths } from "./paths.js";

export const BRIEFING_MARKER_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_RECAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BriefingMarker {
  session_id: string;
  task?: string;
  source: string;
  created_at: string;
  root: string;
  memory_ids?: string[];
  files?: string[];
}

export function enforcementDir(paths: HaivePaths): string {
  return path.join(paths.runtimeDir, "enforcement");
}

export function briefingMarkersDir(paths: HaivePaths): string {
  return path.join(enforcementDir(paths), "briefings");
}

export function normalizeSessionId(sessionId?: string): string {
  return (sessionId?.trim() || "default").replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 120);
}

export function briefingMarkerPath(paths: HaivePaths, sessionId?: string): string {
  return path.join(briefingMarkersDir(paths), `${normalizeSessionId(sessionId)}.json`);
}

export async function writeBriefingMarker(
  paths: HaivePaths,
  input: {
    sessionId?: string;
    task?: string;
    source: string;
    memoryIds?: string[];
    files?: string[];
    /**
     * Accumulate memory_ids/files with the existing fresh marker for THIS session instead of
     * overwriting (default true). This is what lets decision-coverage build up as the agent works:
     * every get_briefing call, every pre-edit injection, every `hivelore briefing` ADDS to the
     * session's consulted set — so a broad commit no longer requires one giant briefing covering
     * every relevant decision at once. Pass false to replace (e.g. starting a brand-new session).
     */
    accumulate?: boolean;
  },
): Promise<BriefingMarker> {
  const sessionId = normalizeSessionId(input.sessionId);
  const accumulate = input.accumulate ?? true;

  // Union with the existing fresh marker for the same session, so consulted memories accrue.
  let priorIds: string[] = [];
  let priorFiles: string[] = [];
  if (accumulate) {
    const existing = await readSessionBriefingMarker(paths, sessionId);
    if (existing) {
      priorIds = existing.memory_ids ?? [];
      priorFiles = existing.files ?? [];
    }
  }

  const mergedIds = [...new Set([...priorIds, ...(input.memoryIds ?? [])])];
  const mergedFiles = [...new Set([...priorFiles, ...(input.files ?? [])])];

  const marker: BriefingMarker = {
    session_id: sessionId,
    ...(input.task?.trim() ? { task: input.task.trim() } : {}),
    ...(mergedIds.length > 0 ? { memory_ids: mergedIds } : {}),
    ...(mergedFiles.length > 0 ? { files: mergedFiles } : {}),
    source: input.source,
    created_at: new Date().toISOString(),
    root: paths.root,
  };
  await mkdir(briefingMarkersDir(paths), { recursive: true });
  await writeFile(
    briefingMarkerPath(paths, marker.session_id),
    JSON.stringify(marker, null, 2) + "\n",
    "utf8",
  );
  return marker;
}

/** Read THIS session's marker if it exists and is still fresh (within TTL). Null otherwise. */
async function readSessionBriefingMarker(
  paths: HaivePaths,
  sessionId: string,
  ttlMs = BRIEFING_MARKER_TTL_MS,
  now = Date.now(),
): Promise<BriefingMarker | null> {
  const file = briefingMarkerPath(paths, sessionId);
  if (!existsSync(file)) return null;
  try {
    const marker = JSON.parse(await readFile(file, "utf8")) as BriefingMarker;
    const created = Date.parse(marker.created_at);
    if (!Number.isFinite(created) || now - created > ttlMs) return null;
    return marker;
  } catch {
    return null;
  }
}

export async function hasRecentBriefingMarker(
  paths: HaivePaths,
  sessionId?: string,
  ttlMs = BRIEFING_MARKER_TTL_MS,
): Promise<boolean> {
  const now = Date.now();
  const candidates: string[] = [];
  const exact = briefingMarkerPath(paths, sessionId);
  if (existsSync(exact)) candidates.push(exact);
  try {
    const dir = briefingMarkersDir(paths);
    const files = await readdir(dir);
    for (const file of files) {
      if (file.endsWith(".json")) candidates.push(path.join(dir, file));
    }
  } catch {
    // no marker directory yet
  }

  for (const file of new Set(candidates)) {
    try {
      const marker = JSON.parse(await readFile(file, "utf8")) as BriefingMarker;
      const created = Date.parse(marker.created_at);
      if (Number.isFinite(created) && now - created <= ttlMs) return true;
    } catch {
      // ignore corrupt markers
    }
  }
  return false;
}

/** Where a briefing marker came from, relative to the session asking about it. */
export type BriefingMarkerSource = "this-session" | "other-session" | "none";

export interface BriefingMarkerStatus {
  marker: BriefingMarker | null;
  source: BriefingMarkerSource;
  /** Age of the marker in ms, or null when there is none. */
  age_ms: number | null;
}

/**
 * Answer the question the `briefing-loaded` gate actually means to ask: did THIS session load a
 * briefing?
 *
 * `hasRecentBriefingMarker` answers a weaker question — does any marker in the directory fall
 * inside the TTL — and a field report (2026-09-05 §3) showed what that costs: an agent that never
 * called `get_briefing` passed a `strict` `requireBriefingFirst` gate eight times, on a marker left
 * by a previous session at 23:58. The check reported "A recent Hivelore briefing marker exists",
 * which was true, and which nobody could distinguish from "you are briefed".
 *
 * Callers that need the accrued memory set (decision coverage) still want the union across markers;
 * callers that report a guarantee to a human need this instead.
 */
export async function describeBriefingMarker(
  paths: HaivePaths,
  sessionId?: string,
  ttlMs = BRIEFING_MARKER_TTL_MS,
  now = Date.now(),
): Promise<BriefingMarkerStatus> {
  const age = (marker: BriefingMarker): number | null => {
    const created = Date.parse(marker.created_at);
    return Number.isFinite(created) ? now - created : null;
  };
  const own = await readSessionBriefingMarker(paths, normalizeSessionId(sessionId), ttlMs, now);
  if (own) return { marker: own, source: "this-session", age_ms: age(own) };
  const fromAnySession = await readRecentBriefingMarker(paths, sessionId, ttlMs);
  if (fromAnySession) return { marker: fromAnySession, source: "other-session", age_ms: age(fromAnySession) };
  return { marker: null, source: "none", age_ms: null };
}

export async function readRecentBriefingMarker(
  paths: HaivePaths,
  sessionId?: string,
  ttlMs = BRIEFING_MARKER_TTL_MS,
): Promise<BriefingMarker | null> {
  const now = Date.now();
  const candidates: string[] = [];
  const exact = briefingMarkerPath(paths, sessionId);
  if (existsSync(exact)) candidates.push(exact);
  try {
    const dir = briefingMarkersDir(paths);
    const files = await readdir(dir);
    for (const file of files) {
      if (file.endsWith(".json")) candidates.push(path.join(dir, file));
    }
  } catch {
    // no marker directory yet
  }

  let freshest: BriefingMarker | null = null;
  let freshestTs = 0;
  for (const file of new Set(candidates)) {
    try {
      const marker = JSON.parse(await readFile(file, "utf8")) as BriefingMarker;
      const created = Date.parse(marker.created_at);
      if (!Number.isFinite(created) || now - created > ttlMs) continue;
      if (created > freshestTs) {
        freshest = marker;
        freshestTs = created;
      }
    } catch {
      // ignore corrupt markers
    }
  }
  return freshest;
}

export function isFreshIsoDate(value: string | Date, ttlMs: number, now = Date.now()): boolean {
  const ts = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ts) && now - ts <= ttlMs;
}
