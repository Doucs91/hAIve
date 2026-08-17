import { appendFrictionReport, type FrictionKind } from "@hivelore/core";
import { z } from "zod";
import type { HaiveContext } from "../context.js";

// Injected by tsup `define`; packages/mcp/vitest.config.ts declares the same value, which is what
// keeps this readable under vitest too (see 2026-04-27-gotcha-version-define-tsup-and-vitest).
declare const __HAIVE_VERSION__: string;

export const ReportFrictionInputSchema = {
  kind: z
    .enum(["bug", "suggestion", "docs", "confusing"])
    .describe(
      "'bug' = Hivelore did the wrong thing (REQUIRES `repro`; without one it is filed as a " +
        "suggestion); 'suggestion' = an improvement idea; 'docs' = the documentation was wrong or " +
        "missing; 'confusing' = it worked but the output/naming misled you.",
    ),
  surface: z
    .string()
    .min(1)
    .describe(
      "The Hivelore surface involved — an MCP tool or CLI command, e.g. 'mem_save', " +
        "'enforce check', 'sensors propose'. Used to group reports, so name the tool, not the file.",
    ),
  summary: z
    .string()
    .min(1)
    .describe("One line stating the problem, as specifically as you can. This is the dedup key."),
  expected: z.string().optional().describe("What you expected Hivelore to do."),
  observed: z.string().optional().describe("What it actually did — the exact message or output."),
  repro: z
    .string()
    .optional()
    .describe(
      "The command or tool call that reproduces it, runnable as-is. Required to file a 'bug'.",
    ),
};

export type ReportFrictionInput = {
  [K in keyof typeof ReportFrictionInputSchema]: z.infer<(typeof ReportFrictionInputSchema)[K]>;
};

export interface ReportFrictionOutput {
  ok: boolean;
  kind: FrictionKind;
  fingerprint: string;
  occurrences: number;
  already_reported: boolean;
  notice?: string;
  error?: string;
}

/**
 * Record friction with Hivelore itself into the local journal. Never publishes anything: a human
 * reviews the journal with `hivelore report list` and decides what becomes a GitHub issue.
 */
export async function reportFriction(
  input: ReportFrictionInput,
  ctx: HaiveContext,
): Promise<ReportFrictionOutput> {
  try {
    const result = await appendFrictionReport(ctx.paths, {
      kind: input.kind,
      surface: input.surface,
      summary: input.summary,
      expected: input.expected,
      observed: input.observed,
      repro: input.repro,
      version: __HAIVE_VERSION__,
    });

    const notices: string[] = [];
    if (result.report.downgraded_from === "bug") {
      notices.push(
        "Filed as 'suggestion', not 'bug': no `repro` was supplied. Call again with a runnable " +
          "`repro` if you can reproduce it — an unreproducible bug report cannot be acted on.",
      );
    }
    if (result.already_reported) {
      notices.push(
        `Already reported ${result.occurrences - 1}× before (now ${result.occurrences}×). ` +
          "No need to report this one again — the count is what ranks it.",
      );
    }
    if (result.resolved_as) {
      notices.push(
        `A human already marked this ${result.resolved_as.status}` +
          `${result.resolved_as.url ? ` (${result.resolved_as.url})` : ""}.`,
      );
    }

    return {
      ok: true,
      kind: result.report.kind,
      fingerprint: result.report.fingerprint,
      occurrences: result.occurrences,
      already_reported: result.already_reported,
      ...(notices.length > 0 ? { notice: notices.join(" ") } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      kind: input.kind,
      fingerprint: "",
      occurrences: 0,
      already_reported: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
