# DECISOES.md
> Registro de decisões técnicas do projeto.
> Atualizado em: 2026-06-25

---

## 2026-06-25 — Persistência de sessão WhatsApp após deploy

**Problema:** A cada novo deploy no Render, o processo Node era morto e o sistema de arquivos zerado. O `CREDS_JSON` já era salvo como env-var, mas havia 3 bugs:
1. `restaurarSessao()` priorizava arquivo local em vez da env-var — arquivo podia estar desatualizado
2. Dois `creds.update` simultâneos causavam PUT concorrente na Render API (race condition)
3. Comparação de string inteira no lugar de hash — lento e impreciso

**Decisão:** Reescrever `salvarSessaoNoRender` com:
- Fila de salvamento (`_salvandoAgora` + `_salvarNovamente`) — garante um PUT por vez
- Hash MD5 do conteúdo — evita PUT quando nada mudou
- `restaurarSessao` prioriza `CREDS_JSON` (env-var) sobre arquivo local
- Inicializa `_hashSalvo` no boot para evitar PUT desnecessário imediatamente após restaurar

**Resultado:** Deploy → ~20-30s → bot online sem novo pairing.

---

## 2026-06-25 — Persistência de PRECOS/ALIASES/SINONIMOS via Render API

**Problema:** `PRECOS`, `ALIASES` e `SINONIMOS_EXTRA` eram salvos em arquivos `.json` locais (`precos.json`, `aliases.json`, `sinonimos.json`). O Render apaga o filesystem a cada deploy — dados cadastrados via comando sumiam.

**Decisão:** Criar `src/persist.js` dedicado à Render API, com 3 pares de funções (carregar/salvar para cada dado). `utils.js` atualizado para:
1. Tentar env-var (`BOT_PRECOS`, `BOT_ALIASES`, `BOT_SINONIMOS`) primeiro
2. Fallback para arquivo local (compatibilidade retroativa)
3. Fallback para valor padrão

Ao salvar: grava no arquivo local (rápido, sem rede) E na Render API (sobrevive a deploy).

**Motivo de não usar a planilha:** Acessos frequentes de leitura/escrita à planilha têm custo de latência (~500ms). Env-vars são síncronas no boot e assíncronas no save — melhor UX.

---

## 2026-06-25 — Refatoração modular de sheets.js e handlers.js

**Problema:** `sheets.js` (~1000 linhas) e `handlers.js` (~800 linhas) misturavam responsabilidades — autenticação, operações HTTP, lógica de negócio e relatórios num único arquivo.

**Decisão:** Extrair módulos sem quebrar a API pública existente:
- `sheets/auth.js` — OAuth token
- `sheets/core.js` — HTTP helpers e operações CRUD
- `sheetsReports.js` — todos os relatórios
- `handlers/products.js` — comandos de produto
- `handlers/session.js` — constantes de estado
- Barrels `sheets/index.js` e `handlers/index.js` — transparência para quem importa

**Princípio:** `sheets.js` e `handlers.js` continuam como fachadas — nenhum arquivo externo precisou ser alterado.

---

## 2026-06-25 — Relatórios por período (hoje/semana/mês)

**Problema:** Relatórios existentes eram somente por cliente ou por mês específico. Não havia visão rápida do que aconteceu hoje ou na semana.

**Decisão:** Adicionar `gerarRelatorioPeriodo(tipo)` em `sheetsReports.js` com tipos `hoje`, `semana`, `mes`. Filtra o Histórico pelo campo de data, agrupa por cliente e mostra compras, pagamentos por método e saldo devedor.

---

## 2026-06-25 — Renomear cliente

**Problema:** Não havia como corrigir o nome de um cliente já cadastrado. Uma digitação errada ficava permanentemente no Saldo e no Histórico.

**Decisão:** Comando `renomear [de] → [para]` que atualiza o nome em todas as linhas das abas Saldo e Histórico. Implementado em `sheets.js` como `renomearCliente()`.

---

## Decisões de arquitetura permanentes

### Fachada obrigatória
Todo módulo extraído deve ser transparente para os importadores. `sheets.js` e `handlers.js` são as únicas APIs públicas — módulos internos nunca são importados diretamente por `bot.js` ou `health.js`.

### Retry com backoff para Google API
Todas as chamadas à Sheets API passam por `comRetry(fn, 4)` com espera de `n * 2s`. Erros de rede (`Premature close`, `fetch failed`) são recuperáveis; erros de autenticação e quota não são.

### Sem localStorage / sessionStorage
O bot roda em iframe sandboxado no Render — storage de browser bloqueado. Todo estado transiente fica em variáveis de módulo (`let`). Todo estado persistente vai para Render API.

### Deduplicação de mensagens
Baileys pode disparar `messages.upsert` duplicado para a mesma mensagem. Um `Set` com TTL de 30s (`mensagensProcessadas`) garante idempotência.

---

## Pendências / próximas melhorias

| # | Item | Prioridade |
|---|---|---|
| 1 | Aviso no grupo quando bot cai/reconecta | 🔴 Alta |
| 2 | Limite de tentativas de reconexão + notificação | 🔴 Alta |
| 3 | Backup automático semanal da planilha | 🟡 Média |
| 4 | Comando `status` (uptime, planilha OK, msgs hoje) | 🟡 Média |
| 5 | Feedback de erro quando planilha está offline | 🟡 Média |
| 6 | Relatório por produto (`relatorio produtos`) | 🟡 Média |
| 7 | Confirmação para pagamentos acima de valor X | 🟡 Média |
| 8 | `ajuda` por categoria | 🟢 Baixa |
