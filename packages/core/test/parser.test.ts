import { describe, expect, it } from "vitest";
import {
  buildFrontmatter,
  newMemoryId,
  parseMemory,
  serializeMemory,
  stripPrivate,
} from "../src/parser.js";

describe("newMemoryId", () => {
  it("produces a slug-safe id with date prefix", () => {
    const date = new Date("2026-04-25T10:00:00Z");
    const id = newMemoryId("decision", "Field X removed!", date);
    expect(id).toBe("2026-04-25-decision-field-x-removed");
  });

  it("trims dashes at the edges", () => {
    const date = new Date("2026-04-25T10:00:00Z");
    expect(newMemoryId("convention", "  --hello-- ", date)).toBe(
      "2026-04-25-convention-hello",
    );
  });
});

describe("stripPrivate", () => {
  it("removes <private> blocks (single)", () => {
    const input = "Public\n<private>secret</private>\nMore public";
    expect(stripPrivate(input)).toBe("Public\n\nMore public");
  });

  it("removes multiple <private> blocks", () => {
    const input = "<private>a</private>middle<private>b</private>";
    expect(stripPrivate(input)).toBe("middle");
  });

  it("returns input unchanged when no private block", () => {
    expect(stripPrivate("hello world")).toBe("hello world");
  });
});

describe("parseMemory / serializeMemory", () => {
  it("round-trips a valid memory", () => {
    const input = `---
id: 2026-04-25-decision-test
scope: team
type: decision
status: draft
created_at: 2026-04-25T10:00:00.000Z
tags:
  - schema
anchor:
  paths:
    - src/foo.ts
  symbols: []
expires_when: null
---

# Test
Body content here.`;
    const parsed = parseMemory(input);
    expect(parsed.frontmatter.id).toBe("2026-04-25-decision-test");
    expect(parsed.frontmatter.scope).toBe("team");
    expect(parsed.frontmatter.tags).toEqual(["schema"]);
    expect(parsed.body).toContain("Body content here.");

    const reSerialized = serializeMemory(parsed);
    const reParsed = parseMemory(reSerialized);
    expect(reParsed.frontmatter).toEqual(parsed.frontmatter);
  });

  it("strips <private> sections from body on parse", () => {
    const input = `---
id: 2026-04-25-gotcha-x
type: gotcha
created_at: 2026-04-25T10:00:00.000Z
---

Public note
<private>internal-only</private>`;
    const parsed = parseMemory(input);
    expect(parsed.body).not.toContain("internal-only");
    expect(parsed.body).toContain("Public note");
  });

  it("rejects a memory with module scope but no module name", () => {
    const input = `---
id: bad
scope: module
type: convention
created_at: 2026-04-25T10:00:00.000Z
---
body`;
    expect(() => parseMemory(input)).toThrow();
  });

  it("names the field and allowed values on an unsupported type (no cryptic '([)')", () => {
    const input = `---
id: 2026-08-27-reference-x
type: reference
created_at: 2026-08-27T10:00:00.000Z
---
body`;
    // A hand-written 'reference' file used to vanish with a meaningless '([)' error. The message
    // must now name the field, the offending value, and the supported types so the loss is fixable.
    expect(() => parseMemory(input)).toThrow(/invalid type/i);
    expect(() => parseMemory(input)).toThrow(/reference/);
    expect(() => parseMemory(input)).toThrow(/convention|gotcha|decision/);
    try {
      parseMemory(input);
    } catch (err) {
      expect((err as Error).message).not.toContain("([");
      expect((err as Error).message.split("\n")).toHaveLength(1);
    }
  });

  it("applies sensible defaults", () => {
    const input = `---
id: 2026-04-25-glossary-term
type: glossary
created_at: 2026-04-25T10:00:00.000Z
---
body`;
    const parsed = parseMemory(input);
    expect(parsed.frontmatter.scope).toBe("personal");
    expect(parsed.frontmatter.status).toBe("draft");
    expect(parsed.frontmatter.tags).toEqual([]);
    expect(parsed.frontmatter.anchor.paths).toEqual([]);
    expect(parsed.frontmatter.expires_when).toBeNull();
    // Provenance defaults to null on legacy memories that predate the field.
    expect(parsed.frontmatter.validated_by).toBeNull();
  });

  it("round-trips validated_by provenance and rejects unknown values", () => {
    const human = parseMemory(
      "---\nid: 2026-06-08-decision-x\ntype: decision\ncreated_at: 2026-06-08T10:00:00.000Z\nstatus: validated\nvalidated_by: human\n---\nbody",
    );
    expect(human.frontmatter.validated_by).toBe("human");
    expect(serializeMemory(human)).toContain("validated_by: human");
    expect(() =>
      parseMemory(
        "---\nid: 2026-06-08-decision-y\ntype: decision\ncreated_at: 2026-06-08T10:00:00.000Z\nvalidated_by: robot\n---\nbody",
      ),
    ).toThrow();
  });
});

describe("buildFrontmatter", () => {
  it("builds a personal draft by default", () => {
    const fm = buildFrontmatter({ type: "convention", slug: "use pnpm" });
    expect(fm.scope).toBe("personal");
    expect(fm.status).toBe("draft");
    expect(fm.type).toBe("convention");
    expect(fm.id).toMatch(/^\d{4}-\d{2}-\d{2}-convention-use-pnpm$/);
  });

  it("requires module name when scope is module", () => {
    expect(() =>
      buildFrontmatter({ type: "convention", slug: "x", scope: "module" }),
    ).toThrow();
    const fm = buildFrontmatter({
      type: "convention",
      slug: "x",
      scope: "module",
      module: "transactions",
    });
    expect(fm.module).toBe("transactions");
  });
});
