// A small GraphQL executor covering the documents gh and github-mcp-server send to
// GitHub's v4 API: viewer, repository fields, issue/pull connections with cursor
// pagination, the create/close/merge mutations, node(id:) round-trips, and the
// introspection probes those clients feature-detect with. It resolves against the
// same in-memory forge the REST surface serves, so an object created through one
// surface reads identically through the other.

import type { Forge, IssueRec, RepoRec } from './forge.ts';
import { VIEWER, diffTrees } from './forge.ts';
import { globalId, mergeBase, mergePull, mergedTree } from './api.ts';
import { resolveCommit } from './git.ts';

// ------------------------------------------------------------------ syntax

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'obj'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  name: string;
  alias?: string;
  args: Array<{ name: string; value: Value }>;
  selection?: FieldNode[];
  fragmentSpread?: string;
  inlineOn?: string;
}

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selection: FieldNode[];
}

interface Fragment {
  on: string;
  selection: FieldNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:$!@='.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        tokens.push(`"${src.slice(i + 3, end === -1 ? src.length : end)}"`);
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)) ?? /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;
  constructor(src: string) {
    this.tokens = tokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const t = this.tokens[this.pos];
    this.pos += 1;
    if (t === undefined) throw new Error('unexpected end of GraphQL document');
    return t;
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }
  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.tokens.length) {
      const head = this.peek() as string;
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') {
          name = this.next();
        }
        if (this.peek() === '(') this.skipBalanced();
        // Directives on the operation are skipped.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipBalanced();
        }
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const on = this.next();
        fragments.set(fragName, { on, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head} at document level`);
      }
    }
    return { operations, fragments };
  }
  skipBalanced(): void {
    let depth = 0;
    do {
      const t = this.next();
      if (t === '(' || t === '{' || t === '[') depth += 1;
      else if (t === ')' || t === '}' || t === ']') depth -= 1;
    } while (depth > 0);
  }
  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const on = this.next();
        return { name: '', inlineOn: on, selection: this.parseSelectionSet() };
      }
      return { name: '', fragmentSpread: this.next() };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: FieldNode['args'] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    return { name, alias, args, selection };
  }
  parseValue(): Value {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t.startsWith('"')) return { kind: 'str', value: t.slice(1, -1) };
    if (t === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const fieldName = this.next();
        this.expect(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'obj', fields };
    }
    if (t === 'true' || t === 'false') return { kind: 'bool', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d/.test(t)) return { kind: 'num', value: Number(t) };
    return { kind: 'enum', value: t };
  }
}

function valueOf(v: Value, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'str': return v.value;
    case 'num': return v.value;
    case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => valueOf(i, vars));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = valueOf(f.value, vars);
      return out;
    }
  }
}

// ------------------------------------------------------------------ values

/** A GraphQL object: a type name plus a bag of resolvable fields. */
class GObj {
  readonly type: string;
  readonly data: Record<string, unknown>;
  constructor(type: string, data: Record<string, unknown>) {
    this.type = type;
    this.data = data;
  }
}

type Ctx = {
  forge: Forge;
  vars: Record<string, unknown>;
  fragments: Map<string, Fragment>;
  errors: Array<{ message: string }>;
};

function userObj(): GObj {
  return new GObj('User', { login: VIEWER.login, id: globalId('User', VIEWER.id), databaseId: VIEWER.id, name: VIEWER.name, email: VIEWER.email });
}

function repoObj(forge: Forge, repo: RepoRec): GObj {
  const tip = forge.branchTip(repo, repo.defaultBranch);
  return new GObj('Repository', {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObj(),
    description: repo.description,
    isPrivate: repo.isPrivate,
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    hasWikiEnabled: true,
    viewerPermission: 'ADMIN',
    url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    defaultBranchRef: tip === undefined
      ? null
      : new GObj('Ref', {
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target: new GObj('Commit', { oid: tip, id: globalId('Commit', 0) + tip.slice(0, 8) }),
      }),
    _repo: repo,
  });
}

function issueObj(forge: Forge, repo: RepoRec, item: IssueRec): GObj {
  return new GObj('Issue', {
    id: globalId('Issue', item.id),
    databaseId: item.id,
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    bodyText: item.body ?? '',
    state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
    url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}`,
    author: userObj(),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
    repository: repoObj(forge, repo),
    _item: item,
    _repo: repo,
  });
}

function pullObj(forge: Forge, repo: RepoRec, item: IssueRec): GObj {
  const headTip = forge.branchTip(repo, item.headRef);
  const baseTip = forge.branchTip(repo, item.baseRef);
  const mergeable = item.merged ? 'MERGEABLE' : mergedTree(forge, repo, item) !== null ? 'MERGEABLE' : 'CONFLICTING';
  return new GObj('PullRequest', {
    id: globalId('PullRequest', item.id),
    databaseId: item.id,
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    bodyText: item.body ?? '',
    state: item.merged ? 'MERGED' : item.state === 'closed' ? 'CLOSED' : 'OPEN',
    merged: item.merged,
    mergedAt: item.mergedAt,
    mergeable,
    isDraft: false,
    headRefName: item.headRef,
    baseRefName: item.baseRef,
    headRefOid: headTip ?? null,
    baseRefOid: baseTip ?? null,
    url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${item.number}`,
    author: userObj(),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt,
    repository: repoObj(forge, repo),
    mergeCommit: item.mergeCommitSha === null ? null : new GObj('Commit', { oid: item.mergeCommitSha, id: globalId('Commit', 0) + item.mergeCommitSha.slice(0, 8) }),
    _item: item,
    _repo: repo,
  });
}

function connection(nodes: GObj[], args: Record<string, unknown>): GObj {
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : nodes.length;
  const after = typeof args['after'] === 'string' ? decodeCursor(args['after'] as string) : 0;
  const slice = nodes.slice(after, after + first);
  const edges = slice.map((node, i) => new GObj('Edge', { cursor: encodeCursor(after + i + 1), node }));
  return new GObj('Connection', {
    totalCount: nodes.length,
    nodes: slice,
    edges,
    pageInfo: new GObj('PageInfo', {
      hasNextPage: after + slice.length < nodes.length,
      hasPreviousPage: after > 0,
      startCursor: edges.length > 0 ? encodeCursor(after + 1) : null,
      endCursor: edges.length > 0 ? encodeCursor(after + slice.length) : null,
    }),
  });
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const n = parseInt(text.replace('cursor:', ''), 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------------ execution

function decodeGlobalId(id: string): { type: string; num: number } | undefined {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (match === null) return undefined;
    return { type: match[1] as string, num: parseInt(match[2] as string, 10) };
  } catch {
    return undefined;
  }
}

function findItem(forge: Forge, num: number): { repo: RepoRec; item: IssueRec } | undefined {
  for (const repo of forge.listRepos(VIEWER.login)) {
    for (const item of repo.items.values()) {
      if (item.id === num) return { repo, item };
    }
  }
  return undefined;
}

function commentGObj(repo: RepoRec, item: IssueRec, comment: { id: number; body: string; createdAt: string; updatedAt: string }): GObj {
  return new GObj('IssueComment', {
    id: globalId('IssueComment', comment.id),
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    author: userObj(),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
  });
}

function orderIssues(items: IssueRec[], args: Record<string, unknown>): IssueRec[] {
  const orderBy = (args['orderBy'] ?? {}) as Record<string, unknown>;
  const direction = typeof orderBy['direction'] === 'string' ? (orderBy['direction'] as string) : 'DESC';
  const sorted = [...items].sort((a, b) => (a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1));
  if (direction !== 'ASC') sorted.reverse();
  return sorted;
}

function stateFilter(items: IssueRec[], args: Record<string, unknown>, kind: 'issue' | 'pull'): IssueRec[] {
  const states = Array.isArray(args['states']) ? (args['states'] as unknown[]).map(String) : undefined;
  if (states === undefined) return items;
  return items.filter((i) => {
    const state = kind === 'pull' && i.merged ? 'MERGED' : i.state === 'closed' ? 'CLOSED' : 'OPEN';
    return states.includes(state);
  });
}

function resolveRaw(ctx: Ctx, obj: GObj, field: string, args: Record<string, unknown>): { found: boolean; value: unknown } {
  const forge = ctx.forge;
  if (Object.prototype.hasOwnProperty.call(obj.data, field)) {
    const raw = obj.data[field];
    return { found: true, value: typeof raw === 'function' ? (raw as (a: Record<string, unknown>, c: Ctx) => unknown)(args, ctx) : raw };
  }
  if (obj.type === 'Repository') {
    const repo = obj.data['_repo'] as RepoRec;
    if (field === 'issue') {
      const item = repo.items.get(Number(args['number']));
      return { found: true, value: item !== undefined && item.kind === 'issue' ? issueObj(forge, repo, item) : null };
    }
    if (field === 'issues') {
      const items = stateFilter([...repo.items.values()].filter((i) => i.kind === 'issue'), args, 'issue');
      return { found: true, value: connection(orderIssues(items, args).map((i) => issueObj(forge, repo, i)), args) };
    }
    if (field === 'pullRequest') {
      const item = repo.items.get(Number(args['number']));
      return { found: true, value: item !== undefined && item.kind === 'pull' ? pullObj(forge, repo, item) : null };
    }
    if (field === 'pullRequests') {
      const items = stateFilter([...repo.items.values()].filter((i) => i.kind === 'pull'), args, 'pull');
      return { found: true, value: connection(orderIssues(items, args).map((i) => pullObj(forge, repo, i)), args) };
    }
    if (field === 'ref') {
      const qualified = String(args['qualifiedName'] ?? '');
      const branch = qualified.replace('refs/heads/', '');
      const tip = forge.branchTip(repo, branch);
      return {
        found: true,
        value: tip === undefined ? null : new GObj('Ref', { name: branch, prefix: 'refs/heads/', target: new GObj('Commit', { oid: tip, id: globalId('Commit', 0) + tip.slice(0, 8) }) }),
      };
    }
  }
  if (obj.type === 'Issue' || obj.type === 'PullRequest') {
    const item = obj.data['_item'] as IssueRec;
    const repo = obj.data['_repo'] as RepoRec;
    if (field === 'comments') {
      return { found: true, value: connection(item.comments.map((c) => commentGObj(repo, item, c)), args) };
    }
    if (field === 'labels') {
      const labels = item.labels
        .map((n) => forge.getLabel(repo, n))
        .filter((l) => l !== undefined)
        .map((l) => new GObj('Label', { id: globalId('Label', (l as { id: number }).id), name: (l as { name: string }).name, color: (l as { color: string }).color, description: (l as { description: string | null }).description }));
      return { found: true, value: connection(labels, args) };
    }
  }
  if (obj.type === 'PullRequest' && field === 'files') {
    const item = obj.data['_item'] as IssueRec;
    const repo = obj.data['_repo'] as RepoRec;
    const headTip = forge.branchTip(repo, item.headRef);
    const baseTip = forge.branchTip(repo, item.baseRef);
    if (headTip === undefined || baseTip === undefined) return { found: true, value: connection([], args) };
    const base = mergeBase(forge, headTip, baseTip) ?? baseTip;
    const files = diffTrees(forge, resolveCommit(forge.store, base)?.tree, resolveCommit(forge.store, headTip)?.tree).map((f) => new GObj('PullRequestChangedFile', {
      path: f.filename,
      additions: f.additions,
      deletions: f.deletions,
      changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED',
    }));
    return { found: true, value: connection(files, args) };
  }
  return { found: false, value: undefined };
}

function execSelection(ctx: Ctx, value: unknown, selection: FieldNode[] | undefined): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => execSelection(ctx, v, selection));
  if (value instanceof GObj) {
    if (selection === undefined) return value.data['id'] ?? null;
    const out: Record<string, unknown> = {};
    for (const field of selection) {
      if (field.fragmentSpread !== undefined) {
        const frag = ctx.fragments.get(field.fragmentSpread);
        if (frag !== undefined && (frag.on === value.type || frag.on === 'Node')) {
          Object.assign(out, execSelection(ctx, value, frag.selection) as Record<string, unknown>);
        }
        continue;
      }
      if (field.inlineOn !== undefined) {
        if (field.inlineOn === value.type || field.inlineOn === 'Node') {
          Object.assign(out, execSelection(ctx, value, field.selection ?? []) as Record<string, unknown>);
        }
        continue;
      }
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = value.type;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const a of field.args) args[a.name] = valueOf(a.value, ctx.vars);
      const resolved = resolveRaw(ctx, value, field.name, args);
      if (!resolved.found) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${value.type}'` });
        out[key] = null;
        continue;
      }
      out[key] = execSelection(ctx, resolved.value, field.selection);
    }
    return out;
  }
  return value;
}

// ------------------------------------------------------------------ introspection

const TYPE_FIELDS: Record<string, Array<[string, string]>> = {
  Issue: [
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['state', 'String'],
    ['body', 'String'], ['bodyText', 'String'], ['url', 'String'], ['author', 'User'], ['repository', 'Repository'],
    ['comments', 'Connection'], ['labels', 'Connection'], ['createdAt', 'String'], ['updatedAt', 'String'], ['closedAt', 'String'],
  ],
  PullRequest: [
    ['id', 'ID'], ['databaseId', 'Int'], ['number', 'Int'], ['title', 'String'], ['state', 'String'],
    ['body', 'String'], ['headRefName', 'String'], ['baseRefName', 'String'], ['headRefOid', 'String'], ['baseRefOid', 'String'],
    ['mergeable', 'String'], ['merged', 'Boolean'], ['mergedAt', 'String'], ['files', 'Connection'], ['comments', 'Connection'],
    ['author', 'User'], ['repository', 'Repository'], ['url', 'String'], ['createdAt', 'String'], ['updatedAt', 'String'], ['closedAt', 'String'],
    ['mergeCommit', 'Commit'], ['isDraft', 'Boolean'],
  ],
  Repository: [
    ['id', 'ID'], ['databaseId', 'Int'], ['name', 'String'], ['nameWithOwner', 'String'], ['owner', 'User'],
    ['defaultBranchRef', 'Ref'], ['viewerPermission', 'String'], ['hasIssuesEnabled', 'Boolean'], ['isPrivate', 'Boolean'],
    ['description', 'String'], ['issue', 'Issue'], ['issues', 'Connection'], ['pullRequest', 'PullRequest'], ['pullRequests', 'Connection'],
    ['url', 'String'], ['createdAt', 'String'], ['updatedAt', 'String'], ['ref', 'Ref'],
  ],
  User: [['id', 'ID'], ['databaseId', 'Int'], ['login', 'String'], ['name', 'String'], ['email', 'String'], ['url', 'String']],
  Ref: [['name', 'String'], ['prefix', 'String'], ['target', 'Commit']],
  Commit: [['id', 'ID'], ['oid', 'String'], ['message', 'String'], ['authoredDate', 'String']],
  Label: [['id', 'ID'], ['name', 'String'], ['color', 'String'], ['description', 'String']],
  IssueComment: [['id', 'ID'], ['databaseId', 'Int'], ['body', 'String'], ['author', 'User'], ['createdAt', 'String'], ['updatedAt', 'String'], ['url', 'String']],
  PageInfo: [['hasNextPage', 'Boolean'], ['hasPreviousPage', 'Boolean'], ['startCursor', 'String'], ['endCursor', 'String']],
  PullRequestChangedFile: [['path', 'String'], ['additions', 'Int'], ['deletions', 'Int'], ['changeType', 'String']],
  RateLimit: [['cost', 'Int'], ['limit', 'Int'], ['remaining', 'Int'], ['used', 'Int'], ['resetAt', 'String'], ['nodeCount', 'Int']],
};

function typeObject(name: string): GObj {
  if (name === 'SearchType') {
    return new GObj('__Type', {
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'].map((n) => new GObj('__EnumValue', { name: n, description: null, isDeprecated: false, deprecationReason: null })),
      inputFields: null,
      interfaces: [],
      possibleTypes: null,
    });
  }
  const fields = TYPE_FIELDS[name];
  return new GObj('__Type', {
    kind: 'OBJECT',
    name,
    description: null,
    fields: (fields ?? []).map(([fname, tname]) => new GObj('__Field', {
      name: fname,
      description: null,
      args: [],
      type: new GObj('__Type', { kind: ['Int', 'String', 'Boolean', 'ID', 'Float'].includes(tname) ? 'SCALAR' : 'OBJECT', name: tname, ofType: null, fields: null, enumValues: null, inputFields: null, interfaces: [], possibleTypes: null }),
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
  });
}

function schemaObject(): GObj {
  const names = [...Object.keys(TYPE_FIELDS), 'SearchType', 'Query', 'Mutation'];
  return new GObj('__Schema', {
    queryType: new GObj('__Type', { kind: 'OBJECT', name: 'Query', fields: null, enumValues: null, inputFields: null, interfaces: [], possibleTypes: null }),
    mutationType: new GObj('__Type', { kind: 'OBJECT', name: 'Mutation', fields: null, enumValues: null, inputFields: null, interfaces: [], possibleTypes: null }),
    subscriptionType: null,
    types: names.map((n) => typeObject(n)),
    directives: [],
  });
}

// ------------------------------------------------------------------ roots

function queryRoot(ctx: Ctx): GObj {
  const forge = ctx.forge;
  return new GObj('Query', {
    viewer: userObj(),
    rateLimit: new GObj('RateLimit', { cost: 1, limit: 5000, remaining: 4999, used: 1, resetAt: '2027-01-01T00:00:00Z', nodeCount: 0 }),
    repository: (args: Record<string, unknown>) => {
      const owner = String(args['owner'] ?? '');
      const name = String(args['name'] ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = forge.getRepo(owner, name);
      return repo === undefined ? null : repoObj(forge, repo);
    },
    node: (args: Record<string, unknown>) => {
      const decoded = decodeGlobalId(String(args['id'] ?? ''));
      if (decoded === undefined) return null;
      if (decoded.type === 'Repository') {
        const repo = forge.repoByNumericId(decoded.num);
        return repo === undefined ? null : repoObj(forge, repo);
      }
      if (decoded.type === 'User') return userObj();
      const found = findItem(forge, decoded.num);
      if (found === undefined) return null;
      return found.item.kind === 'pull' ? pullObj(forge, found.repo, found.item) : issueObj(forge, found.repo, found.item);
    },
    __type: (args: Record<string, unknown>) => typeObject(String(args['name'] ?? '')),
    __schema: schemaObject(),
  });
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args['input'];
  if (input !== null && typeof input === 'object') return input as Record<string, unknown>;
  return args;
}

function mutationRoot(ctx: Ctx): GObj {
  const forge = ctx.forge;
  return new GObj('Mutation', {
    createIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
      const repo = decoded === undefined ? undefined : forge.repoByNumericId(decoded.num);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const issue = forge.createIssue(repo, String(input['title'] ?? ''), typeof input['body'] === 'string' ? (input['body'] as string) : null, []);
      return new GObj('CreateIssuePayload', { issue: issueObj(forge, repo, issue), clientMutationId: input['clientMutationId'] ?? null });
    },
    closeIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['issueId'] ?? ''));
      const found = decoded === undefined ? undefined : findItem(forge, decoded.num);
      if (found === undefined) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.item.state = 'closed';
      found.item.closedAt = forge.tick().iso;
      found.item.updatedAt = found.item.closedAt;
      return new GObj('CloseIssuePayload', { issue: issueObj(forge, found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null });
    },
    reopenIssue: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['issueId'] ?? ''));
      const found = decoded === undefined ? undefined : findItem(forge, decoded.num);
      if (found === undefined) {
        ctx.errors.push({ message: 'Issue not found' });
        return null;
      }
      found.item.state = 'open';
      found.item.closedAt = null;
      found.item.updatedAt = forge.tick().iso;
      return new GObj('ReopenIssuePayload', { issue: issueObj(forge, found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null });
    },
    createPullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['repositoryId'] ?? ''));
      const repo = decoded === undefined ? undefined : forge.repoByNumericId(decoded.num);
      if (repo === undefined) {
        ctx.errors.push({ message: 'Repository not found' });
        return null;
      }
      const head = String(input['headRefName'] ?? '').replace('refs/heads/', '');
      const base = String(input['baseRefName'] ?? '').replace('refs/heads/', '');
      if (forge.branchTip(repo, head) === undefined || forge.branchTip(repo, base) === undefined) {
        ctx.errors.push({ message: 'Head or base ref does not exist' });
        return null;
      }
      const pull = forge.createPull(repo, String(input['title'] ?? ''), typeof input['body'] === 'string' ? (input['body'] as string) : null, head, base);
      return new GObj('CreatePullRequestPayload', { pullRequest: pullObj(forge, repo, pull), clientMutationId: input['clientMutationId'] ?? null });
    },
    mergePullRequest: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['pullRequestId'] ?? ''));
      const found = decoded === undefined ? undefined : findItem(forge, decoded.num);
      if (found === undefined || found.item.kind !== 'pull') {
        ctx.errors.push({ message: 'Pull request not found' });
        return null;
      }
      const methodRaw = typeof input['method'] === 'string' ? (input['method'] as string) : 'MERGE';
      const mergeMethod = methodRaw.toLowerCase() === 'squash' ? 'squash' : methodRaw.toLowerCase() === 'rebase' ? 'rebase' : 'merge';
      const result = mergePull(forge, found.repo, found.item, { merge_method: mergeMethod });
      if (result.status !== 200) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return new GObj('MergePullRequestPayload', { pullRequest: pullObj(forge, found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null });
      }
      return new GObj('MergePullRequestPayload', { pullRequest: pullObj(forge, found.repo, found.item), clientMutationId: input['clientMutationId'] ?? null });
    },
    addComment: (args: Record<string, unknown>) => {
      const input = inputOf(args);
      const decoded = decodeGlobalId(String(input['subjectId'] ?? ''));
      const found = decoded === undefined ? undefined : findItem(forge, decoded.num);
      if (found === undefined) {
        ctx.errors.push({ message: 'Subject not found' });
        return null;
      }
      const comment = forge.addComment(found.item, String(input['body'] ?? ''));
      const node = commentGObj(found.repo, found.item, comment);
      return new GObj('AddCommentPayload', {
        commentEdge: new GObj('IssueCommentEdge', { node, cursor: encodeCursor(found.item.comments.length) }),
        subject: found.item.kind === 'pull' ? pullObj(forge, found.repo, found.item) : issueObj(forge, found.repo, found.item),
        clientMutationId: input['clientMutationId'] ?? null,
      });
    },
  });
}

// ------------------------------------------------------------------ handler

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function executeOne(forge: Forge, payload: Record<string, unknown>): Record<string, unknown> {
  const queryText = typeof payload['query'] === 'string' ? (payload['query'] as string) : '';
  const vars = (payload['variables'] !== null && typeof payload['variables'] === 'object' ? payload['variables'] : {}) as Record<string, unknown>;
  const operationName = typeof payload['operationName'] === 'string' ? (payload['operationName'] as string) : undefined;
  let parsed: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    parsed = new Parser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const runOp = (op: Operation): Record<string, unknown> => {
    const ctx: Ctx = { forge, vars, fragments: parsed.fragments, errors: [] };
    const root = op.type === 'mutation' ? mutationRoot(ctx) : queryRoot(ctx);
    const data = execSelection(ctx, root, op.selection);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out['errors'] = ctx.errors;
    return out;
  };
  if (operationName !== undefined) {
    const op = parsed.operations.find((o) => o.name === operationName) ?? parsed.operations[0];
    return op === undefined ? { errors: [{ message: 'No operation found' }] } : runOp(op);
  }
  if (parsed.operations.length === 1) return runOp(parsed.operations[0] as Operation);
  if (parsed.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  // Several operation documents in one body: answer each, in order.
  return { __batch: parsed.operations.map(runOp) } as unknown as Record<string, unknown>;
}

export function handleGraphQL(forge: Forge, rawBody: string): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne(forge, (entry ?? {}) as Record<string, unknown>)) };
  }
  const single = executeOne(forge, (parsed ?? {}) as Record<string, unknown>);
  if (Array.isArray((single as Record<string, unknown>)['__batch'])) {
    return { status: 200, body: (single as Record<string, unknown>)['__batch'] };
  }
  return { status: 200, body: single };
}
