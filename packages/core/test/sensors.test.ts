import { describe, expect, it } from "vitest";
import {
  addedLinesFromDiff,
  compileRegexSensor,
  extractSensorExamples,
  judgeProposedSensor,
  runRegexSensor,
  runSensors,
  runPresenceSensors,
  changedPathsFromDiff,
  selectCommandSensors,
  sensorAppliesToPath,
  sensorPatternBrittleness,
  sensorSelfCheck,
  sensorTargetsFromDiff,
  isSensorScannablePath,
  scannableSensorTargets,
  detectSensorWeakening,
  addedLineNumbersFromDiff,
  scrubbedCommandEnv,
  isHarnessErrorOutput,
  extractCorrectApproachExamples,
} from "../src/sensors.js";
import type { Memory, Sensor } from "../src/types.js";

describe("sensorPatternBrittleness", () => {
  it("flags hardcoded line ranges and numeric literals (they rot when code shifts)", () => {
    expect(sensorPatternBrittleness("enforce\\.ts\\s*:\\s*1131-1186")).toMatch(/line\/number range/);
    expect(sensorPatternBrittleness("foo:\\s*1131")).toMatch(/numeric literal/);
  });

  it("does NOT flag durable patterns that generalize (digits inside classes/quantifiers)", () => {
    expect(sensorPatternBrittleness(":\\s*any\\b")).toBeNull();
    expect(sensorPatternBrittleness("v[0-9]+\\.[0-9]+\\.[0-9]+")).toBeNull();
    expect(sensorPatternBrittleness("DEBUG\\s*=\\s*True")).toBeNull();
    expect(sensorPatternBrittleness("antiPatternGate\\s*[:=]\\s*['\"]off['\"]")).toBeNull();
  });

  it("does NOT flag an arithmetic constant like a /100 divisor (field report 2026-09-01 §5.3)", () => {
    // The `100` is the decimal base of a minor-currency conversion, not a line number. Before the
    // fix the author was forced to replace it with the looser `1[0-9]{2}` (which also accepts /137).
    expect(sensorPatternBrittleness("(priceCents|amountCents)\\s*[/*]\\s*100\\b")).toBeNull();
    expect(sensorPatternBrittleness("amountCents\\s*/\\s*100")).toBeNull();
    expect(sensorPatternBrittleness("bytes\\s*\\*\\s*1024")).toBeNull();
    // A real hardcoded line number (no arithmetic operator before it) is still flagged.
    expect(sensorPatternBrittleness("foo:\\s*1131")).toMatch(/numeric literal/);
  });

  it("does NOT flag IP/port literals or regex escapes, and names the offending token when it does", () => {
    // Field report §4.1: `\d+` is a regex escape (not a line number) and `127\.0\.0\.1` is an IP —
    // neither should be read as a brittle numeric literal. This exact pattern was wrongly rejected.
    expect(sensorPatternBrittleness("['\"`]https?://(localhost|127\\.0\\.0\\.1):\\d+")).toBeNull();
    expect(sensorPatternBrittleness("127\\.0\\.0\\.1")).toBeNull();
    expect(sensorPatternBrittleness("app\\.listen\\(\\d+")).toBeNull();
    // When it does flag, the message must name the token so the author knows what to fix.
    expect(sensorPatternBrittleness("foo:\\s*1131")).toContain("1131");
    expect(sensorPatternBrittleness("enforce\\.ts\\s*:\\s*1131-1186")).toContain("1131-1186");
  });
});

function sensor(overrides: Partial<Sensor> = {}): Sensor {
  return {
    kind: "regex",
    pattern: "open-in-view",
    paths: [],
    message: "open-in-view was disabled on purpose — do not re-enable it.",
    severity: "warn",
    autogen: false,
    last_fired: null,
    ...overrides,
  };
}

function memory(s: Sensor | undefined, anchorPaths: string[] = []): Memory {
  return {
    frontmatter: {
      id: "2026-05-31-gotcha-open-in-view",
      scope: "team",
      type: "gotcha",
      status: "validated",
      anchor: { paths: anchorPaths, symbols: [] },
      sensor: s,
      tags: [],
      created_at: "2026-05-31T00:00:00.000Z",
      expires_when: null,
      verified_at: null,
      stale_reason: null,
      related_ids: [],
      last_read_at: null,
      revision_count: 0,
      requires_human_approval: false,
    },
    body: "open-in-view is intentionally false.",
  };
}

describe("sensors", () => {
  it("compiles a valid regex sensor and rejects invalid/non-regex ones", () => {
    expect(compileRegexSensor(sensor())).toBeInstanceOf(RegExp);
    expect(compileRegexSensor(sensor({ pattern: "(" }))).toBeNull(); // invalid regex
    expect(compileRegexSensor(sensor({ kind: "shell", command: "x" }))).toBeNull();
    expect(compileRegexSensor(sensor({ pattern: undefined }))).toBeNull();
  });

  it("merges caller flags with the forced multiline flag", () => {
    const re = compileRegexSensor(sensor({ flags: "i" }))!;
    expect(re.flags).toContain("i");
    expect(re.flags).toContain("m");
  });

  it("fires on a matching line and reports the matched content", () => {
    const hit = runRegexSensor("m1", sensor(), {
      path: "src/app.properties",
      content: "spring.jpa.open-in-view=true",
    });
    expect(hit).not.toBeNull();
    expect(hit!.matched_line).toContain("open-in-view");
    expect(hit!.message).toContain("do not re-enable");
    expect(hit!.severity).toBe("warn");
  });

  it("does not fire when the pattern is absent", () => {
    const hit = runRegexSensor("m1", sensor(), {
      path: "src/app.properties",
      content: "spring.jpa.show-sql=true",
    });
    expect(hit).toBeNull();
  });

  it("does not fire on a pattern that only appears inside a comment (field report 2026-09-01 §3.1)", () => {
    const colour = sensor({ pattern: "bg-emerald-600", severity: "block" });
    // CSS block comment documenting the rule — must NOT trip the sensor that enforces it.
    expect(
      runRegexSensor("m1", colour, {
        path: "src/index.css",
        content: "/* This is the only source of colours. A class like bg-emerald-600 is forbidden. */",
      }),
    ).toBeNull();
    // Javadoc continuation line naming the forbidden call — must NOT fire.
    const now = sensor({ pattern: "LocalDate\\.now\\(", severity: "block" });
    expect(
      runRegexSensor("m1", now, {
        path: "src/main/java/Slots.java",
        content: " * Never call LocalDate.now() here — pass the salon clock instead.",
      }),
    ).toBeNull();
    // `//` line comment naming the pattern — must NOT fire.
    expect(
      runRegexSensor("m1", colour, {
        path: "src/App.tsx",
        content: "const x = 1; // avoid bg-emerald-600 in JSX",
      }),
    ).toBeNull();
  });

  it("still fires when the pattern appears in real code, not just prose", () => {
    const colour = sensor({ pattern: "bg-emerald-600", severity: "block" });
    // A className string is CODE, not a comment — string literals stay intact so this still fires.
    const hit = runRegexSensor("m1", colour, {
      path: "src/App.tsx",
      content: 'const cls = "bg-emerald-600";',
    });
    expect(hit).not.toBeNull();
    expect(hit!.matched_line).toContain("bg-emerald-600");
  });

  it("does not mistake a URL's // inside a string for a line comment", () => {
    const s = sensor({ pattern: "example\\.com", severity: "block" });
    const hit = runRegexSensor("m1", s, {
      path: "src/App.ts",
      content: 'const url = "https://example.com/path";',
    });
    expect(hit).not.toBeNull();
  });

  it("downgrades a brittle block sensor to warn at match time (never hard-blocks)", () => {
    const brittle = sensor({ pattern: "enforce\\.ts\\s*:\\s*1131-1186", severity: "block" });
    const hit = runRegexSensor("m1", brittle, { path: "x.ts", content: "see enforce.ts: 1131-1186 here" });
    expect(hit).not.toBeNull();
    expect(hit!.severity).toBe("warn"); // brittle pattern can't hard-block even when promoted

    // A durable block sensor keeps its block severity.
    const durable = sensor({ pattern: "open-in-view", severity: "block" });
    const ok = runRegexSensor("m1", durable, { path: "a.properties", content: "open-in-view=true" });
    expect(ok!.severity).toBe("block");
  });

  it("scopes by sensor paths, falling back to anchor paths", () => {
    const s = sensor({ paths: ["src/backend/"] });
    expect(sensorAppliesToPath(s, [], "src/backend/Repo.java")).toBe(true);
    expect(sensorAppliesToPath(s, [], "src/frontend/App.tsx")).toBe(false);
    expect(sensorAppliesToPath(s, [], "src/other/src/backend/Repo.java")).toBe(false);
    // no sensor paths → fall back to anchor paths
    const s2 = sensor({ paths: [] });
    expect(sensorAppliesToPath(s2, ["config/"], "config/app.yml")).toBe(true);
    expect(sensorAppliesToPath(s2, ["config/"], "src/x.ts")).toBe(false);
    // neither → applies everywhere
    expect(sensorAppliesToPath(sensor({ paths: [] }), [], "anywhere.ts")).toBe(true);
  });

  it("matches glob sensor paths (stack packs ship **/*.controller.ts-style scopes)", () => {
    // Regression: glob scopes were silently dead under pure prefix matching — the nestjs
    // no-ORM-in-controller pack sensor never fired anywhere.
    const glob = sensor({ paths: ["**/*.controller.ts"] });
    expect(sensorAppliesToPath(glob, [], "apps/api/src/orders/orders.controller.ts")).toBe(true);
    expect(sensorAppliesToPath(glob, [], "apps/api/src/orders/orders.service.ts")).toBe(false);
    // "**" = explicit repo-wide scope (used by seeded stack sensors so a later memory
    // anchor cannot narrow a stack-wide rule to one exemplar file).
    const repoWide = sensor({ paths: ["**"] });
    expect(sensorAppliesToPath(repoWide, ["apps/api/src/prisma.ts"], "apps/web/src/anything.tsx")).toBe(true);
  });

  it("runSensors only runs regex sensors and respects path scope", () => {
    const memos = [
      memory(sensor({ paths: ["src/backend/"] })),
      memory(sensor({ kind: "shell", command: "echo no" })), // skipped
      memory(undefined), // no sensor, skipped
    ];
    const hits = runSensors(memos, [
      { path: "src/backend/App.java", content: "open-in-view=true" },
      { path: "src/frontend/App.tsx", content: "open-in-view=true" },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("src/backend/App.java");
  });

  it("extracts only added lines from a unified diff", () => {
    const diff = [
      "+++ b/src/app.properties",
      "+spring.jpa.open-in-view=true",
      "-spring.jpa.open-in-view=false",
      " unchanged line",
    ].join("\n");
    const added = addedLinesFromDiff(diff);
    expect(added).toBe("spring.jpa.open-in-view=true");
    // a sensor should fire on the added line, not the removed one
    const hit = runRegexSensor("m1", sensor(), { path: "src/app.properties", content: added });
    expect(hit).not.toBeNull();
  });

  it("splits unified diffs into per-file sensor targets", () => {
    const diff = [
      "diff --git a/src/backend/app.properties b/src/backend/app.properties",
      "--- a/src/backend/app.properties",
      "+++ b/src/backend/app.properties",
      "+spring.jpa.open-in-view=true",
      "diff --git a/src/frontend/App.tsx b/src/frontend/App.tsx",
      "--- a/src/frontend/App.tsx",
      "+++ b/src/frontend/App.tsx",
      "+const flag = 'open-in-view=true';",
    ].join("\n");

    const targets = sensorTargetsFromDiff(diff);
    expect(targets).toEqual([
      { path: "src/backend/app.properties", content: "spring.jpa.open-in-view=true" },
      { path: "src/frontend/App.tsx", content: "const flag = 'open-in-view=true';" },
    ]);

    const hits = runSensors([memory(sensor({ paths: ["src/backend/"] }))], targets);
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("src/backend/app.properties");
  });

  it("selectCommandSensors picks shell/test sensors applicable to changed paths", () => {
    const shell = memory(
      sensor({ kind: "shell", command: "npm run lint", pattern: undefined, paths: ["src/backend/"] }),
    );
    const test = memory(
      sensor({ kind: "test", command: "npm test -- cycle", pattern: undefined, paths: ["src/core/"] }),
    );
    const regex = memory(sensor()); // regex → never selected as a command sensor
    const noCommand = memory(sensor({ kind: "shell", command: "  ", pattern: undefined }));

    const specs = selectCommandSensors([shell, test, regex, noCommand], ["src/backend/Repo.java"]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.command).toBe("npm run lint");
    expect(specs[0]!.kind).toBe("shell");

    // no changed paths → apply unconditionally (both command sensors selected)
    expect(selectCommandSensors([shell, test], []).map((s) => s.kind).sort()).toEqual(["shell", "test"]);
  });
});

describe("discriminating sensors (absent / correct-usage marker)", () => {
  const discriminating: Sensor = {
    kind: "regex",
    pattern: "stripe\\.paymentIntents\\.create",
    absent: "idempotencyKey",
    paths: ["src/payments/stripe.ts"],
    message: "stripe.paymentIntents.create without idempotencyKey",
    severity: "block",
    autogen: true,
    last_fired: null,
  };

  it("fires on the faulty call (trigger present, companion absent)", () => {
    const hit = runRegexSensor("m1", discriminating, {
      path: "src/payments/stripe.ts",
      content: "return stripe.paymentIntents.create({ amount, currency: 'usd' });",
    });
    expect(hit).not.toBeNull();
    expect(hit?.severity).toBe("block");
  });

  it("suppresses the correct call (companion within the window, multi-line)", () => {
    const content = [
      "return stripe.paymentIntents.create(",
      "  { amount, currency: 'usd' },",
      "  { idempotencyKey },",
      ");",
    ].join("\n");
    expect(runRegexSensor("m1", discriminating, { path: "src/payments/stripe.ts", content })).toBeNull();
  });

  it("a correct function directly above a faulty one does NOT mask it (real adjacent layout)", () => {
    // Reproduces the live failure: a symmetric window let goodRefund's idempotencyKey leak down into
    // badRefund's window. The forward-biased window must fire on badRefund anyway.
    const content = [
      "export async function goodRefund(a: number, k: string) {",
      "  return stripe.paymentIntents.create(",
      "    { amount: a, currency: 'usd' },",
      "    { idempotencyKey: k },",
      "  );",
      "}",
      "",
      "export async function badRefund(a: number) {",
      "  return stripe.paymentIntents.create({ amount: a, currency: 'usd' });",
      "}",
    ].join("\n");
    const hit = runRegexSensor("m1", discriminating, { path: "src/payments/stripe.ts", content });
    expect(hit).not.toBeNull();
    expect(hit?.matched_line).toContain("create");
    expect(hit?.matched_line).not.toContain("idempotencyKey");
  });

  it("a hoisted options object on the line just above is still recognized (short lookback)", () => {
    const content = [
      "const opts = { idempotencyKey };",
      "return stripe.paymentIntents.create(args, opts);",
    ].join("\n");
    expect(runRegexSensor("m1", discriminating, { path: "src/payments/stripe.ts", content })).toBeNull();
  });

  it("a sensor without `absent` still fires on every match (back-compat)", () => {
    const plain: Sensor = { ...discriminating, absent: undefined };
    const content = "stripe.paymentIntents.create({ a }, { idempotencyKey });";
    expect(runRegexSensor("m1", plain, { path: "src/payments/stripe.ts", content })).not.toBeNull();
  });
});

describe("sensorSelfCheck (must discriminate before it can block)", () => {
  const discriminating: Sensor = {
    kind: "regex",
    pattern: "stripe\\.paymentIntents\\.create",
    absent: "idempotencyKey",
    paths: ["src/payments/stripe.ts"],
    message: "create without idempotencyKey",
    severity: "block",
    autogen: true,
    last_fired: null,
  };

  it("passes: silent on correct current code, fires on the bad example", () => {
    const check = sensorSelfCheck(discriminating, {
      currentTargets: [{
        path: "src/payments/stripe.ts",
        content: "return stripe.paymentIntents.create({ a }, { idempotencyKey });",
      }],
      badExamples: ["stripe.paymentIntents.create({ amount: 1 });"],
    });
    expect(check.silent_on_current).toBe(true);
    expect(check.fires_on_bad).toBe(true);
    expect(check.passed).toBe(true);
    expect(check.fired_on).toEqual([]);
  });

  it("fails: a broad sensor fires on the current (correct) code → false-positive risk", () => {
    const broad: Sensor = { ...discriminating, absent: undefined };
    const check = sensorSelfCheck(broad, {
      currentTargets: [{
        path: "src/payments/stripe.ts",
        content: "return stripe.paymentIntents.create({ a }, { idempotencyKey });",
      }],
      badExamples: [],
    });
    expect(check.silent_on_current).toBe(false);
    expect(check.fired_on).toEqual(["src/payments/stripe.ts"]);
    expect(check.passed).toBe(false);
  });

  it("fires_on_bad is null when no example is available; passed mirrors silent_on_current", () => {
    const check = sensorSelfCheck(discriminating, {
      currentTargets: [{ path: "src/payments/stripe.ts", content: "const x = 1;" }],
      badExamples: [],
    });
    expect(check.fires_on_bad).toBeNull();
    expect(check.passed).toBe(true);
  });

  it("fails when it cannot fire on the documented bad example", () => {
    const check = sensorSelfCheck(discriminating, {
      currentTargets: [],
      badExamples: ["totally unrelated code"],
    });
    expect(check.fires_on_bad).toBe(false);
    expect(check.passed).toBe(false);
  });

  it("fires_on_correct flags an INVERTED sensor that matches the recommended fix", () => {
    // Lesson: avoid moment, use date-fns. A pattern of `date-fns` matches the CORRECT approach.
    const inverted: Sensor = {
      kind: "regex", pattern: "date-fns", paths: ["src/dates.ts"],
      message: "x", severity: "block", autogen: false, last_fired: null,
    };
    const check = sensorSelfCheck(inverted, {
      currentTargets: [],
      badExamples: [],
      correctExamples: ["date-fns"],
    });
    expect(check.fires_on_correct).toBe(true);
    expect(check.passed).toBe(false);
  });

  it("fires_on_correct is null when no correct example is supplied (unchanged default)", () => {
    const check = sensorSelfCheck(discriminating, {
      currentTargets: [{ path: "src/payments/stripe.ts", content: "const x = 1;" }],
      badExamples: [],
    });
    expect(check.fires_on_correct).toBeNull();
    expect(check.passed).toBe(true);
  });
});

describe("judgeProposedSensor — inverted-sensor guard", () => {
  it("rejects a block sensor that fires on the lesson's recommended approach", () => {
    const inverted: Sensor = {
      kind: "regex", pattern: "date-fns", paths: ["src/dates.ts"],
      message: "x", severity: "block", autogen: false, last_fired: null,
    };
    const verdict = judgeProposedSensor(inverted, {
      currentTargets: [], badExamples: [], correctExamples: ["date-fns"],
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe("fires-on-correct");
  });

  it("still accepts a sensor that targets the mistake, not the fix", () => {
    const good: Sensor = {
      kind: "regex", pattern: "from ['\"]moment['\"]", paths: ["src/dates.ts"],
      message: "x", severity: "block", autogen: false, last_fired: null,
    };
    const verdict = judgeProposedSensor(good, {
      currentTargets: [], badExamples: ["import x from 'moment'"], correctExamples: ["date-fns"],
    });
    expect(verdict.accepted).toBe(true);
  });

  it("rejects an inverted WARN sensor too — noise on correct code is bad at any severity (§3.4)", () => {
    const invertedWarn: Sensor = {
      kind: "regex", pattern: "date-fns", paths: ["src/dates.ts"],
      message: "x", severity: "warn", autogen: false, last_fired: null,
    };
    const verdict = judgeProposedSensor(invertedWarn, {
      currentTargets: [], badExamples: [], correctExamples: ["date-fns"],
    });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toBe("fires-on-correct");
  });
});

describe("presence sensors (require_present) — fire on a DELETION (§3.5)", () => {
  const clockGuard = sensor({
    pattern: "TimeZone\\.setDefault\\(",
    require_present: true,
    paths: ["src/ClockConfig.java"],
    severity: "block",
    message: "Do not remove the UTC default — it prevents the TIME-column shift.",
  });

  it("changedPathsFromDiff parses touched files, including pure deletions", () => {
    const diff = [
      "diff --git a/src/ClockConfig.java b/src/ClockConfig.java",
      "--- a/src/ClockConfig.java",
      "+++ b/src/ClockConfig.java",
      "@@ -3,4 +3,3 @@",
      "   static {",
      "-    TimeZone.setDefault(TimeZone.getTimeZone(\"UTC\"));",
      "   }",
    ].join("\n");
    expect(changedPathsFromDiff(diff)).toContain("src/ClockConfig.java");
  });

  it("fires when the required line is ABSENT from the final content", () => {
    const finalNoUtc = [{ path: "src/ClockConfig.java", content: "class ClockConfig { static { /* nothing */ } }" }];
    const hits = runPresenceSensors([memory(clockGuard, ["src/ClockConfig.java"])], finalNoUtc);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe("block");
  });

  it("stays silent when the required line is still present", () => {
    const finalWithUtc = [{ path: "src/ClockConfig.java", content: "class ClockConfig { static { TimeZone.setDefault(x); } }" }];
    expect(runPresenceSensors([memory(clockGuard, ["src/ClockConfig.java"])], finalWithUtc)).toEqual([]);
  });

  it("is NOT run by the added-lines runner (runSensors skips require_present)", () => {
    // An added line that lacks the marker must not false-fire the presence sensor.
    const added = [{ path: "src/ClockConfig.java", content: "int unrelated = 1;" }];
    expect(runSensors([memory(clockGuard, ["src/ClockConfig.java"])], added)).toEqual([]);
  });
});

describe("isHarnessErrorOutput (prove-RED honesty: a crash is not a RED)", () => {
  it("classifies load/collection failures as harness errors (could not reach the assertion)", () => {
    expect(isHarnessErrorOutput("Error: Cannot find module '../src/refund.js'")).toBe(true);
    expect(isHarnessErrorOutput("ERR_MODULE_NOT_FOUND")).toBe(true);
    expect(isHarnessErrorOutput("SyntaxError: Unexpected token")).toBe(true);
    expect(isHarnessErrorOutput("No test files found, exiting with code 1")).toBe(true);
    expect(isHarnessErrorOutput("collected 0 items")).toBe(true);
    expect(isHarnessErrorOutput("ModuleNotFoundError: No module named 'app'")).toBe(true);
  });

  it("does NOT flag a genuine assertion failure as a harness error", () => {
    expect(isHarnessErrorOutput("AssertionError: expected 100 to equal 50\nrefund must clamp")).toBe(false);
    expect(isHarnessErrorOutput("1 failed, 3 passed")).toBe(false);
    expect(isHarnessErrorOutput("")).toBe(false);
  });
});

describe("extractCorrectApproachExamples", () => {
  it("pulls the Instead-use snippet from an attempt body", () => {
    const body = "# importing moment\n\n**Why it failed / do NOT use:** bloat\n\n**Instead, use:** date-fns";
    expect(extractCorrectApproachExamples(body)).toContain("date-fns");
  });

  it("returns nothing when the lesson states no alternative", () => {
    expect(extractCorrectApproachExamples("# x\n\n**Why it failed / do NOT use:** y")).toEqual([]);
  });
});

describe("judgeProposedSensor (agent proposes, core validates)", () => {
  const base: Sensor = {
    kind: "regex",
    pattern: "stripe\\.paymentIntents\\.create",
    absent: "idempotencyKey",
    paths: ["src/payments/stripe.ts"],
    message: "create without idempotencyKey",
    severity: "block",
    autogen: false,
    last_fired: null,
  };
  const correct = { path: "src/payments/stripe.ts", content: "create stripe.paymentIntents.create({ a }, { idempotencyKey });" };

  it("accepts a discriminating block sensor: silent on current, fires on the bad example", () => {
    const v = judgeProposedSensor(base, { currentTargets: [correct], badExamples: ["stripe.paymentIntents.create({ a });"] });
    expect(v.accepted).toBe(true);
  });

  it("rejects a block sensor that fires on the current correct code", () => {
    const broad: Sensor = { ...base, absent: undefined };
    const v = judgeProposedSensor(broad, { currentTargets: [correct], badExamples: [] });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("fires-on-current");
  });

  it("rejects a brittle block sensor", () => {
    const brittle: Sensor = { ...base, pattern: "foo:1131-1186", absent: undefined };
    const v = judgeProposedSensor(brittle, { currentTargets: [], badExamples: [] });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("brittle");
  });

  it("rejects a block sensor that misses the documented bad example", () => {
    const v = judgeProposedSensor(base, { currentTargets: [], badExamples: ["unrelated code"] });
    expect(v.accepted).toBe(false);
    expect(v.reason).toBe("missed-bad-example");
  });

  it("always accepts a warn sensor (advisory), even if it fires on current code", () => {
    const warn: Sensor = { ...base, absent: undefined, severity: "warn" };
    const v = judgeProposedSensor(warn, { currentTargets: [correct], badExamples: [] });
    expect(v.accepted).toBe(true);
  });
});

describe("isSensorScannablePath", () => {
  it("rejects the .ai/ knowledge base (memory bodies quote the patterns they document)", () => {
    expect(isSensorScannablePath(".ai/memories/team/2026-06-09-gotcha-x.md")).toBe(false);
    expect(isSensorScannablePath(".ai/project-context.md")).toBe(false);
  });

  it("rejects Hivelore-owned bridge/config files", () => {
    expect(isSensorScannablePath("CLAUDE.md")).toBe(false);
    expect(isSensorScannablePath(".cursorrules")).toBe(false);
    expect(isSensorScannablePath(".mcp.json")).toBe(false);
  });

  it("rejects empty/anonymous paths", () => {
    expect(isSensorScannablePath("")).toBe(false);
  });

  it("accepts real source files", () => {
    expect(isSensorScannablePath("src/payments.ts")).toBe(true);
    expect(isSensorScannablePath("packages/core/src/sensors.ts")).toBe(true);
  });
});

describe("scannableSensorTargets", () => {
  const diff = (p: string, line: string): string =>
    `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -0,0 +1 @@\n+${line}\n`;

  it("drops .ai/ targets so a staged memory file cannot self-fire", () => {
    const d = diff(".ai/memories/team/g.md", "await prisma.$disconnect();");
    expect(scannableSensorTargets(d)).toEqual([]);
  });

  it("keeps real source targets", () => {
    const d = diff("src/db.ts", "await prisma.$disconnect();");
    const targets = scannableSensorTargets(d);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("src/db.ts");
  });

  it("only mixes: a code+memory diff keeps just the code target", () => {
    const d = diff("src/db.ts", "process.env.NEXT_PUBLIC_API_SECRET") +
      diff(".ai/memories/team/g.md", "process.env.NEXT_PUBLIC_API_SECRET");
    const targets = scannableSensorTargets(d);
    expect(targets.map((t) => t.path)).toEqual(["src/db.ts"]);
  });

  it("falls back to a single blob only when the diff has no file headers", () => {
    const targets = scannableSensorTargets("+ raw line with no header\n");
    expect(targets).toHaveLength(1);
    expect(targets[0]!.path).toBe("");
  });
});

describe("extractSensorExamples", () => {
  it("pulls fenced code blocks and code-like inline spans, ignoring prose backticks", () => {
    const body = [
      "# Bad",
      "```ts",
      "stripe.paymentIntents.create({ a });",
      "```",
      "Avoid calling `create()` here; the word `idempotency` alone is prose.",
    ].join("\n");
    const examples = extractSensorExamples(body);
    expect(examples.some((e) => e.includes("paymentIntents.create"))).toBe(true);
    expect(examples).toContain("create()");
    expect(examples).not.toContain("idempotency");
  });
});

describe("detectSensorWeakening — gate-surface integrity", () => {
  const memFile = ".ai/memories/team/2026-07-01-attempt-x.md";
  const d = (file: string, removed: string[], added: string[], opts: { deleted?: boolean; created?: boolean } = {}): string =>
    [
      `diff --git a/${file} b/${file}`,
      `--- ${opts.created ? "/dev/null" : `a/${file}`}`,
      `+++ ${opts.deleted ? "/dev/null" : `b/${file}`}`,
      "@@ -1,5 +1,5 @@",
      ...removed.map((l) => `-${l}`),
      ...added.map((l) => `+${l}`),
      "",
    ].join("\n");

  it("flags a block→warn severity demotion", () => {
    const hits = detectSensorWeakening(d(memFile, ["  severity: block"], ["  severity: warn"]));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.change).toBe("severity-demoted");
    expect(hits[0]!.memory_id).toBe("2026-07-01-attempt-x");
  });

  it("flags a changed oracle (pattern or command)", () => {
    const p = detectSensorWeakening(d(memFile, ["  pattern: from ['\"]moment['\"]"], ["  pattern: nothing"]));
    expect(p.map((h) => h.change)).toContain("oracle-changed");
    const c = detectSensorWeakening(d(memFile, ["  command: npx vitest run tests/a.test.ts"], ["  command: true"]));
    expect(c.map((h) => h.change)).toContain("oracle-changed");
  });

  it("flags a removed oracle and a deleted block-sensor memory", () => {
    const removedKey = detectSensorWeakening(d(memFile, ["  command: npx vitest run tests/a.test.ts"], []));
    expect(removedKey.map((h) => h.change)).toContain("oracle-removed");
    const deleted = detectSensorWeakening(
      d(memFile, ["sensor:", "  kind: regex", "  pattern: bad", "  severity: block"], [], { deleted: true }),
    );
    expect(deleted.map((h) => h.change)).toContain("memory-deleted");
  });

  it("flags a broadened absent suppression, but NOT a removed absent (that tightens)", () => {
    const added = detectSensorWeakening(d(memFile, [], ["  absent: idempotencyKey"]));
    expect(added.map((h) => h.change)).toContain("suppression-broadened");
    const removed = detectSensorWeakening(d(memFile, ["  absent: idempotencyKey"], []));
    expect(removed).toHaveLength(0);
  });

  it("stays silent on additions, non-memory files, and sensor-free memory edits", () => {
    // Brand-new sensor (added lines only) — never a weakening.
    expect(detectSensorWeakening(d(memFile, [], ["sensor:", "  pattern: bad", "  absent: safe", "  severity: block"]))).toHaveLength(0);
    // Brand-new memory with a discriminating sensor — `absent` is not a broadening of prior state.
    expect(detectSensorWeakening(d(memFile, [], ["sensor:", "  pattern: bad", "  absent: safe", "  severity: block"], { created: true }))).toHaveLength(0);
    // Same change outside .ai/memories/ is out of scope.
    expect(detectSensorWeakening(d("src/config.yml", ["  severity: block"], ["  severity: warn"]))).toHaveLength(0);
    // Editing prose/verified_at in a memory does not flag.
    expect(detectSensorWeakening(d(memFile, ["verified_at: '2026-06-01'"], ["verified_at: '2026-07-01'"]))).toHaveLength(0);
  });
});

describe("scrubbedCommandEnv — oracle containment", () => {
  it("keeps the test-runner basics and drops everything else (credentials, tokens)", () => {
    const env = scrubbedCommandEnv({
      PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", TERM: "xterm", CI: "1",
      NODE_OPTIONS: "--max-old-space-size=4096", npm_config_registry: "https://r", LC_ALL: "C",
      HIVELORE_SENSOR: "x", NVM_DIR: "/nvm",
      AWS_SECRET_ACCESS_KEY: "leak", GITHUB_TOKEN: "leak", OPENAI_API_KEY: "leak", DATABASE_URL: "leak",
    });
    for (const kept of ["PATH", "HOME", "LANG", "TERM", "CI", "NODE_OPTIONS", "npm_config_registry", "LC_ALL", "HIVELORE_SENSOR", "NVM_DIR"]) {
      expect(env[kept], kept).toBeDefined();
    }
    for (const dropped of ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "DATABASE_URL"]) {
      expect(env[dropped], dropped).toBeUndefined();
    }
  });
});

describe("addedLineNumbersFromDiff", () => {
  it("maps added lines to NEW-side line numbers per file (context and removals accounted)", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,4 +1,5 @@",
      " line1",
      "-old2",
      "+new2",
      "+new3",
      " line4",
      "@@ -10,2 +11,3 @@",
      " ctx",
      "+tail",
      "",
    ].join("\n");
    const map = addedLineNumbersFromDiff(diff);
    expect([...map.get("src/a.ts")!].sort((a, b) => a - b)).toEqual([2, 3, 12]);
    expect(map.has("src/missing.ts")).toBe(false);
  });
});
