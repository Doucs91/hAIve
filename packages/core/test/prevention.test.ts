import { describe, expect, it } from "vitest";
import {
  briefingProofLine,
  buildPreventionReceipt,
  computePreventionTrend,
  computeRecurrence,
  HIVELORE_ATTRIBUTION,
  renderCaughtForYou,
  renderPreventionReceipt,
  renderPreventionReceiptShare,
  summarizeCaughtForYou,
  type PreventionEvent,
} from "../src/prevention.js";
import { emptyUsageIndex, recordPrevention } from "../src/usage.js";
import type { LoadedMemory } from "../src/loader.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");

function ev(daysAgo: number, id: string, source: PreventionEvent["source"] = "sensor"): PreventionEvent {
  return { at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), id, source };
}

describe("computePreventionTrend", () => {
  it("buckets catches into 7d / 30d windows and weekly columns", () => {
    const events = [ev(0, "m1"), ev(3, "m1"), ev(10, "m2"), ev(40, "m3")];
    const t = computePreventionTrend(events, NOW, 6);
    expect(t.last_7d).toBe(2); // 0d + 3d
    expect(t.last_30d).toBe(3); // 0d + 3d + 10d (40d excluded)
    expect(t.weekly).toHaveLength(6);
    // newest week (last column) holds the two recent catches.
    expect(t.weekly[5]).toBe(2);
    // total bucketed never exceeds events within the window.
    expect(t.weekly.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(events.length);
  });

  it("ignores future-dated and malformed timestamps", () => {
    const events: PreventionEvent[] = [
      ev(-5, "future"),
      { at: "not-a-date", id: "bad", source: "sensor" },
      ev(1, "ok"),
    ];
    const t = computePreventionTrend(events, NOW);
    expect(t.last_7d).toBe(1);
  });
});

describe("prevention receipt", () => {
  it("has a stable empty shape", () => {
    const receipt = buildPreventionReceipt([], [], emptyUsageIndex(), {
      since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW,
    });
    expect(receipt).toMatchObject({ total: 0, previous_total: 0, window_days: 7, events: [] });
    expect(renderPreventionReceipt(receipt)).toContain("0 repeat mistakes");
  });

  it("omits the rising/declining verdict on a tiny sample — a 0→1 jump is not a trend (§5)", () => {
    // total + previous below the floor: state the counts, never claim a direction.
    const tiny = buildPreventionReceipt([ev(1, "one")], [], emptyUsageIndex(), {
      since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW,
    });
    expect(tiny.total).toBe(1);
    expect(renderPreventionReceipt(tiny)).toContain("1 this window vs 0 previous window");
    expect(renderPreventionReceipt(tiny)).not.toContain("recurrences");
  });

  it("treats legacy usage rows without prevented_count as zero", () => {
    const usage = emptyUsageIndex();
    usage.by_id["legacy"] = { read_count: 3 } as typeof usage.by_id[string];
    const receipt = buildPreventionReceipt([], [], usage, {
      since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW,
    });
    expect(receipt.prevented_count_total).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain('"prevented_count_total":null');
  });

  it("filters the window, compares the previous window, and exposes stable event keys", () => {
    const receipt = buildPreventionReceipt([ev(1, "current"), ev(8, "previous"), ev(20, "old")], [], emptyUsageIndex(), {
      since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW,
    });
    expect(receipt.total).toBe(1);
    expect(receipt.previous_total).toBe(1);
    expect(receipt.events[0]).toEqual({
      at: ev(1, "current").at, id: "current", title: "current", source: "sensor",
      kind: "regex", stage: null, exit_code: null, message: null, incident: null, red_proven: false,
      evidence: "documented",
    });
  });

  it("carries sensor incident provenance into the row and the rendered receipt", () => {
    const mem = {
      memory: {
        frontmatter: {
          id: "refund-clamp",
          title: "refunds must clamp to capture",
          sensor: {
            kind: "test",
            message: "refund exceeded the captured amount",
            incident: "prod #442",
            severity: "block",
          },
        },
        body: "# refunds must clamp to capture\n",
      },
    } as unknown as LoadedMemory;
    const receipt = buildPreventionReceipt(
      [{ ...ev(1, "refund-clamp"), kind: "test", stage: "pre-commit", exit_code: 1 }],
      [mem],
      emptyUsageIndex(),
      { since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW },
    );
    expect(receipt.events[0]?.incident).toBe("prod #442");
    expect(renderPreventionReceipt(receipt)).toContain("↩ incident: prod #442");
    // --share Markdown carries the incident, the title, and the growth-loop attribution footer.
    const share = renderPreventionReceiptShare(receipt);
    expect(share).toContain("↩ incident: prod #442");
    expect(share).toContain("**refunds must clamp to capture**");
    expect(share).toContain(HIVELORE_ATTRIBUTION);
  });

  it("grades each prevention by evidence (proven / incident / documented) — honest empirical claim", () => {
    const mkMem = (id: string, sensor: Record<string, unknown> | undefined): LoadedMemory => ({
      memory: { frontmatter: { id, title: id, ...(sensor ? { sensor } : {}) }, body: `# ${id}\n` },
    } as unknown as LoadedMemory);
    const mems = [
      mkMem("proven-one", { kind: "test", severity: "block", red_proven: true, incident: "prod #1" }),
      mkMem("incident-one", { kind: "regex", severity: "block", incident: "prod #2" }),
      mkMem("documented-one", { kind: "regex", severity: "block" }),
    ];
    const receipt = buildPreventionReceipt(
      [ev(1, "proven-one"), ev(2, "incident-one"), ev(3, "documented-one")],
      mems,
      emptyUsageIndex(),
      { since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW },
    );
    expect(receipt.by_evidence).toEqual({ proven: 1, incident: 1, documented: 1 });
    expect(receipt.events.find((r) => r.id === "proven-one")?.evidence).toBe("proven");
    expect(receipt.events.find((r) => r.id === "incident-one")?.evidence).toBe("incident");
    expect(receipt.events.find((r) => r.id === "documented-one")?.evidence).toBe("documented");
    expect(renderPreventionReceipt(receipt)).toMatch(/Evidence: 1 red-proven · 1 incident-linked · 1 documented-only/);
  });

  it("share render turns an empty window into a forward CTA (not a dead zero), still attributed", () => {
    const empty = buildPreventionReceipt([], [], emptyUsageIndex(), {
      since: new Date(NOW.getTime() - 7 * 86_400_000), now: NOW,
    });
    const share = renderPreventionReceiptShare(empty);
    expect(share).toContain("Turn a past incident into a guardrail");
    expect(share).toContain("--sensor-command");
    expect(share).toContain(HIVELORE_ATTRIBUTION);
  });
});

describe("computeRecurrence", () => {
  it("flags lessons caught on >= 2 distinct days as re-introduced after capture", () => {
    const events = [
      ev(0, "recurring"),
      ev(5, "recurring"), // different day → recurrence
      ev(0, "oneoff"),
    ];
    const r = computeRecurrence(events);
    expect(r.recurring_count).toBe(1);
    expect(r.top[0]?.id).toBe("recurring");
    expect(r.top[0]?.distinct_days).toBe(2);
    expect(r.top.some((row) => row.id === "oneoff")).toBe(false);
  });

  it("does not count multiple catches on the same day as recurrence", () => {
    const sameDay = [
      { at: "2026-06-01T09:00:00.000Z", id: "m1", source: "sensor" as const },
      { at: "2026-06-01T17:00:00.000Z", id: "m1", source: "anti-pattern" as const },
    ];
    const r = computeRecurrence(sameDay);
    expect(r.recurring_count).toBe(0);
  });
});

describe("briefingProofLine", () => {
  it("returns null when there are no recent prevention events", () => {
    expect(briefingProofLine([ev(40, "old")], { now: NOW })).toBeNull();
  });

  it("summarizes recent prevention as one proof line for briefing", () => {
    expect(briefingProofLine([ev(1, "m1"), ev(2, "m2")], { now: NOW })).toBe(
      "This harness prevented 2 repeated mistakes in the last 30 days.",
    );
  });
});

describe("summarizeCaughtForYou", () => {
  function loaded(id: string, body = "# Avoid legacyField\n\nUse currentField."): LoadedMemory {
    return {
      filePath: `/x/${id}.md`,
      memory: {
        frontmatter: {
          id,
          scope: "team",
          type: "gotcha",
          status: "validated",
          anchor: { paths: [], symbols: [] },
          tags: [],
          created_at: NOW.toISOString(),
          expires_when: null,
          verified_at: null,
          stale_reason: null,
          related_ids: [],
          last_read_at: null,
          revision_count: 0,
          requires_human_approval: false,
        },
        body,
      },
    } as LoadedMemory;
  }

  it("builds prevention count before/after rows from session events", () => {
    const usage = emptyUsageIndex();
    recordPrevention(usage, "m1", NOW.getTime() - 1000);
    recordPrevention(usage, "m1", NOW.getTime() + 10 * 60 * 1000);
    const summary = summarizeCaughtForYou(
      [ev(0, "m1", "anti-pattern"), ev(1, "m1", "sensor"), ev(20, "old")],
      [loaded("m1")],
      usage,
      { since: new Date(NOW.getTime() - 2 * 86_400_000), now: NOW },
    );
    expect(summary.total_catches).toBe(2);
    expect(summary.rows[0]!.title).toBe("Avoid legacyField");
    expect(summary.rows[0]!.current_count).toBe(2);
    expect(summary.rows[0]!.previous_count).toBe(1);
    expect(renderCaughtForYou(summary)).toContain("Prevention 1->2");
  });

  it("does not label unbounded historical events as this session", () => {
    const summary = summarizeCaughtForYou([ev(0, "m1")], [loaded("m1")], emptyUsageIndex(), { now: NOW });
    expect(renderCaughtForYou(summary)).toContain("in recorded history");
    expect(renderCaughtForYou(summary)).not.toContain("this session");
  });
});
