import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Chart } from "chart.js";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  Download,
  Folder,
  Link2,
  RefreshCw,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import {
  ApiError,
  HARNESS_NAMES,
  preferencesApi,
  shareApi,
  usageApi,
  type ChatMessage,
  type CostPoint,
  type Count,
  type Privacy,
  type SessionDetail,
  type Share,
  type ShareKind,
  type TokenTotals,
} from "./api";
import {
  PrivacyContext,
  PaletteContext,
  ToastContext,
  PageHeader,
  compact,
  full,
  dateTime,
  totalOf,
  cacheShare,
  money,
  Tokens,
  type UsageStream,
  StatusBadge,
  cssColor,
  failure,
  CopyLink,
  useFavorites,
  type Period,
  PERIOD_LABELS,
  periodStart,
} from "./ui";

const DETAIL_REFRESH_MS = 3_000;


const percent = new Intl.NumberFormat("pt-BR", {
  style: "percent",
  maximumFractionDigits: 1,
});

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const dateOnly = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });
const timeOnly = new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" });

function period(from: string, to: string): string {
  const start = new Date(from);
  const end = new Date(to);
  const day = dateOnly.format(start);
  if (day === dateOnly.format(end))
    return `${day} · ${timeOnly.format(start)} → ${timeOnly.format(end)}`;
  return `${dateTime.format(start)} → ${dateTime.format(end)}`;
}

/** Collapses repeated calls, e.g. Bash, Bash, Read -> "Bash ×2 · Read". */
function toolSummary(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts]
    .map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool))
    .join(" · ");
}

// Loads older chat pages when the reader nears the top, keeping the visible lines in place.
function SessionChat({
  id,
  agent,
  title,
  tail,
  tailStart,
}: {
  id: string;
  agent?: string;
  title: string;
  tail: ChatMessage[];
  tailStart: number;
}) {
  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [start, setStart] = useState(tailStart);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const body = useRef<HTMLOListElement>(null);
  // scrollHeight before a prepend, so the view can be shifted by exactly what was added.
  const heightBefore = useRef<number | null>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    if (heightBefore.current !== null) {
      element.scrollTop += element.scrollHeight - heightBefore.current;
      heightBefore.current = null;
      return;
    }
    if (atBottom.current) element.scrollTop = element.scrollHeight;
  }, [older, tail]);

  const loadOlder = () => {
    if (loading || start === 0) return;
    setLoading(true);
    setError("");
    usageApi
      .messages(id, start, agent)
      .then((page) => {
        heightBefore.current = body.current?.scrollHeight ?? null;
        setOlder((current) => [...page.messages, ...current]);
        setStart(page.start);
      })
      .catch(() => setError("Não foi possível carregar mensagens anteriores."))
      .finally(() => setLoading(false));
  };

  const messages = [...older, ...tail];
  return (
    <section className="chat" aria-label={`Chat: ${title}`}>
      <ol
        ref={body}
        className="chat-body"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          if (element.scrollTop < 120) loadOlder();
        }}
      >
        <li className="chat-more">
          {start === 0 ? (
            "— início da sessão —"
          ) : (
            <button type="button" onClick={loadOlder} disabled={loading}>
              {loading
                ? "Carregando…"
                : error || `↑ ${full.format(start)} mensagens anteriores`}
            </button>
          )}
        </li>
        {messages.map((message, index) => (
          <li key={start + index} className={`chat-${message.role}`}>
            {message.role === "assistant" && (
              <span className="chat-avatar" aria-hidden="true">
                AI
              </span>
            )}
            <div className="chat-bubble">
              <span className="sr-only">{message.role === "user" ? "Você:" : "Agente:"}</span>
              {message.text && <p>{message.text}</p>}
              {message.tools.length > 0 && (
                <p className="chat-tools">{toolSummary(message.tools)}</p>
              )}
              {message.at && (
                <time dateTime={message.at}>
                  {timeOnly.format(new Date(message.at))}
                  {message.role === "user" && " · você"}
                </time>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      className="copy-id"
      title={`Copiar ${id}`}
      onClick={() => void copy()}
    >
      <code>{id.slice(0, 8)}</code>
      {copied ? (
        <Check size={13} aria-label="Copiado" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
    </button>
  );
}

// Markdown with the prompt on top and the data as JSON, ready to hand to any AI assistant.
function exportForAnalysis(kind: "session" | "project", detail: SessionDetail, privacy: Privacy) {
  const { session } = detail;
  const name = kind === "project" ? (session.title ?? "projeto") : session.id.slice(0, 8);
  const data = {
    ...detail,
    // A project's id is its path, so hiding paths hides it too.
    session: privacy.hidePaths
      ? { ...session, id: kind === "project" ? name : session.id, project: null }
      : session,
    messages: privacy.hideChat ? [] : detail.messages,
  };
  const scope = kind === "project" ? "um projeto (todas as sessões somadas)" : "uma sessão";
  const markdown = `# Análise de uso do Claude Code

Os dados abaixo são o uso de tokens e custo de ${scope} do Claude Code, exportados do monitor local.

Analise e responda em português:
1. Onde o custo se concentrou (modelos, subagentes, tipos de token, picos na \`timeline\`).
2. Desperdícios: contexto crescendo sem necessidade, cache pouco aproveitado, ferramentas ou hooks repetidos ou falhando, subagentes caros para tarefas simples.
3. Recomendações práticas e priorizadas para reduzir custo e tokens sem perder qualidade.

Notas sobre os campos:
- Tokens: \`input\`, \`output\`, \`cacheRead\`, \`cacheWrite\`; custos em USD.
- \`reportedCost\` é o custo informado pelo Claude Code (null quando só há a estimativa em \`costs\`).
- \`timeline\` tem um ponto por resposta, com o custo daquela resposta.
- \`messages\` traz só o trecho final do chat (a partir do índice \`messageStart\`)${privacy.hideChat ? "; aqui foi omitido por privacidade" : ""}.
- \`idleMs\` é o tempo parado dentro do período da sessão.

\`\`\`json
${JSON.stringify(data, null, 1)}
\`\`\`
`;
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `analise-${kind}-${name.replace(/[^\w.-]+/g, "-")}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function CountList({ title, items }: { title: string; items: Count[] }) {
  const max = Math.max(0, ...items.map((item) => item.count));
  return (
    <section className="detail-card">
      <h2>
        {title}
        <span>{full.format(items.reduce((sum, item) => sum + item.count, 0))}</span>
      </h2>
      {items.length ? (
        <ul className="count-list">
          {items.map((item) => (
            <li key={item.name}>
              <span title={item.name}>{item.name}</span>
              <i aria-hidden="true">
                <b style={{ width: `${(item.count / max) * 100}%` }} />
              </i>
              <strong>{full.format(item.count)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="detail-empty">Nenhum uso.</p>
      )}
    </section>
  );
}

type Agent = SessionDetail["agents"][number];
const parentOf = (agent: Agent) => (agent.id === "main" ? "" : (agent.parent ?? "main"));

/** Each agent right under the one that started it, so the table reads as the tree of who started whom. */
function agentTree(agents: Agent[]): { agent: Agent; depth: number }[] {
  const tree: { agent: Agent; depth: number }[] = [];
  const placed = new Set<Agent>();
  const visit = (parent: string, depth: number) => {
    for (const agent of agents) {
      if (placed.has(agent) || parentOf(agent) !== parent) continue;
      placed.add(agent);
      tree.push({ agent, depth });
      visit(agent.id, depth + 1);
    }
  };
  visit("", 0);
  // A parent may be missing, e.g. a project sums agents by type; its children still show.
  for (const agent of agents) if (!placed.has(agent)) tree.push({ agent, depth: 1 });
  return tree;
}

const agentName = (agent: Agent | undefined) => (agent ? agent.description || agent.type : "outro subagente");

/** On a subagent's own detail, "main" is that subagent, and `detail.startedBy` names who started it. */
function startedBy(agent: Agent, detail: SessionDetail): string {
  if (agent.id === "main" && detail.startedBy?.id === "main") return "iniciado pelo agente principal";
  if (agent.id === "main") return `iniciado por ${detail.startedBy?.name ?? "você"}`;
  const parent = detail.agents.find((other) => other.id === parentOf(agent));
  if (parentOf(agent) === "main" && !detail.startedBy) return "iniciado pelo agente principal";
  return `iniciado por ${agentName(parent)}`;
}

function TokenTable({
  label,
  rows,
}: {
  label: string;
  rows: (TokenTotals & { key: string; name: React.ReactNode })[];
}) {
  return (
    <div className="sessions-table-wrap">
      <table className="sessions-table">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Turnos</th>
            <th className="num">Entrada</th>
            <th className="num">Saída</th>
            <th className="num">Cache lido</th>
            <th className="num">Cache gravado</th>
            <th className="num">Total</th>
            <th className="num">Custo</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.name}</td>
              <td className="num">{full.format(row.turns)}</td>
              <td className="num"><Tokens value={row.input} /></td>
              <td className="num"><Tokens value={row.output} /></td>
              <td className="num"><Tokens value={row.cacheRead} /></td>
              <td className="num"><Tokens value={row.cacheWrite} /></td>
              <td className="num total"><Tokens value={totalOf(row)} /></td>
              <td className="num">{money(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const clock = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayClock = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Formats chart times, with the date once the points span more than a day. */
function timeFormat(xs: number[]): (ms: number) => string {
  const format = xs.length > 1 && xs.at(-1)! - xs[0] > 86_400_000 ? dayClock : clock;
  return (ms) => format.format(ms);
}

function chartTheme() {
  return {
    grid: { color: `${cssColor("--border")}88` },
    ticks: cssColor("--muted"),
    point: cssColor("--surface"),
    tooltip: {
      backgroundColor: `${cssColor("--surface")}f2`,
      borderColor: cssColor("--line"),
      borderWidth: 1,
      padding: 10,
      position: "opposite",
      caretSize: 0,
    } as const,
  };
}

type ChartClass = typeof Chart;
let chartClass: ChartClass | undefined;

/** chart.js loads only once a chart is on screen, keeping it out of the first page load. */
function useChartClass(): ChartClass | undefined {
  // Wrapped in functions: React would call a bare class as an initializer or updater.
  const [loaded, setLoaded] = useState(() => chartClass);
  useEffect(() => {
    if (!loaded) void import("./chart").then((module) => setLoaded(() => (chartClass = module.Chart)));
  }, [loaded]);
  return loaded;
}

/**
 * Drag to zoom into a time span, shift+drag to pan, ctrl+wheel to zoom. The span survives
 * the chart being rebuilt on each live update; `reset` goes back to the whole range.
 */
function useChartZoom() {
  const range = useRef<{ min: number; max: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [resets, setResets] = useState(0);
  const keep = useCallback(({ chart }: { chart: Chart }) => {
    range.current = { min: chart.scales.x.min, max: chart.scales.x.max };
    setZoomed(true);
  }, []);
  const reset = useCallback(() => {
    range.current = null;
    setZoomed(false);
    setResets((count) => count + 1);
  }, []);
  const options = useCallback((xs: number[]) => ({
    x: { min: range.current?.min, max: range.current?.max },
    plugin: {
      limits: { x: { min: xs[0], max: xs.at(-1), minRange: 60_000 } },
      pan: { enabled: true, mode: "x", modifierKey: "shift", onPanComplete: keep },
      zoom: {
        mode: "x",
        wheel: { enabled: true, modifierKey: "ctrl" },
        drag: { enabled: true, backgroundColor: `${cssColor("--accent")}33`, borderColor: cssColor("--accent"), borderWidth: 1 },
        onZoomComplete: keep,
      },
    } as const,
  }), [keep]);
  const controls = (
    <div className="chart-zoom">
      <span>Arraste para dar zoom · Shift+arrastar move · Ctrl+roda</span>
      {zoomed && (
        <button className="button secondary" onClick={reset}>
          <RefreshCw size={13} aria-hidden="true" />
          Ver tudo
        </button>
      )}
    </div>
  );
  return { options, reset, resets, controls };
}

// A reply costing this many times the median one gets flagged as a spike.
const SPIKE_FACTOR = 3;
const TOOLTIP_PROMPT = 80;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function pointDetails(point: CostPoint): string[] {
  const lines = [
    `${point.agent}${point.model ? ` · ${point.model}` : ""}`,
    `Entrada ${compact.format(point.input)} · Saída ${compact.format(point.output)}`,
    `Cache lido ${compact.format(point.cacheRead)} · gravado ${compact.format(point.cacheWrite)}`,
  ];
  if (point.tools.length) lines.push(`Ferramentas: ${toolSummary(point.tools)}`);
  const prompt = point.prompt.replace(/\s+/g, " ").trim();
  if (prompt) lines.push(`“${prompt.length > TOOLTIP_PROMPT ? `${prompt.slice(0, TOOLTIP_PROMPT)}…` : prompt}”`);
  return lines;
}

const ALL_AGENTS = "all";

/** Picks which agent a chart shows; agents with a single reply draw no curve, so they are left out. */
function AgentPicker({
  label,
  agents,
  value,
  onChange,
  withAll = false,
}: {
  label: string;
  agents: SessionDetail["agents"];
  value: string;
  onChange: (agentId: string) => void;
  withAll?: boolean;
}) {
  const choices = agents.filter((agent) => agent.turns > 1);
  if (choices.length < 2) return null;
  return (
    <label className="chart-picker">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {withAll && <option value={ALL_AGENTS}>Todos os agentes</option>}
        {choices.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.id === "main" ? "Conversa principal" : `${agent.type}: ${agent.description || agent.id}`} ({full.format(agent.turns)} respostas)
          </option>
        ))}
      </select>
    </label>
  );
}

/** Running total of the session cost; spikes are replies far above the typical one. */
function CostChart({ timeline: all, agents }: { timeline: CostPoint[]; agents: SessionDetail["agents"] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [agentId, setAgentId] = useState(ALL_AGENTS);
  const { options: zoomOptionsFor, reset: resetZoom, resets, controls: zoomControls } = useChartZoom();
  const ChartJs = useChartClass();
  const timeline = useMemo(
    () => (agentId === ALL_AGENTS ? all : all.filter((point) => point.agentId === agentId)),
    [all, agentId],
  );
  const typical = useMemo(() => (timeline.length ? median(timeline.map((point) => point.cost)) : 0), [timeline]);
  const spikes = timeline.filter((point) => point.cost >= typical * SPIKE_FACTOR).length;
  const { palette } = useContext(PaletteContext);
  useEffect(() => {
    if (!canvas.current || !ChartJs) return;
    const theme = chartTheme();
    const line = cssColor("--accent");
    const spikeColor = cssColor("--warning");
    let total = 0;
    const points = timeline.map((point) => ({ x: Date.parse(point.at), y: (total += point.cost) }));
    const isSpike = timeline.map((point) => point.cost >= typical * SPIKE_FACTOR);
    const time = timeFormat(points.map((point) => point.x));
    const zoomOptions = zoomOptionsFor(points.map((point) => point.x));
    const chart = new ChartJs(canvas.current, {
      type: "line",
      data: {
        datasets: [{
          data: points,
          borderColor: line,
          backgroundColor: `${line}22`,
          borderWidth: 2,
          fill: true,
          pointRadius: isSpike.map((spike) => (spike ? 4 : 0)),
          pointBackgroundColor: isSpike.map((spike) => (spike ? spikeColor : line)),
          pointBorderColor: theme.point,
          pointBorderWidth: 2,
          pointHoverRadius: 6,
          pointHitRadius: 8,
        }],
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        scales: {
          x: { type: "linear", ...zoomOptions.x, ticks: { color: theme.ticks, maxTicksLimit: 8, callback: (value) => time(Number(value)) }, grid: theme.grid },
          y: { beginAtZero: true, ticks: { color: theme.ticks, callback: (value) => money(Number(value)) }, grid: theme.grid },
        },
        plugins: {
          zoom: zoomOptions.plugin,
          tooltip: {
            ...theme.tooltip,
            displayColors: false,
            callbacks: {
              title: ([item]) => time(item.parsed.x ?? 0),
              label: (item) => {
                const cost = timeline[item.dataIndex].cost;
                const spike = isSpike[item.dataIndex] ? ` · pico ${Math.round(cost / typical)}× a mediana` : "";
                return [`Acumulado ${money(item.parsed.y ?? 0)}`, `Esta resposta +${money(cost)}${spike}`];
              },
              afterBody: ([item]) => ["", ...pointDetails(timeline[item.dataIndex])],
            },
          },
        },
      },
    });
    return () => chart.destroy();
    // The kept span lives in a ref; a reset bumps `resets` to rebuild without it.
  }, [ChartJs, timeline, typical, zoomOptionsFor, resets, palette]);
  const pick = (id: string) => {
    setAgentId(id);
    resetZoom();
  };
  const picker = <AgentPicker label="Custo de" agents={agents} value={agentId} onChange={pick} withAll />;
  if (timeline.length < 2)
    return (
      <>
        {picker}
        <p className="detail-empty">Poucas respostas para desenhar.</p>
      </>
    );
  return (
    <>
      {picker}
      {zoomControls}
      <div className="cost-chart">
        <canvas ref={canvas} role="img" aria-label="Custo acumulado ao longo do tempo" />
      </div>
      <p className="cost-chart-note">
        <i aria-hidden="true" />
        {spikes
          ? `${full.format(spikes)} ${spikes > 1 ? "respostas custaram" : "resposta custou"} ${SPIKE_FACTOR}× ou mais que a mediana (${money(typical)}).`
          : `Nenhum pico: nenhuma resposta passou de ${SPIKE_FACTOR}× a mediana (${money(typical)}).`}
      </p>
    </>
  );
}

// Cache entries expire after 5 minutes idle, so a longer pause rewrites the whole context.
const CACHE_TTL_MS = 5 * 60 * 1000;
const contextSeries = [
  { key: "cacheRead", label: "Cache lido", mix: "cache-read" },
  { key: "input", label: "Entrada", mix: "input" },
  { key: "cacheWrite", label: "Cache gravado", mix: "cache-write" },
] as const;

type Compaction = NonNullable<SessionDetail["compactions"]>[number];
const compactionName = (compaction: Compaction) => (compaction.trigger === "manual" ? "/compact" : "Compactação automática");
type ContextValues = Pick<CostPoint, "cacheRead" | "input" | "cacheWrite">;
// A reply (`index`), or a step with a `note`: a /clear drops the context to zero, a compaction to its summary.
// `marker` steps draw the event's symbol; a compaction also gets a plain step, so its level has a tooltip.
type ContextStep = ContextValues & { at: number; index?: number; note?: string; marker?: "clear" | "compact"; link?: string };
const EMPTY_CONTEXT: ContextValues = { cacheRead: 0, input: 0, cacheWrite: 0 };

/** Context sent on each reply of one agent; a tall cache-write band means the cache was lost. */
function ContextChart({
  timeline,
  agents,
  compactions,
  clear,
  onOpenSession,
}: {
  timeline: CostPoint[];
  agents: SessionDetail["agents"];
  compactions: Compaction[];
  clear?: SessionDetail["clear"];
  onOpenSession?: (id: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [agentId, setAgentId] = useState("main");
  const { options: zoomOptionsFor, reset: resetZoom, resets, controls: zoomControls } = useChartZoom();
  const ChartJs = useChartClass();
  // Each agent keeps its own context, so mixing them would draw a meaningless sawtooth.
  const points = useMemo(() => timeline.filter((point) => point.agentId === agentId), [timeline, agentId]);
  // The first reply after a compaction, keyed by its index; compactions are only recorded for the main agent.
  const compactedAt = useMemo(
    () =>
      new Map(
        points.flatMap((point, index) => {
          const compaction =
            index && agentId === "main" && compactions.find((item) => item.at > points[index - 1].at && item.at <= point.at);
          return compaction ? [[index, compaction] as const] : [];
        }),
      ),
    [points, agentId, compactions],
  );
  // The other side of a /clear opens from its marker, only where the page can navigate.
  const previous = onOpenSession && clear?.previous;
  const next = onOpenSession && clear?.next;
  const steps = useMemo(() => {
    const replies: ContextStep[] = points.map((point, index) => ({ ...point, at: Date.parse(point.at), index }));
    if (agentId !== "main") return replies;
    const events: ContextStep[] = [
      ...[...compactedAt.values()].flatMap((compaction) => {
        const step = { ...EMPTY_CONTEXT, input: compaction.postTokens, at: Date.parse(compaction.at) };
        const name = compactionName(compaction);
        return [
          { ...step, marker: "compact" as const, note: `${name}: ${compact.format(compaction.preTokens)} → ${compact.format(compaction.postTokens)} tokens` },
          { ...step, note: `Contexto depois de ${name === "/compact" ? "/compact" : "compactação automática"}` },
        ];
      }),
      ...(clear?.startedAt
        ? [{
            ...EMPTY_CONTEXT,
            at: Date.parse(clear.startedAt),
            marker: "clear" as const,
            note: `Sessão aberta por /clear: o contexto começou do zero${previous ? " · clique para abrir a anterior" : ""}`,
            link: previous || undefined,
          }]
        : []),
      ...(clear?.endedAt
        ? [{
            ...EMPTY_CONTEXT,
            at: Date.parse(clear.endedAt),
            marker: "clear" as const,
            note: `/clear: contexto zerado, a conversa segue em outra sessão${next ? " · clique para abrir" : ""}`,
            link: next || undefined,
          }]
        : []),
    ];
    return [...replies, ...events].sort((a, b) => a.at - b.at);
  }, [points, agentId, compactedAt, clear, previous, next]);
  // More than half the context rewritten: the cached prefix was gone, not just extended.
  // After a compaction the context is new on purpose, so that is not a lost cache.
  const misses = useMemo(
    () =>
      points.flatMap((point, index) => {
        if (!index || point.cacheWrite <= point.cacheRead || compactedAt.has(index)) return [];
        return [{ index, idleMs: Date.parse(point.at) - Date.parse(points[index - 1].at) }];
      }),
    [points, compactedAt],
  );
  const missCost = misses.reduce((sum, miss) => sum + points[miss.index].cost, 0);
  const afterIdle = misses.filter((miss) => miss.idleMs > CACHE_TTL_MS).length;
  const kinds = new Set(steps.flatMap((step) => (step.marker ? [step.marker] : [])));
  const { palette } = useContext(PaletteContext);
  useEffect(() => {
    if (!canvas.current || !ChartJs) return;
    const theme = chartTheme();
    const xs = steps.map((step) => step.at);
    const time = timeFormat(xs);
    const zoomOptions = zoomOptionsFor(xs);
    const missAt = new Map(misses.map((miss) => [miss.index, miss.idleMs]));
    const colors = { clear: cssColor("--danger"), compact: cssColor("--caution") };
    const chart = new ChartJs(canvas.current, {
      type: "line",
      plugins: [
        {
          id: "contextEvents",
          afterDatasetsDraw: ({ ctx, chartArea, scales }) => {
            ctx.save();
            for (const step of steps) {
              if (!step.marker) continue;
              const x = scales.x.getPixelForValue(step.at);
              if (x < chartArea.left || x > chartArea.right) continue;
              const y = scales.y.getPixelForValue(step.cacheRead + step.input + step.cacheWrite);
              ctx.fillStyle = colors[step.marker];
              ctx.strokeStyle = theme.point;
              ctx.lineWidth = 2;
              ctx.setLineDash([]);
              ctx.beginPath();
              if (step.marker === "clear") ctx.arc(x, y, 6, 0, 2 * Math.PI);
              else {
                ctx.moveTo(x, y - 7);
                ctx.lineTo(x + 7, y + 5);
                ctx.lineTo(x - 7, y + 5);
                ctx.closePath();
              }
              ctx.fill();
              ctx.stroke();
            }
            ctx.restore();
          },
        },
      ],
      data: {
        datasets: contextSeries.map((series, order) => {
          const color = cssColor(`--series-${series.mix}`);
          return {
            label: series.label,
            data: steps.map((step) => ({ x: step.at, y: step[series.key], marker: !!step.marker })),
            // The context holds between replies, so a /clear or a compaction reads as a straight drop.
            stepped: "before" as const,
            borderColor: color,
            backgroundColor: `${color}55`,
            borderWidth: 1.5,
            fill: order ? "-1" : "origin",
            pointRadius:
              series.key === "cacheWrite"
                ? steps.map((step) => (step.index !== undefined && missAt.has(step.index) ? 4 : 0))
                : 0,
            pointBackgroundColor: color,
            pointBorderColor: theme.point,
            pointBorderWidth: 2,
            pointHoverRadius: 4,
            pointHitRadius: 8,
          };
        }),
      },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: "step", intersect: false },
        onHover: (event, [item]) => {
          if (event.native?.target instanceof HTMLElement)
            event.native.target.style.cursor = item && steps[item.index].link ? "pointer" : "";
        },
        onClick: (_, [item]) => {
          const link = item && steps[item.index].link;
          if (link) onOpenSession?.(link);
        },
        scales: {
          x: { type: "linear", ...zoomOptions.x, ticks: { color: theme.ticks, maxTicksLimit: 8, callback: (value) => time(Number(value)) }, grid: theme.grid },
          y: { stacked: true, beginAtZero: true, ticks: { color: theme.ticks, callback: (value) => compact.format(Number(value)) }, grid: theme.grid },
        },
        plugins: {
          zoom: zoomOptions.plugin,
          tooltip: {
            ...theme.tooltip,
            boxPadding: 4,
            callbacks: {
              title: ([item]) => time(item.parsed.x ?? 0),
              label: (item) => `${item.dataset.label} ${compact.format(item.parsed.y ?? 0)}`,
              footer: ([item]) => {
                const step = steps[item.dataIndex];
                if (step.index === undefined) return [step.note ?? ""];
                const point = points[step.index];
                const lines = [`Contexto ${compact.format(point.input + point.cacheRead + point.cacheWrite)} · +${money(point.cost)}`];
                const idleMs = missAt.get(step.index);
                if (idleMs !== undefined) lines.push(`Cache perdido, ${duration(idleMs)} após a resposta anterior`);
                return lines;
              },
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [ChartJs, steps, points, misses, zoomOptionsFor, resets, palette, onOpenSession]);
  const pick = (id: string) => {
    setAgentId(id);
    resetZoom();
  };
  const picker = <AgentPicker label="Contexto de" agents={agents} value={agentId} onChange={pick} />;
  if (points.length < 2)
    return (
      <>
        {picker}
        <p className="detail-empty">Poucas respostas para desenhar.</p>
      </>
    );
  return (
    <>
      {picker}
      <ul className="chart-legend">
        {contextSeries.map((series) => (
          <li key={series.key}>
            <i className={`mix-${series.mix}`} aria-hidden="true" />
            {series.label}
          </li>
        ))}
        {kinds.has("clear") && (
          <li>
            <i className="marker-clear" aria-hidden="true" />
            /clear
            {previous && (
              <button type="button" className="legend-link" title="Provável sessão encerrada pelo /clear que abriu esta" onClick={() => onOpenSession(previous)}>
                ← sessão anterior
              </button>
            )}
            {next && (
              <button type="button" className="legend-link" title="Provável sessão aberta pelo /clear que encerrou esta" onClick={() => onOpenSession(next)}>
                sessão seguinte →
              </button>
            )}
          </li>
        )}
        {kinds.has("compact") && (
          <li>
            <i className="marker-compact" aria-hidden="true" />
            Compactação
          </li>
        )}
      </ul>
      {zoomControls}
      <div className="cost-chart">
        <canvas ref={canvas} role="img" aria-label="Tamanho do contexto em cada resposta do agente escolhido" />
      </div>
      <p className="cost-chart-note">
        <i aria-hidden="true" />
        {misses.length
          ? `O cache foi perdido ${full.format(misses.length)}× (${full.format(afterIdle)} depois de mais de 5 min parado); essas respostas somaram ${money(missCost)}.`
          : "O cache se manteve em todas as respostas deste contexto."}
        {compactedAt.size > 0 && ` O contexto foi compactado ${full.format(compactedAt.size)}×.`}
      </p>
    </>
  );
}

type SessionEvent = { at: number; title: string; note: string; tone?: "warning" | "live" };

/** The session's notable moments, newest first: start, subagents, compactions, /clear and cost spikes. */
function SessionEvents({ detail }: { detail: SessionDetail }) {
  const { session, timeline } = detail;
  const typical = timeline.length ? median(timeline.map((point) => point.cost)) : 0;
  const events: SessionEvent[] = [
    { at: Date.parse(session.lastAt), title: "Última resposta", note: `turno ${full.format(session.turns)}`, tone: "live" as const },
    { at: Date.parse(session.firstAt), title: "Sessão iniciada", note: session.models[0] ?? HARNESS_NAMES[session.harness] },
    ...detail.agents.flatMap((agent) => {
      const first = agent.id !== "main" && timeline.find((point) => point.agentId === agent.id);
      if (!first) return [];
      return [{ at: Date.parse(first.at), title: `Subagente: ${agentName(agent)}`, note: `${agent.type} · ${startedBy(agent, detail)} · ${money(agent.cost)}` }];
    }),
    ...(detail.compactions ?? []).map((compaction) => ({
      at: Date.parse(compaction.at),
      title: compactionName(compaction),
      note: `Contexto de ${compact.format(compaction.preTokens)} → ${compact.format(compaction.postTokens)}`,
    })),
    ...(detail.clear?.startedAt ? [{ at: Date.parse(detail.clear.startedAt), title: "Aberta por /clear", note: "O contexto começou do zero" }] : []),
    ...(detail.clear?.endedAt ? [{ at: Date.parse(detail.clear.endedAt), title: "/clear", note: "A conversa seguiu em outra sessão" }] : []),
    ...timeline
      .filter((point) => typical > 0 && point.cost >= typical * SPIKE_FACTOR)
      .map((point) => ({
        at: Date.parse(point.at),
        title: `Pico de custo · +${money(point.cost)}`,
        note: `${Math.round(point.cost / typical)}× a mediana · ${point.agent}${point.tools.length ? ` · ${toolSummary(point.tools)}` : ""}`,
        tone: "warning" as const,
      })),
  ].sort((a, b) => b.at - a.at);
  const time = timeFormat(events.map((event) => event.at));
  return (
    <ol className="event-list">
      {events.map((event, index) => (
        <li key={index} className={event.tone}>
          <time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time>
          <i aria-hidden="true" />
          <div>
            <strong>{event.title}</strong>
            <span>{event.note}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

const detailSections = {
  summary: "Resumo",
  events: "O que aconteceu",
  costChart: "Custo ao longo do tempo",
  contextChart: "Contexto por resposta",
  costByType: "Custo por tipo de token",
  byModel: "Por modelo",
  agents: "Agentes",
  usage: "Ferramentas, MCPs, skills e comandos",
  hooks: "Hooks",
  chat: "Chat",
} as const;
export type DetailSection = keyof typeof detailSections;
const tabLabels: Partial<Record<DetailSection, string>> = {
  costChart: "Custo",
  contextChart: "Contexto",
  costByType: "Custo por tipo",
  usage: "Ferramentas",
};
type SectionLayout = { order: DetailSection[]; hidden: DetailSection[] };
export const ALL_SECTIONS = Object.keys(detailSections) as DetailSection[];
// Until the user picks, only what helps spot waste shows.
const DEFAULT_LAYOUT: SectionLayout = { order: ALL_SECTIONS, hidden: ["costByType", "byModel", "usage", "hooks", "chat"] };
// Kept between screens so reopening a session does not flash the default layout.
let savedLayout: SectionLayout | undefined;

/** Drops sections that no longer exist and appends new ones, which show by default. */
function sectionLayout(order: string[], hidden: string[]): SectionLayout {
  const known = order.filter((section): section is DetailSection => section in detailSections);
  return {
    order: [...known, ...ALL_SECTIONS.filter((section) => !known.includes(section))],
    hidden: hidden.filter((section): section is DetailSection => section in detailSections),
  };
}

/** Order and visibility of the detail sections, saved on the user's account. */
function useSectionLayout() {
  const notify = useContext(ToastContext);
  const [layout, setLayout] = useState(() => savedLayout ?? DEFAULT_LAYOUT);
  useEffect(() => {
    preferencesApi
      .get()
      .then(({ sectionOrder, hiddenSections }) => {
        if (sectionOrder && hiddenSections) setLayout((savedLayout = sectionLayout(sectionOrder, hiddenSections)));
      })
      .catch(() => {});
  }, []);
  const save = (next: SectionLayout) => {
    setLayout((savedLayout = next));
    preferencesApi
      .save({ sectionOrder: next.order, hiddenSections: next.hidden })
      .then(() => notify("Layout salvo"))
      .catch(() => setLayout((savedLayout = layout)));
  };
  return {
    order: layout.order,
    show: (section: DetailSection) => !layout.hidden.includes(section),
    toggle: (section: DetailSection) =>
      save({
        ...layout,
        hidden: layout.hidden.includes(section)
          ? layout.hidden.filter((item) => item !== section)
          : [...layout.hidden, section],
      }),
    // Swaps with a neighbor from the list on screen, which may skip sections this screen lacks.
    swap: (section: DetailSection, other: DetailSection) => {
      const order = [...layout.order];
      const from = order.indexOf(section);
      const to = order.indexOf(other);
      [order[from], order[to]] = [order[to], order[from]];
      save({ ...layout, order });
    },
  };
}

// A project sums sessions that ran days apart: no single chat, and its context line is only sessions opening and closing.
export const PROJECT_EXCLUDED: DetailSection[] = ["contextChart", "chat", "events"];

function SectionsPicker({
  order: all,
  show,
  toggle,
  swap,
  exclude,
}: ReturnType<typeof useSectionLayout> & { exclude: DetailSection[] }) {
  const order = all.filter((section) => !exclude.includes(section));
  return (
    <>
      <button className="button secondary" popoverTarget="detail-sections">
        <SlidersHorizontal size={14} aria-hidden="true" />
        Personalizar
      </button>
      <div id="detail-sections" className="sections-popover" popover="auto">
        <h2>O que mostrar</h2>
        <p>Vale para todas as sessões e fica salvo na sua conta.</p>
        <ol>
          {order.map((section, index) => (
            <li key={section}>
              <label>
                <input type="checkbox" checked={show(section)} onChange={() => toggle(section)} />
                {detailSections[section]}
              </label>
              <button
                className="icon-button"
                onClick={() => swap(section, order[index - 1])}
                disabled={index === 0}
                aria-label={`Subir ${detailSections[section]}`}
              >
                <ChevronUp size={14} aria-hidden="true" />
              </button>
              <button
                className="icon-button"
                onClick={() => swap(section, order[index + 1])}
                disabled={index === order.length - 1}
                aria-label={`Descer ${detailSections[section]}`}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

/** Links of this session or project on the hub, and the form that makes a new one. */
function ShareDialog({ kind, scope, onClose }: { kind: ShareKind; scope: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [title, setTitle] = useState("");
  const [access, setAccess] = useState<Share["access"]>("public");
  const [emails, setEmails] = useState("");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    shareApi
      .settings()
      .then(async ({ connected }) => {
        setConnected(connected);
        if (!connected) return;
        const [list, suggested] = await Promise.all([shareApi.list(kind, scope), shareApi.defaultTitle(kind, scope)]);
        setShares(list.shares);
        setTitle(suggested.title);
      })
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível falar com o hub.")));
  }, [kind, scope]);
  const create = () => {
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    if (access === "emails" && !list.length) return setError("Informe ao menos um e-mail.");
    setError("");
    setBusy(true);
    shareApi
      .create({
        kind,
        scope,
        title: title.trim(),
        access,
        emails: access === "emails" ? list : [],
        // The chosen day counts whole, until its last second in local time.
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
      })
      .then(({ share }) => setShares((current) => [share, ...current]))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível criar o link.")))
      .finally(() => setBusy(false));
  };
  const revoke = (id: string) => {
    setError("");
    shareApi
      .revoke(id)
      .then(() => setShares((current) => current.filter((share) => share.id !== id)))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível revogar o link.")));
  };
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <dialog ref={ref} className="confirm-dialog share-dialog" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>Compartilhar {kind === "project" ? "projeto" : "sessão"}</h2>
      {connected === false && <p>Conecte um hub em Conta → Compartilhamento para gerar links de compartilhamento.</p>}
      {shares.length > 0 && (
        <ul className="share-list">
          {shares.map((share) => (
            <li key={share.id}>
              <span>
                <strong>{share.title}</strong>
                <small>
                  {share.access === "public" ? "Qualquer pessoa com o link" : share.emails.join(", ")}
                  {" · "}
                  {share.expiresAt ? `expira em ${dateTime.format(new Date(share.expiresAt))}` : "não expira"}
                </small>
              </span>
              <CopyLink url={share.url} />
              <button type="button" className="button ghost" onClick={() => revoke(share.id)}>
                Revogar
              </button>
            </li>
          ))}
        </ul>
      )}
      {connected && (
        <>
          <label className="confirm-field">
            Título que as pessoas vão ver
            <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <fieldset className="settings-choice">
            <legend className="sr-only">Quem pode ver</legend>
            <label>
              <input type="radio" name="share-access" checked={access === "public"} onChange={() => setAccess("public")} />
              <span>
                <strong>Qualquer pessoa com o link</strong>
                <small>Sem login. O hub pode ter links públicos desativados.</small>
              </span>
            </label>
            <label>
              <input type="radio" name="share-access" checked={access === "emails"} onChange={() => setAccess("emails")} />
              <span>
                <strong>Só estes e-mails</strong>
                <small>Cada pessoa recebe um link de acesso no próprio e-mail.</small>
              </span>
            </label>
          </fieldset>
          {access === "emails" && (
            <label className="confirm-field">
              E-mails, separados por vírgula ou linha
              <textarea rows={3} value={emails} onChange={(event) => setEmails(event.target.value)} />
            </label>
          )}
          <label className="confirm-field">
            Expira em (vazio = não expira)
            <input type="date" min={today} value={expires} onChange={(event) => setExpires(event.target.value)} />
          </label>
          <p className="confirm-safe">
            <ShieldCheck size={14} aria-hidden="true" />
            Só números saem desta máquina: sem chat, prompts, caminhos nem comandos. O link se atualiza a cada 30 s.
          </p>
        </>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <div className="confirm-actions">
        <button className="button secondary" onClick={() => ref.current?.close()}>
          Fechar
        </button>
        {connected && (
          <button className="button primary" onClick={create} disabled={busy || !title.trim()} aria-busy={busy || undefined}>
            <Link2 size={14} aria-hidden="true" />
            Criar link
          </button>
        )}
      </div>
    </dialog>
  );
}

/** Detail of one session, or of a whole project (`id` is then its path) summed from its sessions. */
export function SessionDetailScreen({
  kind,
  id,
  agent,
  period = "all",
  stream,
  onBack,
  onOpenAgent,
  onOpenSession,
}: {
  kind: "session" | "project";
  id: string;
  // Projects only: counts just the turns inside this period.
  period?: Period;
  // A subagent of session `id`, shown on its own.
  agent?: string;
  stream: UsageStream;
  onBack: () => void;
  onOpenAgent?: (agent: string) => void;
  onOpenSession?: (id: string) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  const { privacy } = useContext(PrivacyContext);
  const { favorites, save: star, remove: unstar } = useFavorites();
  // Only a whole session can be starred, not a project or one of its subagents.
  const starrable = kind === "session" && !agent;
  const favorite = starrable ? favorites?.find((row) => row.sessionId === id) : undefined;
  const sections = useSectionLayout();
  const { order, show } = sections;
  // Only the newest request may write, so a slow older response never overwrites a fresher one.
  const latest = useRef(0);
  // Once the chat tail is loaded, refreshes extend it from the same start instead of sliding it.
  const since = useRef<number | undefined>(undefined);
  const load = useCallback(() => {
    const request = ++latest.current;
    const from = period === "all" ? undefined : new Date(periodStart(period, Date.now())).toISOString();
    (kind === "project" ? usageApi.project(id, from) : usageApi.session(id, since.current, agent))
      .then((next) => {
        if (request !== latest.current) return;
        since.current = next.messageStart;
        setDetail(next);
        setError("");
      })
      .catch((reason) => {
        if (request === latest.current)
          setError(
            reason instanceof ApiError
              ? reason.message
              : "Não foi possível carregar os detalhes.",
          );
      });
  }, [kind, id, agent, period]);
  useEffect(load, [load]);
  // Updates arrive every ~300 ms while an agent works, so refetch at most once per window plus a trailing call.
  const lastLoad = useRef(0);
  const pendingLoad = useRef<number | undefined>(undefined);
  useEffect(() => {
    lastLoad.current = 0;
    return () => {
      window.clearTimeout(pendingLoad.current);
      pendingLoad.current = undefined;
    };
  }, [load]);
  useEffect(() => {
    const touched =
      kind === "project"
        ? stream.sessions.some((session) => session.project === id && stream.updated.has(session.id))
        : stream.updated.has(id);
    if (!touched || pendingLoad.current !== undefined) return;
    const wait = lastLoad.current + DETAIL_REFRESH_MS - Date.now();
    const run = () => {
      pendingLoad.current = undefined;
      lastLoad.current = Date.now();
      load();
    };
    if (wait <= 0) {
      run();
      return;
    }
    pendingLoad.current = window.setTimeout(run, wait);
  }, [stream.updated, stream.sessions, kind, id, load]);

  const excluded: DetailSection[] = [
    ...(kind === "project" ? PROJECT_EXCLUDED : []),
    ...(privacy.hideChat || detail?.summary ? (["chat"] as const) : []),
  ];

  const parent = detail?.startedBy;
  const back = (
    <>
      {parent && parent.id !== "main" && (
        <button className="button secondary" title={parent.name} onClick={() => onOpenAgent?.(parent.id)}>
          <ArrowLeft size={14} aria-hidden="true" />
          Agente pai
        </button>
      )}
      <button className="button secondary" onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" />
        {kind === "project" ? "Projetos" : agent ? "Sessão" : "Sessões"}
      </button>
    </>
  );
  const eyebrow =
    kind === "project"
      ? period === "all" ? "PROJETO" : `PROJETO · ${PERIOD_LABELS[period].toUpperCase()}`
      : agent ? "SUBAGENTE" : "SESSÃO";
  if (!detail) {
    // The title is usually known before the details arrive: the folder name or the stream's copy.
    const listed = stream.sessions.find((session) => session.id === id);
    const knownTitle =
      kind === "project" ? id.split(/[\\/]/).filter(Boolean).at(-1) : !agent && listed && (listed.title ?? "Sem título");
    return (
      <>
        <PageHeader
          eyebrow={eyebrow}
          title={knownTitle ?? <span className="skeleton skeleton-title" aria-hidden="true" />}
          actions={back}
        />
        {error ? (
          <p className="page-state error">{error}</p>
        ) : (
          <div className="detail-stats" aria-hidden="true">
            {[0, 1, 2, 3].map((card) => (
              <span key={card} className="skeleton skeleton-stat" />
            ))}
          </div>
        )}
        <p className="sr-only" role="status">
          {error ? "" : kind === "project" ? "Lendo as sessões do projeto…" : "Lendo a sessão…"}
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title={favorite?.name ?? detail.session.title ?? "Sem título"}
        actions={
          <>
            <StatusBadge status={stream.status} updates={stream.updates} onRefresh={stream.refresh} />
            {starrable && favorites && (
              <button
                className="button secondary favorite-toggle"
                aria-pressed={!!favorite}
                onClick={() => void (favorite ? unstar(id) : star(id, null))}
              >
                <Star size={14} aria-hidden="true" fill={favorite ? "currentColor" : "none"} />
                {favorite ? "Favorita" : "Favoritar"}
              </button>
            )}
            <SectionsPicker {...sections} exclude={excluded} />
            <button
              className="button secondary"
              title="Baixa um .md com prompt e dados para análise"
              onClick={() => exportForAnalysis(kind, detail, privacy)}
            >
              <Download size={14} aria-hidden="true" />
              Exportar
            </button>
            {!agent && (
              <button className="button secondary" onClick={() => setSharing(true)}>
                <Share2 size={14} aria-hidden="true" />
                Compartilhar
              </button>
            )}
            {back}
          </>
        }
      />
      {sharing && <ShareDialog kind={kind} scope={id} onClose={() => setSharing(false)} />}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <DetailBody
        kind={kind}
        detail={detail}
        order={order}
        show={show}
        excluded={excluded}
        hidePaths={privacy.hidePaths}
        agent={agent}
        onOpenAgent={onOpenAgent}
        onOpenSession={onOpenSession}
      />
    </>
  );
}

/** The numbers, charts and tables of a detail: the local screen and a hub link both show it. */
export function DetailBody({
  kind,
  detail,
  order,
  show,
  excluded,
  hidePaths,
  agent,
  onOpenAgent,
  onOpenSession,
}: {
  kind: "session" | "project";
  detail: SessionDetail;
  order: DetailSection[];
  show: (section: DetailSection) => boolean;
  excluded: DetailSection[];
  hidePaths: boolean;
  agent?: string;
  onOpenAgent?: (agent: string) => void;
  onOpenSession?: (id: string) => void;
}) {
  const { session } = detail;
  const subagents = detail.agents.filter((agent) => agent.id !== "main");
  const subagentTotal = subagents.reduce((sum, agent) => sum + totalOf(agent), 0);
  const wallMs = new Date(session.lastAt).getTime() - new Date(session.firstAt).getTime();
  const cost = detail.agents.reduce((sum, agent) => sum + agent.cost, 0);
  const subagentCost = subagents.reduce((sum, agent) => sum + agent.cost, 0);
  const total = totalOf(session);
  const composition: [string, string, number][] = [
    ["input", "Entrada", session.input],
    ["output", "Saída", session.output],
    ["cache-read", "Cache lido", session.cacheRead],
    ["cache-write", "Cache gravado", session.cacheWrite],
  ];
  const spent = [detail.costs.input, detail.costs.output, detail.costs.cacheRead, detail.costs.cacheWrite];
  const visible = order.filter((section) => show(section) && !excluded.includes(section));
  const blocks: Record<DetailSection, React.ReactNode> = {
    summary: (
      <>
        {detail.summary && (
          <p className="cost-chart-note">A transcrição foi apagada pelo agente. Os números vêm do resumo guardado pelo monitor, sem o chat.</p>
        )}
        <div className="detail-stats">
          <div className="stat-highlight">
            <span>{detail.reportedCost === null ? "Custo estimado" : "Custo total"}</span>
            <strong>{money(detail.reportedCost ?? cost)}</strong>
            <small>{money(subagentCost)} em subagentes</small>
          </div>
          <div>
            <span>Tokens</span>
            <strong><Tokens value={total} /></strong>
            <small>
              <Tokens value={subagentTotal} /> em subagentes
            </small>
          </div>
          <div>
            <span>Cache</span>
            <strong>{percent.format(cacheShare(session))}</strong>
            <small>da entrada veio do cache</small>
          </div>
          <div>
            <span>Duração</span>
            <strong>{duration(Math.max(0, wallMs - detail.idleMs))}</strong>
            <small>{duration(detail.idleMs)} parado</small>
          </div>
          <div>
            <span>Turnos</span>
            <strong>{full.format(session.turns)}</strong>
            <small>
              {full.format(subagents.length)} subagentes
              {!!detail.compactions?.length && ` · ${full.format(detail.compactions.length)} compactações`}
            </small>
          </div>
        </div>
        <section className="token-mix" aria-label="Composição dos tokens">
          <div className="token-bar" aria-hidden="true">
            {composition.map(([key, , value]) => (
              <i
                key={key}
                className={`mix-${key}`}
                style={{ flexGrow: value }}
              />
            ))}
          </div>
          <ul>
            {composition.map(([key, label, value]) => (
              <li key={key}>
                <i className={`mix-${key}`} aria-hidden="true" />
                {label}
                <strong><Tokens value={value} /></strong>
                <span>{percent.format(total ? value / total : 0)}</span>
              </li>
            ))}
          </ul>
        </section>

        
      </>
    ),
    events: (
      <>
        <h2 className="detail-heading">O que aconteceu</h2>
        <SessionEvents detail={detail} />
      </>
    ),
    costChart: (
      <>
        <h2 className="detail-heading">Custo ao longo do tempo</h2>
        <CostChart timeline={detail.timeline} agents={detail.agents} />

        
      </>
    ),
    contextChart: (
      <>
        <h2 className="detail-heading">Contexto por resposta</h2>
        <ContextChart
          timeline={detail.timeline}
          agents={detail.agents}
          compactions={detail.compactions ?? []}
          clear={detail.clear}
          onOpenSession={onOpenSession}
        />

        
      </>
    ),
    costByType: (
      <>
        <h2 className="detail-heading">Custo por tipo de token</h2>
        <div className="sessions-table-wrap">
          <table className="sessions-table">
            <thead>
              <tr>
                <th>Tipo</th>
                <th className="num">Tokens</th>
                <th className="num">Custo</th>
                <th className="num">% do custo</th>
              </tr>
            </thead>
            <tbody>
              {composition.map(([key, label, value], index) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td className="num"><Tokens value={value} /></td>
                  <td className="num">{money(spent[index])}</td>
                  <td className="num">{percent.format(cost ? spent[index] / cost : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        
      </>
    ),
    byModel: (
      <>
        <h2 className="detail-heading">Por modelo</h2>
        <TokenTable
          label="Modelo"
          rows={detail.byModel.map((row) => ({ ...row, key: row.model, name: row.model }))}
        />

        
      </>
    ),
    agents: (
      <>
        <h2 className="detail-heading">Agentes</h2>
        <TokenTable
          label="Agente"
          rows={agentTree(detail.agents).map(({ agent: row, depth }) => ({
            ...row,
            key: row.id,
            name: (
              <div className="session-cell" style={{ paddingLeft: depth * 16 }}>
                {onOpenAgent && row.id !== "main" ? (
                  <a
                    className="session-link"
                    href={`/sessions/${session.id}/agents/${row.id}`}
                    title={row.description}
                    onClick={(event) => {
                      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
                      event.preventDefault();
                      onOpenAgent(row.id);
                    }}
                  >
                    {row.description || row.type}
                  </a>
                ) : (
                  <strong title={row.description}>{row.description || row.type}</strong>
                )}
                <span>
                  {row.type}
                  {row.models.length > 0 && ` · ${row.models.join(", ")}`}
                  {kind === "session" && ` · ${startedBy(row, detail)}`}
                </span>
              </div>
            ),
          }))}
        />

        
      </>
    ),
    usage: (
      <>
        <div className="detail-grid">
          <CountList title="Ferramentas" items={detail.tools} />
          <CountList title="MCPs" items={detail.mcp} />
          <CountList title="Skills" items={detail.skills} />
          <CountList title="Comandos" items={detail.commands} />
        </div>

        
      </>
    ),
    hooks: (
      <>
        <h2 className="detail-heading">Hooks</h2>
        {detail.hooks.length ? (
          <div className="sessions-table-wrap">
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>Evento</th>
                  <th>Comando</th>
                  <th className="num">Execuções</th>
                  <th className="num">Falhas</th>
                  <th className="num">Tempo</th>
                </tr>
              </thead>
              <tbody>
                {detail.hooks.map((hook) => (
                  <tr key={`${hook.event}:${hook.command}`}>
                    <td>{hook.event}</td>
                    <td className="hook-command" title={hook.command}>
                      <code>{hook.command || "—"}</code>
                    </td>
                    <td className="num">{full.format(hook.runs)}</td>
                    <td className={hook.failures ? "num failed" : "num"}>
                      {full.format(hook.failures)}
                    </td>
                    <td className="num">{duration(hook.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="detail-empty">Nenhum hook executado.</p>
        )}

        
      </>
    ),
    chat: (
      <>
        <h2 className="detail-heading">Chat</h2>
        <SessionChat
          id={session.id}
          agent={agent}
          title={`${session.harness} — ${session.project?.split(/[\\/]/).at(-1) ?? session.id.slice(0, 8)}`}
          tail={detail.messages}
          tailStart={detail.messageStart}
        />
      </>
    ),
  };
  return (
    <>
      <ul className="detail-meta">
        {kind === "session" && session.id && (
          <li>
            <CopyId id={session.id} />
          </li>
        )}
        {kind === "session" && <li>{HARNESS_NAMES[session.harness]}</li>}
        {session.project && (
          <li title={hidePaths ? undefined : session.project}>
            <Folder size={14} aria-hidden="true" />
            {session.project.split(/[\\/]/).at(-1)}
          </li>
        )}
        <li>
          <Clock size={14} aria-hidden="true" />
          {period(session.firstAt, session.lastAt)}
        </li>
        {session.models.map((model) => (
          <li key={model}>
            <Cpu size={14} aria-hidden="true" />
            {model}
          </li>
        ))}
      </ul>
      {detail.unpriced.length > 0 && (
        <p className="auth-error" role="alert">
          Sem preço cadastrado para {detail.unpriced.join(", ")}: esses tokens
          ficaram fora do custo.
        </p>
      )}
      {visible.length > 1 && (
        <nav className="detail-tabs" aria-label="Seções">
          {visible.map((section) => (
            <a
              key={section}
              href={`#secao-${section}`}
              onClick={(event) => {
                event.preventDefault();
                const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                document.getElementById(`secao-${section}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
              }}
            >
              {tabLabels[section] ?? detailSections[section]}
            </a>
          ))}
        </nav>
      )}
      {visible.map((section) => (
        <div key={section} id={`secao-${section}`} className="detail-section">
          {blocks[section]}
        </div>
      ))}
    </>
  );
}
