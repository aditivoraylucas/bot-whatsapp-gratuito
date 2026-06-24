# PROJETO_MEMORIA.md
> Arquivo de memória do projeto. Atualizar a cada sessão de trabalho.
> **Como usar em nova sessão:** _"Leia o PROJETO_MEMORIA.md do repositório aditivoraylucas/bot-whatsapp-gratuito e continue o trabalho."_

---

## 🤖 Sobre o Projeto

**Nome:** bot-whatsapp-vendas
**Repositório:** https://github.com/aditivoraylucas/bot-whatsapp-gratuito
**Hospedagem:** Render (free tier — container recria a cada deploy)
**Stack:**
- Node.js ≥ 18 + `@whiskeysockets/baileys` — cliente WhatsApp Web
- `google-spreadsheet` v4 + `google-auth-library` — integração Google Sheets
- `pino` — logging
- `node-fetch` — chamadas HTTP (transcrição Groq Whisper)
- `form-data` — envio de áudio para Groq
- Google Apps Script (`Codigo_Google_Apps_Script.gs`) — backend da planilha
- Flask/Python (`bot_whatsapp_puro.py`) — versão alternativa/legada (não usar)

**Função:** Monitorar um grupo de WhatsApp, registrar vendas de doces (trufa, bolo, bombom), controlar saldos por cliente em planilha Google Sheets, transcrever áudios via Groq Whisper.

---

## 📦 Variáveis de Ambiente (Render)

| Variável | Descrição |
|----------|-----------|
| `CREDS_JSON` | JSON serializado das credenciais Baileys (sessão WhatsApp) |
| `GOOGLE_SCRIPT_URL` | URL do Web App do Google Apps Script |
| `SEU_NUMERO` | Número do WhatsApp do bot (formato: 5511999999999) |
| `RENDER_API_KEY` | Chave da API do Render (para salvar sessão via API) |
| `RENDER_SERVICE_ID` | ID do serviço no Render |
| `GROQ_API_KEY` | Chave da API Groq (transcrição Whisper de áudios) |
| `LIMITE_CREDITO` | Limite de crédito por cliente (padrão: 100) |

---

## 🏗️ Arquitetura Atual

```
WhatsApp ←→ Baileys (src/bot.js)
               ↓
         src/handlers.js   ← lógica de parsing e comandos
               ↓
         src/sheets.js     ← integração Google Sheets
               ↓
         src/utils.js      ← utilitários, produtos, aliases, histórico
               ↓
         Google Sheets API (google-spreadsheet v4)
               ↓
         Planilha Google (aba "Controle")
               ↓
         Google Apps Script (Codigo_Google_Apps_Script.gs)
         [doPost webhook — ações: add/pag/ver/relatorio/del]
```

**Sessão WhatsApp:** Salva como JSON na variável de ambiente `CREDS_JSON` do Render via API REST.
**Autenticação Google:** Via `config.js` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` + `GOOGLE_SHEET_ID`.

---

## 📁 Estrutura de Arquivos

```
/
├── index.js                    ← Entry point (importa src/bot.js)
├── src/
│   ├── bot.js                  ← Conexão Baileys, reconexão, listener de mensagens
│   ├── handlers.js             ← processarTexto(), parsers, comandos
│   ├── sheets.js               ← registrarOuAcumular(), cancelar, relatórios
│   ├── utils.js                ← norm(), PRECOS, ALIASES, pushLancamento, etc.
│   └── config.js               ← Variáveis de ambiente centralizadas
├── CONTEXTO_BOT.md             ← Arquivo de memória antigo (substituído por este)
├── PROJETO_MEMORIA.md          ← Este arquivo (memória principal)
├── Codigo_Google_Apps_Script.gs ← Script da planilha Google
├── package.json
├── Procfile                    ← web: node index.js
└── render-build.sh
```

**Arquivos de estado (gerados em runtime, fora do git):**
- `precos.json` — preços dos produtos
- `sinonimos.json` — sinônimos adicionais de produtos
- `aliases.json` — apelidos de clientes

---

## ✅ Funcionalidades Prontas

### Registro de vendas
- Compra fiada: `julia 2 trufas`, `carlos 1 bolo 3 trufas`
- Venda à vista: `julia 2 trufas pago`, `carlos 1 bolo pago pix`
- Registro de pagamento: `julia pagou 10`, `carlos pix 15`, `ana pagou 2 trufas`
- Transcrição de áudio via Groq Whisper (modelo `whisper-large-v3-turbo`)

### Relatórios e consultas
- `relatorio` — geral
- `relatorio detalhado` — com histórico
- `relatorio quitados` — só quem zerou
- `relatorio junho` — por mês
- `resumo` — resumo do dia
- `saldo julia` — saldo individual
- `historico carlos` — histórico do cliente

### Gerenciamento
- `cancelar carlos` — desfaz último lançamento do Carlos
- `zerar carlos` — zera dívida (com confirmação via `sim`)
- `alias ray Raylucas` — cadastra apelido
- `aliases` — lista apelidos
- `produtos` — lista produtos e preços
- `preco trufa 6` — muda preço
- `novo brigadeiro 3.50` — cadastra novo produto

### Infraestrutura
- Reconexão automática com backoff exponencial
- Deduplicação de mensagens (Set com TTL de 30s) — evita duplo processamento
- Limite de crédito por cliente (bloqueia nova compra se ultrapassar)
- Fuzzy matching de nomes (Levenshtein)
- Aliases de nomes persistidos em `aliases.json`
- Confirmação antes de zerar cliente (TTL 60s)

---

## 🔴 Bugs Pendentes (identificados, ainda não corrigidos)

### Bug 7 — `getSheetHistorico()` faz dupla chamada `getDoc()` em cascata
- **Arquivo:** `src/sheets.js`
- **Problema:** `registrarOuAcumular()` chama `getSheetSaldo()` + `getSheetHistorico()` separadamente, cada uma chamando `getDoc()` → 2 chamadas à API Google por operação. Com volume moderado causa erro **429 Too Many Requests**.
- **Fix planejado:** Refatorar para chamar `getDoc()` uma única vez e passar a instância para ambas.

### Bug 8 — `onEdit` no Apps Script sem proteção de sheet
- **Arquivo:** `Codigo_Google_Apps_Script.gs`
- **Problema:** O trigger `onEdit` não verifica `e.range.getSheet().getName()` — dispara para qualquer edição em qualquer aba. Edição manual pode corromper saldos.
- **Fix planejado:** Adicionar no início de `onEdit`: `if (e.range.getSheet().getName() !== 'Controle') return;`

### Bug 9 — Sem hot-reload (toda atualização derruba sessão)
- **Problema:** O Render recria o container a cada deploy, perdendo sessão em memória e forçando novo pairing code.
- **Fix planejado:** Avaliar persistência de sessão em volume externo ou estratégia zero-downtime.

---

## 🚧 Melhorias Pendentes (priorizadas)

### Alta prioridade
| # | Melhoria | Status |
|---|----------|--------|
| 4 | Múltiplos clientes numa mensagem (`Ana 2 trufas, Carlos 1 bolo`) | Planejada — implementar em `handlers.js` com `parsearLote()` |
| 6 | `cancelar carlos` mostra últimos 3 lançamentos para escolher | Planejada — requer `CANCELAR_PENDENTE` + confirmação `cancelar 1/2/3` |

### Não implementar no bot (solução externa)
| # | Melhoria | Motivo |
|---|----------|--------|
| 10 | Backup mensal da planilha | Usar Google Apps Script com gatilho mensal — ver seção abaixo |

---

## 📋 Detalhes das Melhorias Planejadas

### Sugestão 4 — Múltiplos clientes por mensagem
**Onde implementar:** `src/handlers.js`
**O que adicionar:**
1. Nova função `parsearLote(texto)` — divide por `,` `;` `\n`, tenta parsear cada segmento
2. Só ativa se ≥ 2 segmentos válidos (senão cai no fluxo normal)
3. Cada segmento passa por `parsearVendaVista` → `parsearPagamento` → `parsearLinha`
4. No `processarTexto`, chamar `parsearLote` antes do bloco `parsearVendaVista`

### Sugestão 6 — Cancelar com seleção (opção C — sem ambiguidade)
**Onde implementar:** `src/handlers.js` + `src/sheets.js`
**Fluxo:**
1. `cancelar carlos` → lista até 3 últimos lançamentos numerados
2. Usuário responde `cancelar 1`, `cancelar 2` ou `cancelar 3`
3. Bot executa o cancelamento do item escolhido
**O que adicionar:**
- `CANCELAR_PENDENTE` em `handlers.js` (mesmo padrão do `ZERAR_PENDENTE`)
- `cancelarLancamento` em `sheets.js` aceita índice opcional além do nome
- Reconhecer `cancelar N` como confirmação quando há pendente para o `jid`

---

## 🗓️ Backup Automático da Planilha (Apps Script)

Não implementar no bot. Usar este script diretamente na planilha:

```javascript
function backupMensal() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const abaOrigem = ss.getSheetByName('Histórico'); // ajustar nome da aba
  if (!abaOrigem) return;

  const mes  = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM');
  const nome = `Histórico ${mes}`;

  if (ss.getSheetByName(nome)) return; // já existe, não duplica

  abaOrigem.copyTo(ss).setName(nome);
}
```

**Gatilho:** Extensões → Apps Script → Gatilhos → `backupMensal` → Mensal → dia 1 → 00h–01h

---

## 📅 Histórico de Sessões

### Sessão 24/06/2026
- Analisado e planejado: sugestão 4 (múltiplos clientes), sugestão 6 (cancelar robusto), sugestão 10 (backup planilha)
- Criado `PROJETO_MEMORIA.md` (este arquivo)
- Nenhum código alterado nesta sessão além deste documento

### Sessão 22/06/2026
- Corrigidos bugs 1–6 (ver `CONTEXTO_BOT.md` para detalhes)
- Implementadas: deduplicação de mensagens, aliases, confirmação de zerar, transcrição Groq
- Removido agendamento automático de relatório de devedores (revertido em `428150e`)

### Sessão 20/06/2026
- Correções iniciais de reconexão, JWT, retry Google Sheets
- Substituição de QR Code por Pairing Code

---

## ⚠️ Regras Importantes

1. **Nunca alterar a estrutura da planilha Google** sem confirmar nomes de abas com o dono do projeto.
2. **Nunca remover o retry/backoff** nas chamadas ao Google Sheets (Bug 7 ainda existe).
3. **`parsearVendaVista` tem prioridade** sobre `parsearPagamento` no fluxo do `processarTexto` — não inverter essa ordem.
4. **`ZERAR_PENDENTE` e futuros `*_PENDENTE`** devem sempre ter TTL + `setTimeout` para limpeza automática.
5. **`localStorage`/`sessionStorage` não funcionam** no Render — usar apenas variáveis em memória ou arquivos JSON.
6. **Ao criar novo produto** via `novo`, a chave interna usa `norm().replace(/\s+/g, '_')` — não mudar esse padrão.
7. **Não usar `bot_whatsapp_puro.py`** — é versão legada, mantida só como referência.
