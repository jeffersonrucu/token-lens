# Política de privacidade

*Última atualização: 18/09/2026*

O TokenLens é um monitor que roda **só na sua máquina**. A API e o painel ficam no seu computador,
e não existe servidor nosso do outro lado: ninguém além de você tem acesso ao que o monitor lê.

Esta é a versão completa da política que o monitor mostra no primeiro acesso.

## Sumário

- [O que é lido](#o-que-é-lido)
- [Onde os dados ficam](#onde-os-dados-ficam)
- [O que nunca sai da máquina](#o-que-nunca-sai-da-máquina)
- [Controles no painel](#controles-no-painel)
- [Compartilhamento (opcional)](#compartilhamento-opcional)
- [Como apagar tudo](#como-apagar-tudo)
- [Mudanças nesta política](#mudanças-nesta-política)

## O que é lido

- Os registros que o Claude Code, o Codex e o pi **já gravam** no seu computador:
  `~/.claude/projects`, `~/.codex/sessions` e `~/.pi/agent/sessions`.
- Desses arquivos, o monitor soma os tokens de cada resposta. Guarda também o título, o projeto e
  os modelos de cada sessão. No Codex e no pi, que não gravam título, o título é o começo do
  primeiro prompt (até 80 caracteres).
- O restante do chat só é lido quando você abre o detalhe de uma sessão, e não é guardado. Nessa
  hora, o monitor também lê o começo das outras sessões da mesma pasta, só para achar a sessão
  anterior ou seguinte a um `/clear`.
- A leitura é **só leitura**: nada nessas pastas é alterado ou apagado.
- No **modo manual**, só as pastas do Claude Code que você escolheu são lidas. O Codex e o pi são
  lidos integralmente e filtrados no momento da exibição.

## Onde os dados ficam

| Arquivo | Conteúdo |
|---|---|
| `~/.tokenlens/app.db` | Sua conta (nome, e-mail, semente do avatar e senha como hash **argon2id**), os logins, as preferências, os favoritos (com os nomes que você deu) e as configurações de privacidade. Também um resumo de cada sessão (custo, tempo, agentes, ferramentas), sem o chat, para os números continuarem no projeto quando o agente apaga a transcrição. |
| `~/.tokenlens/usage-cache.json` | Os totais de tokens, os títulos e projetos das sessões e a posição de leitura de cada arquivo. Apagar força uma releitura completa. |
| `~/.tokenlens/favorites/` | Uma cópia das transcrições de cada sessão favorita, com o chat, para ela sobreviver à limpeza do agente. Sai quando você tira a estrela. |

A conta existe só nesta máquina: não há cadastro em nenhum serviço externo.

## O que nunca sai da máquina

- **Não há telemetria, análises, verificação de atualizações ou relatórios de erro.**
- **A API só escuta em `localhost`.** Nenhum outro computador da rede alcança o painel.
- **Tudo que a página usa vem junto com ela:** fontes, ícones e bibliotecas entram no build, sem
  CDN nem Google Fonts.
- Chat, prompts, caminhos, descrições de tarefas, argumentos de comandos e comandos de hooks não saem
  da máquina **em nenhuma hipótese**, nem no compartilhamento.

Os detalhes técnicos, com os pontos exatos do código e os comandos para conferir, estão em
[docs/como-funciona.md](docs/como-funciona.md#rede-o-que-pode-sair-da-máquina).

## Controles no painel

Em **Privacidade**:

| Opção | Efeito |
|---|---|
| **Automático / Manual** | Lê todos os projetos, ou só as pastas que você escolher. |
| **Pausar o monitoramento** | O painel para de receber dados novos. Ao retomar, o que foi gasto no período entra na conta. |
| **Ocultar o conteúdo do chat** | Esconde mensagens e prompts. Tokens e custo continuam aparecendo. |
| **Esconder caminhos completos** | Mostra só o nome da pasta do projeto. |
| **Zerar tudo** | A conta passa a contar a partir de agora. O histórico dos agentes continua no disco. |
| **Limpar cache local** | Apaga os totais guardados e relê o histórico, respeitando o modo manual. |

Na lista de projetos, **Remover projeto** esconde o projeto de todas as listas.

## Compartilhamento (opcional)

O compartilhamento é a **única** forma de um dado sair da máquina. Ele vem desligado e só passa a
existir depois de três passos seus:

1. criar uma conta num servidor Hub;
2. gerar lá uma chave de envio;
3. colar a URL e a chave em **Conta → Compartilhamento**.

Sem isso, o botão Compartilhar não funciona e nada é enviado.

**Se você compartilhar uma sessão ou um projeto:**

- **Vão:** o título e os números (tokens, custo, modelos e a linha do tempo).
- **Não vão:** chat, prompts, caminhos, descrições de tarefas, argumentos de comandos e comandos de
  hooks.
- O título sugerido é o começo do primeiro prompt, ou o nome da pasta num projeto, e dá para
  editar. Com *Esconder caminhos completos*, ele vira genérico, como "Sessão de 18/09/2026".
- Você escolhe quem vê (qualquer pessoa com o link ou uma lista de e-mails) e, se quiser, define uma
  data de expiração.
- Enquanto o link existir, os números são atualizados no Hub a cada 30 segundos de atividade.
- A conexão com o Hub exige **https**, exceto para um Hub na mesma máquina.
- **Pausar** o monitoramento ou **desconectar** o Hub interrompe o envio. Os links já criados
  continuam no ar até você **revogá-los**, e revogar apaga os dados do link no Hub.

O Hub guarda a conta de quem cria os links, a chave de envio (somente como hash) e os dados de cada
link. Quem hospeda o Hub é responsável pelos dados guardados nele.

## Como apagar tudo

- **Excluir a conta** (em **Conta**) apaga os seus dados do `app.db`: conta, logins, preferências,
  favoritos, privacidade e links.
- Para remover qualquer rastro do monitor, pare o monitor e apague a pasta dele (o
  `tokenlens-destroy` do README faz os dois):
  ```sh
  rm -rf ~/.tokenlens
  ```
- Os registros dos agentes (`~/.claude`, `~/.codex`, `~/.pi`) não são do TokenLens e continuam
  intactos.

## Mudanças nesta política

Toda mudança nesta política é registrada neste arquivo, e o histórico fica no Git. Um pull request que
faça o monitor enviar qualquer dado novo para fora da máquina precisa atualizar esta política também
(veja o [CONTRIBUTING](CONTRIBUTING.md#privacidade-o-que-nunca-pode-entrar-no-repositório)).

Dúvidas sobre segurança ou uma vulnerabilidade? Veja o [SECURITY.md](SECURITY.md).
