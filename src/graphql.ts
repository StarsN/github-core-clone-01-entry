// graphql.ts — a small GraphQL engine (lexer, parser, executor) plus the schema surface the suite
// exercises: viewer, repository, issues/pull-request connections with cursor pagination, the five
// mutations gh uses, Relay node(id:), and the __type introspection probes. No dependencies.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  repos,
  findRepo,
  branchTip,
  createIssue,
  createPull,
  addComment,
  mergePull,
  pullMergeable,
  pullFiles,
  globalId,
  parseGlobalId,
  type Repo,
  type Issue,
  type PullRequest,
} from './forge.ts';

// -------------------------------------------------------------------------------------------------
// Lexer and parser
// -------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

function parseDocument(source: string): Document {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expectPunct = (value: string): void => {
    const token = next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  };

  function parseValue(): Value {
    const token = next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = next();
      return { kind: 'var', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(peek().kind === 'punct' && peek().value === ']')) items.push(parseValue());
      next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!(peek().kind === 'punct' && peek().value === '}')) {
        const key = next();
        expectPunct(':');
        fields.set(key.value, parseValue());
      }
      next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  function parseSelectionSet(): SelectionNode[] {
    expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(peek().kind === 'punct' && peek().value === '}')) {
      if (peek().kind === 'spread') {
        next();
        const head = next();
        if (head.kind === 'name' && head.value === 'on') {
          const typeCondition = next().value;
          selections.push({ kind: 'inline', typeCondition, selectionSet: parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: head.value });
        }
        continue;
      }
      const first = next();
      let alias: string | null = null;
      let name = first.value;
      if (peek().kind === 'punct' && peek().value === ':') {
        next();
        alias = name;
        name = next().value;
      }
      const args = new Map<string, Value>();
      if (peek().kind === 'punct' && peek().value === '(') {
        next();
        while (!(peek().kind === 'punct' && peek().value === ')')) {
          const argName = next().value;
          expectPunct(':');
          args.set(argName, parseValue());
        }
        next();
      }
      // Directives (@include/@skip) are not used by the suite; skip them if present.
      while (peek().kind === 'punct' && peek().value === '@') {
        next();
        next();
        if (peek().kind === 'punct' && peek().value === '(') {
          let depth = 0;
          do {
            const token = next();
            if (token.kind === 'punct' && token.value === '(') depth += 1;
            if (token.kind === 'punct' && token.value === ')') depth -= 1;
          } while (depth > 0);
        }
      }
      const selectionSet = peek().kind === 'punct' && peek().value === '{' ? parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    next();
    return selections;
  }

  function skipVariableDefinitions(): void {
    if (!(peek().kind === 'punct' && peek().value === '(')) return;
    let depth = 0;
    do {
      const token = next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  const operations: Operation[] = [];
  const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
  while (peek().kind !== 'eof') {
    const head = peek();
    if (head.kind === 'punct' && head.value === '{') {
      operations.push({ type: 'query', name: null, selectionSet: parseSelectionSet() });
      continue;
    }
    if (head.kind !== 'name') throw new Error(`unexpected token ${head.value}`);
    if (head.value === 'query' || head.value === 'mutation' || head.value === 'subscription') {
      next();
      let name: string | null = null;
      if (peek().kind === 'name') name = next().value;
      skipVariableDefinitions();
      operations.push({ type: head.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: parseSelectionSet() });
      continue;
    }
    if (head.value === 'fragment') {
      next();
      const fragName = next().value;
      next(); // 'on'
      const typeCondition = next().value;
      fragments.set(fragName, { typeCondition, selectionSet: parseSelectionSet() });
      continue;
    }
    throw new Error(`unexpected definition ${head.value}`);
  }
  return { operations, fragments };
}

function coerce(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'literal':
      return value.value;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => coerce(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.fields) out[key] = coerce(entry, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Schema: introspection surface and resolvers
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'mergeCommit', 'mergedAt', 'createdAt', 'updatedAt',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

type Source = Record<string, unknown> & { __type: string };

const userSource = (): Source => ({ __type: 'User', login: VIEWER_LOGIN });
const repoSource = (repo: Repo): Source => ({ __type: 'Repository', repo });
const issueSource = (repo: Repo, issue: Issue): Source => ({ __type: 'Issue', repo, issue });
const pullSource = (repo: Repo, pull: PullRequest): Source => ({ __type: 'PullRequest', repo, pull });

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Document['fragments'];
  errors: Array<{ message: string }>;
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function connection<T>(items: T[], args: Record<string, unknown>, type: string): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const decoded = Number(Buffer.from(args.after, 'base64url').toString('utf8'));
    if (Number.isInteger(decoded) && decoded >= 0) start = decoded;
  }
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return {
    __type: type,
    nodes,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? Buffer.from(String(start + 1)).toString('base64url') : null,
      endCursor: nodes.length > 0 ? Buffer.from(String(end)).toString('base64url') : null,
    },
    totalCount: items.length,
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userSource(),
    repository: (_source, args) => {
      const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? findRepo(args.owner, args.name) : null;
      return repo === null ? null : repoSource(repo);
    },
    node: (_source, args) => {
      if (typeof args.id !== 'string') return null;
      const parsed = parseGlobalId(args.id);
      if (parsed === null) return null;
      if (parsed.kind === 'repo') {
        const id = Number(parsed.parts[0]);
        for (const repo of repoValues()) if (repo.id === id) return repoSource(repo);
      }
      return null;
    },
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoById(Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found for createIssue');
      const issue = createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      return { __type: 'CreateIssuePayload', issue: issueSource(repo, issue) };
    },
    closeIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const located = typeof input.issueId === 'string' ? locateIssue(input.issueId) : null;
      if (located === null) throw new Error('issue not found for closeIssue');
      located.issue.state = 'closed';
      located.issue.updatedAt = new Date().toISOString();
      return { __type: 'CloseIssuePayload', issue: issueSource(located.repo, located.issue) };
    },
    createPullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoById(Number(parsed.parts[0])) : null;
      if (repo === null) throw new Error('repository not found for createPullRequest');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTip(repo, head) === null) throw new Error(`head branch ${head} does not exist`);
      const pull = createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull) };
    },
    mergePullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const located = typeof input.pullRequestId === 'string' ? locatePull(input.pullRequestId) : null;
      if (located === null) throw new Error('pull request not found for mergePullRequest');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const outcome = mergePull(located.repo, located.pull, method);
      if (!outcome.ok) throw new Error('pull request is not mergeable');
      return { __type: 'MergePullRequestPayload', pullRequest: pullSource(located.repo, located.pull) };
    },
    addComment: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const parsed = parseGlobalId(subjectId);
      if (parsed === null || (parsed.kind !== 'issue' && parsed.kind !== 'pr')) throw new Error('subject not found for addComment');
      const repo = repoById(Number(parsed.parts[0]));
      if (repo === null) throw new Error('subject not found for addComment');
      const number = Number(parsed.parts[1]);
      const comment = addComment(repo, number, typeof input.body === 'string' ? input.body : '');
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'CommentEdge',
          node: { __type: 'IssueComment', id: globalId('comment', repo.id, number, comment.id), body: comment.body },
        },
      };
    },
  },
  User: {
    id: () => globalId('user', VIEWER_ID),
    login: () => VIEWER_LOGIN,
    name: () => 'ada iversen',
    email: () => 'adaiversen@example.invalid',
  },
  Repository: {
    id: (source) => globalId('repo', (source.repo as Repo).id),
    databaseId: (source) => (source.repo as Repo).id,
    name: (source) => (source.repo as Repo).name,
    nameWithOwner: (source) => `${VIEWER_LOGIN}/${(source.repo as Repo).name}`,
    description: (source) => (source.repo as Repo).description,
    isPrivate: (source) => (source.repo as Repo).isPrivate,
    owner: () => userSource(),
    defaultBranchRef: (source) => {
      const repo = source.repo as Repo;
      return branchTip(repo, 'main') !== null ? { __type: 'Ref', name: 'main' } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    issue: (source, args) => {
      const repo = source.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (source, args) => {
      const repo = source.repo as Repo;
      let issues = [...repo.issues.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const descending = orderBy.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      return connection(issues.map((issue) => issueSource(repo, issue)), args, 'IssueConnection');
    },
    pullRequest: (source, args) => {
      const repo = source.repo as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullSource(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = source.repo as Repo;
      let pulls = [...repo.pulls.values()];
      if (Array.isArray(args.states)) {
        const wanted = new Set((args.states as unknown[]).map((state) => String(state)));
        pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      }
      pulls.sort((a, b) => a.number - b.number);
      return connection(pulls.map((pull) => pullSource(repo, pull)), args, 'PullRequestConnection');
    },
  },
  Issue: {
    id: (source) => globalId('issue', (source.repo as Repo).id, (source.issue as Issue).number),
    number: (source) => (source.issue as Issue).number,
    title: (source) => (source.issue as Issue).title,
    body: (source) => (source.issue as Issue).body,
    state: (source) => (source.issue as Issue).state.toUpperCase(),
    author: () => userSource(),
    repository: (source) => repoSource(source.repo as Repo),
    createdAt: (source) => (source.issue as Issue).createdAt,
    updatedAt: (source) => (source.issue as Issue).updatedAt,
    closedAt: (source) => ((source.issue as Issue).state === 'closed' ? (source.issue as Issue).updatedAt : null),
  },
  PullRequest: {
    id: (source) => globalId('pr', (source.repo as Repo).id, (source.pull as PullRequest).number),
    number: (source) => (source.pull as PullRequest).number,
    title: (source) => (source.pull as PullRequest).title,
    body: (source) => (source.pull as PullRequest).body,
    state: (source) => {
      const pull = source.pull as PullRequest;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRequest).merged,
    mergeable: (source) => pullMergeable(source.repo as Repo, source.pull as PullRequest),
    headRefName: (source) => (source.pull as PullRequest).headRef,
    baseRefName: (source) => (source.pull as PullRequest).baseRef,
    headRef: (source) => ({ __type: 'Ref', name: (source.pull as PullRequest).headRef }),
    baseRef: (source) => ({ __type: 'Ref', name: (source.pull as PullRequest).baseRef }),
    author: () => userSource(),
    repository: (source) => repoSource(source.repo as Repo),
    mergedAt: (source) => (source.pull as PullRequest).mergedAt,
    createdAt: (source) => (source.pull as PullRequest).createdAt,
    updatedAt: (source) => (source.pull as PullRequest).updatedAt,
    files: (source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as PullRequest;
      const files = pullFiles(repo, pull).map((file) => ({
        __type: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status.toUpperCase(),
      }));
      return connection(files, args, 'PullRequestFileConnection');
    },
  },
};

function repoValues(): Repo[] {
  return [...repos.values()];
}

function repoById(id: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

function locateIssue(global: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(global);
  if (parsed === null || parsed.kind !== 'issue') return null;
  const repo = repoById(Number(parsed.parts[0]));
  if (repo === null) return null;
  const issue = repo.issues.get(Number(parsed.parts[1]));
  return issue === undefined ? null : { repo, issue };
}

function locatePull(global: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(global);
  if (parsed === null || parsed.kind !== 'pr') return null;
  const repo = repoById(Number(parsed.parts[0]));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number(parsed.parts[1]));
  return pull === undefined ? null : { repo, pull };
}

// -------------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------------

function typeDescriptor(name: string): Source | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      fields: TYPE_FIELDS[name].map((fieldName) => ({ __type: '__Field', name: fieldName })),
      enumValues: null,
    };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      fields: null,
      enumValues: ENUM_VALUES[name].map((valueName) => ({ __type: '__EnumValue', name: valueName })),
    };
  }
  return null;
}

function executeSelectionSet(typeName: string, source: Source, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === typeName) Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(typeName, source, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, selection, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (typeof source.__type === 'string' && selection.selectionSet !== null) {
      return executeSelectionSet(source.__type, source, selection.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

function executeField(typeName: string, source: Source, field: FieldNode, ctx: ExecContext): unknown {
  if (field.name === '__typename') return typeName;
  if (field.name === '__type' && typeName === 'Query') {
    const args: Record<string, unknown> = {};
    for (const [name, value] of field.args) args[name] = coerce(value, ctx.variables);
    const descriptor = typeof args.name === 'string' ? typeDescriptor(args.name) : null;
    if (descriptor === null) return null;
    return field.selectionSet !== null ? executeSelectionSet('__Type', descriptor, field.selectionSet, ctx) : descriptor;
  }
  const args: Record<string, unknown> = {};
  for (const [name, value] of field.args) args[name] = coerce(value, ctx.variables);
  const resolver = RESOLVERS[typeName]?.[field.name];
  try {
    let value: unknown;
    if (resolver !== undefined) value = resolver(source, args, ctx);
    else if (field.name in source) value = source[field.name];
    else {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      return null;
    }
    return completeValue(value, field, ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Run one GraphQL document; returns the response body (HTTP 200 semantics, errors in-band). */
export function executeGraphQL(body: unknown): { data?: unknown; errors?: Array<{ message: string }> } {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  const operation = document.operations.find((op) => operationName === null || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __type: rootType }, operation.selectionSet, ctx);
  const response: { data?: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}
