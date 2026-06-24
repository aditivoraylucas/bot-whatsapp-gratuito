# TODO.md
> Lista de tarefas pendentes. Atualizar a cada sessão.
> Formato: prioridade · descrição · arquivo(s) afetado(s)

---

## 🔴 Alta Prioridade

### [ ] Sugestão 4 — Múltiplos clientes por mensagem
- **O que fazer:** Criar função `parsearLote(texto)` em `src/handlers.js`
- **Comportamento:** `"Ana 2 trufas, Carlos 1 bolo, Julia 3 bombons"` → 3 registros
- **Lógica:** Divide por `,` `;` `\n` → parseia cada segmento → só ativa se ≥ 2 válidos
- **Onde inserir:** No `processarTexto()`, antes do bloco `parsearVendaVista`
- **Arquivo:** `src/handlers.js`

### [ ] Sugestão 6 — Cancelar com seleção interativa
- **O que fazer:** Mostrar últimos 3 lançamentos do cliente para escolher qual cancelar
- **Fluxo:**
  1. `cancelar carlos` → lista 3 lançamentos numerados
  2. Usuário responde `cancelar 1`, `cancelar 2` ou `cancelar 3`
  3. Bot executa o cancelamento escolhido
- **Adicionar:** `CANCELAR_PENDENTE` (mesmo padrão do `ZERAR_PENDENTE`)
- **Arquivos:** `src/handlers.js` + `src/sheets.js`

### [ ] Bug 7 — Dupla chamada `getDoc()` por operação
- **O que fazer:** Refatorar `registrarOuAcumular()` para chamar `getDoc()` uma única vez
- **Arquivo:** `src/sheets.js`
- **Impacto:** Evita erro 429 (Too Many Requests) com volume moderado

---

## 🟡 Média Prioridade

### [ ] Bug 8 — `onEdit` sem proteção de aba
- **O que fazer:** Adicionar guard no início de `onEdit`:
  ```javascript
  if (e.range.getSheet().getName() !== 'Controle') return;
  ```
- **Arquivo:** `Codigo_Google_Apps_Script.gs`

### [ ] Backup mensal da planilha
- **O que fazer:** Configurar gatilho mensal no Google Apps Script
- **Não é no bot** — ver `SHEETS.md` para o script e instruções

---

## 🔵 Baixa Prioridade / Em avaliação

### [ ] Bug 9 — Sessão perdida a cada deploy
- **O que fazer:** Avaliar persistência de sessão em volume externo ou zero-downtime deploy
- **Complexidade:** Alta — envolve mudança na infraestrutura do Render

### [ ] Persistir `precos.json` / `aliases.json` entre deploys
- **Opção A:** Commitar os arquivos no repositório após cada mudança
- **Opção B:** Salvar como env var no Render (mesmo padrão do `CREDS_JSON`)
- **Decisão pendente:** Ver `DECISOES.md`

---

## ✅ Concluído (histórico)

- [x] Bug 0 — regex escapada incorretamente em `parsearLinha` (`9f6bd86`)
- [x] Bug implícito — QR Code substituído por Pairing Code (`0e169ae`)
- [x] Bug 1 — conflito da dependência `qrcode` (`289a671`)
- [x] Bug 2 — `sockGlobal` nunca inicializado → 503 no `/pair` (`878b22e`)
- [x] Bug 3 — normalização robusta de `CREDS_JSON` (`2bf6c08`)
- [x] Bug implícito — código 515 tratado como `loggedOut`
- [x] Bug implícito — cache JWT inválido em erros de rede
- [x] Bug implícito — sem retry no Google Sheets
- [x] Bug 4 — `creds.update` não persistia sessão no Render
- [x] Bug 5 — `agendamentosIniciados` nunca resetado no reconnect (`69af2e9`)
- [x] Bug 6 — `norm()` usada antes de ser declarada (`69af2e9`)
- [x] Aliases de nomes (apelidos de clientes)
- [x] Confirmação antes de zerar cliente
- [x] Deduplicação de mensagens duplicadas do Baileys
- [x] Transcrição de áudio via Groq Whisper
- [x] Limite de crédito por cliente
- [x] Documentação: `PROJETO_MEMORIA.md`, `DECISOES.md`, pasta `/docs`
