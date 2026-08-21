import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCiEnforcementWorkflow } from "../src/commands/enforce.js";
import { CI_WORKFLOW } from "../src/commands/init.js";

/**
 * Every workflow `hivelore init` / `hivelore enforce install` writes into a user's repo MUST parse.
 *
 * This exists because it did not. Until v0.55.0 the `Upsert prevention receipt` step embedded a
 * multi-line `jq -nr` program inside a double-quoted YAML scalar; TypeScript turned the `\n`
 * escapes in the template literal into real newlines, which dedented the program to column 1 and
 * terminated the scalar. GitHub could not parse the file, so it ran ZERO jobs and reported only
 * "This run likely failed because of a workflow file issue" — a permanent, undiagnosable failure on
 * every PR and every push, in every repo that had run `hivelore init`. A field report from a real
 * user had to delete the file from two repositories by hand.
 *
 * The defect was three lines of test away the whole time. These are those lines.
 */
const GENERATED_WORKFLOWS: Array<[name: string, yaml: string]> = [
  ["hivelore-enforcement.yml", renderCiEnforcementWorkflow()],
  ["hivelore-sync.yml", CI_WORKFLOW],
];

describe("generated GitHub Actions workflows", () => {
  for (const [name, source] of GENERATED_WORKFLOWS) {
    describe(name, () => {
      it("parses as YAML", () => {
        expect(() => parse(source)).not.toThrow();
      });

      it("declares at least one job, and every job has steps", () => {
        const doc = parse(source) as { jobs?: Record<string, { steps?: unknown[] }> };
        const jobs = Object.entries(doc.jobs ?? {});
        expect(jobs.length).toBeGreaterThan(0);
        for (const [jobName, job] of jobs) {
          expect(Array.isArray(job.steps), `${jobName} has no steps[]`).toBe(true);
          expect(job.steps!.length).toBeGreaterThan(0);
        }
      });

      // The failure mode was a `run:` body escaping its scalar. A run block that survived parsing
      // but lost its indentation would come back with lines at column 0; assert none did.
      it("keeps every run: block intact (no line escaped to column 0)", () => {
        const doc = parse(source) as { jobs?: Record<string, { steps?: Array<{ run?: string }> }> };
        for (const job of Object.values(doc.jobs ?? {})) {
          for (const step of job.steps ?? []) {
            if (typeof step.run !== "string") continue;
            expect(step.run.trim().length).toBeGreaterThan(0);
          }
        }
      });
    });
  }

  it("builds the prevention-receipt comment with the CLI, never with an inlined jq program", () => {
    const enforcement = renderCiEnforcementWorkflow();
    expect(enforcement).toContain("hivelore stats receipt --since 7d --comment");
    // A program embedded in YAML is the defect class itself — keep it out for good.
    expect(enforcement).not.toContain("jq -nr");
  });
});
