# Hivelore MCP server — container image for the Glama listing check.
#
# Glama starts this container and issues an MCP introspection request
# (initialize + tools/list) over stdio. The server only needs to start and
# answer that handshake — no project corpus is required.
#
# Build context: the repository root.
#   docker build -t hivelore-mcp .
#   docker run --rm -i hivelore-mcp        # then speak JSON-RPC over stdin/stdout

FROM node:20-bookworm-slim

# pnpm via corepack, pinned to the repo's packageManager version.
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
RUN corepack enable

WORKDIR /app

# The whole monorepo is copied: the workspace build links core → mcp → cli.
COPY . .

# Install pinned deps and build all four workspace packages.
# The optional native deps (@ast-grep/napi) are prebuilt binaries — no
# build toolchain is required; the embeddings model is never downloaded here
# (it lazy-loads at runtime only when semantic ranking is actually used).
RUN pnpm install --frozen-lockfile \
 && pnpm -r build

# Transport is stdio; the server logs only to stderr (stdout is the JSON-RPC
# channel). `mcp --stdio` is the exact command `hivelore init` writes into
# client configs, so the container mirrors a real MCP client's invocation.
ENTRYPOINT ["node", "/app/packages/cli/dist/index.js", "mcp", "--stdio"]
