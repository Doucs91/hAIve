/**
 * THE single source of truth for briefing memory priority — must_read / useful / background.
 *
 * This tier decides what an agent reads first. It used to be implemented TWICE: once in the MCP
 * `get_briefing` tool (briefing-helpers) and once in the `hivelore briefing` CLI command, each on its
 * own data shape. The two drifted (the stack-pack down-rank, then the env-workaround down-rank, both
 * had to be applied in two places, and one was missed). This module is the shared classifier: both
 * call sites map their available evidence into {@link PrioritySignals} and call {@link classifyMemoryPriority}
 * here, so the CLI and MCP can never disagree again. Pure, unit-tested.
 */
import { isEnvWorkaroundMemory, isStackPackSeed } from "./relevance.js";

import { DEFAULT_SPECIFICITY, isWeakAnchor } from "./anchor-specificity.js";

export type MemoryPriority = "must_read" | "useful" | "background";

/**
 * Normalized priority evidence. A caller fills only the signals it can compute; unknown ones default
 * to false (see {@link DEFAULT_PRIORITY_SIGNALS}). The MCP path has semantic scores; the CLI path has
 * lexical scores — both reduce to these booleans.
 */
export interface PrioritySignals {
  /** Memory type (attempt, gotcha, skill, decision, …). */
  type: string;
  /** Memory tags — used for the stack-pack / env-workaround down-rank. */
  tags: string[];
  /** The memory demands explicit human approval — always surface first. */
  requiresHumanApproval: boolean;
  /** Anchored to a file the agent is editing. */
  directAnchor: boolean;
  /** Anchored to a symbol the agent requested. */
  directSymbol: boolean;
  /** Exact/literal task match (semantic match_quality "exact", or an exact lexical task hit). */
  exactTaskMatch: boolean;
  /** Strong semantic relevance (cosine ≥ 0.65). CLI has no embeddings → passes false. */
  strongSemantic: boolean;
  /** Useful-level relevance: semantic ≥ 0.35, a partial task hit, or a high lexical score. */
  usefulSemantic: boolean;
  /** Matched an inferred module or domain from the touched files. */
  moduleOrDomainMatch: boolean;
  /** A memory tag matched a task token. */
  tagTaskMatch: boolean;
  /**
   * How much information the matched anchor carries in THIS repo, 0..1 (see `anchor-specificity.ts`).
   * 1 (the default) means "unknown or highly specific" and preserves the historical behaviour
   * exactly, so a repo without git history ranks as it always did.
   */
  anchorSpecificity?: number;
}

export const DEFAULT_PRIORITY_SIGNALS: PrioritySignals = {
  type: "",
  tags: [],
  requiresHumanApproval: false,
  directAnchor: false,
  directSymbol: false,
  exactTaskMatch: false,
  strongSemantic: false,
  usefulSemantic: false,
  moduleOrDomainMatch: false,
  tagTaskMatch: false,
  anchorSpecificity: DEFAULT_SPECIFICITY,
};

/** Convenience: build a full signal set from a partial one. */
export function prioritySignals(partial: Partial<PrioritySignals>): PrioritySignals {
  return { ...DEFAULT_PRIORITY_SIGNALS, ...partial };
}

/**
 * Classify a memory's briefing priority from its signals. Order matters:
 *   1. must_read — human-approval gates, direct anchor/symbol matches, and exact/strong hits on
 *      negative (attempt) or skill memories: the things an agent must not miss.
 *   2. background (down-rank) — generic stack-pack seeds and local dev-environment workarounds never
 *      claim `useful` on a semantic/tag match alone; they'd crowd out repo-specific knowledge. (A
 *      direct anchor already promoted them to must_read above, so genuinely-relevant ones still rank.)
 *   3. useful — skills, module/domain matches, exact hits, and useful-level relevance.
 *   4. background — everything else.
 */
export function classifyMemoryPriority(signals: PrioritySignals): MemoryPriority {
  const isNegative = signals.type === "attempt";
  const isSkill = signals.type === "skill";

  // An anchor match is the strongest signal available — WHEN the anchor is specific. On a file every
  // commit touches (`package.json`, a lockfile, CI config) it is nearly no evidence at all: measured
  // on this repo, the p90 memory claimed 60% of commits, so ~34 memories declared `must_read` on a
  // single release commit and the briefing's 8 slots went to whichever sorted first. A weak anchor
  // must therefore be corroborated by something about the task before it outranks everything.
  const weakAnchor =
    signals.directAnchor && isWeakAnchor(signals.anchorSpecificity ?? DEFAULT_SPECIFICITY);
  const strongAnchor = signals.directAnchor && !weakAnchor;
  // Corroboration deliberately EXCLUDES exactTaskMatch. That signal is a literal token AND-match
  // over the whole memory body, and on a task-shaped corpus it fires on almost everything: a
  // "chore: bump version" commit marked every package.json lesson `exact` and promoted all of them
  // straight back to must_read, defeating the specificity check entirely. Literal body overlap is
  // precisely the "global textual relevance" a field report identified as the ranking's weak point.
  // Real corroboration is a strong semantic hit or an explicit symbol match.
  const corroborated = signals.strongSemantic || signals.directSymbol;

  if (
    signals.requiresHumanApproval ||
    strongAnchor ||
    signals.directSymbol ||
    (weakAnchor && corroborated) ||
    (isNegative && (signals.exactTaskMatch || signals.strongSemantic)) ||
    (isSkill && (signals.exactTaskMatch || signals.strongSemantic))
  ) {
    return "must_read";
  }

  // A weak anchor still means the memory governs a file in play — it stays `useful`, ahead of a
  // purely semantic hit. It just no longer crowds the top rank.
  if (weakAnchor) return "useful";

  if (isStackPackSeed({ tags: signals.tags }) || isEnvWorkaroundMemory({ tags: signals.tags })) {
    // The down-rank exists to stop generic seeds crowding out repo-specific knowledge on weak
    // matches (a tag hit, mid semantic). But its documented escape hatch — "a direct anchor already
    // promoted them" — is dead for stack packs: they ship anchor-less (needs_anchor). So a STRONG
    // task hit (exact/literal match, or cosine ≥ 0.65) rescues a stack seed to `useful` — the agent
    // is working squarely in the pack's subject ("add a prisma migration" → the prisma-migrations
    // rule must not hide in background). Never must_read, and env workarounds keep the hard cap:
    // their fix is repairing the environment, not surfacing the note.
    if (isStackPackSeed({ tags: signals.tags }) && (signals.exactTaskMatch || signals.strongSemantic)) {
      return "useful";
    }
    return "background";
  }

  if (
    isSkill ||
    signals.moduleOrDomainMatch ||
    signals.exactTaskMatch ||
    signals.usefulSemantic ||
    signals.tagTaskMatch
  ) {
    return "useful";
  }

  return "background";
}

export function priorityRank(priority: MemoryPriority): number {
  return priority === "must_read" ? 3 : priority === "useful" ? 2 : 1;
}
