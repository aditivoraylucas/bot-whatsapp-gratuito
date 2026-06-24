# PROJETO_MEMORIA.md
> Arquivo de memória do projeto. Atualizar a cada sessão de trabalho.

---

## 🔄 Fluxo de Trabalho com a IA

> **Copie e salve esses dois comandos. Use sempre.**

### ▶️ Início de sessão
```
Leia o PROJETO_MEMORIA.md do repositório aditivoraylucas/bot-whatsapp-gratuito e continue o trabalho.
```
A IA vai ler o arquivo, carregar todo o contexto e já saber exatamente onde parou.

### ⏹️ Fim de sessão (ou a qualquer grande avanço)
```
Atualize a memória
```
A IA vai:
1. Ler os arquivos atuais do GitHub (`PROJETO_MEMORIA.md` + `DECISOES.md`)
2. Incorporar tudo que foi feito na sessão
3. Fazer commit com os dois arquivos atualizados
4. Confirmar o que mudou

### 🗓️ Ciclo completo
```
[INÍCIO]  "Leia o PROJETO_MEMORIA.md e continue o trabalho"
              ↓
         trabalho, commits, decisões...
              ↓
[FIM]    "Atualize a memória"
              ↓
         PROJETO_MEMORIA.md + DECISOES.md atualizados no GitHub
              ↓
         próxima sessão começa do ponto exato
```

> ⚠️ **A IA não atualiza automaticamente sem você pedir.** “Atualize a memória” é o gatilho manual intencional.

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
├── index.js                     ← Entry point (importa src/bot.js)
├── src/
│   ├── bot.js                   ← Conexão Baileys, reconexão, listener de mensagens
│   ├── handlers.js              ← processarTexto(), parsers, comandos
│   ├── sheets.js                ← registrarOuAcumular(), cancelar, relatórios
│   ├── utils.js                 ← norm(), PRECOS, ALIASES, pushLancamento, etc.
│   └── config.js                ← Variáveis de ambiente centralizadas
├── PROJETO_MEMORIA.md           ← Este arquivo (memória principal)
├── DECISOES.md                  ← Registro de decisões arquiteturais
├── CONTEXTO_BOT.md              ← Arquivo de memória antigo (substituído)
├── Codigo_Google_Apps_Script.gs ← Script da planilha Google
├── package.json
├── Procfile                     ← web: node index.js
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
- Deduplicação de mensagens (Set com TTL de 30s)
- Limite de crédito por cliente
- Fuzzy matching de nomes (Levenshtein)
- Aliases de nomes persistidos em `aliases.json`
- Confirmação antes de zerar cliente (TTL 60s)

---

## 🔴 Bugs Pendentes

### Bug 7 — Dupla chamada `getDoc()` por operação
- **Arquivo:** `src/sheets.js`
- **Problema:** `registrarOuAcumular()` chama `getSheetSaldo()` + `getSheetHistorico()` separadamente → 2 chamadas à API Google por operação → erro **429** com volume moderado.
- **Fix planejado:** Chamar `getDoc()` uma única vez e passar a instância para ambas.

### Bug 8 — `onEdit` sem proteção de aba
- **Arquivo:** `Codigo_Google_Apps_Script.gs`
- **Fix planejado:** Adicionar `if (e.range.getSheet().getName() !== 'Controle') return;`

### Bug 9 — Sem hot-reload (sessão perdida a cada deploy)
- **Fix planejado:** Avaliar persistência de sessão em volume externo.

---

## 🚧 Melhorias Pendentes

| # | Melhoria | Plano |
|---|----------|-------|
| 4 | Múltiplos clientes por mensagem (`Ana 2 trufas, Carlos 1 bolo`) | `parsearLote()` em `handlers.js` — divide por `,` `;` `\n`, ativa se ≥ 2 segmentos válidos |
| 6 | `cancelar carlos` exibe últimos 3 lançamentos para escolher | `CANCELAR_PENDENTE` em `handlers.js` + confirmação `cancelar 1/2/3` |
| 10 | Backup mensal da planilha | **Não é no bot** — usar Google Apps Script (ver abaixo) |

---

## 🗓️ Backup Automático da Planilha

```javascript
function backupMensal() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const abaOrigem = ss.getSheetByName('Histórico');
  if (!abaOrigem) return;
  const mes  = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM');
  const nome = `Histórico ${mes}`;
  if (ss.getSheetByName(nome)) return;
  abaOrigem.copyTo(ss).setName(nome);
}
```
**Gatilho:** Extensões → Apps Script → Gatilhos → `backupMensal` → Mensal → dia 1 → 00h–01h

---

## 📅 Histórico de Sessões

### Sessão 24/06/2026
- Planejadas sugestões 4, 6 e 10
- Criados `PROJETO_MEMORIA.md`, `DECISOES.md`
- Adicionado fluxo de sessão ("Atualize a memória")

### Sessão 22/06/2026
- Corrigidos bugs 1–6
- Implementadas: deduplicação, aliases, confirmação de zerar, transcrição Groq
- Revertido agendamento automático de devedores (`428150e`)

### Sessão 20/06/2026
- Correções de reconexão, JWT, retry Google Sheets
- Substituição de QR Code por Pairing Code

---

## ⚠️ Regras Importantes

1. **Nunca alterar a estrutura da planilha Google** sem confirmar nomes de abas.
2. **Nunca remover o retry/backoff** nas chamadas ao Google Sheets (Bug 7 ainda existe).
3. **`parsearVendaVista` tem prioridade** sobre `parsearPagamento` — não inverter essa ordem.
4. **`*_PENDENTE`** devem sempre ter TTL + `setTimeout` para limpeza automática.
5. **`localStorage`/`sessionStorage` não funcionam** no Render — usar variáveis em memória ou JSON.
6. **Chave interna de produto** usa `norm().replace(/\s+/g, '_')` — não mudar esse padrão.
7. **Não usar `bot_whatsapp_puro.py`** — versão legada.
