// The forge's whole state, in memory: repositories, git objects and refs, issues,
// pull requests, labels and comments. One process, one store; the trial mounts the
// repository read-only and the entry may only write under /tmp, so nothing here
// touches the disk. All lookups are Maps; every entity a check can name is an
// object the checks themselves created through the API (the entry starts empty).
//
// Owner learning: the bearer token names the scenario viewer, but the token
// itself is an opaque `shpat_…` string that carries no login. The owner is
// therefore learned from the first request that names one (a git path
// /<owner>/<repo>.git/… or a REST /repos/<owner>/… path). Repositories created
// through POST /user/repos (which carries no owner) are stored owner-less until
// the first owner-named lookup adopts them; a lookup under any other owner is
// a 404, never a 403 (the foreign-token check).
//
// Determinism: timestamps come from MAKEFUN_TRIAL_NOW when set, plus a
// monotonic counter, so creation order == time order and created-sort works.
// No Math.random / UUIDs anywhere in responses.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdOrder: number;
  comments: Comment[];
  nextCommentId: number;
}

export interface Label {
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string;
  default: boolean;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** MERGEABLE | CONFLICTING | UNKNOWN, as GraphQL reports it. */
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdOrder: number;
}

export interface Repo {
  id: number;
  nodeId: string;
  /** The owner login, once learned; undefined while owner-less. */
  owner?: string;
  ownerId: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  createdOrder: number;
  /** git objects by lowercase 40-hex oid */
  objects: Map<string, GitObject>;
  /** ref name -> lowercase 40-hex oid, e.g. refs/heads/main */
  refs: Map<string, string>;
  headTarget: string;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextIssueId: number;
  nextPull: number;
  nextPullId: number;
  nextLabelId: number;
  store: Store;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The default label set GitHub seeds into every new repository. */
export const DEFAULT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'duplicate', color: 'cfd3d7', description: 'This issue or pull request already exists' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
  { name: 'invalid', color: 'e4e669', description: 'This doesn\'t seem right' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'wontfix', color: 'ffffff', description: 'This will not be worked on' },
];

/** Deterministic timestamps: the trial's opening time when present, else now. */
function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return Date.now();
}

export class Store {
  /** The login the token names, learned from the first owner-named request. */
  learnedOwner: string | null = null;
  /** Repositories by name (names are unique per account). */
  repos = new Map<string, Repo>();
  private repoIdSeq = 0;
  private entityIdSeq = 0;
  private orderSeq = 0;
  private timeSeq = 0;
  private readonly timeBase = trialNowMs();

  /** A strictly increasing ISO timestamp (creation order == time order). */
  nowIso(): string {
    this.timeSeq += 1;
    return new Date(this.timeBase + this.timeSeq * 1000).toISOString();
  }

  nowMs(): number {
    return this.timeBase + this.timeSeq * 1000;
  }

  nextOrder(): number {
    this.orderSeq += 1;
    return this.orderSeq;
  }

  nextId(): number {
    this.entityIdSeq += 1;
    return this.entityIdSeq;
  }

  /** Opaque, stable, decodable global id (GraphQL `id`, never a plain number). */
  gid(kind: string, ...parts: unknown[]): string {
    return gid(kind, parts.map((part) => String(part)).join(':'));
  }

  createRepo(name: string, opts: { private?: boolean; description?: string } = {}): Repo {
    this.repoIdSeq += 1;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.repoIdSeq,
      nodeId: this.gid('Repository', this.repoIdSeq),
      owner: undefined,
      ownerId: 1000,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      createdOrder: this.nextOrder(),
      objects: new Map(),
      refs: new Map(),
      headTarget: 'refs/heads/main',
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextIssueId: 1,
      nextPull: 1,
      nextPullId: 1,
      nextLabelId: 1,
      store: this,
    };
    // Labels are NOT seeded: the checks create the labels they use through
    // POST /labels and expect a 201, so a fresh repo starts with no labels.
    this.repos.set(name, repo);
    return repo;
  }

  /** Find a repository by name, whatever its owner is (duplicate detection). */
  findRepoByName(name: string): Repo | null {
    return this.repos.get(name) ?? null;
  }

  /**
   * Find a repository by owner and name. An owner-less repository is adopted
   * by the first owner-named lookup; a lookup under a different owner is a
   * miss (the caller answers 404). A name that does not exist is a miss.
   */
  findRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === undefined) {
      repo.owner = owner;
      if (this.learnedOwner === null) this.learnedOwner = owner;
      return repo;
    }
    return repo.owner === owner ? repo : null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  /** Repositories visible to the token owner, in creation order. */
  visibleRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === undefined || repo.owner === this.learnedOwner) out.push(repo);
    }
    out.sort((a, b) => a.createdOrder - b.createdOrder);
    return out;
  }

  /** The login GET /api/v3/user answers with. */
  viewerLogin(): string {
    return this.learnedOwner ?? 'viewer';
  }

  /** Learn the owner from a path segment (git and REST paths name it). */
  learnOwner(owner: string): void {
    if (this.learnedOwner === null && owner !== '') this.learnedOwner = owner;
  }
}

/** Opaque, stable, decodable global ids (GraphQL `id`, never a plain number). */
export function gid(kind: string, parts: string): string {
  return Buffer.from(`${kind}:${parts}`, 'utf8').toString('base64url');
}

export function ungid(id: string): { kind: string; parts: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), parts: text.slice(at + 1) };
  } catch {
    return null;
  }
}

export function repoGid(repo: Repo): string {
  return gid('Repository', `${repo.owner ?? ''}/${repo.name}`);
}

export function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.owner ?? ''}/${repo.name}#${issue.number}`);
}

export function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.owner ?? ''}/${repo.name}#${pull.number}`);
}

export function commentGid(repo: Repo, issueNumber: number, comment: Comment): string {
  return gid('IssueComment', `${repo.owner ?? ''}/${repo.name}#${issueNumber}:${comment.id}`);
}
