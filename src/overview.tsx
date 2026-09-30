import { useContext, useEffect, useMemo, useState } from "react";
import { Bell, Folder } from "lucide-react";
import { HARNESS_NAMES, usageApi, type Breakdown, type Harness } from "./api";
import {
  PageHeader,
  PrivacyContext,
  StatusBadge,
  Tokens,
  bigContext,
  full,
  money,
  projectLabel,
  totalOf,
  periodStart,
  PERIOD_LABELS,
  type Period,
  type UsageStream,
} from "./ui";
import { ACTIVE_MS, StreamPlaceholder, ago } from "./lists";

const PERIODS: Period[] = ["today", "week", "month"];
const TOP_PROJECTS = 6;
const TOP_AGENTS = 8;
const BAR_MAX = 150;
const today = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short" });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent" });

type Bucket = { key: string; label: string; cost: number };

/** Today's hours up to now, or each day of the week or month so far, in local time. */
function buckets(period: Period, since: number, now: number): Bucket[] {
  const list: Bucket[] = [];
  if (period === "today") {
    for (let hour = 0; hour <= new Date(now).getHours(); hour++) list.push({ key: String(hour), label: `${hour}h`, cost: 0 });
    return list;
  }
  for (const day = new Date(since); day.getTime() <= now; day.setDate(day.getDate() + 1))
    list.push({ key: day.toDateString(), label: period === "week" ? weekday.format(day) : String(day.getDate()), cost: 0 });
  return list;
}

// ponytail: the server buckets by UTC hour, so zones with a half-hour offset shift by 30 min.
const bucketKey = (period: Period, hour: number) =>
  period === "today" ? String(new Date(hour).getHours()) : new Date(hour).toDateString();

export function OverviewScreen({
  stream: { sessions, status, updates, refresh },
  period,
  onPeriod,
  onNavigate,
}: {
  stream: UsageStream;
  period: Period;
  onPeriod: (period: Period) => void;
  onNavigate: (to: string) => void;
}) {
  const { privacy } = useContext(PrivacyContext);
  const [now, setNow] = useState(() => Date.now());
  const [spend, setSpend] = useState<[number, number][] | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [alerts, setAlerts] = useState(() => ("Notification" in window ? Notification.permission : "denied"));
  const [spendError, setSpendError] = useState(false);
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);
  const since = periodStart(period, now);
  // Refetched with the 30 s tick, which is often enough for a chart of hours and days.
  useEffect(() => {
    let current = true;
    usageApi.spend(new Date(since).toISOString()).then(
      ({ hours, breakdown }) => {
        if (!current) return;
        setSpend(hours);
        setBreakdown(breakdown);
        setSpendError(false);
      },
      () => current && setSpendError(true),
    );
    return () => {
      current = false;
    };
  }, [since, now]);
  // Like the lists, a session counts in full once it was active in the period.
  const inPeriod = useMemo(() => sessions.filter((session) => new Date(session.lastAt).getTime() >= since), [sessions, since]);
  const totals = inPeriod.reduce(
    (sum, session) => ({
      turns: sum.turns + session.turns,
      input: sum.input + session.input,
      output: sum.output + session.output,
      cacheRead: sum.cacheRead + session.cacheRead,
      cacheWrite: sum.cacheWrite + session.cacheWrite,
    }),
    { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const total = totalOf(totals);
  const live = inPeriod.filter((session) => !session.lost && now - new Date(session.lastAt).getTime() < ACTIVE_MS);
  const byHarness = new Map<Harness, number>();
  const byProject = new Map<string, number>();
  for (const session of inPeriod) {
    byHarness.set(session.harness, (byHarness.get(session.harness) ?? 0) + 1);
    if (session.project) byProject.set(session.project, (byProject.get(session.project) ?? 0) + session.cost);
  }
  const projects = [...byProject].sort((a, b) => b[1] - a[1]).slice(0, TOP_PROJECTS);
  // Summed over the sessions of the period, like the other lists of this page.
  const hookFailures = new Map<string, { count: number; ms: number }>();
  for (const session of inPeriod)
    for (const [key, { count, ms }] of Object.entries(session.hookFailures ?? {})) {
      const failure = hookFailures.get(key) ?? hookFailures.set(key, { count: 0, ms: 0 }).get(key)!;
      failure.count += count;
      failure.ms += ms;
    }
  const failedHooks = [...hookFailures].sort((a, b) => b[1].count - a[1].count);
  const shareOf = (cost: number) => percent.format(breakdown?.cost ? cost / breakdown.cost : 0);
  const agents = breakdown?.agents.slice(0, TOP_AGENTS) ?? [];
  const bars = buckets(period, since, now);
  const byKey = new Map(bars.map((bar) => [bar.key, bar]));
  for (const [hour, cost] of spend ?? []) {
    const bar = byKey.get(bucketKey(period, hour));
    if (bar) bar.cost += cost;
  }
  // Today starts at the first hour with spend, so a late start does not leave a row of empty bars.
  const firstSpent = period === "today" ? bars.findIndex((bar) => bar.cost > 0) : 0;
  const shown = firstSpent > 0 ? bars.slice(firstSpent) : bars;
  const spent = bars.reduce((sum, bar) => sum + bar.cost, 0);
  const peak = Math.max(0, ...shown.map((bar) => bar.cost));
  // Modified clicks keep the browser's open-in-new-tab behavior.
  const follow = (to: string) => (event: React.MouseEvent) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(to);
  };
  return (
    <>
      <PageHeader
        eyebrow={today.format(now).toUpperCase()}
        title="Visão geral"
        actions={
          <>
            <div className="segmented" role="group" aria-label="Período">
              {PERIODS.map((option) => (
                <button key={option} type="button" aria-pressed={period === option} onClick={() => onPeriod(option)}>
                  {PERIOD_LABELS[option]}
                </button>
              ))}
            </div>
            {alerts === "default" && (
              <button
                type="button"
                className="button ghost"
                onClick={() => void Notification.requestPermission().then(setAlerts)}
                title="Avisa quando o contexto de uma sessão passa de 100 mil tokens, enquanto o painel estiver aberto"
              >
                <Bell size={14} aria-hidden="true" />
                Ativar alertas
              </button>
            )}
            <StatusBadge status={status} updates={updates} onRefresh={refresh} />
          </>
        }
      />
      {status !== "live" && !sessions.length ? (
        <StreamPlaceholder status={status} />
      ) : (
        <>
          <section className="overview-kpis" aria-label="Resumo do período">
            <div className="stat-highlight">
              <span>Custo estimado</span>
              <strong>{spend ? money(spent) : "–"}</strong>
              <small>{peak > 0 ? `Pico de ${money(peak)} ${period === "today" ? "numa hora" : "num dia"}` : "Nenhum gasto no período"}</small>
            </div>
            <div>
              <span>Tokens</span>
              <strong><Tokens value={total} /></strong>
              <span className="token-bar" aria-hidden="true">
                <i className="mix-input" style={{ flexGrow: totals.input }} />
                <i className="mix-output" style={{ flexGrow: totals.output }} />
                <i className="mix-cache-read" style={{ flexGrow: totals.cacheRead }} />
                <i className="mix-cache-write" style={{ flexGrow: totals.cacheWrite }} />
              </span>
              <small>
                Cache lido {percent.format(total ? totals.cacheRead / total : 0)} · gravado{" "}
                {percent.format(total ? totals.cacheWrite / total : 0)}
              </small>
            </div>
            <div>
              <span>Para onde foi o custo</span>
              {/* Each share stands alone: a reply of a subagent in a /loop session counts in both. */}
              <ul className="overview-where">
                <li title="Respostas dos subagentes">
                  Subagentes<strong>{breakdown ? shareOf(breakdown.subagents) : "–"}</strong>
                </li>
                <li title="Sessões que usaram /loop ou agendaram o próprio retorno">
                  Sessões com /loop<strong>{breakdown ? shareOf(breakdown.loop) : "–"}</strong>
                </li>
                <li title="Respostas que enviaram 100 mil tokens de contexto ou mais">
                  Contexto ≥ 100 mil<strong>{breakdown ? shareOf(breakdown.bigContext) : "–"}</strong>
                </li>
              </ul>
            </div>
            <div>
              <span>Sessões</span>
              <strong>{full.format(inPeriod.length)}</strong>
              <small className="overview-live">
                <i className="active-dot" aria-hidden="true" />
                {full.format(live.length)} ao vivo agora
              </small>
              <small>
                {[...byHarness].map(([harness, count]) => `${HARNESS_NAMES[harness]} ${full.format(count)}`).join(" · ")}
              </small>
            </div>
          </section>

          <div className="overview-heading">
            <h2 className="detail-heading">Ao vivo agora</h2>
            <a href="/sessions" onClick={follow("/sessions")}>Ver todas as sessões →</a>
          </div>
          {live.length ? (
            <div className="overview-live-grid">
              {live.map((session) => (
                <a key={session.id} className="live-card" href={`/sessions/${session.id}`} onClick={follow(`/sessions/${session.id}`)}>
                  <span className="live-card-top">
                    {/* The title changes as the agent works; the folder is what tells sessions apart. */}
                    <span className="live-project" title={privacy.hidePaths ? undefined : (session.project ?? undefined)}>
                      <Folder size={13} aria-hidden="true" />
                      {session.project ? projectLabel(session.project, privacy.hidePaths) : "sem pasta"}
                    </span>
                    <b title={session.cost ? undefined : "Sem preço para este modelo"}>{session.cost ? money(session.cost) : "–"}</b>
                  </span>
                  <strong>{session.title ?? "Sem título"}</strong>
                  {session.context !== undefined && (
                    <span className={bigContext(session) ? "live-context big" : "live-context"}>
                      Contexto <Tokens value={session.context} />
                      {bigContext(session) && " · considere /compact ou /clear"}
                    </span>
                  )}
                  <span>{[HARNESS_NAMES[session.harness], session.models[0]].filter(Boolean).join(" · ")}</span>
                  <span className="token-bar row-bar" aria-hidden="true">
                    <i className="mix-input" style={{ flexGrow: session.input }} />
                    <i className="mix-output" style={{ flexGrow: session.output }} />
                    <i className="mix-cache-read" style={{ flexGrow: session.cacheRead }} />
                    <i className="mix-cache-write" style={{ flexGrow: session.cacheWrite }} />
                  </span>
                  <small>
                    <span>
                      <i className="active-dot" aria-hidden="true" />
                      Resposta {ago(session.lastAt, now)} · turno {full.format(session.turns)}
                    </span>
                    <b><Tokens value={totalOf(session)} /></b>
                  </small>
                </a>
              ))}
            </div>
          ) : (
            <p className="detail-empty">Nenhuma sessão ativa nos últimos 5 minutos.</p>
          )}

          <div className="overview-split">
            <section className="overview-panel" aria-labelledby="spend-heading">
              <div className="overview-heading">
                <h2 id="spend-heading">{period === "today" ? "Gasto por hora" : "Gasto por dia"}</h2>
                {peak > 0 && <span>pico {money(peak)}</span>}
              </div>
              {spendError ? (
                <p className="detail-empty">Não foi possível carregar o gasto.</p>
              ) : (
                <ol className="spend-bars">
                  {shown.map((bar, index) => (
                    <li key={bar.key} className={index === shown.length - 1 ? "current" : undefined} title={`${bar.label}: ${money(bar.cost)}`}>
                      <span className="sr-only">{bar.label}: {money(bar.cost)}</span>
                      {/* Only the peak is labeled: a value over every bar would not fit on narrow bars. */}
                      <span className="spend-value" aria-hidden="true">{bar.cost > 0 && bar.cost === peak ? money(bar.cost) : ""}</span>
                      <i style={{ height: peak ? Math.max(bar.cost > 0 ? 3 : 0, (bar.cost / peak) * BAR_MAX) : 0 }} aria-hidden="true" />
                      <span className="spend-label" aria-hidden="true">{bar.label}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section className="overview-panel" aria-labelledby="agents-heading">
              <div className="overview-heading">
                <h2 id="agents-heading">Agentes e modelos</h2>
              </div>
              {agents.length ? (
                <ul className="overview-projects">
                  {agents.map((row) => (
                    <li key={`${row.agent}\n${row.model}`}>
                      <span title={`${row.agent} · ${row.model} · ${full.format(row.turns)} respostas`}>
                        {row.agent} <small>{row.model.replace(/^claude-/, "")}</small>
                      </span>
                      <i aria-hidden="true">
                        <b style={{ width: `${agents[0].cost ? (row.cost / agents[0].cost) * 100 : 0}%` }} />
                      </i>
                      <strong>{money(row.cost)}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="detail-empty">Nenhuma resposta com preço neste período.</p>
              )}
            </section>
            {failedHooks.length > 0 && (
              <section className="overview-panel" aria-labelledby="hooks-heading">
                <div className="overview-heading">
                  <h2 id="hooks-heading">Hooks com falha</h2>
                </div>
                <ul className="overview-hooks">
                  {failedHooks.map(([key, { count, ms }]) => (
                    <li key={key}>
                      <span title={key}>{key}</span>
                      <strong>{full.format(count)}×</strong>
                      <small>{ms < 60_000 ? `${full.format(Math.round(ms / 1000))} s` : `${full.format(Math.round(ms / 60_000))} min`} esperando</small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="overview-panel" aria-labelledby="projects-heading">
              <div className="overview-heading">
                <h2 id="projects-heading">Projetos</h2>
                <a href="/projects" onClick={follow("/projects")}>Ver projetos →</a>
              </div>
              {projects.length ? (
                <ul className="overview-projects">
                  {projects.map(([path, cost]) => (
                    <li key={path}>
                      <span title={privacy.hidePaths ? undefined : path}>{projectLabel(path, privacy.hidePaths)}</span>
                      <i aria-hidden="true">
                        <b style={{ width: `${projects[0][1] ? (cost / projects[0][1]) * 100 : 0}%` }} />
                      </i>
                      <strong>{cost ? money(cost) : "–"}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="detail-empty">Nenhum projeto com uso neste período.</p>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
