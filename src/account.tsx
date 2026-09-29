import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, Folder, FolderPlus, RefreshCw, X } from "lucide-react";
import { authApi, privacyApi, shareApi, type FolderListing, type Privacy } from "./api";
import {
  PrivacyContext,
  palettes,
  PaletteContext,
  ToastContext,
  AuthContext,
  PasswordInput,
  PageHeader,
  ListSkeleton,
  dateTime,
  ConfirmDialog,
  ClearHistoryButton,
  failure,
} from "./ui";

function FolderPickerDialog({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const browse = useCallback((path?: string) => {
    privacyApi
      .folders(path)
      .then((next) => {
        setListing(next);
        setError("");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Não foi possível abrir esta pasta."),
      );
  }, []);
  useEffect(() => {
    ref.current?.showModal();
    browse();
  }, [browse]);
  return (
    <dialog ref={ref} className="confirm-dialog folder-picker" aria-labelledby={titleId} onClose={onClose}>
      <h2 id={titleId}>Escolher pasta</h2>
      <p className="confirm-path">{listing?.path ?? <span className="skeleton skeleton-line" aria-hidden="true" />}</p>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {!listing && !error && <ListSkeleton label="Abrindo pasta…" rows={5} className="folder-list" />}
      <ul className="folder-list" hidden={!listing}>
        {listing?.parent && (
          <li>
            <button type="button" onClick={() => browse(listing.parent ?? undefined)}>
              <ArrowLeft size={14} aria-hidden="true" />
              <span>Voltar</span>
            </button>
          </li>
        )}
        {listing?.folders.map((folder) => (
          <li key={folder.path}>
            <button type="button" onClick={() => browse(folder.path)}>
              <Folder size={14} aria-hidden="true" />
              <span>{folder.path.split(/[\\/]/).at(-1)}</span>
              {folder.hasSessions && <em>com sessões</em>}
            </button>
          </li>
        ))}
        {listing && !listing.folders.length && <li className="detail-empty">Nenhuma subpasta.</li>}
      </ul>
      <div className="confirm-actions">
        <button className="button secondary" onClick={onClose}>
          Cancelar
        </button>
        <button className="button primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
          Monitorar esta pasta
        </button>
      </div>
    </dialog>
  );
}

function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function DeleteAccountSection() {
  const auth = useContext(AuthContext);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const close = () => {
    setConfirming(false);
    setPassword("");
    setError("");
  };
  const remove = () => {
    if (deleting) return;
    if (!password) return setError("Digite sua senha para confirmar.");
    setError("");
    setDeleting(true);
    authApi
      .deleteAccount(password)
      .then(() => auth?.logout())
      .catch((reason: unknown) => {
        setDeleting(false);
        setError(reason instanceof Error ? reason.message : "Não foi possível excluir a conta.");
      });
  };
  return (
    <section className="settings-card">
      <h2>Conta</h2>
      <p>Exclui sua conta e tudo que o monitor guardou sobre ela. Não dá para desfazer.</p>
      <div className="settings-actions">
        <button className="button danger" onClick={() => setConfirming(true)}>
          Excluir conta e dados
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          title="Excluir sua conta?"
          confirmLabel={deleting ? "Excluindo…" : "Excluir conta"}
          safe="Nada do Claude Code é apagado: as sessões continuam no computador e no painel das outras contas."
          busy={deleting}
          onConfirm={remove}
          onClose={close}
        >
          <p>A exclusão é imediata e não pode ser desfeita.</p>
          <ul>
            <li>Seu login, nome, e-mail e avatar.</li>
            <li>Suas configurações de privacidade e a ordem das seções.</li>
            <li>Todas as sessões abertas desta conta, em qualquer navegador.</li>
          </ul>
          <label className="confirm-field">
            Digite sua senha para confirmar
            <PasswordInput
              autoComplete="current-password"
              value={password}
              readOnly={deleting}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && remove()}
            />
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

/** Tracking mode and display options; each change is saved right away. */
export function PrivacyChoices() {
  const { privacy, save } = useContext(PrivacyContext);
  const notify = useContext(ToastContext);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const update = (patch: Partial<Privacy>) => {
    setError("");
    save({ ...privacy, ...patch })
      .then(() => notify("Configuração salva"))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Não foi possível salvar."),
      );
  };
  return (
    <>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <section className="settings-card">
        <h2>Rastreamento</h2>
        <fieldset className="settings-choice">
          <legend className="sr-only">Modo de rastreamento</legend>
          <label>
            <input type="radio" name="mode" checked={privacy.mode === "auto"} onChange={() => update({ mode: "auto" })} />
            <span>
              <strong>Automático</strong>
              <small>Todo projeto em que você usar o Claude Code aparece aqui sozinho.</small>
            </span>
          </label>
          <label>
            <input type="radio" name="mode" checked={privacy.mode === "manual"} onChange={() => update({ mode: "manual" })} />
            <span>
              <strong>Manual</strong>
              <small>Só as pastas que você escolher são lidas. Projetos novos não aparecem até você adicioná-los.</small>
            </span>
          </label>
        </fieldset>
        {privacy.mode === "manual" && (
          <div className="settings-projects">
            {privacy.projects.length ? (
              <ul>
                {privacy.projects.map((path) => (
                  <li key={path}>
                    <Folder size={14} aria-hidden="true" />
                    <span title={path}>{path}</span>
                    <button
                      className="icon-button"
                      aria-label={`Parar de monitorar ${path}`}
                      onClick={() => update({ projects: privacy.projects.filter((item) => item !== path) })}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="detail-empty">Nenhuma pasta escolhida: nada está sendo monitorado.</p>
            )}
            <button className="button secondary" onClick={() => setPicking(true)}>
              <FolderPlus size={14} aria-hidden="true" />
              Escolher pasta
            </button>
          </div>
        )}
      </section>
      <section className="settings-card">
        <h2>Exibição</h2>
        <SettingToggle
          label="Pausar o monitoramento"
          description="O painel para de receber dados novos. Ao retomar, o que foi usado no período entra na conta."
          checked={privacy.paused}
          onChange={(paused) => update({ paused })}
        />
        <SettingToggle
          label="Ocultar o conteúdo do chat"
          description="Esconde o texto das mensagens e dos prompts. Tokens e custo continuam aparecendo."
          checked={privacy.hideChat}
          onChange={(hideChat) => update({ hideChat })}
        />
        <SettingToggle
          label="Esconder caminhos completos"
          description="Mostra só o nome da pasta do projeto, sem o caminho no computador."
          checked={privacy.hidePaths}
          onChange={(hidePaths) => update({ hidePaths })}
        />
      </section>
      {picking && (
        <FolderPickerDialog
          onPick={(path) => {
            setPicking(false);
            if (!privacy.projects.includes(path)) update({ projects: [...privacy.projects, path] });
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

/** Where shares go; nothing leaves this machine until the user shares something. */
function HubSection() {
  const [settings, setSettings] = useState<{ url: string | null; connected: boolean } | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    shareApi.settings().then(setSettings).catch(() => undefined);
  }, []);
  const run = (action: Promise<{ url: string | null; connected: boolean }>) => {
    setError("");
    setBusy(true);
    action
      .then((next) => {
        setSettings(next);
        setKey("");
      })
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível falar com o hub.")))
      .finally(() => setBusy(false));
  };
  return (
    <section className="settings-card">
      <h2>Compartilhamento</h2>
      {settings?.connected ? (
        <>
          <p>
            Conectado a <strong>{settings.url}</strong>. Os links criados continuam no ar até serem revogados, mesmo
            desconectando.
          </p>
          <div className="settings-actions">
            <button className="button secondary" disabled={busy} onClick={() => run(shareApi.disconnect())}>
              Desconectar
            </button>
          </div>
        </>
      ) : (
        <form
          className="hub-form"
          onSubmit={(event) => {
            event.preventDefault();
            run(shareApi.connect(url.trim(), key.trim()));
          }}
        >
          <p>
            Para compartilhar uma sessão ou um projeto, conecte um hub. Crie sua conta nele, gere uma chave de envio
            e cole aqui. Nada é enviado até você compartilhar algo.
          </p>
          <label className="confirm-field">
            URL do hub
            <input type="url" required placeholder="https://tokenlens.exemplo.com.br" value={url} onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="confirm-field">
            Chave de envio
            <PasswordInput required autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <div className="settings-actions">
            <button className="button primary" disabled={busy} aria-busy={busy || undefined}>
              Conectar
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Saved per browser: it's a display preference, not account data. */
function PaletteChoice() {
  const { palette, setPalette } = useContext(PaletteContext);
  return (
    <section className="settings-card">
      <h2>Aparência</h2>
      <fieldset className="settings-choice">
        <legend className="sr-only">Paleta de cores</legend>
        {palettes.map((option) => (
          <label key={option.id}>
            <input type="radio" name="palette" checked={palette === option.id} onChange={() => setPalette(option.id)} />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

export function PrivacyScreen() {
  const { privacy, set } = useContext(PrivacyContext);
  const [confirmingSync, setConfirmingSync] = useState(false);
  const [history, setHistory] = useState<"idle" | "working" | "synced">("idle");
  const [error, setError] = useState("");
  const [cache, setCache] = useState<"idle" | "confirming" | "clearing" | "done">("idle");
  const fail = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message : "Não foi possível salvar.");
  const sync = () => {
    setConfirmingSync(false);
    setError("");
    setHistory("working");
    privacyApi
      .syncHistory()
      .then((next) => {
        set(next);
        setHistory("synced");
      })
      .catch((reason: unknown) => {
        setHistory("idle");
        fail(reason);
      });
  };
  const clearCache = () => {
    setError("");
    setCache("clearing");
    privacyApi
      .clearCache()
      .then(() => setCache("done"))
      .catch((reason: unknown) => {
        setCache("idle");
        fail(reason);
      });
  };
  return (
    <>
      <PageHeader eyebrow="CONFIGURAÇÕES" title="Privacidade" />
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      <PrivacyChoices />
      <section className="settings-card">
        <h2>Histórico</h2>
        <p>
          {privacy.since
            ? `Contando só o uso a partir de ${dateTime.format(new Date(privacy.since))}.`
            : "Mostrando todo o histórico do Claude Code desta máquina."}
        </p>
        <div className="settings-actions">
          <ClearHistoryButton className="button danger" />
          <button
            className="button secondary"
            onClick={() => setConfirmingSync(true)}
            disabled={history === "working"}
            aria-busy={history === "working" || undefined}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {history === "working" ? "Sincronizando…" : "Sincronizar tudo"}
          </button>
          {history === "synced" && <span role="status">Histórico completo de volta.</span>}
        </div>
      </section>
      <section className="settings-card">
        <h2>Cache local</h2>
        <p>
          Apaga os totais guardados pelo monitor e lê o histórico de novo, respeitando o modo manual.
          Nada do Claude Code é apagado.
        </p>
        <div className="settings-actions">
          <button
            className="button secondary"
            onClick={() => setCache("confirming")}
            disabled={cache === "clearing"}
            aria-busy={cache === "clearing" || undefined}
          >
            {cache === "clearing" ? "Limpando…" : "Limpar cache local"}
          </button>
          {cache === "done" && <span role="status">Cache limpo.</span>}
        </div>
      </section>
      {cache === "confirming" && (
        <ConfirmDialog
          title="Limpar o cache local?"
          confirmLabel="Limpar cache"
          safe="Nada do Claude Code é apagado: só o arquivo de cache do monitor (~/.tokenlens/usage-cache.json)."
          onConfirm={clearCache}
          onClose={() => setCache("idle")}
        >
          <p>O monitor esquece os totais que guardou e lê o histórico do Claude Code de novo.</p>
          <ul>
            <li>Vale para todas as contas deste monitor.</li>
            <li>Pode levar alguns segundos; enquanto isso, os números podem aparecer incompletos.</li>
            <li>Pastas que nenhuma conta monitora deixam de ficar guardadas no cache.</li>
            <li>Sessões que o agente já apagou continuam guardadas, porque não dá para lê-las de novo.</li>
            <li>O "Zerar tudo", os projetos removidos e suas configurações continuam valendo.</li>
          </ul>
        </ConfirmDialog>
      )}
      {confirmingSync && (
        <ConfirmDialog
          title="Sincronizar todo o histórico?"
          confirmLabel="Sincronizar tudo"
          danger={false}
          safe="Nada é apagado: só volta a aparecer o que já estava no computador."
          onConfirm={sync}
          onClose={() => setConfirmingSync(false)}
        >
          <p>Volta a mostrar todo o histórico do Claude Code desta máquina.</p>
          <ul>
            <li>Desfaz o "Zerar tudo" da sua conta: as sessões antigas voltam com os totais completos.</li>
            <li>Os projetos que alguém parou de monitorar voltam para todas as contas.</li>
            <li>O modo manual, a pausa e as opções de exibição continuam como estão.</li>
            <li>Pode levar alguns segundos.</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  );
}

export function AccountScreen() {
  return (
    <>
      <PageHeader eyebrow="CONFIGURAÇÕES" title="Conta" />
      <HubSection />
      <PaletteChoice />
      <DeleteAccountSection />
    </>
  );
}
