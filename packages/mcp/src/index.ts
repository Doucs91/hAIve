import {
  parseMcpCliArgs,
  printHaiveMcpVersion,
  runHaiveMcpStdio,
} from "./server.js";

const parsed = parseMcpCliArgs(process.argv);
if (parsed.versionOnly) {
  printHaiveMcpVersion();
  process.exit(0);
}

runHaiveMcpStdio({ root: parsed.root }).catch((err: unknown) => {
  console.error("[hivelore-mcp] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
