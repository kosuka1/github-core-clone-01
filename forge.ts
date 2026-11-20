// The forge's domain model: repositories, refs, issues, pull requests, labels and
// comments, all in memory over the shared git object store. Every timestamp comes from
// a deterministic counter clock, so two runs of the same request sequence produce the
// same bytes — the property the trial's live/replay comparison relies on.

import {
  ObjectStore,
  buildCommitData,
  flattenTree,
  parseCommit,
  peelToCommit,
  updateTree,
  ZERO,
} from './git.ts';

/** The login the trial's bearer <redacted> names (the suite scenario's viewer). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  kind: 'issue' | 'pull';
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  // pull-only fields
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  items: Map<number, IssueRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

const CLOCK_BASE_SEC = 1767225600; // 2026-01-01T00:00:00Z

export class Forge {
  readonly store = new ObjectStore();
  private repos = new Map<string, RepoRec>();
  private repoById = new Map<number, RepoRec>();
  private nextRepoId = 5001;
  private nextLabelId = 300001;
  private nextItemId = 100001;
  private nextCommentId = 200001;
  private clockSeq = 0;

  /** Deterministic clock: each call advances one second from a fixed base. */
  tick(): { epoch: number; iso: string } {
    const epoch = CLOCK_BASE_SEC + this.clockSeq;
    this.clockSeq += 1;
    return { epoch, iso: new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') };
  }

  identityLine(): string {
    const { epoch } = this.tick();
    return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
  }

  // ------------------------------------------------------------ repositories

  createRepo(owner: string, name: string, opts: { description?: string | null; isPrivate?: boolean }): RepoRec {
    const { iso } = this.tick();
    const repo: RepoRec = {
      id: this.nextRepoId,
      owner,
      name,
      description: opts.description ?? null,
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      createdAt: iso,
      updatedAt: iso,
    };
    this.nextRepoId += 1;
    this.repos.set(`${owner}/${name}`, repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  repoByNumericId(id: number): RepoRec | undefined {
    return this.repoById.get(id);
  }

  listRepos(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) return false;
    this.repos.delete(`${owner}/${name}`);
    this.repoById.delete(repo.id);
    return true;
  }

  // ------------------------------------------------------------ refs and commits

  headRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  tip(repo: RepoRec, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  setRef(repo: RepoRec, ref: string, sha: string): void {
    if (sha === ZERO) repo.refs.delete(ref);
    else repo.refs.set(ref, sha);
    repo.updatedAt = this.tick().iso;
  }

  /** Create a commit on a branch from a tree mutation and move the branch to it. */
  commitOnBranch(repo: RepoRec, branch: string, tree: string, message: string, extraParents: string[] = []): string {
    const ref = `refs/heads/${branch}`;
    const parent = repo.refs.get(ref);
    const parents = parent === undefined ? [...extraParents] : [parent, ...extraParents];
    const line = this.identityLine();
    const data = buildCommitData({ tree, parents, authorLine: line, committerLine: line, message });
    const sha = this.store.put('commit', data);
    repo.refs.set(ref, sha);
    repo.updatedAt = this.tick().iso;
    return sha;
  }

  /** The tree sha a branch tip carries, or undefined for an unborn branch. */
  treeOfTip(repo: RepoRec, branch: string): string | undefined {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return undefined;
    const obj = this.store.get(peelToCommit(this.store, tip));
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  // ------------------------------------------------------------ labels

  createLabel(repo: RepoRec, name: string, color: string, description: string | null): LabelRec {
    const label: LabelRec = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  getLabel(repo: RepoRec, name: string): LabelRec | undefined {
    return repo.labels.get(name.toLowerCase());
  }

  // ------------------------------------------------------------ issues and pulls

  createIssue(repo: RepoRec, title: string, body: string | null, labelNames: string[]): IssueRec {
    const { iso } = this.tick();
    const issue: IssueRec = {
      kind: 'issue',
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      userLogin: VIEWER.login,
      comments: [],
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      headRef: '',
      baseRef: '',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: RepoRec, title: string, body: string | null, headRef: string, baseRef: string): IssueRec {
    const { iso } = this.tick();
    const pull: IssueRec = {
      kind: 'pull',
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [],
      userLogin: VIEWER.login,
      comments: [],
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      headRef,
      baseRef,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  addComment(item: IssueRec, body: string): CommentRec {
    const { iso } = this.tick();
    const comment: CommentRec = {
      id: this.nextCommentId,
      body,
      userLogin: VIEWER.login,
      createdAt: iso,
      updatedAt: iso,
    };
    this.nextCommentId += 1;
    item.comments.push(comment);
    item.updatedAt = iso;
    return comment;
  }

  /** Write or delete one file on a branch, as the contents API does; returns the commit sha. */
  writeFile(repo: RepoRec, branch: string, path: string, content: Buffer | null, message: string): string {
    const baseTree = this.treeOfTip(repo, branch);
    const segments = path.split('/').filter((s) => s !== '');
    const blobSha = content === null ? null : this.store.put('blob', content);
    const newTree = updateTree(this.store, baseTree, segments, blobSha);
    return this.commitOnBranch(repo, branch, newTree, message);
  }
}

/** Line-level diff counts between two blob contents (LCS over lines). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Drop a shared trailing empty line produced by a final newline.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j]
        ? (dp[(i + 1) * (n + 1) + j + 1] as number) + 1
        : Math.max(dp[(i + 1) * (n + 1) + j] as number, dp[i * (n + 1) + j + 1] as number);
    }
  }
  const common = dp[0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The file-level diff between two trees: one entry per changed path. */
export function diffTrees(
  forge: Forge,
  baseTree: string | undefined,
  headTree: string | undefined,
): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; sha: string }> {
  const baseFlat = baseTree === undefined ? new Map() : flattenTree(forge.store, baseTree);
  const headFlat = headTree === undefined ? new Map() : flattenTree(forge.store, headTree);
  const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; sha: string }> = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.sha === after.sha) continue;
    const oldText = before === undefined ? '' : (forge.store.get(before.sha)?.data.toString('utf8') ?? '');
    const newText = after === undefined ? '' : (forge.store.get(after.sha)?.data.toString('utf8') ?? '');
    const counts = lineDiffCounts(oldText, newText);
    out.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      sha: after?.sha ?? before?.sha ?? ZERO,
    });
  }
  return out;
}
