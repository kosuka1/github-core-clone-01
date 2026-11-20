# github-core-clone-01 entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kosuka1/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kosuka1/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in TypeScript on Node 22, standard library
only — no git binary, no dependencies, no install step. It serves four surfaces from
one in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (ls-refs and
  fetch, with shallow and deepen support) plus a v0 fallback, and receive-pack v0
  with report-status, side-band-64k and per-ref fast-forward enforcement. Packfiles
  are parsed and built by hand, including ofs/ref delta resolution.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents (with the
  409 stale-sha rule), labels, issues, comments and pull requests with squash,
  merge and rebase-shaped merges computed as a three-way file-level merge over the
  real git object graph.
- **GraphQL v4** at `/api/graphql`: a small executor covering the documents gh and
  github-mcp-server send — viewer, repository fields, cursor-paginated issue and
  pull-request connections, the create/close/merge mutations, `node(id:)`
  round-trips and the introspection probes those clients feature-detect with.
- **MCP** at `/mcp`: JSON-RPC over streamable HTTP (the 2026-07-28 `server/discover`
  revision and the classic initialize handshake), with six tools that act on the
  same store the REST surface reads.

Every timestamp comes from a deterministic counter clock, so a trial and its replay
produce byte-identical state. `main.ts` is the harness lifecycle, kept as the kit's
starter ships it; the forge itself lives in `app.ts`, `git.ts`, `forge.ts`,
`api.ts`, `graphql.ts` and `mcp.ts`.
