// The REST v3 surface of the forge, shaped after api.github.com: repositories and
// their contents, branches, commits, labels, issues, comments and pull requests.
// Handlers return {status, body} and never throw; app.ts turns that into a response
// (and adds the X-GitHub-Request-Id header every reply must carry).

import {
  blobAtPath,
  flattenTree,
  parseCommit,
  parseTree,
  peelToCommit,
  resolveCommit,
  updateTree,
  ZERO,
} from './git.ts';
import type { Forge, IssueRec, LabelRec, RepoRec } from './forge.ts';
import { VIEWER, diffTrees } from './forge.ts';

export interface ApiResult {
  status: number;
  body: unknown; // undefined means an empty body (204)
  headers?: Record<string, string>;
}

const NOT_FOUND: ApiResult = { status: 404, body: { message: 'Not Found' } };

export function userObject(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function globalId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function repoObject(repo: RepoRec, base: string): Record<string, unknown> {
  const openCount = [...repo.items.values()].filter((i) => i.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: userObject(),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://${base.replace(/^https?:\/\//, '')}/${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openCount,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    archived: false,
    disabled: false,
    license: null,
  };
}

function labelObject(repo: RepoRec, label: LabelRec, base: string): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueObject(forge: Forge, repo: RepoRec, item: IssueRec, base: string): Record<string, unknown> {
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const obj: Record<string, unknown> = {
    url: `${repoUrl}/issues/${item.number}`,
    repository_url: repoUrl,
    labels_url: `${repoUrl}/issues/${item.number}/labels{/name}`,
    comments_url: `${repoUrl}/issues/${item.number}/comments`,
    events_url: `${repoUrl}/issues/${item.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${item.number}`,
    id: item.id,
    node_id: globalId(item.kind === 'pull' ? 'PullRequest' : 'Issue', item.id),
    number: item.number,
    title: item.title,
    user: userObject(),
    labels: item.labels
      .map((name) => forge.getLabel(repo, name))
      .filter((l) => l !== undefined)
      .map((l) => labelObject(repo, l as LabelRec, base)),
    state: item.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    closed_at: item.closedAt,
    author_association: 'OWNER',
    body: item.body,
  };
  if (item.kind === 'pull') {
    obj['pull_request'] = {
      url: `${repoUrl}/pulls/${item.number}`,
      html_url: `${base}/${repo.owner}/${repo.name}/pull/${item.number}`,
      diff_url: `${base}/${repo.owner}/${repo.name}/pull/${item.number}.diff`,
      patch_url: `${base}/${repo.owner}/${repo.name}/pull/${item.number}.patch`,
      merged_at: item.mergedAt,
    };
  }
  return obj;
}

export function pullObject(forge: Forge, repo: RepoRec, item: IssueRec, base: string): Record<string, unknown> {
  const obj = issueObject(forge, repo, item, base);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const headSha = forge.branchTip(repo, item.headRef) ?? ZERO;
  const baseSha = forge.branchTip(repo, item.baseRef) ?? ZERO;
  const refObject = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userObject(),
    repo: repoObject(repo, base),
  });
  obj['url'] = `${repoUrl}/pulls/${item.number}`;
  obj['html_url'] = `${base}/${repo.owner}/${repo.name}/pull/${item.number}`;
  obj['diff_url'] = `${base}/${repo.owner}/${repo.name}/pull/${item.number}.diff`;
  obj['patch_url'] = `${base}/${repo.owner}/${repo.name}/pull/${item.number}.patch`;
  obj['merged_at'] = item.mergedAt;
  obj['merge_commit_sha'] = item.mergeCommitSha;
  obj['merged'] = item.merged;
  obj['draft'] = false;
  obj['head'] = refObject(item.headRef, headSha);
  obj['base'] = refObject(item.baseRef, baseSha);
  const mergeable = computeMergeable(forge, repo, item);
  obj['mergeable'] = mergeable;
  obj['mergeable_state'] = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
  obj['rebaseable'] = mergeable;
  obj['commits'] = 0;
  obj['additions'] = 0;
  obj['deletions'] = 0;
  obj['changed_files'] = 0;
  return obj;
}

/** The merge-base commit of two branch tips, by ancestor intersection. */
export function mergeBase(forge: Forge, a: string, b: string): string | undefined {
  const store = forge.store;
  const ancestorsA: string[] = [];
  const seen = new Set<string>();
  const queue = [peelToCommit(store, a)];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    ancestorsA.push(cur);
    const commit = resolveCommit(store, cur);
    if (commit !== undefined) queue.push(...commit.parents);
  }
  const ancestorsB = new Set<string>();
  const queueB = [peelToCommit(store, b)];
  while (queueB.length > 0) {
    const cur = queueB.shift() as string;
    if (ancestorsB.has(cur)) continue;
    ancestorsB.add(cur);
    const commit = resolveCommit(store, cur);
    if (commit !== undefined) queueB.push(...commit.parents);
  }
  return ancestorsA.find((sha) => ancestorsB.has(sha));
}

/**
 * Three-way, file-granularity merge of a pull's head into its base. Returns the merged
 * tree sha, or null when both sides changed the same file differently (a conflict).
 */
export function mergedTree(forge: Forge, repo: RepoRec, pull: IssueRec): string | null {
  const store = forge.store;
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) return null;
  const base = mergeBase(forge, headTip, baseTip);
  const originFlat = base === undefined ? new Map() : flattenTree(store, (resolveCommit(store, base)?.tree as string) ?? '');
  const baseFlat = flattenTree(store, resolveCommit(store, baseTip)?.tree as string);
  const headFlat = flattenTree(store, resolveCommit(store, headTip)?.tree as string);
  const paths = new Set([...originFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  let tree = resolveCommit(store, baseTip)?.tree as string;
  for (const path of paths) {
    const origin = originFlat.get(path)?.sha;
    const inBase = baseFlat.get(path)?.sha;
    const inHead = headFlat.get(path)?.sha;
    const baseChanged = inBase !== origin;
    const headChanged = inHead !== origin;
    if (baseChanged && headChanged && inBase !== inHead) return null;
    if (headChanged && inHead !== inBase) {
      const segments = path.split('/');
      tree = updateTree(store, tree, segments, inHead ?? null, headFlat.get(path)?.mode ?? '100644');
    }
  }
  return tree;
}

export function computeMergeable(forge: Forge, repo: RepoRec, pull: IssueRec): boolean | null {
  if (pull.state === 'closed') return pull.merged;
  try {
    return mergedTree(forge, repo, pull) !== null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ REST routing

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
  base: string;
}

function paginate<T>(req: RestRequest, items: T[], urlFor: (page: number, perPage: number) => string): ApiResult {
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1, perPage)}>; rel="next"`);
    links.push(`<${urlFor(totalPages, perPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(1, perPage)}>; rel="first"`);
    links.push(`<${urlFor(page - 1, perPage)}>; rel="prev"`);
  }
  return { status: 200, body: slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

function commitObject(forge: Forge, sha: string, base: string, repo: RepoRec): Record<string, unknown> {
  const commit = resolveCommit(forge.store, sha) as NonNullable<ReturnType<typeof resolveCommit>>;
  const person = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: line, email: '', date: repo.createdAt };
    return {
      name: match[1],
      email: match[2],
      date: new Date(parseInt(match[3] as string, 10) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha,
    node_id: globalId('Commit', 0) + sha.slice(0, 8),
    commit: {
      author: person(commit.authorLine),
      committer: person(commit.committerLine),
      message: commit.message,
      tree: { sha: commit.tree, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
    },
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: userObject(),
    committer: userObject(),
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`,
      html_url: `${base}/${repo.owner}/${repo.name}/commit/${p}`,
    })),
  };
}

function briefCommit(forge: Forge, repo: RepoRec, sha: string, base: string): Record<string, unknown> {
  const commit = resolveCommit(forge.store, sha) as NonNullable<ReturnType<typeof resolveCommit>>;
  return {
    sha,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { name: VIEWER.name, email: VIEWER.email },
    committer: { name: VIEWER.name, email: VIEWER.email },
    message: commit.message,
    tree: { sha: commit.tree, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
    parents: commit.parents.map((p) => ({ sha: p, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${p}` })),
  };
}

export function handleRest(forge: Forge, req: RestRequest): ApiResult {
  const seg = req.segments;
  const base = req.base;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: `${base}/api/v3/user`,
        current_user_repositories_url: `${base}/api/v3/user/repos`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
        issue_search_url: `${base}/api/v3/search/issues?q={query}`,
      },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return {
      status: 200,
      body: {
        installed_version: '1.0.0-forge',
        github_developer_version: 'v3',
        selected_actions_workflow_runs_url: null,
      },
    };
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return NOT_FOUND;
    return { status: 200, body: userObject() };
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER.login).map((r) => repoObject(r, base));
      return paginate(req, repos, (p, pp) => `${base}/api/v3/user/repos?page=${p}&per_page=${pp}`);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const name = typeof body['name'] === 'string' ? (body['name'] as string) : '';
      if (name === '') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] } };
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] } };
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        description: typeof body['description'] === 'string' ? (body['description'] as string) : null,
        isPrivate: body['private'] === true,
      });
      if (typeof body['default_branch'] === 'string' && body['default_branch'] !== '') {
        repo.defaultBranch = body['default_branch'] as string;
      }
      return { status: 201, body: repoObject(repo, base) };
    }
    return NOT_FOUND;
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    if (owner !== VIEWER.login) return NOT_FOUND;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) return NOT_FOUND;
    return handleRepo(forge, req, repo, seg.slice(3));
  }
  return NOT_FOUND;
}

function handleRepo(forge: Forge, req: RestRequest, repo: RepoRec, seg: string[]): ApiResult {
  const base = req.base;
  const method = req.method;
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;

  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, body: repoObject(repo, base) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body['description'] === 'string' || body['description'] === null) repo.description = body['description'] as string | null;
      if (typeof body['private'] === 'boolean') repo.isPrivate = body['private'] as boolean;
      if (typeof body['default_branch'] === 'string') repo.defaultBranch = body['default_branch'] as string;
      repo.updatedAt = forge.tick().iso;
      return { status: 200, body: repoObject(repo, base) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: undefined };
    }
    return NOT_FOUND;
  }

  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${repoUrl}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return paginate(req, branches, (p, pp) => `${repoUrl}/branches?page=${p}&per_page=${pp}`);
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const sha = forge.branchTip(repo, branch);
      if (sha === undefined) return NOT_FOUND;
      return {
        status: 200,
        body: {
          name: branch,
          commit: commitObject(forge, sha, base, repo),
          protected: false,
          _links: { self: `${repoUrl}/branches/${branch}`, html: `${base}/${repo.owner}/${repo.name}/tree/${branch}` },
        },
      };
    }
    return NOT_FOUND;
  }

  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const body = req.body ?? {};
      const ref = typeof body['ref'] === 'string' ? (body['ref'] as string) : '';
      const sha = typeof body['sha'] === 'string' ? (body['sha'] as string) : '';
      if (!ref.startsWith('refs/') || !forge.store.has(sha)) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'GitRef', field: 'sha', code: 'invalid' }] } };
      }
      if (repo.refs.has(ref)) return { status: 422, body: { message: 'Reference already exists' } };
      forge.setRef(repo, ref, sha);
      return {
        status: 201,
        body: {
          ref,
          node_id: globalId('GitRef', repo.id),
          url: `${repoUrl}/git/${ref}`,
          object: { type: forge.store.typeOf(sha) ?? 'commit', sha, url: `${repoUrl}/git/commits/${sha}` },
        },
      };
    }
    if (seg.length >= 3 && method === 'GET') {
      const ref = `refs/${seg.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return NOT_FOUND;
      return {
        status: 200,
        body: {
          ref,
          node_id: globalId('GitRef', repo.id),
          url: `${repoUrl}/git/${ref}`,
          object: { type: forge.store.typeOf(sha) ?? 'commit', sha, url: `${repoUrl}/git/commits/${sha}` },
        },
      };
    }
    if (seg.length >= 3 && method === 'DELETE') {
      const ref = `refs/${seg.slice(2).join('/')}`;
      if (!repo.refs.has(ref)) return NOT_FOUND;
      repo.refs.delete(ref);
      return { status: 204, body: undefined };
    }
    return NOT_FOUND;
  }

  if (seg[0] === 'commits') {
    if (seg.length === 1 && method === 'GET') {
      const refParam = req.query.get('sha') ?? repo.defaultBranch;
      let tip = forge.branchTip(repo, refParam);
      if (tip === undefined && forge.store.has(refParam)) tip = refParam;
      if (tip === undefined) return { status: 200, body: [] };
      const ordered: string[] = [];
      const seen = new Set<string>();
      const stack = [peelToCommit(forge.store, tip)];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        ordered.push(cur);
        const commit = resolveCommit(forge.store, cur);
        if (commit !== undefined) {
          for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
        }
      }
      const objects = ordered.map((sha) => commitObject(forge, sha, base, repo));
      return paginate(req, objects, (p, pp) => `${repoUrl}/commits?page=${p}&per_page=${pp}`);
    }
    if (seg.length === 2 && method === 'GET') {
      const sha = seg[1] as string;
      if (!forge.store.has(sha) || forge.store.typeOf(sha) !== 'commit') return NOT_FOUND;
      return { status: 200, body: commitObject(forge, sha, base, repo) };
    }
    return NOT_FOUND;
  }

  if (seg[0] === 'contents') {
    return handleContents(forge, req, repo, seg.slice(1));
  }

  if (seg[0] === 'labels') {
    if (seg.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id).map((l) => labelObject(repo, l, base));
        return paginate(req, labels, (p, pp) => `${repoUrl}/labels?page=${p}&per_page=${pp}`);
      }
      if (method === 'POST') {
        const body = req.body ?? {};
        const labelName = typeof body['name'] === 'string' ? (body['name'] as string) : '';
        if (labelName === '') return { status: 422, body: { message: 'Validation Failed' } };
        if (forge.getLabel(repo, labelName) !== undefined) {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }] } };
        }
        const color = (typeof body['color'] === 'string' ? (body['color'] as string) : 'ededed').replace(/^#/, '').toLowerCase();
        const label = forge.createLabel(repo, labelName, color, typeof body['description'] === 'string' ? (body['description'] as string) : null);
        return { status: 201, body: labelObject(repo, label, base) };
      }
      return NOT_FOUND;
    }
    if (seg.length === 2) {
      const label = forge.getLabel(repo, seg[1] as string);
      if (label === undefined) return NOT_FOUND;
      if (method === 'GET') return { status: 200, body: labelObject(repo, label, base) };
      if (method === 'DELETE') {
        repo.labels.delete(label.name.toLowerCase());
        return { status: 204, body: undefined };
      }
      return NOT_FOUND;
    }
    return NOT_FOUND;
  }

  if (seg[0] === 'issues') return handleIssues(forge, req, repo, seg.slice(1));
  if (seg[0] === 'pulls') return handlePulls(forge, req, repo, seg.slice(1));
  return NOT_FOUND;
}

function fileObject(forge: Forge, repo: RepoRec, path: string, sha: string, mode: string, base: string): Record<string, unknown> {
  const data = forge.store.get(sha)?.data ?? Buffer.alloc(0);
  const b64 = data.toString('base64');
  const wrapped = b64.replace(/(.{60})/g, '$1\n') + (b64.length % 60 === 0 && b64.length > 0 ? '' : b64.length > 0 ? '\n' : '');
  return {
    name: path.split('/').pop(),
    path,
    sha,
    size: data.length,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
    download_url: `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    type: 'file',
    encoding: 'base64',
    content: wrapped,
    mode,
    _links: {
      self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${sha}`,
      html: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function dirListing(forge: Forge, repo: RepoRec, treeSha: string, prefix: string, base: string): Record<string, unknown>[] {
  const obj = forge.store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = entry.mode === '40000';
    return {
      name: entry.name,
      path,
      sha: entry.sha,
      size: isDir ? 0 : (forge.store.get(entry.sha)?.data.length ?? 0),
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `${base}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`,
      download_url: isDir ? null : `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
      type: isDir ? 'dir' : 'file',
      _links: {
        self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`,
        html: `${base}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
      },
    };
  });
}

function handleContents(forge: Forge, req: RestRequest, repo: RepoRec, pathSegs: string[]): ApiResult {
  const base = req.base;
  const method = req.method;
  const body = req.body ?? {};
  const branch = (typeof body['branch'] === 'string' ? (body['branch'] as string) : undefined)
    ?? req.query.get('ref')
    ?? repo.defaultBranch;
  const path = pathSegs.join('/');

  if (method === 'GET') {
    const treeSha = forge.treeOfTip(repo, branch);
    if (treeSha === undefined) return NOT_FOUND;
    if (pathSegs.length === 0) return { status: 200, body: dirListing(forge, repo, treeSha, '', base) };
    // Navigate to the parent tree of the last segment.
    let cur = treeSha;
    for (let i = 0; i < pathSegs.length - 1; i += 1) {
      const obj = forge.store.get(cur);
      if (obj === undefined || obj.type !== 'tree') return NOT_FOUND;
      const entry = parseTree(obj.data).find((e) => e.name === pathSegs[i]);
      if (entry === undefined || entry.mode !== '40000') return NOT_FOUND;
      cur = entry.sha;
    }
    const parent = forge.store.get(cur);
    if (parent === undefined || parent.type !== 'tree') return NOT_FOUND;
    const entry = parseTree(parent.data).find((e) => e.name === pathSegs[pathSegs.length - 1]);
    if (entry === undefined) return NOT_FOUND;
    if (entry.mode === '40000') return { status: 200, body: dirListing(forge, repo, entry.sha, path, base) };
    return { status: 200, body: fileObject(forge, repo, path, entry.sha, entry.mode, base) };
  }

  if (method === 'PUT') {
    if (pathSegs.length === 0) return NOT_FOUND;
    const contentB64 = typeof body['content'] === 'string' ? (body['content'] as string) : '';
    const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : `Create ${path}`;
    const treeSha = forge.treeOfTip(repo, branch);
    const existing = treeSha === undefined ? undefined : blobAtPath(forge.store, treeSha, pathSegs);
    const givenSha = typeof body['sha'] === 'string' ? (body['sha'] as string) : undefined;
    if (existing !== undefined) {
      if (givenSha !== existing.sha) return { status: 409, body: { message: `${path} does not match ${givenSha ?? ''}` } };
      const commitSha = forge.writeFile(repo, branch, path, content, message);
      return { status: 200, body: { content: fileObject(forge, repo, path, forge.store.put('blob', content), '100644', base), commit: briefCommit(forge, repo, commitSha, base) } };
    }
    if (givenSha !== undefined) return { status: 409, body: { message: `${path} does not match ${givenSha}` } };
    const commitSha = forge.writeFile(repo, branch, path, content, message);
    const blobSha = forge.store.put('blob', content);
    return { status: 201, body: { content: fileObject(forge, repo, path, blobSha, '100644', base), commit: briefCommit(forge, repo, commitSha, base) } };
  }

  if (method === 'DELETE') {
    if (pathSegs.length === 0) return NOT_FOUND;
    const treeSha = forge.treeOfTip(repo, branch);
    const existing = treeSha === undefined ? undefined : blobAtPath(forge.store, treeSha, pathSegs);
    if (existing === undefined) return NOT_FOUND;
    const givenSha = typeof body['sha'] === 'string' ? (body['sha'] as string) : undefined;
    if (givenSha !== undefined && givenSha !== existing.sha) {
      return { status: 409, body: { message: `${path} does not match ${givenSha}` } };
    }
    const message = typeof body['message'] === 'string' ? (body['message'] as string) : `Delete ${path}`;
    const commitSha = forge.writeFile(repo, branch, path, null, message);
    return { status: 200, body: { content: null, commit: briefCommit(forge, repo, commitSha, base) } };
  }

  return NOT_FOUND;
}

function commentObject(repo: RepoRec, item: IssueRec, comment: { id: number; body: string; createdAt: string; updatedAt: string }, base: string): Record<string, unknown> {
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    url: `${repoUrl}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${item.number}#issuecomment-${comment.id}`,
    issue_url: `${repoUrl}/issues/${item.number}`,
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    user: userObject(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    body: comment.body,
  };
}

function handleIssues(forge: Forge, req: RestRequest, repo: RepoRec, seg: string[]): ApiResult {
  const base = req.base;
  const method = req.method;
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;

  if (seg.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      const labelFilter = (req.query.get('labels') ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s !== '');
      let items = [...repo.items.values()].filter((i) => i.kind === 'issue');
      if (state !== 'all') items = items.filter((i) => i.state === state);
      if (labelFilter.length > 0) {
        items = items.filter((i) => labelFilter.every((lf) => i.labels.some((l) => l.toLowerCase() === lf)));
      }
      items.sort((a, b) => (a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1));
      if (direction !== 'asc') items.reverse();
      const objects = items.map((i) => issueObject(forge, repo, i, base));
      return paginate(req, objects, (p, pp) => `${repoUrl}/issues?page=${p}&per_page=${pp}`);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const title = typeof body['title'] === 'string' ? (body['title'] as string) : '';
      if (title === '') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] } };
      const labelNames = extractLabelNames(body['labels']);
      for (const name of labelNames) {
        if (forge.getLabel(repo, name) === undefined) {
          return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', value: name }] } };
        }
      }
      const issue = forge.createIssue(repo, title, typeof body['body'] === 'string' ? (body['body'] as string) : null, labelNames);
      return { status: 201, body: issueObject(forge, repo, issue, base) };
    }
    return NOT_FOUND;
  }

  const number = parseInt(seg[0] as string, 10);
  if (Number.isNaN(number)) return NOT_FOUND;
  const item = repo.items.get(number);
  if (item === undefined) return NOT_FOUND;

  if (seg.length === 1) {
    if (method === 'GET') return { status: 200, body: issueObject(forge, repo, item, base) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body['title'] === 'string') item.title = body['title'] as string;
      if (typeof body['body'] === 'string' || body['body'] === null) item.body = body['body'] as string | null;
      if (body['labels'] !== undefined) {
        const labelNames = extractLabelNames(body['labels']);
        for (const name of labelNames) {
          if (forge.getLabel(repo, name) === undefined) {
            return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', value: name }] } };
          }
        }
        item.labels = labelNames;
      }
      if (body['state'] === 'closed' || body['state'] === 'open') {
        item.state = body['state'] as 'closed' | 'open';
        item.closedAt = item.state === 'closed' ? forge.tick().iso : null;
      }
      item.updatedAt = forge.tick().iso;
      return { status: 200, body: issueObject(forge, repo, item, base) };
    }
    return NOT_FOUND;
  }

  if (seg.length === 2 && seg[1] === 'comments') {
    if (method === 'GET') {
      const objects = item.comments.map((c) => commentObject(repo, item, c, base));
      return paginate(req, objects, (p, pp) => `${repoUrl}/issues/${item.number}/comments?page=${p}&per_page=${pp}`);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const text = typeof body['body'] === 'string' ? (body['body'] as string) : '';
      if (text === '') return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] } };
      const comment = forge.addComment(item, text);
      return { status: 201, body: commentObject(repo, item, comment, base) };
    }
    return NOT_FOUND;
  }

  if (seg.length === 2 && seg[1] === 'labels') {
    if (method === 'POST') {
      const labelNames = extractLabelNames((req.body ?? {})['labels']);
      for (const name of labelNames) {
        if (forge.getLabel(repo, name) === undefined) return { status: 422, body: { message: 'Validation Failed' } };
        if (!item.labels.includes(name)) item.labels.push(name);
      }
      item.updatedAt = forge.tick().iso;
      return { status: 200, body: item.labels.map((n) => labelObject(repo, forge.getLabel(repo, n) as LabelRec, base)) };
    }
    if (method === 'DELETE') {
      item.labels = [];
      item.updatedAt = forge.tick().iso;
      return { status: 200, body: [] };
    }
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

function extractLabelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['name'] === 'string') {
      names.push((entry as Record<string, unknown>)['name'] as string);
    }
  }
  return names;
}

function handlePulls(forge: Forge, req: RestRequest, repo: RepoRec, seg: string[]): ApiResult {
  const base = req.base;
  const method = req.method;
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;

  if (seg.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let items = [...repo.items.values()].filter((i) => i.kind === 'pull');
      if (state !== 'all') items = items.filter((i) => i.state === state);
      items.sort((a, b) => (a.createdAt === b.createdAt ? a.number - b.number : a.createdAt < b.createdAt ? -1 : 1));
      if (direction !== 'asc') items.reverse();
      const objects = items.map((i) => pullObject(forge, repo, i, base));
      return paginate(req, objects, (p, pp) => `${repoUrl}/pulls?page=${p}&per_page=${pp}`);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const title = typeof body['title'] === 'string' ? (body['title'] as string) : '';
      let head = typeof body['head'] === 'string' ? (body['head'] as string) : '';
      if (head.includes(':')) head = head.split(':').slice(1).join(':');
      const baseBranch = typeof body['base'] === 'string' ? (body['base'] as string) : repo.defaultBranch;
      if (title === '' || head === '') {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'missing_field' }] } };
      }
      if (forge.branchTip(repo, head) === undefined) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } };
      }
      if (forge.branchTip(repo, baseBranch) === undefined) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] } };
      }
      if (head === baseBranch) {
        return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: 'head and base are the same' }] } };
      }
      const pull = forge.createPull(repo, title, typeof body['body'] === 'string' ? (body['body'] as string) : null, head, baseBranch);
      return { status: 201, body: pullObject(forge, repo, pull, base) };
    }
    return NOT_FOUND;
  }

  const number = parseInt(seg[0] as string, 10);
  if (Number.isNaN(number)) return NOT_FOUND;
  const item = repo.items.get(number);
  if (item === undefined || item.kind !== 'pull') return NOT_FOUND;

  if (seg.length === 1) {
    if (method === 'GET') return { status: 200, body: pullObject(forge, repo, item, base) };
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body['title'] === 'string') item.title = body['title'] as string;
      if (typeof body['body'] === 'string' || body['body'] === null) item.body = body['body'] as string | null;
      if (body['state'] === 'closed' || body['state'] === 'open') {
        item.state = body['state'] as 'closed' | 'open';
        item.closedAt = item.state === 'closed' ? forge.tick().iso : null;
      }
      item.updatedAt = forge.tick().iso;
      return { status: 200, body: pullObject(forge, repo, item, base) };
    }
    return NOT_FOUND;
  }

  if (seg.length === 2 && seg[1] === 'files' && method === 'GET') {
    const headTip = forge.branchTip(repo, item.headRef);
    const baseTip = forge.branchTip(repo, item.baseRef);
    if (headTip === undefined || baseTip === undefined) return { status: 200, body: [] };
    const base = mergeBase(forge, headTip, baseTip) ?? baseTip;
    const fromTree = resolveCommit(forge.store, base)?.tree;
    const toTree = resolveCommit(forge.store, headTip)?.tree;
    const files = diffTrees(forge, fromTree, toTree).map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.additions + f.deletions,
      blob_url: `${repoUrl}/git/blobs/${f.sha}`,
      raw_url: `${base}/${repo.owner}/${repo.name}/raw/${item.headRef}/${f.filename}`,
      contents_url: `${repoUrl}/contents/${f.filename}?ref=${item.headRef}`,
    }));
    return paginate(req, files, (p, pp) => `${repoUrl}/pulls/${item.number}/files?page=${p}&per_page=${pp}`);
  }

  if (seg.length === 2 && seg[1] === 'merged' && method === 'GET') {
    return item.merged ? { status: 204, body: undefined } : NOT_FOUND;
  }

  if (seg.length === 2 && seg[1] === 'merge' && method === 'PUT') {
    return mergePull(forge, repo, item, req.body ?? {});
  }

  return NOT_FOUND;
}

/** Perform a pull-request merge (squash by default contract, merge, or rebase-shaped). */
export function mergePull(forge: Forge, repo: RepoRec, pull: IssueRec, body: Record<string, unknown>): ApiResult {
  if (pull.merged || pull.state === 'closed') {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const headTip = forge.branchTip(repo, pull.headRef);
  const baseTip = forge.branchTip(repo, pull.baseRef);
  if (headTip === undefined || baseTip === undefined) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const base = mergeBase(forge, headTip, baseTip);
  if (base !== undefined && peelToCommit(forge.store, headTip) === base) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const tree = mergedTree(forge, repo, pull);
  if (tree === null) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const method = typeof body['merge_method'] === 'string' ? (body['merge_method'] as string) : 'merge';
  const commitTitle = typeof body['commit_title'] === 'string' ? (body['commit_title'] as string) : undefined;
  const commitMessage = typeof body['commit_message'] === 'string' ? (body['commit_message'] as string) : '';
  let message: string;
  if (method === 'squash') {
    message = commitTitle ?? `${pull.title} (#${pull.number})`;
    const extra = commitMessage !== '' ? commitMessage : (pull.body ?? '');
    if (extra !== '') message = `${message}\n\n${extra}`;
  } else {
    message = commitTitle ?? `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
    if (commitMessage !== '') message = `${message}\n\n${commitMessage}`;
  }
  const extraParents = method === 'merge' ? [peelToCommit(forge.store, headTip)] : [];
  const sha = forge.commitOnBranch(repo, pull.baseRef, tree, message, extraParents);
  const { iso } = forge.tick();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = iso;
  pull.closedAt = iso;
  pull.mergeCommitSha = sha;
  pull.updatedAt = iso;
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
}
