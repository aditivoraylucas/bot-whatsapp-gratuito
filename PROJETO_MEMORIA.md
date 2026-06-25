# PROJETO_MEMORIA.md
> Atualizado em: 2026-06-25
> Atualizar com: "Atualize a memória" — o assistente lê este arquivo, compara com a sessão e commita as mudanças.

---

## Objetivo do bot

Bot de WhatsApp para gestão de vendas fiado e à vista de uma confeitaria. Opera exclusivamente dentro de um grupo do WhatsApp. Registra vendas, pagamentos e gera relatórios diretamente na planilha Google Sheets.

---

## Ambiente

| Item | Valor |
|---|---|
| Plataforma | Render (Node.js web service) |
| Repositório | `aditivoraylucas/bot-whatsapp-gratuito` |
| Branch principal | `main` |
| Runtime | Node.js |
| WhatsApp lib | `@whiskeysockets/baileys` |
| Transcrição de áudio | Groq API |
| Planilha | Google Sheets (via Service Account) |
| Sessão WA | Salva como `CREDS_JSON` (env-var Render) |

---

## Estrutura de arquivos (`src/`)

```
src/
├── bot.js              ← Conexão Baileys, reconexão, agendamentos
├── config.js           ← Variáveis de ambiente e constantes
├── handlers.js         ← Fachada: roteador de comandos de texto e áudio
├── handlers/
│   ├── index.js        ← Barrel (re-exporta handlers.js)
│   ├── products.js     ← mudarPreco, cadastrarNovoProduto, listarProdutos, mensagemAjuda
│   └── session.js      ← ZERAR_PENDENTE, ZERAR_TTL_MS, ORDENS_RELATORIO
├── health.js           ← Servidor HTTP, pairing web, webhook GitHub
├── persist.js          ← Persiste PRECOS/ALIASES/SINONIMOS como env-vars no Render
├── sheets.js           ← Fachada: toda lógica de negócio da planilha
├── sheets/
│   ├── index.js        ← Barrel (re-exporta sheets.js)
│   ├── auth.js         ← getAccessToken, cache OAuth
│   └── core.js         ← sheetsGET/POST/PUT/DELETE, getRows, appendRow, etc.
├── sheetsReports.js    ← Relatórios: geral, detalhado, quitados, mês, período
├── utils.js            ← norm, fuzzy, PRECOS, ALIASES, SINONIMOS, retry
└── views/              ← Templates HTML (formulário de pairing)
```

---

## Env-vars no Render

| Chave | Descrição |
|---|---|
| `CREDS_JSON` | Sessão WhatsApp (creds.json serializado) |
| `BOT_PRECOS` | JSON com preços dos produtos |
| `BOT_ALIASES` | JSON com apelidos → nome completo |
| `BOT_SINONIMOS` | JSON com sinônimos extras de produtos |
| `SPREADSHEET_URL` | URL ou ID da planilha Google |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Email da service account |
| `GOOGLE_PRIVATE_KEY` | Chave privada da service account |
| `GROQ_API_KEY` | Chave da API Groq (transcrição de áudio) |
| `RENDER_API_KEY` | Chave da Render API (persistência de env-vars) |
| `RENDER_SERVICE_ID` | ID do serviço Render |
| `GRUPO_NOME` | Nome (ou parte) do grupo WhatsApp monitorado |
| `LIMITE_CREDITO` | Limite de crédito padrão (0 = sem limite) |
| `DIAS_LEMBRETE` | Dias de antecedência para lembrete de vencimento |
| `HORA_LEMBRETE` | Hora do lembrete diário (padrão: 20) |
| `HORA_RESUMO` | Hora do resumo diário (padrão: 21) |
| `GITHUB_WEBHOOK_SECRET` | Secret do webhook GitHub |

---

## Funcionalidades ativas

### Vendas
- Registrar venda fiado: `ana 3 trufas`
- Registrar venda à vista: `ana 3 trufas pix` / `ana 3 trufas dinheiro`
- Cancelar último lançamento: `cancelar ana`
- Reconhecimento fuzzy de nomes (Levenshtein)
- Reconhecimento de números por extenso (`três trufas`)
- Transcrição de áudio via Groq

### Pagamentos
- Registrar pagamento: `ana pagou 50` / `ana pix 50`
- Zerar saldo com confirmação: `zerar ana` → confirmar

### Clientes
- Alias de nome: `alias ray Raylucas` → resolve `ray` para `Raylucas`
- Renomear cliente: `renomear Ana → Ana Clara` (atualiza Saldo e Histórico)
- Limite de crédito individual

### Produtos
- Mudar preço: `preco trufa 6`
- Cadastrar novo produto: `novo brigadeiro 3.50`
- Listar produtos: `produtos`
- Sinônimos extras cadastráveis

### Relatórios
- `relatorio` — saldo de todos os clientes
- `relatorio detalhado` — histórico completo
- `relatorio quitados` — clientes com saldo zero
- `relatorio mes` / `relatorio janeiro` — por mês
- `relatorio hoje` / `relatorio semana` — por período
- `resumo` — resumo do dia atual

### Automações
- Lembrete de vencimento diário (hora configurável)
- Resumo automático diário (hora configurável)

### Sistema
- Pairing por número (sem QR code) via formulário web
- Sessão persistente: reconecta automaticamente após deploy
- Persistência de PRECOS/ALIASES/SINONIMOS via Render API
- Deduplicação de mensagens (TTL 30s)
- Retry com backoff exponencial para Google API
- Webhook GitHub para deploy automático

---

## Comandos principais

| Comando | Descrição |
|---|---|
| `[nome] [qtd] [produto]` | Registra venda fiado |
| `[nome] [qtd] [produto] pix/dinheiro` | Registra venda à vista |
| `[nome] pagou [valor]` | Registra pagamento |
| `cancelar [nome]` | Cancela último lançamento do cliente |
| `zerar [nome]` | Zera saldo (pede confirmação) |
| `relatorio` | Relatório geral de saldos |
| `relatorio hoje/semana/mes` | Relatório por período |
| `preco [produto] [valor]` | Altera preço |
| `novo [produto] [valor]` | Cadastra produto |
| `produtos` | Lista produtos e preços |
| `alias [apelido] [nome]` | Cadastra apelido |
| `renomear [de] → [para]` | Renomeia cliente |
| `ajuda` | Lista de comandos |
