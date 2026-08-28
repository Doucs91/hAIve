import matter from "gray-matter";
import { z } from "zod";
import { MemoryFrontmatterSchema } from "./schema.js";
import type { Activation, Memory, MemoryFrontmatter, Sensor } from "./types.js";

const PRIVATE_BLOCK_RE = /<private>[\s\S]*?<\/private>/g;

export function stripPrivate(body: string): string {
  return body.replace(PRIVATE_BLOCK_RE, "").trimEnd();
}

/**
 * Turn a ZodError on the frontmatter into ONE actionable sentence naming the field, the offending
 * value, and — for an enum — the allowed values. A raw ZodError serializes as a multi-line JSON
 * array, so `err.message.split("\n")[0]` (how the loader records the failure) collapsed to a bare
 * `[`, which surfaced in `hivelore doctor` as the meaningless `([)`. A lost corpus file must say
 * WHY it is invisible, or the lesson is lost without a fixable signal.
 */
function formatFrontmatterError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid frontmatter";
  const field = issue.path.length > 0 ? issue.path.join(".") : "frontmatter";
  if (issue.code === "invalid_enum_value") {
    const got = JSON.stringify((issue as z.ZodInvalidEnumValueIssue).received);
    const allowed = (issue as z.ZodInvalidEnumValueIssue).options.join(" | ");
    return `invalid ${field}: ${got} is not a supported value — expected one of: ${allowed}`;
  }
  return `invalid ${field}: ${issue.message}`;
}

export function parseMemory(raw: string): Memory {
  const parsed = matter(raw);
  const result = MemoryFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    throw new Error(formatFrontmatterError(result.error));
  }
  return {
    frontmatter: result.data,
    body: stripPrivate(parsed.content.trim()),
  };
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function serializeMemory(memory: Memory): string {
  const clean = stripUndefined(memory.frontmatter) as Record<string, unknown>;
  return matter.stringify(memory.body, clean);
}

export function newMemoryId(type: string, slug: string, date = new Date()): string {
  const isoDate = date.toISOString().slice(0, 10);
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${isoDate}-${type}-${safeSlug}`;
}

export function buildFrontmatter(input: {
  type: MemoryFrontmatter["type"];
  slug: string;
  scope?: MemoryFrontmatter["scope"];
  module?: string;
  tags?: string[];
  domain?: string;
  author?: string;
  paths?: string[];
  symbols?: string[];
  commit?: string;
  topic?: string;
  status?: MemoryFrontmatter["status"];
  relatedIds?: string[];
  sensor?: Sensor;
  activation?: Activation;
  lifecycle?: MemoryFrontmatter["lifecycle"];
}): MemoryFrontmatter {
  const now = new Date();
  const id = newMemoryId(input.type, input.slug, now);
  return MemoryFrontmatterSchema.parse({
    id,
    scope: input.scope ?? "personal",
    module: input.module,
    type: input.type,
    status: input.status ?? "draft",
    anchor: {
      commit: input.commit,
      paths: input.paths ?? [],
      symbols: input.symbols ?? [],
    },
    tags: input.tags ?? [],
    domain: input.domain,
    author: input.author,
    created_at: now.toISOString(),
    expires_when: null,
    topic: input.topic,
    sensor: input.sensor,
    activation: input.activation,
    lifecycle: input.lifecycle,
    revision_count: 0,
    related_ids: input.relatedIds ?? [],
  });
}
