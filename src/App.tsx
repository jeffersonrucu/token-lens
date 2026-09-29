import {
  Suspense,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Activity, ChevronDown, FolderKanban, LogOut, ShieldCheck, Star, UserCog } from "lucide-react";
import { authApi, metaApi, type Account } from "./api";
import {
  PrivacyContext,
  PALETTE_KEY,
  savedPalette,
  PaletteContext,
  Toaster,
  AuthContext,
  paletteFavicon,
  Brand,
  useUsageStream,
  type UsageStream,
  ListSkeleton,
  cssColor,
  usePrivacyState,
  urlPeriod,
  periodQuery,
  type Period,
} from "./ui";
import { FavoritesScreen, SessionsScreen, ProjectsScreen } from "./lists";
import { SessionDetailScreen } from "./detail";

// Screens off the everyday path load on demand, keeping them out of the first page load.
const Onboarding = lazy(() => import("./onboarding").then((m) => ({ default: m.Onboarding })));
const ClaudeSetup = lazy(() => import("./onboarding").then((m) => ({ default: m.ClaudeSetup })));
const PolicySetup = lazy(() => import("./onboarding").then((m) => ({ default: m.PolicySetup })));
const PrivacySetup = lazy(() => import("./onboarding").then((m) => ({ default: m.PrivacySetup })));
const PrivacyScreen = lazy(() => import("./account").then((m) => ({ default: m.PrivacyScreen })));
const AccountScreen = lazy(() => import("./account").then((m) => ({ default: m.AccountScreen })));
const HubHome = lazy(() => import("./hub").then((m) => ({ default: m.HubHome })));
const ShareViewer = lazy(() => import("./hub").then((m) => ({ default: m.ShareViewer })));

const opening = (
  <main className="onboarding-shell">
    <p className="auth-loading">Abrindo o monitor…</p>
  </main>
);

function AppShell({
  children,
  section,
  onNavigate,
}: {
  children: React.ReactNode;
  section: "sessions" | "projects" | "favorites" | "privacy" | "account";
  onNavigate: (to: string) => void;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const auth = useContext(AuthContext);
  const avatarSeed = auth?.account.avatarSeed;
  const [accountAvatar, setAccountAvatar] = useState<string>();
  // DiceBear and its style are large and only draw this picture, so they load after the first paint.
  useEffect(() => {
    if (avatarSeed === undefined) return;
    let current = true;
    void Promise.all([import("@dicebear/core"), import("@dicebear/styles/bottts-neutral.json")]).then(
      ([{ Avatar, Style }, { default: style }]) => {
        if (current) setAccountAvatar(new Avatar(new Style(style), { seed: avatarSeed, size: 64 }).toDataUri());
      },
    );
    return () => {
      current = false;
    };
  }, [avatarSeed]);
  useEffect(() => {
    if (!profileOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && profileRef.current?.contains(event.target as Node)) return;
      setProfileOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [profileOpen]);
  if (!auth) throw new Error("AppShell precisa de uma sessão autenticada");
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Ir para conteúdo
      </a>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Navegação principal">
          <button
            className={section === "sessions" ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate("/")}
          >
            <Activity aria-hidden="true" size={16} strokeWidth={1.8} />
            Sessões
          </button>
          <button
            className={section === "projects" ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate("/projects")}
          >
            <FolderKanban aria-hidden="true" size={16} strokeWidth={1.8} />
            Projetos
          </button>
          <button
            className={section === "favorites" ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate("/favorites")}
          >
            <Star aria-hidden="true" size={16} strokeWidth={1.8} />
            Favoritos
          </button>
        </nav>
        <nav className="sidebar-settings" aria-label="Configurações">
          <button
            className={section === "privacy" ? "nav-item active" : "nav-item"}
            onClick={() => onNavigate("/privacy")}
          >
            <ShieldCheck aria-hidden="true" size={16} strokeWidth={1.8} />
            Privacidade
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-profile" ref={profileRef}>
            <button
              className="sidebar-account"
              type="button"
              onClick={() => setProfileOpen((open) => !open)}
              aria-expanded={profileOpen}
            >
              <img src={accountAvatar} alt="" />
              <span>{auth.account.name || auth.account.email}</span>
              <ChevronDown aria-hidden="true" size={14} />
            </button>
            {profileOpen && (
              <div className="sidebar-profile-menu">
                <div className="sidebar-profile-info">
                  <strong>{auth.account.name || auth.account.email}</strong>
                  {auth.account.name && <span>{auth.account.email}</span>}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    onNavigate("/account");
                  }}
                >
                  <UserCog aria-hidden="true" size={15} strokeWidth={1.8} />
                  Configurações da conta
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={() => void auth.logout()}
                >
                  <LogOut aria-hidden="true" size={15} strokeWidth={1.8} />
                  Sair
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
      <main id="main" className="main-content">
        {children}
      </main>
    </div>
  );
}

const currentLocation = () => ({ path: window.location.pathname, search: window.location.search });

function usePath() {
  const [location, setLocation] = useState(currentLocation);
  useEffect(() => {
    const sync = () => setLocation(currentLocation());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  // Replacing is for filters: the back button should leave the page, not step through each choice.
  const navigate = useCallback((to: string, replace = false) => {
    window.history[replace ? "replaceState" : "pushState"](null, "", to);
    setLocation(currentLocation());
    if (!replace) window.scrollTo(0, 0);
  }, []);
  return [location, navigate] as const;
}

function Monitor() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("Monitor precisa de uma sessão autenticada");
  // Lives above both screens so switching pages keeps the same stream.
  const liveStream = useUsageStream(auth.logout);
  const privacyContext = usePrivacyState();
  const { privacy } = privacyContext;
  const stream: UsageStream = privacy.paused ? { ...liveStream, status: "paused" } : liveStream;
  const [{ path, search }, navigate] = usePath();
  const projectPeriod = urlPeriod(search, ["today", "week", "month", "all"]);
  const setPeriod = (period: Period) => navigate(`${path}${periodQuery(period)}`, true);
  const [, sessionId, agentId] = /^\/sessions\/([^/]+)(?:\/agents\/(\w+))?$/.exec(path) ?? [];
  const projectPath = /^\/projects\/([^/]+)$/.exec(path)?.[1];
  const inProjects = path.startsWith("/projects");
  const inPrivacy = path === "/privacy";
  const inAccount = path === "/account";
  const inFavorites = path === "/favorites";
  return (
    <PrivacyContext.Provider value={privacyContext}>
      <AppShell
        section={inPrivacy ? "privacy" : inAccount ? "account" : inProjects ? "projects" : inFavorites ? "favorites" : "sessions"}
        onNavigate={navigate}
      >
        <Suspense fallback={<ListSkeleton label="Abrindo…" />}>
          {inPrivacy ? (
            <PrivacyScreen />
          ) : inAccount ? (
            <AccountScreen />
          ) : inFavorites ? (
            <FavoritesScreen stream={stream} onOpen={(id) => navigate(`/sessions/${id}`)} />
          ) : sessionId ? (
            <SessionDetailScreen
              key={path}
              kind="session"
              id={decodeURIComponent(sessionId)}
              agent={agentId}
              stream={stream}
              onBack={() => navigate(agentId ? `/sessions/${sessionId}` : "/")}
              onOpenAgent={(agent) => navigate(`/sessions/${sessionId}/agents/${agent}`)}
              onOpenSession={(other) => navigate(`/sessions/${other}`)}
            />
          ) : projectPath ? (
            <SessionDetailScreen
              // Both detail screens share a slot; the key resets it when switching between them.
              key={path}
              kind="project"
              id={decodeURIComponent(projectPath)}
              period={projectPeriod}
              stream={stream}
              onBack={() => navigate(`/projects${periodQuery(projectPeriod)}`)}
            />
          ) : inProjects ? (
            <ProjectsScreen
              stream={stream}
              period={projectPeriod}
              onPeriod={setPeriod}
              // Carried into the detail so it counts the same period as the list.
              onOpen={(project) => navigate(`/projects/${encodeURIComponent(project)}${periodQuery(projectPeriod)}`)}
            />
          ) : (
            <SessionsScreen
              stream={stream}
              period={urlPeriod(search, ["today", "all"])}
              onPeriod={setPeriod}
              onOpen={(id) => navigate(`/sessions/${id}`)}
            />
          )}
        </Suspense>
      </AppShell>
    </PrivacyContext.Provider>
  );
}

export default function App() {
  const [palette, setPalette] = useState(savedPalette);
  const paletteValue = useMemo(() => ({ palette, setPalette }), [palette]);
  // Layout effect: the attribute lands before the first paint, so there is no flash of the default.
  useLayoutEffect(() => {
    document.documentElement.dataset.palette = palette;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", cssColor("--bg"));
    document.querySelector('link[rel="icon"]')?.setAttribute("href", paletteFavicon());
    try {
      localStorage.setItem(PALETTE_KEY, palette);
    } catch {
      // Private mode: the choice just won't survive a reload.
    }
  }, [palette]);
  const [account, setAccount] = useState<Account | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [step, setStep] = useState<"privacy" | "claude" | "policy">("privacy");
  const [hub, setHub] = useState(false);
  // A shared link opens without an account, so it skips the login check.
  const shareToken = /^\/s\/([^/]+)$/.exec(window.location.pathname)?.[1];
  useEffect(() => {
    if (shareToken) return;
    void Promise.all([
      metaApi.get().then((meta) => setHub(meta.hub)).catch(() => undefined),
      authApi.profile().then(({ user }) => setAccount(user)).catch(() => undefined),
    ]).finally(() => setCheckingSession(false));
  }, [shareToken]);
  const auth = useMemo(
    () =>
      account && {
        account,
        logout: async () => {
          try {
            await authApi.logout();
          } finally {
            setAccount(null);
          }
        },
      },
    [account],
  );
  if (shareToken)
    return (
      <PaletteContext.Provider value={paletteValue}>
        <Suspense fallback={opening}>
          <ShareViewer token={decodeURIComponent(shareToken)} />
        </Suspense>
      </PaletteContext.Provider>
    );
  if (checkingSession) return opening;
  if (!auth)
    return (
      <Suspense fallback={opening}>
        <Onboarding onComplete={setAccount} hub={hub} />
      </Suspense>
    );
  if (hub)
    return (
      <PaletteContext.Provider value={paletteValue}>
        <Toaster>
          <AuthContext.Provider value={auth}>
            <Suspense fallback={opening}>
              <HubHome />
            </Suspense>
          </AuthContext.Provider>
        </Toaster>
      </PaletteContext.Provider>
    );
  const logout = () => {
    setStep("privacy");
    void auth.logout();
  };
  return (
    <PaletteContext.Provider value={paletteValue}>
      <Toaster>
        <Suspense fallback={opening}>
          {auth.account.onboarded ? (
            <AuthContext.Provider value={auth}>
              <Monitor />
            </AuthContext.Provider>
          ) : step === "policy" ? (
            <PolicySetup onComplete={setAccount} onBack={() => setStep("claude")} onLogout={logout} />
          ) : step === "claude" ? (
            <ClaudeSetup onNext={() => setStep("policy")} onBack={() => setStep("privacy")} onLogout={logout} />
          ) : (
            <PrivacySetup onNext={() => setStep("claude")} onLogout={logout} />
          )}
        </Suspense>
      </Toaster>
    </PaletteContext.Provider>
  );
}
