// GraphQL v4 surface: a small parser + executor covering exactly the schema
// surface the suite touches (the 18 documents in the kit's
// analysis/graphql-contract.md), plus __type/__schema introspection.
//
// Design notes:
// - Root fields: viewer, repository(owner, name), node(id), __type, __schema;
//   mutations createIssue / closeIssue / createPullRequest / mergePullRequest /
//   addComment. Mutations reuse the REST create/merge helpers, so effects are
//   visible over REST (and vice versa).
// - Global ids are the stored nodeIds (base64url "Kind:<numeric ids>"), opaque
//   and stable across reads; node(id:) decodes them back.
// - Issue state is OPEN/CLOSED (GraphQL spelling); PR state is OPEN/CLOSED/
//   MERGED; mergeable is computed on read from the same three-way check the
//   REST merge uses.
// - Unknown fields produce HTTP 200 + an errors array whose message names the
//   field literally (the invalid-field check looks for `noSuchFieldOnViewer`).
// - Connections paginate with opaque index cursors; `first` caps the page.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { ungid } from './store.ts';
import {
  createIssueInRepo,
  createPullInRepo,
  diffTrees,
  mergeConflicts,
  performMerge,
  treeForCommit,
} from './rest.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]!:=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push(/[.eE]/.test(text) ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL syntax error at offset ${i}: unexpected ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[] | null;
}
export interface FragmentSpreadSelection {
  kind: 'fragmentSpread';
  name: string;
}
export interface InlineFragmentSelection {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selections: Selection[];
}
export type Selection = FieldSelection | FragmentSpreadSelection | InlineFragmentSelection;

export interface VariableDefinition {
  name: string;
  defaultValue: unknown;
  hasDefault: boolean;
}

export interface Operation {
  kind: 'operation';
  operationType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinition[];
  selections: Selection[];
}

export interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`GraphQL syntax error: expected ${JSON.stringify(value)}, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`GraphQL syntax error: expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`GraphQL syntax error: expected ${value}, got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operationType: 'query',
          name: null,
          variableDefinitions: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, {
          kind: 'fragment',
          name,
          typeCondition,
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      const operationType = this.expectName();
      if (operationType !== 'query' && operationType !== 'mutation' && operationType !== 'subscription') {
        throw new Error(`GraphQL syntax error: unknown operation ${operationType}`);
      }
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      operations.push({
        kind: 'operation',
        operationType,
        name,
        variableDefinitions,
        selections: this.parseSelectionSet(),
      });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const defs: VariableDefinition[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: unknown = undefined;
        let hasDefault = false;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValueLiteral();
          hasDefault = true;
        }
        defs.push({ name, defaultValue, hasDefault });
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): unknown {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { __variable: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: unknown[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const obj: Record<string, unknown> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        obj[name] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    return this.parseValueLiteral();
  }

  private parseValueLiteral(): unknown {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return Number(token.value);
    if (token.kind === 'float') return Number(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    throw new Error(`GraphQL syntax error: unexpected value token ${token.value}`);
  }
}

function resolveVariables(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) return value.map((item) => resolveVariables(item, variables));
    const record = value as Record<string, unknown>;
    if ('__variable' in record) return variables[record.__variable as string] ?? null;
    if ('__enum' in record) return record.__enum as string;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) out[key] = resolveVariables(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- schema registry (for __type and validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'url', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'description', 'createdAt', 'updatedAt', 'url', 'isPrivate',
    'diskUsage', 'forkCount', 'stargazerCount',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt',
    'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository',
    'locked', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged',
    'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author',
    'repository', 'headRefOid', 'baseRefOid', 'createdAt', 'updatedAt',
    'closedAt', 'isDraft', 'additions', 'deletions', 'changedFiles',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'databaseId', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'possibleTypes'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrder: 'INPUT_OBJECT',
  CreateIssueInput: 'INPUT_OBJECT',
  CloseIssueInput: 'INPUT_OBJECT',
  CreatePullRequestInput: 'INPUT_OBJECT',
  MergePullRequestInput: 'INPUT_OBJECT',
  AddCommentInput: 'INPUT_OBJECT',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

/** The GraphQL type a field returns (for nested validation). */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User', defaultBranchRef: 'Ref', issues: 'IssueConnection', issue: 'Issue',
    pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest',
  },
  Issue: {
    author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository',
  },
  PullRequest: {
    author: 'User', files: 'PullRequestChangedFileConnection', repository: 'Repository',
  },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo' },
  IssueEdge: { node: 'Issue' },
  PullRequestEdge: { node: 'PullRequest' },
  LabelEdge: { node: 'Label' },
  IssueCommentEdge: { node: 'IssueComment' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  __Type: { fields: '__Field', enumValues: '__EnumValue', possibleTypes: '__Type' },
  __Field: { type: '__Type' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
};

// ---------------------------------------------------------------- wrapped values

interface Wrapped {
  __typename: string;
  _repo?: Repo;
  _issue?: Issue;
  _pr?: Pull;
  _typeName?: string;
  [key: string]: unknown;
}

function userObj(login: string): Wrapped {
  return {
    __typename: 'User',
    login,
    id: Buffer.from(`User:${login}`, 'utf8').toString('base64url'),
    databaseId: 1000,
    name: login,
    url: `https://github.com/${login}`,
    avatarUrl: '',
  };
}

function repoObj(repo: Repo): Wrapped {
  const owner = repo.owner ?? 'viewer';
  const headRef = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    owner: userObj(owner),
    defaultBranchRef: headRef !== undefined ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: `https://github.com/${owner}/${repo.name}`,
    isPrivate: repo.private,
    diskUsage: 0,
    forkCount: 0,
    stargazerCount: 0,
    _repo: repo,
  };
}

function issueObj(repo: Repo, issue: Issue): Wrapped {
  return {
    __typename: 'Issue',
    id: issue.nodeId,
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: userObj('viewer'),
    url: `https://github.com/x/${repo.name}/issues/${issue.number}`,
    locked: false,
    milestone: null,
    _repo: repo,
    _issue: issue,
  };
}

function pullObj(repo: Repo, pr: Pull): Wrapped {
  const conflicts = mergeConflicts(repo, pr);
  const mergeable = pr.merged ? 'MERGEABLE' : conflicts === null ? 'UNKNOWN' : conflicts ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __typename: 'PullRequest',
    id: pr.nodeId,
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergedAt: pr.mergedAt,
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable,
    headRefOid: pr.headSha,
    baseRefOid: pr.baseSha,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    author: userObj('viewer'),
    isDraft: false,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    _repo: repo,
    _pr: pr,
  };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match !== null ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface Connection {
  __typename: string;
  nodes: Wrapped[];
  edges: Array<{ __typename: string; node: Wrapped; cursor: string }>;
  pageInfo: { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function buildConnection(typeName: string, edgeType: string, items: Wrapped[], first: unknown, after: unknown): Connection {
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const idx = decodeCursor(after);
    if (idx !== null) start = idx + 1;
  }
  const limit = typeof first === 'number' && first >= 0 ? first : items.length;
  const slice = items.slice(start, start + limit);
  const edges = slice.map((node, i) => ({ __typename: edgeType, node, cursor: encodeCursor(start + i) }));
  return {
    __typename: typeName,
    nodes: slice,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDefinition>;
  errors: Array<{ message: string }>;
}

function resolveArgs(field: FieldSelection, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveVariables(value, ctx.variables);
  return out;
}

function typeFields(typeName: string): string[] {
  return TYPE_FIELDS[typeName] ?? [];
}

function fieldType(parentType: string, fieldName: string): string | null {
  return FIELD_TYPE[parentType]?.[fieldName] ?? null;
}

/** Execute a selection set against a wrapped value of the given type. */
function executeSelections(
  parentType: string,
  parentValue: Wrapped | null,
  selections: Selection[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (parentValue === null) return null;
  const out: Record<string, unknown> = {};
  let failed = false;
  // Fragment type conditions match the RUNTIME type of the value, not the
  // static field type (node() returns a Node whose runtime type is Repository).
  const runtimeType = parentValue.__typename ?? parentType;
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        failed = true;
        continue;
      }
      if (fragment.typeCondition !== runtimeType && fragment.typeCondition !== parentType) continue;
      const nested = executeSelections(fragment.typeCondition, parentValue, fragment.selections, ctx);
      if (nested === null) {
        failed = true;
        continue;
      }
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== runtimeType && selection.typeCondition !== parentType) continue;
      const nested = executeSelections(selection.typeCondition ?? parentType, parentValue, selection.selections, ctx);
      if (nested === null) {
        failed = true;
        continue;
      }
      Object.assign(out, nested);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = executeField(parentType, parentValue, selection, ctx);
    if (value === undefined) {
      // A field error was recorded; the field resolves to null and, for the
      // suite's purposes, the whole object is unusable.
      failed = true;
      out[key] = null;
      continue;
    }
    out[key] = value;
  }
  return failed ? null : out;
}

/**
 * Execute one field. Returns the resolved value, or `undefined` when the
 * field errored (an error entry was recorded).
 */
function executeField(
  parentType: string,
  parentValue: Wrapped,
  field: FieldSelection,
  ctx: ExecContext,
): unknown {
  const name = field.name;
  // Introspection meta-fields are valid on every type.
  if (name === '__typename') return parentType;
  if (!typeFields(parentType).includes(name) && !(parentType === 'Node' && name === 'id')) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return undefined;
  }
  const args = resolveArgs(field, ctx);
  const value = resolveField(parentType, parentValue, name, args, ctx);
  if (value === undefined) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return undefined;
  }
  if (field.selections === null) return value;
  const childType = fieldType(parentType, name);
  if (childType === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        return executeSelections(childType, item as Wrapped, field.selections as Selection[], ctx);
      }
      return item;
    });
  }
  if (value !== null && typeof value === 'object') {
    const nested = executeSelections(childType, value as Wrapped, field.selections as Selection[], ctx);
    if (nested === null) return undefined;
    return nested;
  }
  return value;
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function resolveNode(store: Store, id: string): Wrapped | null {
  const decoded = ungid(id);
  if (decoded === null) return null;
  const parts = decoded.parts.split(':');
  if (decoded.kind === 'Repository') {
    const repo = findRepoById(store, Number(parts[0]));
    return repo !== null ? repoObj(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const repo = findRepoById(store, Number(parts[0]));
    const issue = repo?.issues.get(Number(parts[1]));
    return repo !== undefined && repo !== null && issue !== undefined ? issueObj(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const repo = findRepoById(store, Number(parts[0]));
    const pr = repo?.pulls.get(Number(parts[1]));
    return repo !== undefined && repo !== null && pr !== undefined ? pullObj(repo, pr) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const repo = findRepoById(store, Number(parts[0]));
    const issue = repo?.issues.get(Number(parts[1]));
    const comment = issue?.comments.find((item) => item.id === Number(parts[2]));
    if (repo === null || repo === undefined || issue === undefined || comment === undefined) return null;
    return {
      __typename: 'IssueComment',
      id: comment.nodeId,
      databaseId: comment.id,
      body: comment.body,
      author: userObj('viewer'),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: '',
    };
  }
  return null;
}

function resolveField(
  parentType: string,
  parentValue: Wrapped,
  name: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
): unknown {
  const store = ctx.store;
  if (parentType === 'Query') {
    if (name === 'viewer') return userObj(store.viewerLogin());
    if (name === 'repository') {
      const repo = store.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo !== null ? repoObj(repo) : null;
    }
    if (name === 'node') {
      return typeof args.id === 'string' ? resolveNode(store, args.id) : null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (TYPE_FIELDS[typeName] === undefined && TYPE_KIND[typeName] === undefined && ENUM_VALUES[typeName] === undefined) return null;
      return { __typename: '__Type', _typeName: typeName };
    }
    if (name === '__schema') return { __typename: '__Schema' };
  }
  if (parentType === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? resolveNode(store, input.repositoryId) : null;
      if (repo === null || repo._repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve repository for createIssue.' });
        return undefined;
      }
      const labelNames: string[] = [];
      if (Array.isArray(input.labelIds)) {
        for (const labelId of input.labelIds) {
          if (typeof labelId !== 'string') continue;
          const decoded = ungid(labelId);
          if (decoded !== null && decoded.kind === 'Label') {
            const namePart = decoded.parts.split(':').slice(1).join(':');
            if (namePart !== '') labelNames.push(namePart);
          }
        }
      }
      const created = createIssueInRepo(repo._repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        labels: labelNames,
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return undefined;
      }
      return {
        __typename: 'CreateIssuePayload',
        issue: issueObj(repo._repo, created.issue),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = typeof input.issueId === 'string' ? resolveNode(store, input.issueId) : null;
      if (node === null || node._repo === undefined || node._issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve issue for closeIssue.' });
        return undefined;
      }
      node._issue.state = 'closed';
      node._issue.closedAt = node._repo.store.nowIso();
      node._issue.updatedAt = node._repo.store.nowIso();
      return {
        __typename: 'CloseIssuePayload',
        issue: issueObj(node._repo, node._issue),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? resolveNode(store, input.repositoryId) : null;
      if (repo === null || repo._repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve repository for createPullRequest.' });
        return undefined;
      }
      const created = createPullInRepo(repo._repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        return undefined;
      }
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullObj(repo._repo, created.pr),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = typeof input.pullRequestId === 'string' ? resolveNode(store, input.pullRequestId) : null;
      if (node === null || node._repo === undefined || node._pr === undefined) {
        ctx.errors.push({ message: 'Could not resolve pull request for mergePullRequest.' });
        return undefined;
      }
      const result = performMerge(node._repo, node._pr);
      if (result.status !== 'merged') {
        ctx.errors.push({ message: result.status === 'conflict' ? 'Merge conflict' : result.message });
        return undefined;
      }
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullObj(node._repo, node._pr),
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const node = typeof input.subjectId === 'string' ? resolveNode(store, input.subjectId) : null;
      if (node === null || node._repo === undefined || node._issue === undefined) {
        ctx.errors.push({ message: 'Could not resolve subject for addComment.' });
        return undefined;
      }
      const issue = node._issue;
      const repo = node._repo;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = {
        id: issue.nextCommentId++,
        nodeId: repo.store.gid('IssueComment', repo.id, issue.number, issue.nextCommentId - 1),
        body,
        createdAt: repo.store.nowIso(),
        updatedAt: repo.store.nowIso(),
      };
      issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: comment.nodeId,
            databaseId: comment.id,
            body: comment.body,
            author: userObj('viewer'),
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            url: '',
          },
          cursor: encodeCursor(issue.comments.length - 1),
        },
        clientMutationId: (input.clientMutationId as string | null) ?? null,
      };
    }
  }
  if (parentType === 'Repository') {
    const repo = parentValue._repo as Repo;
    if (name === 'issues') {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
      } else {
        issues = issues.filter((issue) => issue.state === 'open');
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => (a.createdOrder - b.createdOrder) * direction);
      return buildConnection('IssueConnection', 'IssueEdge', issues.map((issue) => issueObj(repo, issue)), args.first, args.after);
    }
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue !== undefined ? issueObj(repo, issue) : null;
    }
    if (name === 'pullRequests') {
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        pulls = pulls.filter((pr) => {
          const state = pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
          return states.includes(state);
        });
      } else {
        pulls = pulls.filter((pr) => pr.state === 'open');
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = orderBy.direction === 'ASC' ? 1 : -1;
      pulls.sort((a, b) => (a.createdOrder - b.createdOrder) * direction);
      return buildConnection('PullRequestConnection', 'PullRequestEdge', pulls.map((pr) => pullObj(repo, pr)), args.first, args.after);
    }
    if (name === 'pullRequest') {
      const pr = repo.pulls.get(Number(args.number));
      return pr !== undefined ? pullObj(repo, pr) : null;
    }
  }
  if (parentType === 'Issue') {
    const repo = parentValue._repo as Repo;
    const issue = parentValue._issue as Issue;
    if (name === 'labels') {
      const labels = issue.labels
        .map((labelName) => repo.labels.get(labelName))
        .filter((label) => label !== undefined)
        .map((label) => ({
          __typename: 'Label',
          id: (label as { nodeId: string }).nodeId,
          databaseId: (label as { id: number }).id,
          name: (label as { name: string }).name,
          color: (label as { color: string }).color,
          description: (label as { description: string }).description,
          url: '',
        }));
      return buildConnection('LabelConnection', 'LabelEdge', labels, args.first, args.after);
    }
    if (name === 'comments') {
      const comments = issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: comment.nodeId,
        databaseId: comment.id,
        body: comment.body,
        author: userObj('viewer'),
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: '',
      }));
      return buildConnection('IssueCommentConnection', 'IssueCommentEdge', comments, args.first, args.after);
    }
  }
  if (parentType === 'PullRequest') {
    const repo = parentValue._repo as Repo;
    const pr = parentValue._pr as Pull;
    if (name === 'files') {
      const baseTree = treeForCommit(repo.objects, pr.baseSha);
      const headTree = treeForCommit(repo.objects, pr.headSha);
      const files = diffTrees(repo.objects, baseTree, headTree).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return buildConnection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', files, args.first, args.after);
    }
  }
  if (parentType === '__Type') {
    const typeName = parentValue._typeName as string;
    if (name === 'name') return typeName;
    if (name === 'kind') return TYPE_KIND[typeName] ?? (ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT');
    if (name === 'description') return null;
    if (name === 'fields') {
      return typeFields(typeName).map((fieldName) => ({
        __typename: '__Field',
        name: fieldName,
        description: null,
        type: { __typename: '__Type', _typeName: fieldType(typeName, fieldName) ?? 'String' },
      }));
    }
    if (name === 'enumValues') {
      return (ENUM_VALUES[typeName] ?? []).map((value) => ({
        __typename: '__EnumValue',
        name: value,
        description: null,
      }));
    }
    if (name === 'possibleTypes') return [];
  }
  if (parentType === '__Field') {
    if (name === 'type') return parentValue.type as Wrapped;
  }
  if (parentType === '__Schema') {
    if (name === 'queryType') return { __typename: '__Type', _typeName: 'Query' };
    if (name === 'mutationType') return { __typename: '__Type', _typeName: 'Mutation' };
    if (name === 'description') return null;
    if (name === 'types') {
      const names = [...new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES), ...Object.keys(TYPE_KIND)])].sort();
      return names.map((typeName) => ({ __typename: '__Type', _typeName: typeName }));
    }
  }
  // Plain property on the wrapped value.
  return parentValue[name] ?? null;
}

// ---------------------------------------------------------------- entry point

function executeOne(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): Record<string, unknown> {
  let parsed: Document;
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL syntax error' }] };
  }
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = parsed.operations.find((item) => item.name === operationName);
  }
  if (operation === undefined) operation = parsed.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation found in document.' }] };
  }
  const ctx: ExecContext = { store, variables, fragments: parsed.fragments, errors: [] };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in ctx.variables) && def.hasDefault) ctx.variables[def.name] = def.defaultValue;
  }
  const rootType = operation.operationType === 'mutation' ? 'Mutation' : 'Query';
  const rootValue: Wrapped = { __typename: rootType };
  const data = executeSelections(rootType, rootValue, operation.selections, ctx);
  if (ctx.errors.length > 0) {
    return { data: data ?? null, errors: ctx.errors };
  }
  return { data };
}

/** Handle POST /api/graphql. Returns true when the path matched. */
export function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  body: Buffer,
): boolean {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return false;
  }
  if (req.method !== 'POST' || (path !== '/api/graphql' && path !== '/graphql')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ errors: [{ message: 'Request body is not valid JSON.' }] }));
    return true;
  }
  const send = (value: unknown): void => {
    const text = JSON.stringify(value);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  if (Array.isArray(parsed)) {
    send(parsed.map((item) => {
      const record = (item ?? {}) as Record<string, unknown>;
      return executeOne(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>, (record.operationName as string | null) ?? null);
    }));
    return true;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  send(executeOne(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>, (record.operationName as string | null) ?? null));
  return true;
}
