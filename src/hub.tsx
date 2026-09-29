import { useContext, useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import {
  ApiError,
  hubApi,
  viewerApi,
  type SessionDetail,
  type Share,
  type SharedView,
} from "./api";
import {
  AuthContext,
  Brand,
  PageHeader,
  type StreamStatus,
  dateTime,
  StatusBadge,
  ConfirmDialog,
  failure,
  CopyLink,
} from "./ui";
import { type DetailSection, ALL_SECTIONS, PROJECT_EXCLUDED, DetailBody } from "./detail";
import { DeleteAccountSection } from "./account";

/** Hub home: the key a local monitor sends with, and every link the account has made. */
export function HubHome() {
  const auth = useContext(AuthContext);
  const [key, setKey] = useState("");
  const [shares, setShares] = useState<Omit<Share, "url">[] | null>(null);
  const [revoking, setRevoking] = useState<Omit<Share, "url"> | null>(null);
  const [confirmingKey, setConfirmingKey] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    hubApi
      .shares()
      .then(({ shares }) => setShares(shares))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível carregar seus links.")));
  }, []);
  const createKey = () => {
    setConfirmingKey(false);
    setError("");
    hubApi
      .createKey()
      .then(({ key }) => setKey(key))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível gerar a chave.")));
  };
  const revoke = (id: string) => {
    setRevoking(null);
    hubApi
      .revoke(id)
      .then(() => setShares((current) => current?.filter((share) => share.id !== id) ?? null))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível revogar o link.")));
  };
  return (
    <main className="setup-shell">
      <div className="setup-page">
        <Brand />
        <PageHeader
          eyebrow="HUB DE COMPARTILHAMENTO"
          title={`Olá, ${auth?.account.name ?? ""}`}
          actions={
            <button className="button secondary" onClick={() => void auth?.logout()}>
              <LogOut size={14} aria-hidden="true" />
              Sair
            </button>
          }
        />
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <section className="settings-card">
          <h2>Chave de envio</h2>
          <p>
            Cole a chave no seu monitor local, em Conta → Compartilhamento. Ela só aparece uma vez, e gerar
            outra desliga a anterior em todo monitor que a usa.
          </p>
          {key ? (
            <div className="hub-key">
              <code>{key}</code>
              <CopyLink url={key} />
            </div>
          ) : (
            <div className="settings-actions">
              <button className="button primary" onClick={() => setConfirmingKey(true)}>
                Gerar chave
              </button>
            </div>
          )}
        </section>
        <section className="settings-card">
          <h2>Meus links</h2>
          {shares === null ? (
            <p>Carregando…</p>
          ) : shares.length ? (
            <ul className="share-list">
              {shares.map((share) => (
                <li key={share.id}>
                  <span>
                    <strong>{share.title}</strong>
                    <small>
                      {share.kind === "project" ? "Projeto" : "Sessão"}
                      {" · "}
                      {share.access === "public" ? "qualquer pessoa com o link" : share.emails.join(", ")}
                      {" · "}
                      {share.expiresAt ? `expira em ${dateTime.format(new Date(share.expiresAt))}` : "não expira"}
                      {" · "}
                      {share.updatedAt ? `atualizado em ${dateTime.format(new Date(share.updatedAt))}` : "sem dados ainda"}
                    </small>
                  </span>
                  <button type="button" className="button ghost" onClick={() => setRevoking(share)}>
                    Revogar
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nenhum link ainda. Crie um pelo botão "Compartilhar" de uma sessão ou projeto no monitor local.</p>
          )}
        </section>
        <DeleteAccountSection />
      </div>
      {confirmingKey && (
        <ConfirmDialog
          title="Gerar uma chave nova?"
          confirmLabel="Gerar chave"
          danger={false}
          safe="Os links já criados continuam no ar com os últimos dados enviados."
          onConfirm={createKey}
          onClose={() => setConfirmingKey(false)}
        >
          <p>Se já existe uma chave, ela para de funcionar: cole a nova em cada monitor local que compartilha.</p>
        </ConfirmDialog>
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revogar "${revoking.title}"?`}
          confirmLabel="Revogar link"
          safe="Nada muda no monitor local: a sessão continua lá. Dá para criar outro link depois."
          onConfirm={() => revoke(revoking.id)}
          onClose={() => setRevoking(null)}
        >
          <p>O link para de abrir na hora, para todo mundo, e os dados dele são apagados do hub.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

// Everything except the chat, which never reaches the hub.
const VIEWER_EXCLUDED: DetailSection[] = ["chat"];

/** A /s/:token link: the same detail screen, read-only and live. */
export function ShareViewer({ token }: { token: string }) {
  const [view, setView] = useState<SharedView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "access" | "missing">("loading");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState("");
  // Pasting the access link into this same tab only changes the fragment, so it reloads to read it.
  useEffect(() => {
    const reload = () => window.location.reload();
    window.addEventListener("hashchange", reload);
    return () => window.removeEventListener("hashchange", reload);
  }, []);
  useEffect(() => {
    // The e-mail link carries its one-time code in the fragment, which never reaches the server logs.
    const code = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (code) window.history.replaceState(null, "", window.location.pathname);
    (code ? viewerApi.confirm(code).catch((reason: unknown) => setError(failure(reason, "Link de acesso inválido."))) : Promise.resolve())
      .then(() => viewerApi.get(token))
      .then((next) => {
        setView(next);
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 403) return setState("access");
        setError(failure(reason, "Não foi possível abrir o link."));
        setState("missing");
      });
  }, [token]);
  useEffect(() => {
    if (state !== "ready") return;
    const source = new EventSource(viewerApi.streamUrl(token));
    source.onopen = () => setStatus("live");
    // A revoked or expired link answers 404 and the browser stops retrying.
    source.onerror = () => setStatus("offline");
    source.addEventListener("update", (event) => {
      const detail = JSON.parse((event as MessageEvent<string>).data) as SessionDetail;
      setView((current) => current && { ...current, detail, updatedAt: new Date().toISOString() });
    });
    return () => source.close();
  }, [state, token]);
  const ask = (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    viewerApi
      .requestAccess(token, email)
      .then(() => setAsked(true))
      .catch((reason: unknown) => setError(failure(reason, "Não foi possível pedir o acesso.")));
  };
  if (state === "access")
    return (
      <main className="onboarding-shell">
        <form className="settings-card share-access" onSubmit={ask}>
          <Brand className="brand-intro" />
          <h1>Este link é restrito</h1>
          {asked ? (
            <p className="auth-notice" role="status">
              Se {email} tiver acesso, um link chega no e-mail em instantes. Ele vale por 15 minutos.
            </p>
          ) : (
            <>
              <p>Informe seu e-mail. Se ele estiver na lista de quem compartilhou, você recebe um link de acesso.</p>
              <label className="confirm-field">
                E-mail
                <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <button className="button primary">Enviar link de acesso</button>
            </>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
        </form>
      </main>
    );
  if (state !== "ready" || !view)
    return (
      <main className="onboarding-shell">
        <p className={state === "missing" ? "page-state error" : "auth-loading"}>
          {state === "missing" ? error : "Abrindo o link…"}
        </p>
      </main>
    );
  return (
    <main className="setup-shell">
      <div className="setup-page share-page">
        <Brand />
        <PageHeader
          eyebrow={`COMPARTILHADO · ${view.kind === "project" ? "PROJETO" : "SESSÃO"}`}
          title={view.title}
          actions={<StatusBadge status={status} />}
        />
        {view.detail ? (
          <DetailBody
            kind={view.kind}
            detail={view.detail}
            order={ALL_SECTIONS}
            show={() => true}
            excluded={view.kind === "project" ? PROJECT_EXCLUDED : VIEWER_EXCLUDED}
            hidePaths
          />
        ) : (
          <p className="page-state">Aguardando os primeiros dados do monitor de quem compartilhou.</p>
        )}
      </div>
    </main>
  );
}
