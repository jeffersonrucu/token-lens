import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Check, Copy, Eye, EyeOff, RotateCcw, ShieldCheck } from "lucide-react";
import {
  ApiError,
  authApi,
  DEFAULT_PRIVACY,
  favoritesApi,
  privacyApi,
  usageApi,
  usageStreamUrl,
  type Account,
  type Favorite,
  type Privacy,
  type SessionUsage,
  type TokenTotals,
} from "./api";

// Defaults until the saved settings load; the API enforces them on its side too.
export const PrivacyContext = createContext<{
  privacy: Privacy;
  save: (next: Privacy) => Promise<void>;
  set: (next: Privacy) => void;
}>({ privacy: DEFAULT_PRIVACY, save: async () => undefined, set: () => undefined });

// Each id needs a matching [data-palette] block in index.css (the first is the :root default).
export const palettes = [
  { id: "tokenlens", label: "TokenLens", description: "Escuro neutro com o violeta e o ciano da logo." },
  { id: "dracula", label: "Dracula", description: "O tema clássico de editor, com verde nas ações." },
  { id: "light", label: "Claro", description: "Fundo claro com o violeta da logo, para ambientes iluminados." },
  { id: "cyberpunk", label: "Cyberpunk", description: "Roxo profundo com magenta, ciano e amarelo neon." },
  { id: "matrix", label: "Matrix", description: "Preto quase puro com verde fósforo de terminal." },
] as const;
type PaletteId = (typeof palettes)[number]["id"];
export const PALETTE_KEY = "tokenlens.palette";

export function savedPalette(): PaletteId {
  try {
    const saved = localStorage.getItem(PALETTE_KEY);
    return palettes.find((palette) => palette.id === saved)?.id ?? palettes[0].id;
  } catch {
    return palettes[0].id;
  }
}

export const PaletteContext = createContext<{ palette: PaletteId; setPalette: (id: PaletteId) => void }>({
  palette: palettes[0].id,
  setPalette: () => undefined,
});

// Confirms changes that save on their own, with no save button to click.
export const ToastContext = createContext<(message: string) => void>(() => undefined);

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);
  const notify = useCallback((message: string) => setToast({ id: Date.now(), message }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {/* Always mounted, so screen readers announce each new message. */}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <p className="toast" key={toast.id}>
            <Check size={15} aria-hidden="true" />
            {toast.message}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const AuthContext = createContext<{
  account: Account;
  logout: () => Promise<void>;
} | null>(null);

const ICON_ARC = "M29 33H113A39 39 0 0 1 152 72V84L136 106V72A23 23 0 0 0 113 49H15Z";
const ICON_BAR = "M50 64H67V142L50 158Z";
const ICON_BARS = "M74 117V101a5 5 0 0 1 10 0V117ZM90.5 117V89a5 5 0 0 1 10 0V117ZM107 117V69.5a5 5 0 0 1 10 0V117Z";

/** The favicon is loaded as an image, where CSS variables don't resolve, so colors go in as literals. */
export function paletteFavicon(): string {
  const brand = cssColor("--brand");
  const accent = cssColor("--accent-2");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 27 139 139"><defs><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="88" y1="38" x2="104" y2="48"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${brand}"/></linearGradient><linearGradient id="b" gradientUnits="userSpaceOnUse" x1="74" y1="0" x2="117" y2="0"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${brand}"/></linearGradient></defs><path fill="url(#a)" d="${ICON_ARC}"/><path fill="${accent}" d="${ICON_BAR}"/><path fill="url(#b)" d="${ICON_BARS}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Inline copy of /brand/tokenlens-icon.svg so the gradient follows the active palette. */
function BrandIcon() {
  const id = useId();
  return (
    <svg className="brand-logo" viewBox="14 27 139 139" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}a`} gradientUnits="userSpaceOnUse" x1="88" y1="38" x2="104" y2="48">
          <stop offset="0" style={{ stopColor: "var(--accent-2)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand)" }} />
        </linearGradient>
        <linearGradient id={`${id}b`} gradientUnits="userSpaceOnUse" x1="74" y1="0" x2="117" y2="0">
          <stop offset="0" style={{ stopColor: "color-mix(in srgb, var(--accent-2), var(--brand))" }} />
          <stop offset="1" style={{ stopColor: "var(--brand)" }} />
        </linearGradient>
      </defs>
      <path fill={`url(#${id}a)`} d={ICON_ARC} />
      <path style={{ fill: "var(--accent-2)" }} d={ICON_BAR} />
      <path fill={`url(#${id}b)`} d={ICON_BARS} />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={className ? `brand ${className}` : "brand"}>
      <BrandIcon />
      <span className="brand-name">Token<span>Lens</span></span>
    </span>
  );
}

export function PasswordInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input {...props} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((value) => !value)}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        aria-pressed={visible}
      >
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow: string;
  title: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  );
}

export type StreamStatus = "connecting" | "loading" | "live" | "offline" | "paused";

export const statusLabel: Record<StreamStatus, string> = {
  connecting: "Conectando…",
  loading: "Lendo histórico…",
  live: "Ao vivo",
  offline: "Reconectando…",
  paused: "Pausado",
};

/** Loading pattern: placeholders shaped like the content, and the words only for screen readers. */
export function ListSkeleton({ label, rows = 6, className = "sessions-table-wrap" }: { label: string; rows?: number; className?: string }) {
  return (
    <>
      <div className={`${className} skeleton-list`} aria-hidden="true">
        {Array.from({ length: rows }, (_, row) => (
          <span key={row} className="skeleton-row">
            <span className="skeleton" />
            <span className="skeleton" />
          </span>
        ))}
      </div>
      <p className="sr-only" role="status">
        {label}
      </p>
    </>
  );
}

const RETRY_MS = 3_000;

export const compact = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
export type Period = "today" | "week" | "month" | "all";
export const PERIOD_LABELS: Record<Period, string> = { today: "Hoje", week: "Esta semana", month: "Este mês", all: "Tudo" };

/** Reads `?period=` so a reload keeps the filter; anything unknown falls back to "all". */
export function urlPeriod(search: string, options: Period[]): Period {
  const value = new URLSearchParams(search).get("period") as Period;
  return options.includes(value) ? value : "all";
}

export const periodQuery = (period: Period): string => (period === "all" ? "" : `?period=${period}`);

/** Local start of the period in ms; weeks start on Monday. */
export function periodStart(period: Period, now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  if (period === "month") start.setDate(1);
  return period === "all" ? 0 : start.getTime();
}

export const full = new Intl.NumberFormat("pt-BR");
/** "parent/folder", so same-named folders stay apart; just "folder" when paths are hidden. */
export function projectLabel(path: string, hidePaths: boolean): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(hidePaths ? -1 : -2).join("/");
}
const usd = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" });
const usdSmall = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumSignificantDigits: 2 });
// Sub-cent amounts would round to US$ 0,00, which reads as free.
export const money = (value: number) => (value > 0 && value < 0.01 ? usdSmall : usd).format(value);
export const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});

export const totalOf = (totals: Pick<TokenTotals, "input" | "output" | "cacheRead" | "cacheWrite">) =>
  totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

/** Share of the input side served from cache, 0–1. */
export function cacheShare(totals: Pick<TokenTotals, "input" | "cacheRead" | "cacheWrite">): number {
  const sent = totals.input + totals.cacheRead + totals.cacheWrite;
  return sent ? totals.cacheRead / sent : 0;
}

export function Tokens({ value }: { value: number }) {
  return <span title={full.format(value)}>{compact.format(value)}</span>;
}

// The server's BIG_CONTEXT: past it every reply re-reads a large prefix.
export const BIG_CONTEXT = 100_000;
export const bigContext = (session: SessionUsage) => (session.context ?? 0) >= BIG_CONTEXT;

function notifyBigContext(session: SessionUsage) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification("Contexto passou de 100 mil tokens", {
    body: `${session.title ?? "Sem título"}: ${compact.format(session.context ?? 0)} tokens. Considere /compact ou /clear.`,
    tag: session.id,
  });
}

export function useUsageStream(onUnauthorized: () => void) {
  const [sessions, setSessions] = useState<SessionUsage[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [updated, setUpdated] = useState<Set<string>>(new Set());
  const [updates, setUpdates] = useState(0);
  // Sessions already past BIG_CONTEXT: each alerts once per crossing, not on every reply or reconnect.
  const alerted = useRef(new Set<string>());
  useEffect(() => {
    let source: EventSource | undefined;
    let retry: number | undefined;
    const connect = () => {
      source = new EventSource(usageStreamUrl);
      source.addEventListener("loading", () => setStatus("loading"));
      source.addEventListener("snapshot", (event) => {
        const list = JSON.parse(event.data) as SessionUsage[];
        for (const session of list) if (bigContext(session)) alerted.current.add(session.id);
        setSessions(list);
        setStatus("live");
      });
      source.addEventListener("update", (event) => {
        const changed = JSON.parse(event.data) as SessionUsage[];
        const ids = new Set(changed.map((session) => session.id));
        for (const session of changed) {
          if (!bigContext(session)) alerted.current.delete(session.id);
          else if (!alerted.current.has(session.id)) {
            alerted.current.add(session.id);
            notifyBigContext(session);
          }
        }
        setSessions((current) =>
          [...changed, ...current.filter((session) => !ids.has(session.id))].sort(
            (a, b) => b.lastAt.localeCompare(a.lastAt),
          ),
        );
        setUpdated(ids);
        setUpdates((count) => count + 1);
      });
      source.onerror = () => {
        setStatus("offline");
        // The browser only gives up on its own after a non-200, which is either an expired login or a dead server.
        if (source?.readyState !== EventSource.CLOSED) return;
        authApi
          .profile()
          .then(() => {
            retry = window.setTimeout(connect, RETRY_MS);
          })
          .catch((reason) => {
            if (reason instanceof ApiError && reason.status === 401)
              onUnauthorized();
            else retry = window.setTimeout(connect, RETRY_MS);
          });
      };
    };
    const disconnect = () => {
      source?.close();
      source = undefined;
      window.clearTimeout(retry);
    };
    // Visibility, not focus: a window in split screen or on a second monitor keeps streaming.
    // With no stream open the server stops re-reading the history folders.
    const onVisibility = () => {
      if (document.hidden) return disconnect();
      if (source) return;
      setStatus("connecting");
      connect();
    };
    document.addEventListener("visibilitychange", onVisibility);
    connect();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      disconnect();
    };
  }, [onUnauthorized]);
  const refresh = useCallback(() => usageApi.refresh().then(() => undefined), []);
  return { sessions, status, updated, updates, refresh };
}

export type UsageStream = ReturnType<typeof useUsageStream>;

export function StatusBadge({
  status,
  updates,
  onRefresh,
}: {
  status: StreamStatus;
  updates?: number;
  onRefresh?: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <span className={`stream-status ${status}`} role="status">
      {/* Remounting restarts the finite pulse, so the dot only animates right after an update. */}
      <i key={updates} aria-hidden="true" />
      {statusLabel[status]}
      {onRefresh && (
        <button
          className="icon-button"
          aria-label="Forçar atualização"
          title="Reler o histórico agora"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            onRefresh().finally(() => setRefreshing(false));
          }}
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** Every confirmation says what happens, what goes with it, how to undo it and what stays safe. */
export function ConfirmDialog({
  title,
  confirmLabel,
  children,
  safe,
  danger = true,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  confirmLabel: React.ReactNode;
  children: React.ReactNode;
  safe: string;
  danger?: boolean;
  /** Keeps the dialog open and locked while the confirmed action runs. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // showModal() gives focus trapping, Esc and the backdrop for free.
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      onCancel={(event) => busy && event.preventDefault()}
      onClose={onClose}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      <p className="confirm-safe">
        <ShieldCheck size={14} aria-hidden="true" />
        {safe}
      </p>
      <div className="confirm-actions">
        <button className="button secondary" onClick={onClose} disabled={busy} autoFocus>
          Cancelar
        </button>
        <button
          className={danger ? "button danger" : "button primary"}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** Starts the count over from now; the history stays on disk and "Sincronizar tudo" restores it. */
export function ClearHistoryButton({ className = "button secondary" }: { className?: string }) {
  const { set } = useContext(PrivacyContext);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const clear = () => {
    setConfirming(false);
    setWorking(true);
    setError("");
    privacyApi
      .clearHistory()
      .then(set)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Não foi possível zerar."),
      )
      .finally(() => setWorking(false));
  };
  return (
    <>
      <button className={className} onClick={() => setConfirming(true)} disabled={working} aria-busy={working || undefined}>
        <RotateCcw size={14} aria-hidden="true" />
        {working ? "Zerando…" : "Zerar tudo"}
      </button>
      {error && (
        <span className="auth-error" role="alert">
          {error}
        </span>
      )}
      {confirming && (
        <ConfirmDialog
          title="Zerar todos os projetos e sessões?"
          confirmLabel="Zerar tudo"
          safe="Nada é apagado do computador: o histórico do Claude Code continua lá."
          onConfirm={clear}
          onClose={() => setConfirming(false)}
        >
          <p>A contagem recomeça a partir de agora, só na sua conta.</p>
          <ul>
            <li>Todas as sessões e todos os projetos somem das listas, nas duas páginas.</li>
            <li>
              Sessões que continuarem depois disso aparecem só com a parte nova: tokens, custo,
              gráfico e chat de antes ficam de fora.
            </li>
            <li>Para desfazer, use "Sincronizar tudo" em Privacidade.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

/** Canvas can't use CSS variables, so charts read the palette tokens when they are built. */
export function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const failure = (reason: unknown, fallback: string) => (reason instanceof Error ? reason.message : fallback);

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button type="button" className="button secondary" onClick={() => void copy()}>
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      {copied ? "Copiado" : "Copiar link"}
    </button>
  );
}

/** The account's starred sessions; `null` until they load. */
export function useFavorites() {
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const notify = useContext(ToastContext);
  useEffect(() => {
    favoritesApi.list().then(({ favorites }) => setFavorites(favorites), () => setFavorites([]));
  }, []);
  const fail = (reason: unknown) => notify(reason instanceof Error ? reason.message : "Não foi possível salvar.");
  const save = (sessionId: string, name: string | null) =>
    favoritesApi.save(sessionId, name).then((saved) => {
      setFavorites((current) => {
        const rows = current ?? [];
        // A rename keeps the row in place; a new star goes on top, like the API orders them.
        if (rows.some((row) => row.sessionId === sessionId))
          return rows.map((row) => (row.sessionId === sessionId ? { ...row, name: saved.name } : row));
        return [{ ...saved, createdAt: new Date().toISOString() }, ...rows];
      });
    }, fail);
  const remove = (sessionId: string) =>
    favoritesApi.remove(sessionId).then(() => {
      setFavorites((current) => current?.filter((row) => row.sessionId !== sessionId) ?? null);
      notify("Removida dos favoritos");
    }, fail);
  return { favorites, save, remove };
}

/** The account's privacy settings, saved optimistically and rolled back when the API refuses. */
export function usePrivacyState() {
  const [privacy, setPrivacy] = useState<Privacy>(DEFAULT_PRIVACY);
  useEffect(() => {
    privacyApi.get().then(setPrivacy).catch(() => undefined);
  }, []);
  return useMemo(
    () => ({
      privacy,
      save: async (next: Privacy) => {
        setPrivacy(next);
        try {
          setPrivacy(await privacyApi.save(next));
        } catch (reason) {
          setPrivacy(privacy);
          throw reason;
        }
      },
      set: setPrivacy,
    }),
    [privacy],
  );
}
