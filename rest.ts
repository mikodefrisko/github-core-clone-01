// GitHub REST v3 surface, per the kit's analysis/rest-contract.md.
// All routes live under /api/v3. Authentication (Bearer token) and the
// X-GitHub-Request-Id header are applied by app.ts before dispatch; this
// module assumes an authenticated request.
//
// Semantics that matter to the checks:
// - Foreign owner => 404, never 403.
// - Malformed JSON body => 400 (handled by app.ts).
// - Unknown route => JSON 404, never HTML.
// - Issue numbers start at 1 per repo and increase by 1.
// - PR merge is a squash merge with three-way conflict detection; a
//   conflicted merge answers 405.
// - Contents PUT creates a blob + tree + commit and moves the branch ref.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Label, Pull, Repo, Store } from './store.ts';
import type { GitObject } from './store.ts';
import { ZERO_OID } from './store.ts';
import {
  encodeTree,
  buildCommit,
  collectReachable,
  decodeBase64Loose,
  isAncestor,
  objectId,
  parseCommit,
  parseTree,
  putObject,
} from './gitobj.ts';

export interface RouteContext {
  store: Store;
  /** Parsed JSON body, or null when there is no body. app.ts rejects malformed JSON with 400 first. */
  body: unknown;
  /** The bearer token the client sent (used as the viewer identity where needed). */
  token: string;
  /** The request origin, e.g. http://127.0.0.1:18080 — Link headers are absolute. */
  origin: string;
}

type Handler = (ctx: RouteContext, res: ServerResponse, params: Record<string, string>, query: URLSearchParams) => void;

function json(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, ...extraHeaders });
  res.end(body);
}

function err(res: ServerResponse, status: number, message: string): void {
  json(res, status, { message });
}

function bodyObj(ctx: RouteContext): Record<string, unknown> {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
    return ctx.body as Record<string, unknown>;
  }
  return {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** The viewer login, as learned from the first owner-named request (or 'viewer' before that). */
function viewerLogin(store: Store): string {
  return store.learnedOwner ?? 'viewer';
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewerLogin(store);
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.ownerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${owner}/${repo.name}`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: 'viewer', id: 1000, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/x/${repo.name}/issues/${issue.number}`,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: label?.nodeId ?? '',
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: label?.default ?? false,
  };
}

function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    node_id: pr.nodeId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.mergeable,
    head: { ref: pr.head, sha: pr.headSha, label: pr.head },
    base: { ref: pr.base, sha: pr.baseSha, label: pr.base },
    user: { login: 'viewer', id: 1000, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    html_url: `https://github.com/x/${repo.name}/pull/${pr.number}`,
  };
}

function getRepoOr404(ctx: RouteContext, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = ctx.store.findRepo(owner, name);
  if (repo === null) {
    err(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function parsePagination(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPageRaw = Number(query.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

/** Build a Link header for a paginated collection. `base` is the path without query. */
function linkHeader(reqUrl: string, page: number, perPage: number, total: number): Record<string, string> {
  const url = new URL(reqUrl, 'http://entry');
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const make = (pageNumber: number, rel: string): string => {
    const nextUrl = new URL(url.pathname, url.origin);
    const search = new URLSearchParams(url.searchParams);
    search.set('page', String(pageNumber));
    search.set('per_page', String(perPage));
    nextUrl.search = search.toString();
    return `<${nextUrl.href}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(make(page + 1, 'next'));
  if (page > 1) links.push(make(page - 1, 'prev'));
  links.push(make(totalPages, 'last'));
  links.push(make(1, 'first'));
  if (links.length === 0) return {};
  return { Link: links.join(', ') };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- tree helpers

export function treeForCommit(objects: Map<string, GitObject>, commitOid: string): string | null {
  const obj = objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function entryAtPath(
  objects: Map<string, GitObject>,
  treeOid: string,
  parts: readonly string[],
): { mode: string; oid: string } | null {
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((item) => item.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

export function setEntryAtPath(
  objects: Map<string, GitObject>,
  treeOid: string,
  parts: readonly string[],
  mode: string,
  oid: string,
): string {
  const obj = objects.get(treeOid);
  const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  const [head, ...tail] = parts;
  if (head === undefined) return treeOid;
  if (tail.length === 0) {
    const next = entries.filter((item) => item.name !== head);
    next.push({ mode, name: head, oid });
    return putObject(objects, 'tree', encodeTree(next));
  }
  const existing = entries.find((item) => item.name === head);
  const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : putObject(objects, 'tree', encodeTree([]));
  const newChild = setEntryAtPath(objects, childTree, tail, mode, oid);
  const next = entries.filter((item) => item.name !== head);
  next.push({ mode: '40000', name: head, oid: newChild });
  return putObject(objects, 'tree', encodeTree(next));
}

export function deleteEntryAtPath(
  objects: Map<string, GitObject>,
  treeOid: string,
  parts: readonly string[],
): string | null {
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return null;
  const entries = parseTree(obj.data);
  const [head, ...tail] = parts;
  if (head === undefined) return null;
  if (tail.length === 0) {
    if (!entries.some((item) => item.name === head)) return null;
    return putObject(objects, 'tree', encodeTree(entries.filter((item) => item.name !== head)));
  }
  const existing = entries.find((item) => item.name === head);
  if (existing === undefined || existing.mode !== '40000') return null;
  const newChild = deleteEntryAtPath(objects, existing.oid, tail);
  if (newChild === null) return null;
  const next = entries.filter((item) => item.name !== head);
  const childObj = objects.get(newChild);
  if (childObj !== undefined && childObj.type === 'tree' && parseTree(childObj.data).length === 0) {
    // Drop empty directories.
    return putObject(objects, 'tree', encodeTree(next));
  }
  next.push({ mode: '40000', name: head, oid: newChild });
  return putObject(objects, 'tree', encodeTree(next));
}

/** Flatten a tree to path -> {mode, oid}. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    out.set(path, { mode: entry.mode, oid: entry.oid });
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(objects, entry.oid, path)) out.set(childPath, child);
    }
  }
  return out;
}

export function commitOnBranch(repo: Repo, branch: string, message: string, treeOid: string, parents: string[]): string {
  const now = repo.store.nowIso();
  const epoch = Math.floor(repo.store.nowMs() / 1000);
  const ident = `forge <forge@example.com> ${epoch} +0000`;
  const raw = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
  const oid = putObject(repo.objects, 'commit', raw);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

function lineCounts(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Count added/deleted lines between two text blobs (multiset difference). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldMap = count(oldText);
  const newMap = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newMap) {
    const diff = n - (oldMap.get(line) ?? 0);
    if (diff > 0) additions += diff;
  }
  for (const [line, n] of oldMap) {
    const diff = n - (newMap.get(line) ?? 0);
    if (diff > 0) deletions += diff;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------- handlers

const handlers: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  const keys: string[] = [];
  // A parameter ending in `*` (e.g. :path*) matches the rest of the URL,
  // slashes included; a plain parameter matches one segment.
  const source = pattern.replace(/:([A-Za-z_]+)(\*)?/g, (_, key, star) => {
    keys.push(key as string);
    return star ? '(.+)' : '([^/]+)';
  });
  handlers.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
}

route('GET', '/api/v3/', (ctx, res) => {
  json(res, 200, {
    current_user_url: 'https://api.github.com/user',
    repository_url: 'https://api.github.com/repos/{owner}/{repo}',
    rate_limit_url: 'https://api.github.com/rate_limit',
  }, { 'X-OAuth-Scopes': 'repo, read:org', 'X-Accepted-OAuth-Scopes': 'repo' });
});

route('GET', '/api/v3/meta', (_ctx, res) => {
  json(res, 200, {
    installed_version: '1.0.0',
    verifiable_password_authentication: false,
    ssh_key_fingerprints: {},
    hooks: [],
    github_enterprise_importer: [],
    packages: [],
    actions: [],
  });
});

route('GET', '/api/v3/user', (ctx, res) => {
  const login = viewerLogin(ctx.store);
  json(res, 200, { login, id: 1000, node_id: 'MDQ6VXNlcjEwMDA=', type: 'User', site_admin: false });
});

route('POST', '/api/v3/user/repos', (ctx, res) => {
  const body = bodyObj(ctx);
  const name = str(body.name);
  if (name === undefined || name === '') {
    err(res, 422, 'name is required');
    return;
  }
  if (ctx.store.findRepoByName(name) !== null) {
    err(res, 422, 'Repository creation failed. name already exists on this account');
    return;
  }
  const repo = ctx.store.createRepo(name, {
    private: bool(body.private, false),
    description: str(body.description),
  });
  json(res, 201, repoJson(ctx.store, repo));
});

route('GET', '/api/v3/user/repos', (ctx, res, _params, query) => {
  const { page, perPage } = parsePagination(query);
  const repos = [...ctx.store.repos.values()].sort((a, b) => a.createdOrder - b.createdOrder);
  const total = repos.length;
  const pageItems = paginate(repos, page, perPage);
  json(res, 200, pageItems.map((repo) => repoJson(ctx.store, repo)), linkHeader(`${ctx.origin}/api/v3/user/repos`, page, perPage, total));
});

route('GET', '/api/v3/repos/:owner/:repo', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  json(res, 200, repoJson(ctx.store, repo));
});

route('PATCH', '/api/v3/repos/:owner/:repo', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const description = str(body.description);
  if (description !== undefined) repo.description = description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  repo.updatedAt = ctx.store.nowIso();
  json(res, 200, repoJson(ctx.store, repo));
});

route('DELETE', '/api/v3/repos/:owner/:repo', (ctx, res, params) => {
  const repo = ctx.store.findRepo(params.owner as string, params.repo as string);
  if (repo === null) {
    err(res, 404, 'Not Found');
    return;
  }
  ctx.store.deleteRepo(repo);
  res.writeHead(204);
  res.end();
});

route('GET', '/api/v3/repos/:owner/:repo/branches', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const branches: Array<Record<string, unknown>> = [];
  const names = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .map((name) => name.slice('refs/heads/'.length))
    .sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : 1));
  for (const name of names) {
    branches.push({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`), url: '' },
      protected: false,
    });
  }
  json(res, 200, branches);
});

route('GET', '/api/v3/repos/:owner/:repo/branches/:branch', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const sha = repo.refs.get(`refs/heads/${params.branch as string}`);
  if (sha === undefined) {
    err(res, 404, 'Branch not found');
    return;
  }
  json(res, 200, { name: params.branch, commit: { sha, url: '' }, protected: false });
});

route('POST', '/api/v3/repos/:owner/:repo/git/refs', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    err(res, 422, 'Invalid ref or sha');
    return;
  }
  const obj = repo.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') {
    err(res, 422, 'Object does not exist or is not a commit');
    return;
  }
  if (repo.refs.has(ref)) {
    err(res, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  json(res, 201, { ref, object: { sha, type: 'commit' }, node_id: '' });
});

route('GET', '/api/v3/repos/:owner/:repo/git/refs/heads/:branch', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const ref = `refs/heads/${params.branch as string}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  json(res, 200, { ref, object: { sha, type: 'commit' }, node_id: '' });
});

route('GET', '/api/v3/repos/:owner/:repo/commits', (ctx, res, params, query) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const shaParam = query.get('sha');
  let tip: string | undefined;
  if (shaParam !== null) {
    tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : undefined);
  } else {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  if (tip === undefined) {
    json(res, 200, []);
    return;
  }
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    order.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  json(res, 200, order.map((oid) => {
    const parsed = parseCommit((repo.objects.get(oid) as GitObject).data);
    return {
      sha: oid,
      commit: {
        message: parsed.message,
        author: { name: 'forge', email: 'forge@example.com', date: '' },
        committer: { name: 'forge', email: 'forge@example.com', date: '' },
        tree: { sha: parsed.tree },
      },
      parents: parsed.parents.map((parent) => ({ sha: parent })),
    };
  }));
});

route('GET', '/api/v3/repos/:owner/:repo/contents/:path*', (ctx, res, params, query) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const refParam = query.get('ref');
  const branch = refParam ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const treeOid = treeForCommit(repo.objects, tip);
  if (treeOid === null) {
    err(res, 404, 'Not Found');
    return;
  }
  const rawPath = decodeURIComponent(params.path as string);
  const parts = rawPath.split('/').filter((part) => part !== '');
  if (parts.length === 0) {
    const obj = repo.objects.get(treeOid);
    const entries = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
    json(res, 200, entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
      size: 0,
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
    })));
    return;
  }
  const entry = entryAtPath(repo.objects, treeOid, parts);
  if (entry === null) {
    err(res, 404, 'Not Found');
    return;
  }
  if (entry.mode === '40000') {
    const obj = repo.objects.get(entry.oid);
    const children = obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
    json(res, 200, children.map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: `${rawPath}/${child.name}`,
      sha: child.oid,
      size: 0,
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
    })));
    return;
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') {
    err(res, 404, 'Not Found');
    return;
  }
  json(res, 200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name: parts[parts.length - 1],
    path: rawPath,
    content: blob.data.toString('base64'),
    sha: entry.oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: null,
  });
});

route('PUT', '/api/v3/repos/:owner/:repo/contents/:path*', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const message = str(body.message) ?? 'Update file';
  const contentB64 = str(body.content);
  if (contentB64 === undefined) {
    err(res, 422, 'content is required');
    return;
  }
  const branch = str(body.branch) ?? repo.defaultBranch;
  const rawPath = decodeURIComponent(params.path as string);
  const parts = rawPath.split('/').filter((part) => part !== '');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const existingTree = tip !== undefined ? treeForCommit(repo.objects, tip) : null;
  const existing = existingTree !== null ? entryAtPath(repo.objects, existingTree, parts) : null;
  const expectedSha = str(body.sha);
  if (expectedSha !== undefined && existing !== null && existing.oid !== expectedSha) {
    err(res, 409, 'sha does not match');
    return;
  }
  if (expectedSha !== undefined && existing === null) {
    err(res, 422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
    return;
  }
  let bytes: Buffer;
  try {
    bytes = decodeBase64Loose(contentB64);
  } catch {
    err(res, 422, 'content is not valid base64');
    return;
  }
  const blobOid = putObject(repo.objects, 'blob', bytes);
  const baseTree = existingTree ?? putObject(repo.objects, 'tree', encodeTree([]));
  const newTree = setEntryAtPath(repo.objects, baseTree, parts, '100644', blobOid);
  const parents = tip !== undefined ? [tip] : [];
  const commitOid = commitOnBranch(repo, branch, message, newTree, parents);
  json(res, existing === null ? 201 : 200, {
    content: {
      name: parts[parts.length - 1],
      path: rawPath,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: contentB64,
    },
    commit: { sha: commitOid, message },
  });
});

route('DELETE', '/api/v3/repos/:owner/:repo/contents/:path*', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const message = str(body.message) ?? 'Delete file';
  const expectedSha = str(body.sha);
  const branch = str(body.branch) ?? repo.defaultBranch;
  const rawPath = decodeURIComponent(params.path as string);
  const parts = rawPath.split('/').filter((part) => part !== '');
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const treeOid = treeForCommit(repo.objects, tip);
  if (treeOid === null) {
    err(res, 404, 'Not Found');
    return;
  }
  const existing = entryAtPath(repo.objects, treeOid, parts);
  if (existing === null) {
    err(res, 404, 'Not Found');
    return;
  }
  if (expectedSha !== undefined && existing.oid !== expectedSha) {
    err(res, 409, 'sha does not match');
    return;
  }
  const newTree = deleteEntryAtPath(repo.objects, treeOid, parts);
  if (newTree === null) {
    err(res, 404, 'Not Found');
    return;
  }
  const commitOid = commitOnBranch(repo, branch, message, newTree, [tip]);
  json(res, 200, { content: null, commit: { sha: commitOid, message } });
});

// ---------------------------------------------------------------- labels

route('GET', '/api/v3/repos/:owner/:repo/labels', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  json(res, 200, [...repo.labels.values()].map((label) => labelJson(repo, label.name)));
});

route('POST', '/api/v3/repos/:owner/:repo/labels', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const name = str(body.name);
  if (name === undefined || name === '') {
    err(res, 422, 'name is required');
    return;
  }
  const color = str(body.color) ?? 'ededed';
  const existing = repo.labels.get(name);
  if (existing !== undefined) {
    err(res, 422, 'Validation Failed: label already exists');
    return;
  }
  const label: Label = {
    id: repo.nextLabelId++,
    nodeId: repo.store.gid('Label', repo.id, name),
    name,
    color,
    description: str(body.description) ?? '',
    default: false,
  };
  repo.labels.set(name, label);
  json(res, 201, labelJson(repo, name));
});

// ---------------------------------------------------------------- shared create/merge logic (REST + GraphQL)

export function createIssueInRepo(
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): { issue: Issue } | { error: string } {
  const labelNames = input.labels ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `Label '${name}' does not exist` };
  }
  const issue: Issue = {
    id: repo.nextIssueId++,
    nodeId: repo.store.gid('Issue', repo.id, repo.nextIssue),
    number: repo.nextIssue++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: labelNames,
    createdAt: repo.store.nowIso(),
    updatedAt: repo.store.nowIso(),
    closedAt: null,
    createdOrder: repo.store.nextOrder(),
    comments: [],
    nextCommentId: 1,
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function createPullInRepo(
  repo: Repo,
  input: { head: string; base: string; title: string; body?: string },
): { pr: Pull } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (headSha === undefined || baseSha === undefined) {
    return { error: 'head or base branch does not exist' };
  }
  const pr: Pull = {
    id: repo.nextPullId++,
    nodeId: repo.store.gid('PullRequest', repo.id, repo.nextPull),
    number: repo.nextPull++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    mergeable: null,
    head: input.head,
    base: input.base,
    headSha,
    baseSha: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? baseSha,
    createdAt: repo.store.nowIso(),
    updatedAt: repo.store.nowIso(),
    closedAt: null,
    createdOrder: repo.store.nextOrder(),
  };
  repo.pulls.set(pr.number, pr);
  return { pr };
}

/**
 * Read-only three-way conflict detection for a pull request. Returns true
 * when a path changed on both sides with different results, false when the
 * merge is clean, and null when either branch is missing. Used both by
 * performMerge and by the GraphQL `mergeable` field.
 */
export function mergeConflicts(repo: Repo, pr: Pull): boolean | null {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) return null;
  if (isAncestor(repo.objects, headTip, baseTip)) return false;
  const base = mergeBase(repo.objects, baseTip, headTip);
  const baseTreeOid = base !== null ? treeForCommit(repo.objects, base) : null;
  const headTreeOid = treeForCommit(repo.objects, headTip);
  const baseBranchTreeOid = treeForCommit(repo.objects, baseTip);
  const baseFlat = baseTreeOid !== null ? flattenTree(repo.objects, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const headFlat = headTreeOid !== null ? flattenTree(repo.objects, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const currentFlat = baseBranchTreeOid !== null ? flattenTree(repo.objects, baseBranchTreeOid) : new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...currentFlat.keys()]);
  for (const path of paths) {
    const ancestor = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    const current = currentFlat.get(path);
    const headChanged = (ancestor?.oid ?? null) !== (headEntry?.oid ?? null);
    const currentChanged = (ancestor?.oid ?? null) !== (current?.oid ?? null);
    if (headChanged && currentChanged && (headEntry?.oid ?? null) !== (current?.oid ?? null)) return true;
  }
  return false;
}

export type MergeResult =
  | { status: 'merged'; sha: string }
  | { status: 'conflict' }
  | { status: 'error'; message: string };

/**
 * Squash-merge a pull request onto its base branch with three-way conflict
 * detection. Mutates the PR (merged / mergedAt / mergeCommitSha / state) and
 * the base branch ref. A conflict leaves everything untouched.
 */
export function performMerge(repo: Repo, pr: Pull): MergeResult {
  if (pr.merged) return { status: 'error', message: 'Pull request already merged' };
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (baseTip === undefined || headTip === undefined) {
    return { status: 'error', message: 'head or base branch does not exist' };
  }
  // Already contained in the base: nothing to merge.
  if (isAncestor(repo.objects, headTip, baseTip)) {
    pr.merged = true;
    pr.mergedAt = repo.store.nowIso();
    pr.mergeCommitSha = baseTip;
    pr.state = 'closed';
    pr.closedAt = pr.mergedAt;
    pr.updatedAt = pr.mergedAt;
    return { status: 'merged', sha: baseTip };
  }
  const base = mergeBase(repo.objects, baseTip, headTip);
  const baseTreeOid = base !== null ? treeForCommit(repo.objects, base) : null;
  const headTreeOid = treeForCommit(repo.objects, headTip);
  const baseBranchTreeOid = treeForCommit(repo.objects, baseTip);
  const baseFlat = baseTreeOid !== null ? flattenTree(repo.objects, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const headFlat = headTreeOid !== null ? flattenTree(repo.objects, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const currentFlat = baseBranchTreeOid !== null ? flattenTree(repo.objects, baseBranchTreeOid) : new Map<string, { mode: string; oid: string }>();
  if (mergeConflicts(repo, pr) === true) {
    pr.mergeable = 'CONFLICTING';
    return { status: 'conflict' };
  }
  // Squash: apply the head's changes (vs the merge base) onto the base branch tree.
  let mergedTree = baseBranchTreeOid ?? putObject(repo.objects, 'tree', encodeTree([]));
  const changedPaths = new Set<string>();
  for (const path of [...baseFlat.keys(), ...headFlat.keys()]) {
    const ancestor = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    if ((ancestor?.oid ?? null) !== (headEntry?.oid ?? null)) changedPaths.add(path);
  }
  for (const path of [...changedPaths].sort()) {
    const headEntry = headFlat.get(path);
    const parts = path.split('/');
    if (headEntry === undefined) {
      const next = deleteEntryAtPath(repo.objects, mergedTree, parts);
      if (next !== null) mergedTree = next;
    } else if (headEntry.mode !== '40000') {
      mergedTree = setEntryAtPath(repo.objects, mergedTree, parts, headEntry.mode, headEntry.oid);
    }
  }
  const message = `${pr.title} (#${pr.number})\n\n${pr.body}`;
  const mergeCommit = commitOnBranch(repo, pr.base, message, mergedTree, [baseTip]);
  pr.merged = true;
  pr.mergedAt = repo.store.nowIso();
  pr.mergeCommitSha = mergeCommit;
  pr.state = 'closed';
  pr.closedAt = pr.mergedAt;
  pr.updatedAt = pr.mergedAt;
  pr.mergeable = 'MERGEABLE';
  return { status: 'merged', sha: mergeCommit };
}

// ---------------------------------------------------------------- issues

route('GET', '/api/v3/repos/:owner/:repo/issues', (ctx, res, params, query) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  const { page, perPage } = parsePagination(query);
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.createdOrder - b.createdOrder : b.createdOrder - a.createdOrder));
  }
  const total = issues.length;
  const pageItems = paginate(issues, page, perPage);
  json(res, 200, pageItems.map((issue) => issueJson(repo, issue)), linkHeader(`${ctx.origin}/api/v3/repos/${params.owner}/${params.repo}/issues`, page, perPage, total));
});

route('POST', '/api/v3/repos/:owner/:repo/issues', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const title = str(body.title);
  if (title === undefined || title === '') {
    err(res, 422, 'title is required');
    return;
  }
  const labelNames: string[] = Array.isArray(body.labels)
    ? (body.labels as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
  const created = createIssueInRepo(repo, { title, body: str(body.body) ?? '', labels: labelNames });
  if ('error' in created) {
    err(res, 422, created.error);
    return;
  }
  json(res, 201, issueJson(repo, created.issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  json(res, 200, issueJson(repo, issue));
});

route('PATCH', '/api/v3/repos/:owner/:repo/issues/:number', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const body = bodyObj(ctx);
  const title = str(body.title);
  if (title !== undefined) issue.title = title;
  const bodyText = str(body.body);
  if (bodyText !== undefined) issue.body = bodyText;
  const state = str(body.state);
  if (state === 'closed' || state === 'open') {
    issue.state = state;
    issue.closedAt = state === 'closed' ? repo.store.nowIso() : null;
  }
  if (Array.isArray(body.labels)) {
    const labelNames = (body.labels as unknown[]).filter((item): item is string => typeof item === 'string');
    for (const name of labelNames) {
      if (!repo.labels.has(name)) {
        err(res, 422, `Label '${name}' does not exist`);
        return;
      }
    }
    issue.labels = labelNames;
  }
  issue.updatedAt = repo.store.nowIso();
  json(res, 200, issueJson(repo, issue));
});

route('GET', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  json(res, 200, issue.comments.map((comment) => ({
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: 'viewer', id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
  })));
});

route('POST', '/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const issue = repo.issues.get(Number(params.number));
  if (issue === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const body = bodyObj(ctx);
  const text = str(body.body);
  if (text === undefined || text === '') {
    err(res, 422, 'body is required');
    return;
  }
  const comment = {
    id: issue.nextCommentId++,
    nodeId: repo.store.gid('IssueComment', repo.id, issue.number, issue.nextCommentId - 1),
    body: text,
    createdAt: repo.store.nowIso(),
    updatedAt: repo.store.nowIso(),
  };
  issue.comments.push(comment);
  json(res, 201, {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: { login: 'viewer', id: 1000, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: '',
  });
});

// ---------------------------------------------------------------- pulls

export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = baseTreeOid !== null ? flattenTree(objects, baseTreeOid) : new Map<string, { mode: string; oid: string }>();
  const head = headTreeOid !== null ? flattenTree(objects, headTreeOid) : new Map<string, { mode: string; oid: string }>();
  const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const baseEntry = base.get(path);
    const headEntry = head.get(path);
    if (baseEntry === undefined && headEntry !== undefined) {
      if (headEntry.mode === '40000') continue;
      const blob = objects.get(headEntry.oid);
      const additions = blob !== undefined && blob.type === 'blob' ? lineCounts(blob.data.toString('utf8')) : 0;
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (baseEntry !== undefined && headEntry === undefined) {
      if (baseEntry.mode === '40000') continue;
      const blob = objects.get(baseEntry.oid);
      const deletions = blob !== undefined && blob.type === 'blob' ? lineCounts(blob.data.toString('utf8')) : 0;
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid !== headEntry.oid) {
      if (headEntry.mode === '40000' || baseEntry.mode === '40000') continue;
      const oldBlob = objects.get(baseEntry.oid);
      const newBlob = objects.get(headEntry.oid);
      const oldText = oldBlob !== undefined && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
      const newText = newBlob !== undefined && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** The best common ancestor of two commits (the merge base), or null. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = collectReachable(objects, [a]);
  const queue = [b];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj !== undefined && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

route('GET', '/api/v3/repos/:owner/:repo/pulls', (ctx, res, params, query) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const state = query.get('state') ?? 'open';
  const { page, perPage } = parsePagination(query);
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
  pulls.sort((a, b) => b.createdOrder - a.createdOrder);
  const total = pulls.length;
  const pageItems = paginate(pulls, page, perPage);
  json(res, 200, pageItems.map((pr) => pullJson(repo, pr)), linkHeader(`${ctx.origin}/api/v3/repos/${params.owner}/${params.repo}/pulls`, page, perPage, total));
});

route('POST', '/api/v3/repos/:owner/:repo/pulls', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const body = bodyObj(ctx);
  const head = str(body.head);
  const base = str(body.base);
  const title = str(body.title);
  if (head === undefined || base === undefined || title === undefined || title === '') {
    err(res, 422, 'head, base and title are required');
    return;
  }
  const created = createPullInRepo(repo, { head, base, title, body: str(body.body) ?? '' });
  if ('error' in created) {
    err(res, 422, created.error);
    return;
  }
  json(res, 201, pullJson(repo, created.pr));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const pr = repo.pulls.get(Number(params.number));
  if (pr === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  json(res, 200, pullJson(repo, pr));
});

route('GET', '/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const pr = repo.pulls.get(Number(params.number));
  if (pr === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const baseTree = treeForCommit(repo.objects, pr.baseSha);
  const headTree = treeForCommit(repo.objects, pr.headSha);
  const files = diffTrees(repo.objects, baseTree, headTree);
  json(res, 200, files.map((file) => ({
    sha: '',
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
    patch: '',
  })));
});

route('PUT', '/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx, res, params) => {
  const repo = getRepoOr404(ctx, res, params.owner as string, params.repo as string);
  if (repo === null) return;
  const pr = repo.pulls.get(Number(params.number));
  if (pr === undefined) {
    err(res, 404, 'Not Found');
    return;
  }
  const body = bodyObj(ctx);
  void str(body.merge_method);
  const result = performMerge(repo, pr);
  if (result.status === 'conflict') {
    err(res, 405, 'Merge conflict');
    return;
  }
  if (result.status === 'error') {
    err(res, result.message === 'Pull request already merged' ? 409 : 422, result.message);
    return;
  }
  json(res, 200, { merged: true, sha: result.sha, message: `Merged pull request #${pr.number}` });
});

// ---------------------------------------------------------------- dispatch

/** Dispatch a REST request. Returns true when the path was under /api/v3. */
export function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): boolean {
  let path = '/';
  let query = new URLSearchParams();
  let rawUrl = '/api/v3/';
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    path = url.pathname;
    query = url.searchParams;
    rawUrl = req.url ?? '/api/v3/';
  } catch {
    return false;
  }
  if (!path.startsWith('/api/v3')) return false;
  // Decode %2F inside a contents path so `:path` matches slashes.
  const decodedPath = path.replace(/%2F/gi, '/');
  for (const entry of handlers) {
    if (entry.method !== req.method) continue;
    const match = entry.pattern.exec(decodedPath);
    if (match === null) continue;
    const params: Record<string, string> = {};
    entry.keys.forEach((key, index) => {
      params[key] = match[index + 1] as string;
    });
    // The contents routes need the raw remainder after /contents/ (slashes included).
    if (entry.pattern.source.includes('contents')) {
      const marker = '/contents/';
      const idx = decodedPath.indexOf(marker);
      if (idx >= 0) params.path = decodedPath.slice(idx + marker.length);
    }
    void rawUrl;
    entry.handler(ctx, res, params, query);
    return true;
  }
  err(res, 404, 'Not Found');
  return true;
}
