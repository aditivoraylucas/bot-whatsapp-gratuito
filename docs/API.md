# API.md
> APIs utilizadas pelo bot, integrações externas e detalhes de configuração.

---

## Baileys (WhatsApp Web)

**Pacote:** `@whiskeysockets/baileys`
**Versão:** latest (ver `package.json`)
**Documentação:** https://github.com/WhiskeySockets/Baileys

**Como é usado:**
- Conecta ao WhatsApp Web sem número de telefone registrado como API oficial
- Autenticação via **Pairing Code** (não QR Code — ambiente headless)
- Escuta evento `messages.upsert` para capturar mensagens do grupo
- Credenciais salvas no evento `creds.update` → persistidas via Render API

**Endpoint de pareamento:**
```
GET /pair?phone=5511999999999
→ Retorna código de 8 dígitos para digitar no WhatsApp
```

**Reconexão automática:**
- Código 515 (`restartRequired`) → reconecta sem resetar sessão
- Código 401 (`loggedOut`) → reseta credenciais e para
- Backoff exponencial: tentativa × 5s (máximo configurável)

---

## Google Sheets API

**Pacote:** `google-spreadsheet` v4 + `google-auth-library`
**Autenticação:** Service Account (JWT)

**Variáveis necessárias em `config.js`:**
```
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
GOOGLE_SHEET_ID
```

**Operações usadas:**
- Leitura de linhas (`getRows`)
- Escrita de células (`sheet.addRow`, `row.save`)
- Deleção de linhas (`row.delete`)

**Retry:** Backoff exponencial (4 tentativas, delay × 2s) para erros de rede e 429.

**Cache JWT:** Token reutilizado entre chamadas, invalidado em erros de rede.

**⚠️ Bug 7 pendente:** Cada operação faz 2 chamadas `getDoc()` — risco de 429 com volume.

---

## Google Apps Script

**Arquivo:** `Codigo_Google_Apps_Script.gs`
**Variável:** `GOOGLE_SCRIPT_URL` (URL do Web App publicado)

**Ações disponíveis via `doPost`:**
| Ação | Parâmetros | Descrição |
|------|------------|----------|
| `add` | `cliente`, `produto`, `quantidade` | Registra compra fiada |
| `pag` | `cliente`, `valor` ou `produto`+`qtd` | Registra pagamento |
| `ver` | `cliente` | Consulta saldo |
| `relatorio` | — | Gera relatório geral |
| `del` | `cliente`, `rowIndex` | Remove lançamento (cancelar) |

**⚠️ Bug 8 pendente:** `onEdit` dispara para qualquer aba — risco de corromper saldos com edição manual.

---

## Groq API (Whisper)

**Endpoint:** `https://api.groq.com/openai/v1/audio/transcriptions`
**Modelo:** `whisper-large-v3-turbo`
**Variável:** `GROQ_API_KEY`

**Como é usado:**
- Recebe mensagem de áudio do WhatsApp (buffer + mimeType)
- Envia via `form-data` com prompt guia para nomes brasileiros e produtos
- Retorna transcrição em texto que entra no fluxo normal de `processarTexto()`

**Comportamento quando ausente:** Se `GROQ_API_KEY` não estiver configurada, áudios são silenciosamente ignorados (sem erro).

**Formatos suportados:** `.ogg` (padrão WhatsApp), `.mp4`

**Prompt usado:**
```
Contexto: sistema de vendas de doces.
Nomes próprios brasileiros comuns: Ana, Carlos, Julia...
Produtos: trufa, trufas, bolo, bolos, bombom, bombons.
Exemplos: "Rodrigo 1 bolo", "Ana 3 trufas", "Maria pagou 10"...
```

---

## Render API

**Uso:** Salvar sessão WhatsApp (`CREDS_JSON`) como variável de ambiente após cada atualização de credenciais.

**Variáveis necessárias:**
```
RENDER_API_KEY
RENDER_SERVICE_ID
```

**Endpoint usado:**
```
PATCH https://api.render.com/v1/services/{RENDER_SERVICE_ID}/env-vars
Authorization: Bearer {RENDER_API_KEY}
Body: [{ "key": "CREDS_JSON", "value": "..." }]
```

**Quando é chamado:** No evento `creds.update` do Baileys, toda vez que a sessão é atualizada.
