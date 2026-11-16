# github-core-clone-01-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/StarsN/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/StarsN/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in dependency-free TypeScript for Node 22 — one process, its own content-addressed object store, no git binary. It speaks git smart-HTTP (protocol v2 fetch with shallow/deepen, v0 fetch, receive-pack with report-status and fast-forward enforcement), the REST v3 surface (repositories, contents, branches, commits, labels, issues, comments, pull requests with three-way merges and line diffs), a GraphQL v4 subset (viewer/repository/issue/pull-request queries, cursor connections, the gh mutations, Relay node ids, __type introspection), and an MCP endpoint (legacy initialize handshake, eight tools over the same domain objects). Local run of the kit's own conformance suite: 120/120 checks, perf 190/200 (push 43, clone 47, read 50, write 50) — total 990/1000.

## Run it

```sh
# with the make.fun env server running and MAKEFUN_ENV_URL set:
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vvry49c9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
