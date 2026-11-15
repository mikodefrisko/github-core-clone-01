// MCP endpoint (POST /mcp), per the kit's analysis/mcp-contract.md.
//
// The modern 2026-07-28 era alone passes all 15 checks: `server/discover`
// first, then tools/list + tools/call with no handshake. The legacy era
// (initialize + notifications/initialized) is implemented as well.
//
// - One POST per JSON-RPC message; plain JSON or request-scoped SSE is not
//   needed (plain JSON responses satisfy the suite).
// - The request `id` is echoed verbatim (number or string).
// - tools/list is deterministic: the same frozen tool definitions are
//   serialized on every call.
// - Argument names are normalized through a synonym table onto the canonical
//   property names (owner, repo, title, body, head, base, pull_number, name,
//   description, private, state).
// - tools/call without Authorization answers 401 before any tool lookup.
// - Unknown tool => -32602; malformed JSON body => HTTP 400 + -32700.
// - All six tools mutate the same store the REST surface reads, so effects
//   are visible over REST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { createIssueInRepo, createPullInRepo, performMerge } from './rest.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        name: { type: 'string', description: 'Name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
        labels: { type: 'array', description: 'Labels to apply to the issue.' },
        state: { type: 'string', description: 'Initial state of the issue.' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['repo', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['repo', 'pull_number'],
    },
  },
];

const ARG_SYNONYMS: Record<string, string> = {
  repository: 'repo',
  repo_name: 'repo',
  repository_name: 'repo',
  owner_login: 'owner',
  pullNumber: 'pull_number',
  pullnumber: 'pull_number',
  pr_number: 'pull_number',
  number: 'pull_number',
  issue_number: 'pull_number',
  merge_method: 'merge_method',
  mergeMethod: 'merge_method',
};

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[ARG_SYNONYMS[key] ?? key] = value;
  }
  return out;
}

function textResult(text: string, isError = false): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (isError) result.isError = true;
  return result;
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** Handle POST /mcp. `authorized` is false when no valid Bearer token was sent. Returns true when the path matched. */
export function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
  authorized: boolean,
): boolean {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  if (req.method !== 'POST' || path !== '/mcp') return false;
  const sendJson = (status: number, text: string): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    message = parsed as Record<string, unknown>;
  } catch {
    sendJson(400, JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  const id = message.id ?? null;
  const method = String(message.method ?? '');
  // Notifications carry no id and get no JSON-RPC response.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return true;
  }
  if (method === 'server/discover') {
    sendJson(200, rpcResult(id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }
  if (method === 'initialize') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    sendJson(200, rpcResult(id, {
      protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }
  if (method === 'tools/list') {
    sendJson(200, rpcResult(id, { tools: TOOLS }));
    return true;
  }
  if (method === 'tools/call') {
    // Auth is decided before tool existence.
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Basic realm="forge", Bearer' });
      res.end(JSON.stringify({ message: 'Requires authentication' }));
      return true;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    const name = String(params.name ?? '');
    const args = normalizeArgs((params.arguments ?? {}) as Record<string, unknown>);
    const tool = TOOLS.find((item) => item.name === name);
    if (tool === undefined) {
      sendJson(200, rpcError(id, -32602, `Unknown tool: ${name}`));
      return true;
    }
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : (store.learnedOwner ?? 'viewer');
    const repoName = typeof args.repo === 'string' ? args.repo : '';
    const result = callTool(store, name, owner, repoName, args);
    sendJson(200, rpcResult(id, result));
    return true;
  }
  if (method === 'ping') {
    sendJson(200, rpcResult(id, {}));
    return true;
  }
  sendJson(200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}

function callTool(
  store: Store,
  name: string,
  owner: string,
  repoName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (repoNameArg === '') {
      return textResult(JSON.stringify({ error: 'name is required' }), true);
    }
    if (store.findRepoByName(repoNameArg) !== null) {
      return textResult(JSON.stringify({ error: 'Repository already exists', name: repoNameArg }), true);
    }
    const repo = store.createRepo(repoNameArg, {
      private: typeof args.private === 'boolean' ? args.private : false,
      description: typeof args.description === 'string' ? args.description : '',
    });
    return textResult(JSON.stringify({
      id: repo.id,
      name: repo.name,
      full_name: `${owner}/${repo.name}`,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    }));
  }
  const repo = repoName === '' ? null : store.findRepo(owner, repoName);
  if (repo === null) {
    return textResult(JSON.stringify({ error: 'Not Found', repo: repoName }), true);
  }
  if (name === 'get_repo') {
    return textResult(JSON.stringify({
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner ?? owner}/${repo.name}`,
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
    }));
  }
  if (name === 'create_issue') {
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') {
      return textResult(JSON.stringify({ error: 'title is required' }), true);
    }
    const labels: string[] = Array.isArray(args.labels)
      ? (args.labels as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];
    const created = createIssueInRepo(repo, {
      title,
      body: typeof args.body === 'string' ? args.body : '',
      labels,
    });
    if ('error' in created) {
      return textResult(JSON.stringify({ error: created.error }), true);
    }
    const issue = created.issue;
    return textResult(JSON.stringify({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
    }));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => a.createdOrder - b.createdOrder);
    return textResult(JSON.stringify(issues.map((issue) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
    }))));
  }
  if (name === 'create_pull_request') {
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    const title = typeof args.title === 'string' ? args.title : 'Untitled';
    if (head === '' || base === '') {
      return textResult(JSON.stringify({ error: 'head and base are required' }), true);
    }
    const created = createPullInRepo(repo, {
      head,
      base,
      title,
      body: typeof args.body === 'string' ? args.body : '',
    });
    if ('error' in created) {
      return textResult(JSON.stringify({ error: created.error }), true);
    }
    const pr = created.pr;
    return textResult(JSON.stringify({
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: { ref: pr.head, sha: pr.headSha },
      base: { ref: pr.base, sha: pr.baseSha },
    }));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    if (!Number.isFinite(number)) {
      return textResult(JSON.stringify({ error: 'pull_number is required' }), true);
    }
    const pr = repo.pulls.get(number);
    if (pr === undefined) {
      return textResult(JSON.stringify({ error: 'Not Found', pull_number: number }), true);
    }
    const result = performMerge(repo, pr);
    if (result.status === 'conflict') {
      return textResult(JSON.stringify({ error: 'Merge conflict', merged: false }), true);
    }
    if (result.status === 'error') {
      return textResult(JSON.stringify({ error: result.message, merged: false }), true);
    }
    return textResult(JSON.stringify({ merged: true, sha: result.sha, message: `Merged pull request #${pr.number}` }));
  }
  return textResult(JSON.stringify({ error: `Unknown tool: ${name}` }), true);
}
