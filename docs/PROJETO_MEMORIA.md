# PROJETO_MEMORIA.md
> Estado geral do projeto. Atualizar a cada sessão de trabalho.

---

## 🔄 Fluxo de Trabalho com a IA

> **Copie e salve esses dois comandos. Use sempre.**

### ▶️ Início de sessão
```
Leia o docs/PROJETO_MEMORIA.md do repositório aditivoraylucas/bot-whatsapp-gratuito e continue o trabalho.
```

### ⏹️ Fim de sessão (ou a qualquer grande avanço)
```
Atualize a memória
```
A IA vai:
1. Ler os arquivos atuais de `/docs` no GitHub
2. Incorporar tudo que foi feito na sessão
3. Fazer commit com os arquivos atualizados
4. Confirmar o que mudou

### 🗓️ Ciclo completo
```
[INÍCIO]  "Leia o docs/PROJETO_MEMORIA.md e continue o trabalho"
              ↓
         trabalho, commits, decisões...
              ↓
[FIM]    "Atualize a memória"
              ↓
         /docs atualizado no GitHub
              ↓
         próxima sessão começa do ponto exato
```

> ⚠️ A IA não atualiza automaticamente sem você pedir. "Atualize a memória" é o gatilho manual.

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
- Flask/Python (`bot_whatsapp_puro.py`) — versão legada (não usar)

**Função:** Monitorar grupo de WhatsApp, registrar vendas de doces (trufa, bolo, bombom), controlar saldos por cliente em planilha Google Sheets, transcrever áudios via Groq Whisper.

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

**Sessão WhatsApp:** Salva como JSON na variável `CREDS_JSON` do Render via API REST.
**Autenticação Google:** Via `config.js` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` + `GOOGLE_SHEET_ID`.

---

## 📁 Estrutura de Arquivos

```
/
├── index.js                     ← Entry point
├── src/
│   ├── bot.js                   ← Conexão Baileys, reconexão, listener
│   ├── handlers.js              ← processarTexto(), parsers, comandos
│   ├── sheets.js                ← registrarOuAcumular(), cancelar, relatórios
│   ├── utils.js                 ← norm(), PRECOS, ALIASES, pushLancamento
│   └── config.js                ← Variáveis de ambiente centralizadas
├── docs/                        ← Documentação do projeto
│   ├── PROJETO_MEMORIA.md       ← Este arquivo
│   ├── DECISOES.md              ← Decisões arquiteturais
│   ├── TODO.md                  ← Tarefas pendentes
│   ├── API.md                   ← APIs e integrações
│   ├── BUGS.md                  ← Bugs conhecidos
│   └── SHEETS.md                ← Estrutura da planilha
├── Codigo_Google_Apps_Script.gs ← Script da planilha Google
├── package.json
├── Procfile                     ← web: node index.js
└── render-build.sh
```

**Arquivos de estado (runtime, fora do git):**
- `precos.json` — preços dos produtos
- `sinonimos.json` — sinônimos adicionais
- `aliases.json` — apelidos de clientes

---

## ✅ Funcionalidades Prontas

### Registro de vendas
- Compra fiada: `julia 2 trufas`, `carlos 1 bolo 3 trufas`
- Venda à vista: `julia 2 trufas pago`, `carlos 1 bolo pago pix`
- Pagamento de dívida: `julia pagou 10`, `carlos pix 15`, `ana pagou 2 trufas`
- Transcrição de áudio via Groq Whisper (`whisper-large-v3-turbo`)

### Relatórios e consultas
- `relatorio` — geral | `relatorio detalhado` | `relatorio quitados` | `relatorio junho`
- `resumo` — resumo do dia
- `saldo julia` — saldo individual | `historico carlos` — histórico do cliente

### Gerenciamento
- `cancelar carlos` — desfaz último lançamento
- `zerar carlos` — zera dívida (confirmação via `sim`, TTL 60s)
- `alias ray Raylucas` — apelido | `aliases` — lista apelidos
- `produtos` — lista produtos | `preco trufa 6` — muda preço | `novo brigadeiro 3.50` — novo produto

### Infraestrutura
- Reconexão automática com backoff exponencial
- Deduplicação de mensagens (Set + TTL 30s)
- Limite de crédito por cliente
- Fuzzy matching de nomes (Levenshtein)

---

## 📅 Histórico de Sessões

### Sessão 24/06/2026
- Planejadas sugestões 4, 6 e 10
- Criados `PROJETO_MEMORIA.md`, `DECISOES.md`
- Adicionado fluxo de sessão ("Atualize a memória")
- Criada pasta `/docs` com documentação completa

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
2. **Nunca remover o retry/backoff** nas chamadas ao Google Sheets (Bug 7 pendente).
3. **`parsearVendaVista` tem prioridade** sobre `parsearPagamento` — não inverter.
4. **`*_PENDENTE`** devem sempre ter TTL + `setTimeout` para limpeza automática.
5. **`localStorage`/`sessionStorage` não funcionam** no Render — usar memória ou JSON.
6. **Chave interna de produto** usa `norm().replace(/\s+/g, '_')` — não mudar.
7. **Não usar `bot_whatsapp_puro.py`** — versão legada.
