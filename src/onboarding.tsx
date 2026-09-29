import { useEffect, useMemo, useState } from "react";
import { Avatar, Style } from "@dicebear/core";
import botttsNeutral from "@dicebear/styles/bottts-neutral.json";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { ApiError, type ClaudeStatus, authApi, claudeApi, privacyApi, type Account } from "./api";
import {
  PrivacyContext,
  Brand,
  PasswordInput,
  PageHeader,
  usePrivacyState,
} from "./ui";
import { PrivacyChoices } from "./account";

const diceBearStyle = new Style(botttsNeutral);

// Where the hub's e-mail confirmation link lands: /?verified=1, or 0 when the link had expired.
const verified = new URLSearchParams(window.location.search).get("verified");

export function Onboarding({ onComplete, hub = false }: { onComplete: (account: Account) => void; hub?: boolean }) {
  const [mode, setMode] = useState<"signup" | "login">("login");
  const [notice, setNotice] = useState(verified === "1" ? "E-mail confirmado. Entre com sua senha." : "");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [seed, setSeed] = useState(() => crypto.randomUUID());
  const [password, setPassword] = useState("");
  const [error, setError] = useState(verified === "0" ? "O link de confirmação expirou ou já foi usado. Crie a conta de novo para receber outro." : "");
  const [submitting, setSubmitting] = useState(false);
  const avatar = useMemo(
    () => new Avatar(diceBearStyle, { seed, size: 128 }).toDataUri(),
    [seed],
  );
  const switchTo = (next: "signup" | "login") => {
    setMode(next);
    setError("");
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setSubmitting(true);
    try {
      const result =
        mode === "signup"
          ? await authApi.signup({ name, email, password, avatarSeed: seed })
          : await authApi.login({ email, password });
      if ("pending" in result) {
        setMode("login");
        setNotice(`Enviamos um link de confirmação para ${email}. Abra o link e depois entre aqui.`);
        return;
      }
      onComplete(result.user);
    } catch (reason) {
      setError(
        reason instanceof ApiError
          ? reason.message
          : "Não foi possível conectar ao serviço local.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <div className="onboarding-intro">
          <Brand className="brand-intro" />
          <p className="eyebrow">{hub ? "HUB DE COMPARTILHAMENTO" : "MONITOR DE USO"}</p>
          <h1>
            {mode === "signup" ? "Crie sua conta" : "Entre na sua conta"}
          </h1>
          <p>
            {hub
              ? "Gere a chave de envio do seu monitor local e acompanhe os links que você compartilhou."
              : "Acompanhe em tempo real os tokens de cada sessão do Claude Code, do Codex e do pi."}
          </p>
          <div className="onboarding-points">
            <span>
              <ShieldCheck size={15} />
              {hub ? "Recebe só números, nunca o chat" : "Lê só os registros locais dos agentes"}
            </span>
            <span>
              <Activity size={15} />
              {hub ? "Links ao vivo, com expiração e revogação" : "Atualiza a cada resposta, sem recarregar"}
            </span>
          </div>
        </div>
        <form onSubmit={submit} className="onboarding-form">
          <div className="auth-tabs">
            <button
              type="button"
              className={mode === "login" ? "active" : ""}
              onClick={() => switchTo("login")}
            >
              Entrar
            </button>
            <button
              type="button"
              className={mode === "signup" ? "active" : ""}
              onClick={() => switchTo("signup")}
            >
              Criar conta
            </button>
          </div>
          {mode === "signup" && (
            <>
              <div className="avatar-picker">
                <img src={avatar} alt="Avatar gerado" />
                <div>
                  <strong>Seu avatar</strong>
                  <span>Gerado localmente com DiceBear</span>
                  <button
                    type="button"
                    onClick={() => setSeed(crypto.randomUUID())}
                  >
                    <RefreshCw size={14} />
                    Gerar outro
                  </button>
                </div>
              </div>
              <label>
                Nome
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Como devemos chamar você?"
                />
              </label>
            </>
          )}
          <label>
            E-mail
            <input
              required
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="voce@empresa.com"
            />
          </label>
          <label>
            Senha
            <PasswordInput
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={mode === "signup" ? 8 : undefined}
              placeholder={
                mode === "signup" ? "Mínimo de 8 caracteres" : "Sua senha"
              }
            />
          </label>
          {notice && (
            <p className="auth-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button primary onboarding-submit"
            disabled={submitting}
            aria-busy={submitting || undefined}
          >
            <Sparkles size={16} />
            {submitting
              ? "Aguarde…"
              : mode === "signup"
                ? "Criar conta"
                : "Entrar"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function ClaudeSetup({
  onNext,
  onBack,
  onLogout,
}: {
  onNext: () => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const failure = (reason: unknown) =>
    setError(
      reason instanceof ApiError
        ? reason.message
        : "Não foi possível conectar ao serviço local.",
    );
  const load = () =>
    claudeApi
      .status()
      .then(setStatus)
      .catch(failure)
      .finally(() => setBusy(false));
  useEffect(() => void load(), []);
  const check = () => {
    setBusy(true);
    setError("");
    void load();
  };
  const problem = error || (status && !status.ok ? status.message : "");
  return (
    <main className="onboarding-shell">
      <section className="onboarding-card">
        <div className="onboarding-intro">
          <Brand className="brand-intro" />
          <p className="eyebrow">PRIMEIRO ACESSO · 2 DE 3</p>
          <h1>Conecte seus agentes</h1>
          <p>
            O monitor lê as sessões que o Claude Code, o Codex e o pi gravam neste computador.
            Antes de abrir o painel, vamos confirmar que elas estão acessíveis.
          </p>
        </div>
        <div className="onboarding-form" aria-live="polite">
          {busy && !status ? (
            <p className="auth-loading">Procurando as sessões dos agentes…</p>
          ) : status?.ok && !error ? (
            <p className="claude-check ok">
              <Check size={16} />
              Conectado: {status.sessions}{" "}
              {status.sessions === 1 ? "sessão encontrada" : "sessões encontradas"}.
            </p>
          ) : (
            <p className="auth-error" role="alert">
              {problem}
            </p>
          )}
          {status && <code className="claude-root">{status.root}</code>}
          {status?.ok && !error ? (
            <button
              type="button"
              className="button primary onboarding-submit"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={onNext}
            >
              <ChevronRight size={16} />
              Continuar
            </button>
          ) : (
            <button
              type="button"
              className="button primary onboarding-submit"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={check}
            >
              <RefreshCw size={16} />
              {busy ? "Verificando…" : "Tentar de novo"}
            </button>
          )}
          <button type="button" className="button secondary" onClick={onBack} disabled={busy}>
            <ChevronLeft size={16} />
            Voltar para privacidade
          </button>
          <button type="button" className="button secondary" onClick={onLogout}>
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </section>
    </main>
  );
}

export function PolicySetup({
  onComplete,
  onBack,
  onLogout,
}: {
  onComplete: (account: Account) => void;
  onBack: () => void;
  onLogout: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const finish = () => {
    setBusy(true);
    setError("");
    claudeApi
      .finishOnboarding()
      .then(({ user }) => onComplete(user))
      .catch((reason: unknown) => {
        setError(
          reason instanceof ApiError
            ? reason.message
            : "Não foi possível conectar ao serviço local.",
        );
        setBusy(false);
      });
  };
  return (
    <main className="setup-shell">
      <div className="setup-page">
        <Brand />
        <PageHeader eyebrow="PRIMEIRO ACESSO · 3 DE 3" title="Política de privacidade" />
        <p className="setup-lead">
          O TokenLens foi feito para rodar localmente, na sua máquina. A API e o painel ficam
          neste computador, sem um servidor nosso do outro lado: somente você tem acesso ao que o
          monitor lê.
        </p>
        <section className="settings-card">
          <h2>Como funciona</h2>
          <ul>
            <li>A API escuta apenas em 127.0.0.1, e o painel abre no seu navegador.</li>
            <li>
              Ela lê os registros que o Claude Code, o Codex e o pi já gravam neste computador
              (<code>~/.claude/projects</code>, <code>~/.codex/sessions</code> e{" "}
              <code>~/.pi/agent/sessions</code>) e soma os tokens de cada sessão.
            </li>
            <li>A leitura é somente leitura: nada nessas pastas é alterado ou apagado.</li>
            <li>No modo manual, só as pastas que você escolheu são lidas.</li>
          </ul>
        </section>
        <section className="settings-card">
          <h2>Onde os dados ficam</h2>
          <ul>
            <li>
              <code>~/.tokenlens/app.db</code>: sua conta (nome, e-mail, avatar e senha
              armazenada como hash Argon2), logins e configurações de privacidade.
            </li>
            <li>
              <code>~/.tokenlens/usage-cache.json</code>: os totais de tokens, para a API não
              precisar reler tudo a cada inicialização.
            </li>
            <li>
              A conta existe apenas neste computador. Excluir a conta apaga os dados associados a
              ela.
            </li>
          </ul>
        </section>
        <section className="settings-card">
          <h2>Nenhum dado sai daqui</h2>
          <p>
            Não há telemetria, analytics nem envio automático. O monitor não envia chats, prompts,
            caminhos ou números para nenhum lugar.
          </p>
          <p>
            A única exceção é o botão para compartilhar uma sessão ou um projeto. Ele só funciona
            depois que você cria uma conta em um servidor Hub, gera sua chave de envio e informa a
            URL e a chave em Conta → Compartilhamento. Sem isso, o botão não funciona e nada é
            enviado.
          </p>
        </section>
        <section className="settings-card">
          <h2>Se você compartilhar</h2>
          <ul>
            <li>
              São enviados apenas o título e os números: tokens, custo, modelos e linha do tempo.
              Chat, prompts, caminhos, descrições de tarefas, argumentos de comandos e comandos de
              hooks ficam no computador.
            </li>
            <li>
              O título sugerido usa o início do primeiro prompt (ou o nome da pasta, no caso de um
              projeto) e pode ser editado. Com "Esconder caminhos completos", ele fica genérico,
              como "Sessão de 18/09/2026".
            </li>
            <li>
              Você escolhe quem pode ver: qualquer pessoa com o link ou apenas uma lista de
              e-mails. Também pode definir uma data de expiração.
            </li>
            <li>A conexão com o Hub exige HTTPS, exceto quando o Hub está nesta mesma máquina.</li>
            <li>
              Pausar o monitoramento ou desconectar o Hub interrompe novos envios, mas os links já
              criados continuam ativos até serem revogados. Revogar um link apaga os dados dele no
              Hub.
            </li>
          </ul>
        </section>
        <p className="setup-lead">
          Fontes, ícones e bibliotecas vêm junto com o monitor: fora do Hub, o painel não faz
          nenhuma conexão externa.
        </p>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <div className="setup-actions">
          <button type="button" className="button secondary" onClick={onLogout}>
            <LogOut size={16} />
            Sair
          </button>
          <button type="button" className="button secondary" onClick={onBack} disabled={busy}>
            <ChevronLeft size={16} />
            Voltar
          </button>
          <button
            type="button"
            className="button primary"
            onClick={finish}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            <Sparkles size={16} />
            {busy ? "Aguarde…" : "Concordo, abrir o painel"}
          </button>
        </div>
      </div>
    </main>
  );
}

export function PrivacySetup({ onNext, onLogout }: { onNext: () => void; onLogout: () => void }) {
  const privacyContext = usePrivacyState();
  const { privacy } = privacyContext;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const noFolders = privacy.mode === "manual" && !privacy.projects.length;
  // Saving here too records the choice even when the defaults were kept untouched.
  const next = () => {
    setBusy(true);
    setError("");
    privacyApi
      .save(privacy)
      .then(onNext)
      .catch((reason: unknown) => {
        setError(
          reason instanceof ApiError
            ? reason.message
            : "Não foi possível conectar ao serviço local.",
        );
        setBusy(false);
      });
  };
  return (
    <PrivacyContext.Provider value={privacyContext}>
      <main className="setup-shell">
        <div className="setup-page">
          <Brand />
          <PageHeader eyebrow="PRIMEIRO ACESSO · 1 DE 3" title="Privacidade" />
          <p className="setup-lead">
            Antes de ler qualquer sessão, escolha o que o monitor pode ler e mostrar.
            Dá para mudar depois em Privacidade.
          </p>
          <PrivacyChoices />
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <div className="setup-actions">
            <button type="button" className="button secondary" onClick={onLogout}>
              <LogOut size={16} />
              Sair
            </button>
            <button
              type="button"
              className="button primary"
              onClick={next}
              disabled={busy || noFolders}
              aria-busy={busy || undefined}
              title={noFolders ? "Escolha ao menos uma pasta" : undefined}
            >
              <ChevronRight size={16} />
              {busy ? "Salvando…" : "Continuar"}
            </button>
          </div>
        </div>
      </main>
    </PrivacyContext.Provider>
  );
}
