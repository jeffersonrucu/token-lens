# Política de segurança

O TokenLens lê conversas privadas com agentes de IA. Portanto, uma falha de segurança pode expor
código, prompts e caminhos das pessoas que o utilizam. Obrigado por ajudar a manter o projeto seguro.

## Versões suportadas

Só a versão mais recente do `master` recebe correções. Antes de relatar, atualize com
`git pull` e confira se o problema persiste.

## Como relatar uma vulnerabilidade

**Não abra uma issue pública** nem um pull request descrevendo a falha.

Relate pelo [aviso privado de vulnerabilidade](https://github.com/jeffersonrucu/token-lens/security/advisories/new)
do GitHub, que só quem mantém o projeto enxerga. Se possível, inclua:

- o que a falha permite (ler dados de outra conta, enviar dados para fora, executar comando…);
- os passos para reproduzir;
- a versão (commit) e o sistema (Linux, macOS, Windows ou WSL);
- uma sugestão de correção, se você tiver.

Respondemos o quanto antes, combinamos o prazo da correção e damos o crédito a você, se quiser.

## O que conta como vulnerabilidade

- Algum dado sair da máquina sem o compartilhamento estar configurado e sem o usuário pedir.
- O compartilhamento enviar chat, prompts, caminhos ou outro dado que a
  [política de privacidade](PRIVACY.md#compartilhamento-opcional) diz que não vai.
- Acesso ao painel ou à API sem login, ou uma conta vendo dados de outra.
- Leitura de arquivos fora das pastas dos agentes (path traversal).
- Execução de código a partir do conteúdo de um `.jsonl`.
- XSS no painel ou na página de um link compartilhado.
- No Hub: acesso a um link revogado, expirado ou restrito a outros e-mails.

Ficam de fora: ataques que exigem acesso prévio à conta do sistema operacional do usuário (quem tem
esse acesso já lê `~/.claude` diretamente) e a ausência de cabeçalhos sem impacto demonstrável.

## Proteções que já existem

| Área | Proteção |
|---|---|
| Rede | A API escuta só em `localhost`. Nada é buscado na internet. |
| Senhas | Hash **argon2id**, nunca em texto. |
| Sessão | Cookie `httpOnly` e `SameSite=strict`. No banco, o token fica somente como hash. |
| CSRF | Toda escrita cuja `Origin` não esteja entre as origens permitidas é recusada. |
| Abuso | Limite de 240 requisições por minuto e limites mais baixos nas rotas de e-mail. |
| Arquivos | A página serve apenas arquivos de dentro de `dist/`. |
| Hub | Conexão somente por HTTPS (exceto na mesma máquina). A chave de envio fica somente como hash no Hub. |
| Dados compartilhados | Chat, prompts, caminhos e comandos são removidos antes do envio (`shareable` em [`shares.ts`](src/server/shares.ts)). |
