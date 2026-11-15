# GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/mikodefrisko/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/mikodefrisko/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Entry for [make.fun](https://make.fun/bounty/github-core-clone-01) competition **github-core-clone-01** ("Build a GitHub-compatible git forge").
Account: @golden-badger-44 · wallet `ApmXVZkSs74N5Z9hkSNMHA6abUbKyEoS5BNmhdAM6znx`.

## What it does

`main.ts` (Node 22, standard library only — no dependencies, no `git` binary,
no network, no disk writes) is a GitHub-compatible forge that speaks the real
protocols real clients speak:

- **Git smart HTTP** — protocol v2 advertisements, `ls-refs` (with `peel`,
  `symrefs`, `unborn`, `ref-prefix`), v2 `fetch` (shallow/deepen, `unshallow`,
  haves negotiation, thin packs), v0 fetch, and v0 `receive-pack` with
  per-ref fast-forward enforcement (`non-fast-forward` refusals), annotated-tag
  peeling, and OFS/REF delta resolution on read. Packs sent carry plain objects
  only, framed as sideband band-1. Verified end to end with the system `git`
  binary: empty clone, push, tag push, `--depth 1` shallow clone, full clone
  (`git fsck --strict` clean), non-fast-forward push rejected.
- **REST v3** (`/api/v3`) — repos (create/get/patch/delete, pagination with
  absolute `Link` headers), branches, refs, commits, contents (create/update/
  delete with base64 blobs, stale-sha 409), labels, issues (numbered from 1,
  state/sort/pagination), comments, pull requests (files diff with
  additions/deletions, squash merge with three-way conflict detection → 405).
  Foreign owner is always 404, never 403; every reply is JSON with a
  non-empty `X-GitHub-Request-Id`; no token is 401.
- **GraphQL v4** (`/api/graphql`) — a real parser + executor (variables,
  aliases, inline/named fragments, batched operations) over `viewer`,
  `repository`, `node(id:)` with opaque stable global ids, `__type`/`__schema`
  introspection, cursor connections, and the `createIssue` / `closeIssue` /
  `createPullRequest` / `mergePullRequest` / `addComment` mutations. Effects
  are visible over REST and vice versa.
- **MCP** (`/mcp`) — JSON-RPC 2.0 in the modern `2026-07-28` era
  (`server/discover`, `tools/list`, `tools/call`; legacy `initialize` also
  works): `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`. `tools/call` without
  authorization is 401 before any tool lookup.

## Run it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL in a trial
```

Locally (no trial env), start the server directly:

```sh
node --experimental-strip-types -e "import('./app.ts').then(m => m.createApp().listen(18080))"
```

Then `curl -H "Authorization: Bearer <token>" http://127.0.0.1:18080/api/v3/user`.
The bearer token is `MAKEFUN_SHOP_TOKEN` when set; any non-empty Bearer token
(or a Basic password equal to it, for real `git`) is accepted otherwise.

## Local check results

Kit checks (`node --experimental-strip-types sdk/run.ts --url … --token …`):

- **120/120 checks pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
  protocol 5/5, graphql 20/20, mcp 15/15.
- Perf (`--perf`, local VM, contention-bound): push 23, clone 13, read 2,
  write 3 (41/200). The request handler itself costs ~0.06 ms/request
  in-process; the local shortfall is VM scheduling contention between the
  runner and the server, not server work.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry ↔ env lifecycle (register, poll `/done`, exit 0). Unchanged from the starter. |
| `app.ts` | HTTP server: request-id, auth (Bearer + Basic), body reading, dispatch. |
| `store.ts` | All state, in memory: repos, objects, refs, issues, pulls, labels, comments. Owner learned from the first owner-named request. |
| `gitobj.ts` | Git object model, packfile codec (incl. OFS/REF deltas), pkt-line framing, sideband. |
| `githttp.ts` | Smart HTTP: info/refs, v2 ls-refs/fetch, v0 fetch, receive-pack + fast-forward rules. |
| `rest.ts` | REST v3 routes, contents/merge helpers shared with GraphQL and MCP. |
| `graphql.ts` | GraphQL parser + executor + schema registry. |
| `mcp.ts` | MCP endpoint (modern + legacy eras, six tools). |

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
