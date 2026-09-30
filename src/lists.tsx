import { useContext, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronUp, ChevronRight, EyeOff, Pencil, Search, Star, StarOff } from "lucide-react";
import { HARNESS_NAMES, usageApi, type Harness, type Privacy, type SessionUsage } from "./api";
import {
  PrivacyContext,
  ToastContext,
  PageHeader,
  type StreamStatus,
  statusLabel,
  ListSkeleton,
  full,
  dateTime,
  totalOf,
  cacheShare,
  money,
  projectLabel,
  Tokens,
  type UsageStream,
  StatusBadge,
  ConfirmDialog,
  ClearHistoryButton,
  useFavorites,
  type Period,
  PERIOD_LABELS,
  periodStart,
} from "./ui";

export const ACTIVE_MS = 5 * 60 * 1000;

/** Stand-in for a list whose stream has sent nothing yet; paused means nothing is coming. */
export function StreamPlaceholder({ status }: { status: StreamStatus }) {
  if (status === "paused") return <p className="sessions-empty">Monitoramento pausado.</p>;
  return <ListSkeleton label={statusLabel[status]} />;
}
const PAGE_SIZE = 25;

function PeriodSelect({ value, options, onChange }: { value: Period; options: Period[]; onChange: (period: Period) => void }) {
  return (
    <label className="sessions-period">
      <span className="sr-only">Período</span>
      <select value={value} onChange={(event) => onChange(event.target.value as Period)}>
        {options.map((option) => (
          <option key={option} value={option}>{PERIOD_LABELS[option]}</option>
        ))}
      </select>
    </label>
  );
}

const relative = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function ago(iso: string, now: number): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (seconds > -60) return "agora";
  if (seconds > -3600) return relative.format(Math.round(seconds / 60), "minute");
  if (seconds > -86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return dateTime.format(new Date(iso));
}

const TITLE_LIMIT = 29;
const shortTitle = (title: string) =>
  title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT).trimEnd()}…` : title;

type Sort<K extends string> = { key: K; desc: boolean };

/** Sort state for a table; names start A→Z, numbers and dates start biggest or newest. */
function useSort<K extends string>(initial: K, textKey: K) {
  const [sort, setSort] = useState<Sort<K>>({ key: initial, desc: initial !== textKey });
  const sortBy = (key: K) =>
    setSort((current) => ({ key, desc: current.key === key ? !current.desc : key !== textKey }));
  return [sort, sortBy] as const;
}

function sortRows<T, K extends string>(rows: T[], sort: Sort<K>, value: (row: T, key: K) => string | number): T[] {
  return [...rows].sort((a, b) => {
    const x = value(a, sort.key);
    const y = value(b, sort.key);
    const order = typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y);
    return sort.desc ? -order : order;
  });
}

function SortHeader<K extends string>({
  column,
  label,
  sort,
  onSort,
  className,
}: {
  column: K;
  label: string;
  sort: Sort<K>;
  onSort: (key: K) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <th className={className} aria-sort={active ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button className="sort-button" onClick={() => onSort(column)}>
        {label}
        {active &&
          (sort.desc ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />)}
      </button>
    </th>
  );
}

// Below this the row flags its cache, since most of the input was paid at full price.
const LOW_CACHE = 0.8;
const percent = new Intl.NumberFormat("pt-BR", { style: "percent" });
type Totals = Pick<SessionUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "cost">;

/** Tokens with their mix, cache share and cost: the numeric cells shared by the sessions and projects tables. */
function UsageCells({ totals }: { totals: Totals }) {
  const share = cacheShare(totals);
  return (
    <>
      <td>
        <div className="tokens-cell">
          <Tokens value={totalOf(totals)} />
          <span className="token-bar row-bar" aria-hidden="true">
            <i className="mix-input" style={{ flexGrow: totals.input }} />
            <i className="mix-output" style={{ flexGrow: totals.output }} />
            <i className="mix-cache-read" style={{ flexGrow: totals.cacheRead }} />
            <i className="mix-cache-write" style={{ flexGrow: totals.cacheWrite }} />
          </span>
        </div>
      </td>
      <td className={share < LOW_CACHE ? "num low-cache" : "num"}>{percent.format(share)}</td>
      {/* Zero means the model has no price, e.g. Codex, not a free session. */}
      <td className="num cost" title={totals.cost ? undefined : "Sem preço para este modelo"}>
        {totals.cost ? money(totals.cost) : "–"}
      </td>
    </>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  if (pageCount < 2) return null;
  return (
    <nav className="sessions-pager" aria-label="Paginação">
      <button
        className="button secondary"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={14} aria-hidden="true" />
        Anterior
      </button>
      <span>
        Página {page} de {pageCount}
      </span>
      <button
        className="button secondary"
        disabled={page === pageCount}
        onClick={() => onPage(page + 1)}
      >
        Próxima
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}

type SessionSort = "title" | "lastAt" | "total" | "cache" | "cost";

const sessionSortValue: Record<SessionSort, (session: SessionUsage) => string | number> = {
  title: (session) => session.title ?? "",
  lastAt: (session) => session.lastAt,
  total: totalOf,
  cache: cacheShare,
  cost: (session) => session.cost,
};


// Manual mode with nothing chosen is empty on purpose; says where to change it.
const manualEmpty = (privacy: Privacy) =>
  privacy.mode === "manual" && !privacy.projects.length
    ? "Modo manual: escolha as pastas a monitorar em Privacidade."
    : undefined;

export function SessionsScreen({
  stream: { sessions, status, updated, updates, refresh },
  period,
  onPeriod,
  onOpen,
}: {
  stream: UsageStream;
  period: Period;
  onPeriod: (period: Period) => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sort, sortBy] = useSort<SessionSort>("lastAt", "title");
  const [harness, setHarness] = useState<Harness | null>(null);
  const [liveOnly, setLiveOnly] = useState(false);
  const { favorites, save, remove } = useFavorites();
  const { privacy } = useContext(PrivacyContext);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  const inPeriod = useMemo(() => {
    const since = periodStart(period, now);
    return sessions.filter((session) => !session.lost && new Date(session.lastAt).getTime() >= since);
  }, [sessions, period, now]);
  const harnessCounts = useMemo(() => {
    const counts = new Map<Harness, number>();
    for (const session of inPeriod) counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1);
    return counts;
  }, [inPeriod]);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = inPeriod.filter(
      (session) =>
        (!harness || session.harness === harness) &&
        (!liveOnly || now - new Date(session.lastAt).getTime() < ACTIVE_MS) &&
        (!term ||
          [session.id, session.title, session.project, ...session.models].some((field) =>
            field?.toLowerCase().includes(term),
          )),
    );
    return sortRows(matches, sort, (session, key) => sessionSortValue[key](session));
  }, [inPeriod, query, sort, harness, liveOnly, now]);
  const starred = new Set(favorites?.map((favorite) => favorite.sessionId));
  const total = visible.reduce((sum, session) => sum + totalOf(session), 0);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamped on read: a narrower search can leave the stored page past the end.
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  return (
    <>
      <PageHeader
        eyebrow="CLAUDE CODE · CODEX · PI"
        title="Sessões"
        actions={<StatusBadge status={status} updates={updates} onRefresh={refresh} />}
      />
      <div className="sessions-toolbar">
        <label className="sessions-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Buscar sessão</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="ID da sessão, título, projeto ou modelo"
          />
        </label>
        <PeriodSelect
          value={period}
          options={["today", "all"]}
          onChange={(value) => {
            onPeriod(value);
            setPage(1);
          }}
        />
        <div className="filter-chips" role="group" aria-label="Agente">
          {[null, ...harnessCounts.keys()].map((key) => (
            <button
              key={key ?? "all"}
              type="button"
              className="filter-chip"
              aria-pressed={harness === key}
              onClick={() => {
                setHarness(key);
                setPage(1);
              }}
            >
              {key ? HARNESS_NAMES[key] : "Todos"} <span>{key ? harnessCounts.get(key) : inPeriod.length}</span>
            </button>
          ))}
          <button
            type="button"
            className="filter-chip"
            aria-pressed={liveOnly}
            onClick={() => {
              setLiveOnly((on) => !on);
              setPage(1);
            }}
          >
            <i className="active-dot" aria-hidden="true" />
            Só ao vivo
          </button>
        </div>
        <div className="sessions-summary">
          <ClearHistoryButton className="button ghost" />
          <p>
            {full.format(visible.length)} {visible.length === 1 ? "sessão" : "sessões"} · <Tokens value={total} />{" "}
            tokens
          </p>
        </div>
      </div>
      {status !== "live" && !sessions.length ? (
        <StreamPlaceholder status={status} />
      ) : (
        <div className="sessions-table-wrap">
          <table className="sessions-table">
            <thead>
              <tr>
                <th className="star-cell"><span className="sr-only">Favorito</span></th>
                <SortHeader column="title" label="Sessão" sort={sort} onSort={sortBy} />
                <th>Modelo</th>
                <SortHeader column="lastAt" label="Atividade" sort={sort} onSort={sortBy} />
                <SortHeader column="total" label="Tokens" sort={sort} onSort={sortBy} />
                <SortHeader column="cache" label="Cache" sort={sort} onSort={sortBy} className="num" />
                <SortHeader column="cost" label="Custo" sort={sort} onSort={sortBy} className="num" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map((session) => (
                <tr
                  key={
                    // Remounting on update replays the highlight animation.
                    updated.has(session.id)
                      ? `${session.id}:${session.turns}`
                      : session.id
                  }
                  className={updated.has(session.id) ? "just-updated" : undefined}
                >
                  <td className="star-cell">
                    <button
                      type="button"
                      className="icon-button star-toggle"
                      aria-pressed={starred.has(session.id)}
                      aria-label={`${starred.has(session.id) ? "Remover dos favoritos" : "Favoritar"}: ${session.title ?? session.id}`}
                      disabled={!favorites}
                      onClick={() => void (starred.has(session.id) ? remove(session.id) : save(session.id, null))}
                    >
                      <Star size={16} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </td>
                  <td>
                    <div className="session-cell">
                      <a
                        className="session-link"
                        href={`/sessions/${session.id}`}
                        title={session.title ?? undefined}
                        onClick={(event) => {
                          // Modified clicks keep the browser's open-in-new-tab behavior.
                          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
                          event.preventDefault();
                          onOpen(session.id);
                        }}
                      >
                        {session.title ?? "Sem título"}
                      </a>
                      <span>
                        <code title={session.id}>{session.id.slice(0, 8)}</code>
                        <span>{HARNESS_NAMES[session.harness]}</span>
                        {session.project && (
                          <span className="session-project" title={privacy.hidePaths ? undefined : session.project}>
                            {projectLabel(session.project, privacy.hidePaths)}
                          </span>
                        )}
                        <span>{full.format(session.turns)} turnos</span>
                      </span>
                    </div>
                  </td>
                  <td title={session.models.join(", ")}>
                    {session.models[0] && <span className="model-chip">{session.models[0]}</span>}
                    {session.models.length > 1 && <span className="model-more">+{session.models.length - 1}</span>}
                  </td>
                  <td>
                    {now - new Date(session.lastAt).getTime() < ACTIVE_MS && (
                      <i className="active-dot" aria-label="ativa" />
                    )}
                    <span title={dateTime.format(new Date(session.lastAt))}>
                      {ago(session.lastAt, now)}
                    </span>
                  </td>
                  <UsageCells totals={session} />
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className="sessions-empty">
              {manualEmpty(privacy) ?? "Nenhuma sessão encontrada."}
            </p>
          )}
          <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />
        </div>
      )}
      <ul className="chart-legend sessions-legend">
        <li><i className="mix-input" />Entrada</li>
        <li><i className="mix-output" />Saída</li>
        <li><i className="mix-cache-read" />Cache lido</li>
        <li><i className="mix-cache-write" />Cache gravado</li>
        <li>· Cache = parte da entrada servida do cache</li>
      </ul>
    </>
  );
}

type ProjectRow = Omit<SessionUsage, "id" | "harness" | "title" | "firstAt"> & {
  project: string;
  name: string;
  sessions: number;
};
type ProjectSort = "name" | "lastAt" | "sessions" | "turns" | "total" | "cache" | "cost";
const projectColumns: [ProjectSort, string][] = [["sessions", "Sessões"], ["turns", "Turnos"]];
const projectSortValue: Record<ProjectSort, (project: ProjectRow) => string | number> = {
  name: (project) => project.name,
  lastAt: (project) => project.lastAt,
  sessions: (project) => project.sessions,
  turns: (project) => project.turns,
  total: totalOf,
  cache: cacheShare,
  cost: (project) => project.cost,
};

function RemoveProjectDialog({
  project,
  onConfirm,
  onClose,
}: {
  project: ProjectRow;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { privacy } = useContext(PrivacyContext);
  return (
    <ConfirmDialog
      title={`Parar de monitorar ${project.name}?`}
      confirmLabel={
        <>
          <EyeOff size={14} aria-hidden="true" />
          Parar de monitorar
        </>
      }
      safe="Nada é apagado: a pasta do projeto e o histórico do Claude Code continuam onde estão."
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <p>O projeto sai do painel, mas continua no computador.</p>
      <ul>
        <li>
          {project.sessions === 1
            ? "A sessão dele também some da página Sessões."
            : `As ${full.format(project.sessions)} sessões dele também somem da página Sessões.`}
        </li>
        <li>Vale para todas as contas deste monitor.</li>
        <li>
          Para trazer de volta, use "Sincronizar tudo" em Privacidade ou escolha a pasta no modo
          manual.
        </li>
      </ul>
      {!privacy.hidePaths && <p className="confirm-path">{project.project}</p>}
    </ConfirmDialog>
  );
}

export function ProjectsScreen({
  stream: { sessions, status, updates, refresh },
  period,
  onPeriod,
  onOpen,
}: {
  stream: UsageStream;
  period: Period;
  onPeriod: (period: Period) => void;
  onOpen: (project: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [sort, sortBy] = useSort<ProjectSort>("lastAt", "name");
  const { privacy } = useContext(PrivacyContext);
  const notify = useContext(ToastContext);
  const [removing, setRemoving] = useState<ProjectRow | null>(null);
  // Hidden right away; the server's next snapshot drops them for good.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  // Sessions arrive newest first, so each project's first one sets its last activity.
  // ponytail: the list counts a session whole if it was active in the period; the detail trims by turn.
  const projects = useMemo(() => {
    const since = periodStart(period, now);
    const byProject = new Map<string, ProjectRow>();
    for (const session of sessions) {
      if (!session.project || removed.has(session.project)) continue;
      if (new Date(session.lastAt).getTime() < since) continue;
      let row = byProject.get(session.project);
      if (!row)
        byProject.set(
          session.project,
          (row = { project: session.project, name: session.project.split(/[\\/]/).at(-1) ?? session.project, sessions: 0, models: [], turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastAt: session.lastAt }),
        );
      row.sessions += 1;
      row.turns += session.turns;
      row.input += session.input;
      row.output += session.output;
      row.cacheRead += session.cacheRead;
      row.cacheWrite += session.cacheWrite;
      row.cost += session.cost;
      for (const model of session.models) if (!row.models.includes(model)) row.models.push(model);
    }
    return [...byProject.values()];
  }, [sessions, removed, period, now]);
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matches = term
      ? projects.filter((row) =>
          [row.project, ...row.models].some((field) => field.toLowerCase().includes(term)),
        )
      : projects;
    return sortRows(matches, sort, (row, key) => projectSortValue[key](row));
  }, [projects, query, sort]);
  const total = visible.reduce((sum, project) => sum + totalOf(project), 0);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const remove = (path: string) => {
    setRemoving(null);
    setError("");
    setRemoved((current) => new Set(current).add(path));
    usageApi.removeProject(path).then(() => notify("Projeto removido do monitor"), (reason: unknown) => {
      setRemoved((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setError(reason instanceof Error ? reason.message : "Não foi possível parar de monitorar o projeto.");
    });
  };
  return (
    <>
      <PageHeader
        eyebrow="CLAUDE CODE · CODEX · PI"
        title="Uso por projeto"
        actions={<StatusBadge status={status} updates={updates} onRefresh={refresh} />}
      />
      <div className="sessions-toolbar">
        <label className="sessions-search">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Buscar projeto</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Caminho do projeto ou modelo"
          />
        </label>
        <PeriodSelect
          value={period}
          options={["today", "week", "month", "all"]}
          onChange={(value) => {
            onPeriod(value);
            setPage(1);
          }}
        />
        <div className="sessions-summary">
          <ClearHistoryButton className="button ghost" />
          <p>
            {full.format(visible.length)} projetos · <Tokens value={total} />{" "}
            tokens
          </p>
        </div>
      </div>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {removing && (
        <RemoveProjectDialog
          project={removing}
          onConfirm={() => remove(removing.project)}
          onClose={() => setRemoving(null)}
        />
      )}
      {status !== "live" && !sessions.length ? (
        <StreamPlaceholder status={status} />
      ) : (
        <div className="sessions-table-wrap">
          <table className="sessions-table">
            <thead>
              <tr>
                <SortHeader column="name" label="Projeto" sort={sort} onSort={sortBy} />
                <th>Modelo</th>
                <SortHeader column="lastAt" label="Última atividade" sort={sort} onSort={sortBy} />
                {projectColumns.map(([key, label]) => (
                  <SortHeader key={key} column={key} label={label} sort={sort} onSort={sortBy} className="num" />
                ))}
                <SortHeader column="total" label="Tokens" sort={sort} onSort={sortBy} />
                <SortHeader column="cache" label="Cache" sort={sort} onSort={sortBy} className="num" />
                <SortHeader column="cost" label="Custo" sort={sort} onSort={sortBy} className="num" />
                <th><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((project) => (
                <tr key={project.project}>
                  <td>
                    <div className="session-cell">
                      <a
                        className="session-link"
                        href={`/projects/${encodeURIComponent(project.project)}`}
                        title={project.name}
                        onClick={(event) => {
                          if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
                          event.preventDefault();
                          onOpen(project.project);
                        }}
                      >
                        {shortTitle(project.name)}
                      </a>
                      {!privacy.hidePaths && (
                        <span className="session-path" title={project.project}>
                          {project.project}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="models">{project.models.join(", ")}</td>
                  <td>
                    {now - new Date(project.lastAt).getTime() < ACTIVE_MS && (
                      <i className="active-dot" aria-label="ativa" />
                    )}
                    <span title={dateTime.format(new Date(project.lastAt))}>
                      {ago(project.lastAt, now)}
                    </span>
                  </td>
                  <td className="num">{full.format(project.sessions)}</td>
                  <td className="num">{full.format(project.turns)}</td>
                  <UsageCells totals={project} />
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Parar de monitorar ${project.name}`}
                      title="Parar de monitorar (os arquivos continuam no computador)"
                      onClick={() => setRemoving(project)}
                    >
                      <EyeOff size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className="sessions-empty">
              {manualEmpty(privacy) ?? "Nenhum projeto encontrado."}
            </p>
          )}
          <Pager page={currentPage} pageCount={pageCount} onPage={setPage} />
        </div>
      )}
    </>
  );
}

/** Starred sessions under the name the user gave them, renamed in place. */
export function FavoritesScreen({ stream: { sessions, status, updates, refresh }, onOpen }: { stream: UsageStream; onOpen: (id: string) => void }) {
  const { favorites, save, remove } = useFavorites();
  const { privacy } = useContext(PrivacyContext);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const now = Date.now();
  const rename = (id: string) => {
    setEditing(null);
    void save(id, draft.trim() || null);
  };
  return (
    <>
      <PageHeader eyebrow="FAVORITOS" title="Sessões favoritas" actions={<StatusBadge status={status} updates={updates} onRefresh={refresh} />} />
      {!favorites ? (
        <ListSkeleton label="Carregando favoritos…" rows={3} />
      ) : !favorites.length ? (
        <p className="sessions-empty">Nenhuma sessão favorita ainda. Abra uma sessão e clique em Favoritar.</p>
      ) : (
        <div className="sessions-table-wrap">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Sessão</th>
                <th>Última atividade</th>
                <th className="num">Turnos</th>
                <th className="num">Total</th>
                <th className="num">Ações</th>
              </tr>
            </thead>
            <tbody>
              {favorites.map((favorite) => {
                const session = sessions.find((row) => row.id === favorite.sessionId);
                const title = favorite.name ?? session?.title ?? "Sem título";
                return (
                  <tr key={favorite.sessionId}>
                    <td>
                      <div className="session-cell">
                        {editing === favorite.sessionId ? (
                          <input
                            className="favorite-name"
                            aria-label="Nome da sessão"
                            autoFocus
                            maxLength={120}
                            value={draft}
                            placeholder={session?.title ?? "Sem título"}
                            onChange={(event) => setDraft(event.target.value)}
                            onBlur={() => rename(favorite.sessionId)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") rename(favorite.sessionId);
                              if (event.key === "Escape") setEditing(null);
                            }}
                          />
                        ) : (
                          <a
                            className="session-link"
                            href={`/sessions/${favorite.sessionId}`}
                            title={title}
                            onClick={(event) => {
                              if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
                              event.preventDefault();
                              onOpen(favorite.sessionId);
                            }}
                          >
                            {shortTitle(title)}
                          </a>
                        )}
                        <span>
                          <code title={favorite.sessionId}>{favorite.sessionId.slice(0, 8)}</code>
                          {favorite.name && session?.title && <span title={session.title}>{shortTitle(session.title)}</span>}
                          {session?.project && (
                            <span title={privacy.hidePaths ? undefined : session.project}>{session.project.split(/[\\/]/).at(-1)}</span>
                          )}
                          {!session && status === "live" && <span>fora do monitor</span>}
                        </span>
                      </div>
                    </td>
                    <td>
                      {session && (
                        <span title={dateTime.format(new Date(session.lastAt))}>{ago(session.lastAt, now)}</span>
                      )}
                    </td>
                    <td className="num">{session ? full.format(session.turns) : "–"}</td>
                    <td className="num total">{session ? <Tokens value={totalOf(session)} /> : "–"}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="icon-button"
                        title="Renomear"
                        aria-label={`Renomear ${title}`}
                        onClick={() => {
                          setDraft(favorite.name ?? "");
                          setEditing(favorite.sessionId);
                        }}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Remover dos favoritos"
                        aria-label={`Remover ${title} dos favoritos`}
                        onClick={() => void remove(favorite.sessionId)}
                      >
                        <StarOff size={14} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
