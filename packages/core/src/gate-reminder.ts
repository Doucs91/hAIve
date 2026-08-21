/**
 * Repetition throttle for the gate's ADVISORY reminders.
 *
 * Advisory findings carry teaching text — the bootstrap gate prints a six-line checklist of what the
 * repo's knowledge layer is still missing. That is the right thing to show once. Printed on every
 * single commit it becomes wallpaper: a field report on v0.54.0 listed it under "nuisances", with
 * the observation that "un rappel qui se répète cinquante fois cesse d'être lu". A reminder nobody
 * reads is worse than no reminder, because it also teaches that gate output is skippable.
 *
 * So the full text is shown once per window, and collapsed to a single line the rest of the time.
 * Nothing is suppressed: the finding, its severity and its `fix` are unchanged, and `--json`
 * consumers always receive the complete message. Only the human rendering gets quieter.
 *
 * State lives in gitignored `.ai/.cache/`, so it is per-machine and disposable — never team truth.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { HaivePaths } from "./paths.js";

/** One full reminder per working day: long enough to stop nagging, short enough to still land. */
export const GATE_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

function reminderMarkerPath(paths: HaivePaths): string {
  return path.join(paths.haiveDir, ".cache", "gate-reminders.json");
}

async function readMarkers(paths: HaivePaths): Promise<Record<string, string>> {
  const file = reminderMarkerPath(paths);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Should this reminder be shown in full right now? True the first time in the window, and again
 * once the window lapses. Recording is the caller's job (see {@link recordGateReminder}) so a
 * reminder that was never actually rendered does not consume the window.
 */
export async function shouldExpandGateReminder(
  paths: HaivePaths,
  key: string,
  now: number = Date.now(),
  windowMs: number = GATE_REMINDER_WINDOW_MS,
): Promise<boolean> {
  const last = (await readMarkers(paths))[key];
  if (!last) return true;
  const at = Date.parse(last);
  return !Number.isFinite(at) || now - at >= windowMs;
}

/** Record that the full reminder was just shown. Best-effort: telemetry never breaks a commit. */
export async function recordGateReminder(
  paths: HaivePaths,
  key: string,
  now: number = Date.now(),
): Promise<void> {
  const file = reminderMarkerPath(paths);
  const markers = await readMarkers(paths);
  markers[key] = new Date(now).toISOString();
  await mkdir(path.dirname(file), { recursive: true }).catch(() => { /* ignore */ });
  await writeFile(file, JSON.stringify(markers, null, 2), "utf8").catch(() => { /* ignore */ });
}
