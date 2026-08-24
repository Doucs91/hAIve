/**
 * One ordering for dotted version strings, shared by everything in the release chain.
 *
 * There were three byte-identical copies of this — two in core, one in the CLI — because each new
 * release check wrote its own rather than look for one. Ordering is the kind of thing that must
 * not disagree with itself between two gates reading the same tags.
 *
 * Deliberately lenient, not a semver parser: it splits on `.` and `-`, reads each part as an
 * integer and treats anything unparseable as 0. Inputs here are tags and registry versions the
 * repo produced itself, and a comparator that throws would turn an advisory check into a crash.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
