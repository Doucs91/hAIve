/**
 * Strip memory markdown down to actionable bullet lines — cheaper for briefing payloads.
 */

const MAX_DEFAULT_CHARS = 1200;

/**
 * Prefer markdown list lines; fall back to the first substantive paragraph block.
 */
export function extractActionsBriefBody(markdown: string, maxChars = MAX_DEFAULT_CHARS): string {
  const stripped = markdown.replace(/\r/g, "").trim();
  if (!stripped) return "";

  const lines = stripped.split("\n");
  const bullets: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*[-*+]\s+(.+)/);
    if (m?.[1]) {
      bullets.push(`- ${m[1].trim()}`);
      if (bullets.join("\n").length >= maxChars) break;
    }
  }
  if (bullets.length >= 2) {
    let text = bullets.join("\n");
    if (text.length > maxChars) text = text.slice(0, maxChars).trimEnd() + "…";
    return text;
  }

  // Single bullet or none — take contiguous non-empty paragraphs (skip headings)
  const paragraphs: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (buf.length) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
      continue;
    }
    if (t.startsWith("#") || t.startsWith("```")) {
      if (buf.length) {
        paragraphs.push(buf.join(" ").trim());
        buf = [];
      }
      continue;
    }
    buf.push(t);
  }
  if (buf.length) paragraphs.push(buf.join(" ").trim());

  if (paragraphs.length === 0) {
    let out = stripped.slice(0, maxChars);
    if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + "…";
    return out;
  }

  // Accumulate as many paragraphs as fit — not just the first. A must-read memory that opens with a
  // short delivery-log accroche ("Lot 8, livré le 2026-08-31.") keeps its actual substance in the
  // paragraphs that follow; returning only paragraphs[0] truncated it to the accroche and dropped
  // everything the agent needed (field report 2026-09-01 §5.2, reported twice).
  const collected: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    const cost = (collected.length ? 2 : 0) + paragraph.length;
    if (collected.length > 0 && length + cost > maxChars) break;
    collected.push(paragraph);
    length += cost;
  }
  let out = collected.join("\n\n");
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd() + "…";
  return out;
}
