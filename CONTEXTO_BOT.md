# CONTEXTO_BOT.md
> Arquivo de memória do projeto. Atualizar a cada sessão de trabalho.
> Em nova sessão: "Leia o CONTEXTO_BOT.md do repositório aditivoraylucas/bot-whatsapp-gratuito e continue o trabalho."

---

## 🤖 Sobre o Projeto

**Nome:** bot-whatsapp-vendas  
**Repositório:** https://github.com/aditivoraylucas/bot-whatsapp-gratuito  
**Hospedagem:** Render (free tier — container recria a cada deploy)  
**Stack:**
- Node.js ≥ 18 + [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) — cliente WhatsApp Web
- `google-spreadsheet` v4 + `google-auth-library` — integração Google Sheets
- `pino` — logging
- Google Apps Script (`Codigo_Google_Apps_Script.gs`) — backend da planilha
- Flask/Python (`bot_whatsapp_puro.py`) — versão alternativa/legada do bot

**Função do bot:** Monitorar um grupo de WhatsApp, registrar vendas de bombom e bolo, controlar saldos por cliente na planilha Google Sheets, enviar agendamentos/lembretes automáticos.

---

## 📦 Variáveis de Ambiente (Render)

| Variável | Descrição |
|----------|-----------|
| `CREDS_JSON` | JSON serializado das credenciais Baileys (sessão WhatsApp) |
| `GOOGLE_SCRIPT_URL` | URL do Web App do Google Apps Script |
| `SEU_NUMERO` | Número do WhatsApp do bot (formato: 5511999999999) |
| `RENDER_API_KEY` | Chave da API do Render (para salvar sessão via API) |
| `RENDER_SERVICE_ID` | ID do serviço no Render |

---

## ✅ Bugs Corrigidos (histórico completo)

### Bug 0 — regex escapada incorretamente em `parsearLinha`
- **Commit:** `9f6bd86` (21/06/2026)
- **Problema:** Regex com escape duplo quebrava o parsing de linhas de texto do grupo.
- **Fix:** Corrigida a regex para escape simples correto.

### Bug implícito — QR Code substituído por Pairing Code
- **Commit:** `0e169ae` (22/06/2026)
- **Problema:** QR Code não funciona em ambiente headless (Render). Impossível escanear.
- **Fix:** Substituído por `requestPairingCode()` — gera código de 8 dígitos via HTTP.

### Bug 1 — Conflito da dependência `qrcode`
- **Commit:** `289a671` (22/06/2026)
- **Problema:** Dependência `qrcode` conflitava com o Pairing Code causando erro na inicialização.
- **Fix:** Removida a dependência `qrcode` do `package.json`.

### Bug 2 — `sockGlobal` nunca inicializado → erro 503 no `/pair`
- **Commit:** `878b22e` (22/06/2026)
- **Problema:** Funções `processarMensagem()` e `conectarBot()` estavam ausentes no arquivo principal. O `sockGlobal` nunca era atribuído, causando 503 em qualquer requisição ao endpoint `/pair`.
- **Fix:** Adicionadas as funções ausentes; `sockGlobal` agora é corretamente inicializado na conexão.

### Bug 3 (tentativa 1) — `restaurarSessao` não tratava escapes duplos
- **Commit:** `b44daca` (22/06/2026)
- **Problema:** `JSON.parse` falhava silenciosamente — o Render introduz escapes duplos (`\\n`) na variável de ambiente `CREDS_JSON`.
- **Fix parcial:** Adicionado log do erro real do `JSON.parse`.

### Bug 3 (tentativa 2 — fix definitivo) — normalização robusta de `CREDS_JSON`
- **Commit:** `2bf6c08` (22/06/2026)
- **Problema:** O fix anterior não cobria todos os cenários de escape duplo.
- **Fix:** Criada função `normalizarCredsJson()` que trata `\\n → \n`, `\\t → \t`, `\\r → \r`, `\\\\ → \\`. Log dos primeiros 300 chars e tamanho do JSON para diagnóstico.

### Bug implícito — código 515 tratado como `loggedOut`
- **Commits:** `561ed55` → `688735` → `fbae200` (20/06/2026)
- **Problema:** O código Baileys 515 (`restartRequired`) estava sendo tratado como logout, deletando credenciais e causando loop infinito de pairing.
- **Fix:** Código 515 agora causa reconexão imediata sem resetar sessão.

### Bug implícito — cache JWT inválido em erros de rede
- **Commit:** `17454843` (20/06/2026)
- **Problema:** Cache JWT não era invalidado em erros de rede, causando falhas repetidas com token expirado.
- **Fix:** Cache JWT é invalidado ao detectar erro de rede, forçando novo token no retry.

### Bug implícito — sem retry no Google Sheets
- **Commit:** `60b14ca` (20/06/2026)
- **Fix:** Adicionado retry com backoff exponencial nas chamadas ao Google Sheets.

### Bug implícito — JWT reutilizado sem cache / sem timeout
- **Commit:** `1bc9456` (20/06/2026)
- **Fix:** JWT com cache + timeout nas chamadas Google Sheets.

### Bug implícito — bot ignorava mensagens do grupo
- **Commit:** `47e71e4` (20/06/2026)
- **Problema:** Comparação exata do nome do grupo falhava por diferença de capitalização/espaços.
- **Fix:** Substituído `===` por `.includes()` na comparação do nome do grupo.

### Bug implícito — crash em `processarPagamentoProduto`
- **Commits:** `7f0c971`, `999ef20`, `a23f568` (20/06/2026)
- **Problemas:**
  1. `SyntaxError` nos returns da função.
  2. Precedência de operador `||` causava crash quando `nomeCanon` era truthy e `row` era null.
  3. Nome do cliente acessado após `row.delete()` causava erro.
- **Fix:** Corrigido syntax error, adicionados parênteses explícitos, nome salvo antes do delete.

### Bug 4 — `creds.update` não persistia sessão no Render
- **Status:** ✅ Confirmado corrigido (mencionado no commit `69af2e9`)
- **Fix:** `creds.update` chama `salvarSessaoNoRender()`.

### Bug 5 — `agendamentosIniciados` nunca resetado no reconnect
- **Commit:** `69af2e9` (22/06/2026)
- **Problema:** Flag `agendamentosIniciados = true` persistia após queda do bot, impedindo reinício dos agendamentos na reconexão → silêncio total.
- **Fix:** `agendamentosIniciados = false` adicionado no bloco `connection === 'close'`.

### Bug 6 — `norm()` usada antes de ser declarada em `CORRECOES_VOZ`
- **Commit:** `69af2e9` (22/06/2026)
- **Problema:** `corrigirPalavra()` chamava `norm()` que estava declarada depois no arquivo — risco de manutenção (dependia de hoisting).
- **Fix:** `function norm()` movida para antes de `CORRECOES_VOZ` e `corrigirPalavra()`.

---

## 🔴 Bugs Pendentes (identificados, ainda não corrigidos)

### Bug 7 — `getSheetHistorico()` faz dupla chamada `getDoc()` em cascata
- **Arquivo:** `index.js`
- **Problema:** `registrarOuAcumular()` chama `getSheetSaldo()` + `getSheetHistorico()` separadamente, cada uma chamando `getDoc()` — 2 chamadas à API Google por operação. Com volume moderado causa erro **429 Too Many Requests**.
- **Fix planejado:** Refatorar para chamar `getDoc()` uma única vez e derivar ambas as sheets da mesma instância.

### Bug 8 — `onEdit` no Apps Script sem proteção de sheet
- **Arquivo:** `Codigo_Google_Apps_Script.gs`
- **Problema:** O trigger `onEdit` não verifica `e.range.getSheet().getName()` — dispara para qualquer edição em qualquer aba. Edição manual na aba "Historico" pode corromper saldos.
- **Fix planejado:** Adicionar guard no início de `onEdit`: `if (e.range.getSheet().getName() !== 'Controle') return;`

### Bug 9 — Sem hot-reload (toda atualização derruba sessão)
- **Problema:** O Render recria o container a cada deploy, perdendo a sessão em memória e forçando novo pairing code (agravado pelo Bug 4, já corrigido).
- **Fix planejado:** Avaliar persistência de sessão em volume externo ou estratégia de zero-downtime deploy.

---

## 🏗️ Arquitetura Atual

```
WhatsApp ←→ Baileys (index.js)
               ↓
         Google Sheets API
         (google-spreadsheet v4)
               ↓
         Planilha Google
         (aba "Controle")
               ↓
         Google Apps Script
         (Codigo_Google_Apps_Script.gs)
         [doPost webhook — ações: add/pag/ver/relatorio/del]
```

**Sessão WhatsApp:** Salva como JSON na variável de ambiente `CREDS_JSON` do Render via API REST.

---

## 📋 Próximos Passos

1. **Corrigir Bug 7** — refatorar `getDoc()` para chamada única em `registrarOuAcumular()`
2. **Corrigir Bug 8** — adicionar proteção de sheet no `onEdit` do Apps Script
3. **Avaliar Bug 9** — estratégia de persistência de sessão entre deploys
4. Testar o bot end-to-end após todos os fixes dos bugs 5 e 6 (último deploy)

---

## 📅 Última atualização
**22/06/2026 — 13:33 BRT**  
Bugs 1–6 corrigidos. Bugs 7, 8, 9 identificados e pendentes.
