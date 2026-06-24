# DECISOES.md
> Registro de decisões arquiteturais e técnicas do projeto.
> Toda vez que uma escolha importante for feita (ou revertida), documentar aqui.
> **Formato:** Data — Decisao — Motivo — Alternativas descartadas.

---

## Decisões de Infraestrutura

### D-01 — Hospedagem no Render (free tier)
**Data:** junho/2026
**Decisão:** Usar Render como plataforma de hospedagem.
**Motivo:** Gratuito, suporta Node.js, deploy via GitHub automático.
**Limitacões conhecidas e aceitas:**
- Container recria a cada deploy → sessão WhatsApp é perdida (requer novo pairing code)
- Free tier hiberna após inatividade (workaround: healthcheck endpoint)
**Alternativas descartadas:** Railway (pago), Heroku (pago), VPS (complexidade).

### D-02 — Sessão WhatsApp salva em variável de ambiente
**Data:** junho/2026
**Decisão:** Persistir `CREDS_JSON` como variável de ambiente no Render via API REST.
**Motivo:** Render free tier não tem volume persistente. Variável de ambiente é o único lugar que sobrevive ao recriação do container.
**Limitacões conhecidas e aceitas:** Tamanho máximo da env var pode ser um problema se as creds crescerem muito.
**Alternativas descartadas:** Salvar em arquivo local (não persiste), Redis (custo), banco de dados (overhead).

### D-03 — Autenticação WhatsApp via Pairing Code (não QR Code)
**Data:** 22/06/2026 — commit `0e169ae`
**Decisão:** Substituir QR Code por `requestPairingCode()` do Baileys.
**Motivo:** Render é ambiente headless — impossível exibir ou escanear QR Code. Pairing Code gera código de 8 dígitos via requisição HTTP ao endpoint `/pair`.
**Alternativas descartadas:** QR Code via imagem no terminal (não funciona em headless), QR Code via webhook (complexidade desnecessária).

---

## Decisões de Arquitetura de Código

### D-04 — Separar lógica em módulos (bot / handlers / sheets / utils)
**Data:** junho/2026
**Decisão:** Dividir o código em 4 módulos com responsabilidades separadas.
**Motivo:** Versão original tinha tudo num único arquivo. Ficou impossível de manter.
**Estrutura atual:**
- `bot.js` — conexão Baileys, reconexão, listener
- `handlers.js` — parsing de mensagens, comandos
- `sheets.js` — operações na planilha
- `utils.js` — utilitários compartilhados

### D-05 — Google Apps Script como backend da planilha
**Data:** junho/2026
**Decisão:** Manter o Google Apps Script (`Codigo_Google_Apps_Script.gs`) como camada de lógica na planilha.
**Motivo:** O Apps Script já existia e o `onEdit` automático era usado para recalcular saldos. Removê-lo exigiria reescrever toda a lógica de saldo no Node.
**Risco conhecido:** trigger `onEdit` sem proteção de aba (Bug 8 — pendente).

### D-06 — Histórico de lançamentos em memória (não persistido)
**Data:** junho/2026
**Decisão:** `ULTIMOS_LANCAMENTOS` (usado pelo `cancelar`) é mantido apenas em memória RAM, sem persistência.
**Motivo:** Simplicidade. O caso de uso principal é desfazer um erro imediato — não faz sentido persistir histórico de cancelamento entre restartes.
**Consequência aceita:** Reiniciar o bot limpa o histórico de cancelamentos. `cancelar` não funciona após restart.

### D-07 — Arquivos JSON locais para estado volátil (preços, sinônimos, aliases)
**Data:** junho/2026
**Decisão:** `precos.json`, `sinonimos.json` e `aliases.json` são salvos em disco local.
**Motivo:** Simple, sem dependência externa. Dados raramente mudam.
**Limitacões conhecidas e aceitas:** Render recria o container a cada deploy — esses arquivos são perdidos. Workaround: commitar os arquivos no repositório quando houver mudanças.
**Alternativa futura:** Salvar como env vars no Render (mesmo padrão do `CREDS_JSON`).

### D-08 — Deduplicacão de mensagens com Set em memória + TTL
**Data:** 22/06/2026
**Decisão:** Usar `Set` com `setTimeout` de 30s para ignorar mensagens duplicadas do Baileys.
**Motivo:** Baileys ocasionalmente dispara `messages.upsert` duas vezes para a mesma mensagem. Sem deduplicacão, o bot registrava compras em dobro.
**Alternativas descartadas:** Flag em banco de dados (overhead), deduplicacão na planilha (complexidade).

---

## Decisões de Produto

### D-09 — Limite de crédito por cliente
**Data:** junho/2026
**Decisão:** Implementar limite de crédito configurável via `LIMITE_CREDITO` env var (padrão: R$ 100).
**Motivo:** Pedido do dono do projeto para evitar dívidas altas sem pagamento.
**Comportamento:** Nova compra que ultrapassaria o limite é bloqueada com mensagem de aviso. Não impede pagamento.

### D-10 — Confirmação antes de zerar cliente
**Data:** junho/2026
**Decisão:** Comando `zerar` requer confirmação com `sim` dentro de 60 segundos.
**Motivo:** Operação irreversível. Evitar acidentes por digitação errada.
**Implementacão:** `ZERAR_PENDENTE` em `handlers.js` com TTL automático.

### D-11 — Aliases de nomes persistidos em arquivo
**Data:** junho/2026
**Decisão:** Suporte a apelidos (`alias ray Raylucas`) salvos em `aliases.json`.
**Motivo:** Nomes longos no grupo são digitados de formas diferentes. Alias resolve sem precisar de fuzzy matching agressivo.
**Regra:** Alias é resolvido apenas na primeira palavra da mensagem (não no meio da frase).

### D-12 — Transcrição de áudio via Groq Whisper (não OpenAI)
**Data:** junho/2026
**Decisão:** Usar Groq (`whisper-large-v3-turbo`) para transcrever áudios.
**Motivo:** Groq é significativamente mais rápido que OpenAI Whisper e tem tier gratuito generoso.
**Comportamento:** Se `GROQ_API_KEY` não estiver configurada, áudios são silenciosamente ignorados (sem erro).
**Alternativas descartadas:** OpenAI Whisper (mais lento, pago), AssemblyAI (complexidade), speech-to-text local (inviável no Render).

### D-13 — Agendamento automático de relatório de devedores — REVERTIDO
**Data:** 24/06/2026 — commit `428150e`
**Decisão:** Remover o agendamento automático diário de cobrança de devedores.
**Motivo:** Funcionalidade adicionada por sugestão e revertida a pedido do dono. O envio automático de cobranças não era o comportamento desejado.
**O que foi removido:** `HORA_RELATORIO` de `config.js`, `gerarRelatorioGeral` do agendamento, bloco de cron em `bot.js`, `ultimoDiaRelatorio`.

---

## Decisões sobre o que NÃO implementar no bot

### D-14 — Backup mensal da planilha via Google Apps Script (não via bot)
**Data:** 24/06/2026
**Decisão:** Backup automático da planilha deve ser feito pelo Google Apps Script com gatilho mensal, não pelo bot Node.js.
**Motivo:** Duplicar uma aba exige Google Drive API ou Sheets `copyTo` — escopos adicionais no service account, mais superfície de erro, e o bot precisaria estar online no momento exato.
**Solucão adotada:** Script de 5 linhas em Apps Script com gatilho mensal configurado pelo Google. Ver `PROJETO_MEMORIA.md` para o código.

---

## 🗓️ Próximas decisões a tomar

| # | Questão em aberto | Contexto |
|---|-------------------|----------|
| ? | Persistir `precos.json` / `aliases.json` entre deploys | Hoje são perdidos no restart. Salvar como env var no Render? |
| ? | Sugestão 4: separador entre clientes no lote | Vírgula apenas? Ou também ponto-e-vírgula e quebra de linha? |
| ? | Sugestão 6: resposta `cancelar N` ou só `N`? | `cancelar 2` é mais seguro (sem ambiguidade), mas mais verboso |

---

## 📅 Última atualização
**24/06/2026**
