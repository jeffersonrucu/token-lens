export type Account = {
  id: string;
  name: string;
  email: string;
  avatarSeed: string;
  // False until the first check that Claude Code's history can be read.
  onboarded: boolean;
};

export type Harness = "claude" | "codex" | "pi";

export const HARNESS_NAMES: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
};

export type SessionUsage = {
  id: string;
  harness: Harness;
  title: string | null;
  project: string | null;
  models: string[];
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Estimated USD; replies of models without a price add nothing.
  cost: number;
  firstAt: string;
  lastAt: string;
  // The agent deleted the transcript: it still counts for its project, but leaves the sessions list.
  lost?: boolean;
  // Context sent with the main agent's latest reply.
  context?: number;
  // Ran /loop or scheduled its own wakeups.
  loop?: boolean;
  // Hook runs that timed out, were cancelled or failed, keyed by `event · command`.
  hookFailures?: Record<string, { count: number; ms: number }>;
};

// Where a period's cost went; `agent` is the subagent type or "principal".
export type Breakdown = {
  cost: number;
  subagents: number;
  loop: number;
  bigContext: number;
  agents: { agent: string; model: string; cost: number; turns: number }[];
};

export type TokenTotals = {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type Count = { name: string; count: number };

export type SessionDetail = {
  session: SessionUsage;
  reportedCost: number | null;
  costs: { input: number; output: number; cacheRead: number; cacheWrite: number };
  idleMs: number;
  byModel: (TokenTotals & { model: string })[];
  agents: (TokenTotals & {
    id: string;
    type: string;
    description: string;
    models: string[];
    // Who started it: "main" is the user's conversation, else another subagent's id.
    parent?: string;
  })[];
  unpriced: string[];
  tools: Count[];
  // Characters of text and images each tool returned into the context; missing from old summaries.
  toolOutput?: { name: string; chars: number; images: number }[];
  mcp: Count[];
  skills: Count[];
  commands: Count[];
  hooks: {
    event: string;
    command: string;
    runs: number;
    failures: number;
    ms: number;
  }[];
  // Index of messages[0] in the whole chat; older lines come from usageApi.messages.
  messageStart: number;
  messages: ChatMessage[];
  timeline: CostPoint[];
  // Each /compact (trigger "manual") or automatic compaction of the main agent's context.
  compactions?: { at: string; trigger: string; preTokens: number; postTokens: number }[];
  // Only on a subagent's own detail: who started it, where `id` "main" is the session.
  startedBy?: { id: string; name: string };
  // The likely sessions on either side of a /clear, which starts a new session id, and when each /clear ran.
  clear?: { previous?: string; next?: string; startedAt?: string; endedAt?: string };
  // Rebuilt from the saved numbers after the agent deleted the transcript, so there is no chat.
  summary?: boolean;
};

export type CostPoint = {
  at: string;
  cost: number;
  agentId: string;
  agent: string;
  model: string;
  tools: string[];
  prompt: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // Most of the cache write used the 1-hour TTL.
  ttl1h?: boolean;
};

export type ChatMessage = {
  role: "user" | "assistant";
  at: string;
  text: string;
  tools: string[];
};

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// A second click while a write is pending gets the same answer instead of running it again,
// and a different write to the same endpoint waits its turn so they reach the server in order.
const pending = new Map<string, { body: RequestInit["body"]; promise: Promise<unknown> }>();

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!init.method) return send<T>(path, init);
  const key = `${init.method} ${path}`;
  const running = pending.get(key);
  if (running && running.body === init.body) return running.promise as Promise<T>;
  const promise = (running?.promise.catch(() => undefined) ?? Promise.resolve()).then(() => send<T>(path, init));
  const entry = { body: init.body, promise };
  pending.set(key, entry);
  const done = () => {
    if (pending.get(key) === entry) pending.delete(key);
  };
  promise.then(done, done);
  return promise;
}

async function send<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: init.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new ApiError(
      body.error?.message ?? "Não foi possível concluir esta ação.",
      response.status,
    );
  }
  return (await response.json()) as T;
}

export const authApi = {
  profile: () => request<{ user: Account }>("/profile"),
  signup: (input: {
    name: string;
    email: string;
    password: string;
    avatarSeed: string;
  }) =>
    // The hub answers { pending } instead: the account opens only after the e-mail link.
    request<{ user: Account } | { pending: true }>("/auth/signup", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  login: (input: { email: string; password: string }) =>
    request<{ user: Account }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  deleteAccount: (password: string) =>
    request<{ ok: true }>("/account", {
      method: "DELETE",
      body: JSON.stringify({ password }),
    }),
};

export type ClaudeStatus =
  | { ok: true; root: string; sessions: number }
  | {
      ok: false;
      root: string;
      code: "not-found" | "no-access" | "empty" | "unreadable";
      message: string;
    };

export const claudeApi = {
  status: () => request<ClaudeStatus>("/claude/status"),
  // Refused with the reason while the history cannot be read.
  finishOnboarding: () =>
    request<{ user: Account }>("/onboarding", { method: "POST" }),
};

export const usageApi = {
  // Re-reads the history folders now, without waiting for the poll.
  refresh: () => request<{ ok: true }>("/usage/refresh", { method: "POST" }),
  // With `agent`, the subagent's own transcript is read as if it were the session.
  session: (id: string, since?: number, agent?: string) =>
    request<SessionDetail>(
      `/usage/sessions/${encodeURIComponent(id)}?${new URLSearchParams({
        ...(since === undefined ? {} : { since: String(since) }),
        ...(agent ? { agent } : {}),
      })}`,
    ),
  // Every session of the project summed; the chat stays empty.
  // With `from`, only turns from that ISO date on are counted.
  project: (path: string, from?: string) =>
    request<SessionDetail>(`/usage/projects?${new URLSearchParams({ path, ...(from ? { from } : {}) })}`),
  // Stops showing the project everywhere; the stream then sends a new snapshot.
  removeProject: (path: string) =>
    request<{ ok: true }>(`/usage/projects?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  // USD per hour since `from`, keyed by the start of each UTC hour in ms.
  spend: (from: string) => request<{ hours: [number, number][]; breakdown: Breakdown }>(`/usage/spend?${new URLSearchParams({ from })}`),
  messages: (id: string, before: number, agent?: string) =>
    request<{ start: number; messages: ChatMessage[] }>(
      `/usage/sessions/${encodeURIComponent(id)}/messages?${new URLSearchParams({ before: String(before), ...(agent ? { agent } : {}) })}`,
    ),
};

export type Preferences = { sectionOrder: string[]; hiddenSections: string[] };

export const preferencesApi = {
  // Both lists are null until the user saves once.
  get: () =>
    request<{ sectionOrder: string[] | null; hiddenSections: string[] | null }>("/preferences"),
  save: (preferences: Preferences) =>
    request<Preferences>("/preferences", {
      method: "PUT",
      body: JSON.stringify(preferences),
    }),
};

export type Favorite = { sessionId: string; name: string | null; createdAt: string };

export const favoritesApi = {
  list: () => request<{ favorites: Favorite[] }>("/favorites"),
  // Stars the session, or renames it when already starred; null keeps the session's own title.
  save: (id: string, name: string | null) =>
    request<Pick<Favorite, "sessionId" | "name">>(`/favorites/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  remove: (id: string) => request<{ ok: true }>(`/favorites/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const usageStreamUrl = "/api/v1/usage/stream";

export type Privacy = {
  mode: "auto" | "manual";
  projects: string[];
  paused: boolean;
  hideChat: boolean;
  hidePaths: boolean;
  // Set by "Zerar tudo": only usage from this moment on is counted.
  since: string | null;
};

export const DEFAULT_PRIVACY: Privacy = {
  mode: "auto",
  projects: [],
  paused: false,
  hideChat: false,
  hidePaths: false,
  since: null,
};

export type FolderListing = {
  path: string;
  parent: string | null;
  hasSessions: boolean;
  folders: { path: string; hasSessions: boolean }[];
};

export const privacyApi = {
  get: () => request<Privacy>("/privacy"),
  save: (privacy: Privacy) =>
    request<Privacy>("/privacy", { method: "PUT", body: JSON.stringify(privacy) }),
  // Without a path the API starts at the user's home folder.
  folders: (path?: string) =>
    request<FolderListing>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  clearCache: () => request<{ ok: true }>("/privacy/clear-cache", { method: "POST" }),
  clearHistory: () => request<Privacy>("/history/clear", { method: "POST" }),
  syncHistory: () => request<Privacy>("/history/sync", { method: "POST" }),
};

export type HubSettings = { url: string | null; connected: boolean };
export type ShareKind = "session" | "project";
export type ShareSettings = {
  access: "public" | "emails";
  emails: string[];
  expiresAt: string | null;
};
export type Share = ShareSettings & {
  id: string;
  kind: ShareKind;
  title: string;
  updatedAt: string | null;
  createdAt: string;
  // Kept on this machine: the hub stores only the token's hash and cannot show it again.
  url: string;
};

const scopeQuery = (kind: ShareKind, scope: string) =>
  `kind=${kind}&scope=${encodeURIComponent(scope)}`;

export const shareApi = {
  settings: () => request<HubSettings>("/hub/settings"),
  // The API tests the key against the hub before saving it.
  connect: (url: string, key: string) =>
    request<HubSettings>("/hub/settings", { method: "PUT", body: JSON.stringify({ url, key }) }),
  disconnect: () => request<HubSettings>("/hub/settings", { method: "DELETE" }),
  list: (kind: ShareKind, scope: string) =>
    request<{ shares: Share[] }>(`/shares?${scopeQuery(kind, scope)}`),
  defaultTitle: (kind: ShareKind, scope: string) =>
    request<{ title: string }>(`/shares/default-title?${scopeQuery(kind, scope)}`),
  create: (input: ShareSettings & { kind: ShareKind; scope: string; title: string }) =>
    request<{ share: Share }>("/shares", { method: "POST", body: JSON.stringify(input) }),
  revoke: (id: string) => request<{ ok: true }>(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const metaApi = {
  get: () => request<{ hub: boolean; publicShares: boolean }>("/meta"),
};

/** Hub side: the owner's key and shares. */
export const hubApi = {
  // Shown once; a new key replaces the old one on every local monitor using it.
  createKey: () => request<{ key: string }>("/hub/key", { method: "POST" }),
  shares: () => request<{ shares: Omit<Share, "url">[] }>("/hub/shares"),
  revoke: (id: string) =>
    request<{ ok: true }>(`/hub/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export type SharedView = {
  title: string;
  kind: ShareKind;
  updatedAt: string | null;
  // Null until the local monitor sends the first data.
  detail: SessionDetail | null;
};

/** Whoever opens a /s/:token link. */
export const viewerApi = {
  get: (token: string) => request<SharedView>(`/share/${encodeURIComponent(token)}`),
  requestAccess: (token: string, email: string) =>
    request<{ ok: true }>(`/share/${encodeURIComponent(token)}/access`, {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  confirm: (code: string) =>
    request<{ email: string }>("/share/access/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  streamUrl: (token: string) => `/api/v1/share/${encodeURIComponent(token)}/stream`,
};
