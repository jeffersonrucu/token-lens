# Como contribuir

Obrigado por querer melhorar o TokenLens! Este guia mostra como rodar o projeto, testar e abrir um
pull request.

## Sumário

- [Preparando o ambiente](#preparando-o-ambiente)
- [Rodando em modo de desenvolvimento](#rodando-em-modo-de-desenvolvimento)
- [Onde fica cada coisa](#onde-fica-cada-coisa)
- [Testes, lint e build](#testes-lint-e-build)
- [Padrões de código](#padrões-de-código)
- [Commits](#commits)
- [Abrindo um pull request](#abrindo-um-pull-request)
- [Privacidade: o que nunca pode entrar no repositório](#privacidade-o-que-nunca-pode-entrar-no-repositório)
- [Tarefas comuns](#tarefas-comuns)

## Preparando o ambiente

Você precisa de **Node.js 24+**, **pnpm 11+** e `make`.

```sh
git clone git@github.com:jeffersonrucu/token-lens.git
cd token-lens
make setup   # pnpm install + cria o .env a partir do .env.example
```

## Rodando em modo de desenvolvimento

```sh
make dev
```

O comando sobe dois processos, e `Ctrl+C` derruba os dois:

| Processo | Endereço | Recarrega sozinho quando |
|---|---|---|
| API (Fastify via `tsx watch`) | `localhost:47831` | um arquivo em `src/server/` muda |
| Front (Vite) | http://localhost:47832 | um arquivo do front muda |

O Vite repassa `/api` para a API, então use sempre a porta **47832** no navegador.

> [!TIP]
> Se você já usa o monitor no dia a dia com o `make start`, pare ele antes (`tokenlens-stop`, se
> tiver o alias do README), porque os dois usam a porta 47832.

O `make dev` lê o **seu** histórico real (`~/.claude/projects`, `~/.codex/sessions` e
`~/.pi/agent/sessions`). Para testar com outra pasta, aponte `CLAUDE_PROJECTS_DIR`,
`CODEX_SESSIONS_DIR` e `PI_SESSIONS_DIR` no `.env`. Para não misturar com a sua conta local,
aponte também `MONITOR_DB_PATH` e `MONITOR_CACHE_PATH` para outro lugar.

## Onde fica cada coisa

```
src/
├── App.tsx                     # rotas; as telas menos usadas carregam sob demanda
├── ui.tsx                      # componentes e estado compartilhados
├── lists.tsx, detail.tsx       # listas e detalhe da sessão, do subagente e do projeto
├── onboarding.tsx, account.tsx # primeiro acesso, conta e privacidade (sob demanda)
├── hub.tsx                     # páginas do Hub e do link compartilhado (sob demanda)
├── api.ts, chart.ts            # chamadas à API e chart.js (carregado sob demanda)
├── index.css, sessions.css     # estilos e paletas
└── server/
    ├── index.ts, app.ts        # entrada da API e registro das rotas
    ├── usage.ts                # leitura incremental dos .jsonl, cache, SSE
    ├── harnesses.ts            # adaptadores do Codex e do pi
    ├── session-detail.ts       # detalhe da sessão (gráficos, agentes, ferramentas)
    ├── pricing.ts              # tabela de preços dos modelos Claude
    ├── privacy.ts              # modos, pastas, histórico
    ├── auth.ts, database.ts    # conta local (argon2id + SQLite)
    └── shares.ts, hub.ts       # compartilhamento opcional
```

Antes de mexer no fluxo de leitura, leia [docs/como-funciona.md](docs/como-funciona.md). Ele tem
os diagramas e explica por que cada arquivo só é lido a partir do último byte.

## Testes, lint e build

| Comando | O que faz |
|---|---|
| `make test` | Testes com o `node:test` embutido (`src/**/*.test.ts`) |
| `make lint` | oxlint |
| `make build` | Typecheck (`tsc -b`) + build do front |
| **`make check`** | Os três acima. **É o que o CI roda**, e precisa passar antes do PR |

Os testes ficam ao lado do código (`usage.ts` → `usage.test.ts`) e não usam framework: são
`node:test` + `node:assert/strict`. Quando um teste precisa de transcrições, ele cria os `.jsonl`
numa pasta temporária (`mkdtempSync`) e passa essa pasta ao `UsageTracker`. Veja
[`usage.test.ts`](src/server/usage.test.ts) como exemplo.

Os testes do front ficam direto em `src/` (`api.ts` → `api.test.ts`): o typecheck deles é feito pelo
`tsconfig.node.json`, que só inclui `src/*.test.ts`.

Para rodar um arquivo só:

```sh
node --import tsx --test src/server/usage.test.ts
```

## Padrões de código

- **TypeScript com tipos explícitos.** Evite `any`.
- **Simples antes de esperto.** Prefira a biblioteca padrão e o que já existe no projeto antes de
  criar um helper ou adicionar uma dependência. Dependência nova precisa de um motivo claro no PR.
- **Early return** em vez de `else` aninhado.
- **Comentários em inglês**, curtos, explicando o **porquê**, nunca o quê.
- **Código e nomes em inglês. Textos da interface em português.**
- **Nada de conexão externa.** O monitor não pode buscar nada na internet: nada de CDN, fonte
  remota ou telemetria. Fontes e bibliotecas entram no build. Veja
  [por que ele não acessa a internet](README.md#por-que-ele-não-acessa-a-internet).
- Não reformate código que você não mudou: o diff fica menor e a revisão, mais fácil.

## Commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/pt-br/), escritos em **inglês** e no
**imperativo**:

```
feat: add Gemini CLI adapter
fix: count Codex cached tokens once
refactor: extract cost chart options
docs: explain cache miss detection
test: cover pi sessions without usage
chore: update dependencies
perf: read large transcripts in chunks
```

Um assunto por commit. Nada de `WIP`.

## Abrindo um pull request

1. Crie uma branch a partir do `master`:
   ```sh
   git switch master && git pull
   git switch -c feat/nome-curto
   ```
2. Faça as mudanças, com testes quando houver lógica nova.
3. Rode `make check` localmente.
4. Suba a branch e abra o PR para o `master`:
   ```sh
   git push -u origin feat/nome-curto
   gh pr create --base master
   ```
5. No PR, descreva **o que** mudou e **por quê**. Se mexeu no painel, anexe uma captura de tela feita
   **com dados fictícios** (veja a próxima seção).
6. O CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda o `make check`, e o PR só entra com ele verde.

## Privacidade: o que nunca pode entrar no repositório

O TokenLens lê conversas privadas. Por isso:

- **Nunca** faça commit de `.jsonl` real, do `~/.tokenlens/app.db` ou do `usage-cache.json`.
- **Nunca** faça commit do `.env` nem das variantes dele (`.env.local`, `.env.hub`…). Todas estão no
  `.gitignore`, exceto o `.env.example`.
- **Capturas de tela só com dados fictícios.** Nada de nome de projeto, prompt ou caminho reais. As
  imagens do README vieram de uma instância separada, com transcrições geradas.
- Nos testes, use dados inventados (`/repo`, `s1`, `m1`…).
- Se o seu PR fizer o monitor enviar qualquer dado para fora da máquina, deixe isso explícito na
  descrição. Isso altera a [política de privacidade](PRIVACY.md), que precisa ser atualizada no mesmo PR.
- Achou uma falha de segurança? Não abra issue: siga o [SECURITY.md](SECURITY.md).

## Tarefas comuns

### Adicionar o preço de um modelo Claude

Adicione a linha em `CLAUDE` em [`src/server/pricing.ts`](src/server/pricing.ts) (USD por milhão de
tokens) e um caso em `pricing.test.ts`.

### Mudar como os tokens são somados

Se você mudar o formato do cache ou a regra de contagem em `usage.ts`, **aumente o
`CACHE_VERSION`**. Assim o cache antigo é descartado e tudo é relido com a regra nova.

### Mudar o banco (app.db)

Acrescente uma função ao fim da lista `migrations` em [`src/server/database.ts`](src/server/database.ts).
Cada migração roda uma vez, em ordem e numa transação, e o `PRAGMA user_version` guarda quantas já
rodaram. Nunca edite nem reordene uma migração existente: crie outra.

### Suportar um agente novo

1. Adicione o agente ao tipo `Harness` e a pasta em `defaultSources()` (`usage.ts`).
2. Defina os `NEEDLES`: os trechos de texto que marcam as linhas com uso, título ou contexto.
3. Escreva o `parse<Agente>` que reduz uma linha a `Parsed`.
4. Para a tela de detalhe, crie o leitor em `harnesses.ts`, seguindo o `readPiDetail`.
5. Cubra tudo com testes em `harnesses.test.ts`.
6. Documente a pasta e a variável de ambiente no `.env.example` e no README.

---

Dúvidas? Abra uma issue ou fale com quem mantém o projeto (veja
[Contribuidores](README.md#contribuidores)).
