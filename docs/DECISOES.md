# DECISOES.md
> Registro de decisões arquiteturais e técnicas do projeto.
> Formato: Data — Decisão — Motivo — Alternativas descartadas.

---

## Infraestrutura

### D-01 — Hospedagem no Render (free tier)
**Data:** junho/2026
**Decisão:** Usar Render como plataforma de hospedagem.
**Motivo:** Gratuito, suporta Node.js, deploy via GitHub automático.
**Limitações aceitas:** Container recria a cada deploy → sessão WhatsApp perdida (requer novo pairing code).
**Alternativas descartadas:** Railway (pago), Heroku (pago), VPS (complexidade).

### D-02 — Sessão WhatsApp salva em variável de ambiente
**Data:** junho/2026
**Decisão:** Persistir `CREDS_JSON` como env var no Render via API REST.
**Motivo:** Render free tier não tem volume persistente.
**Alternativas descartadas:** Arquivo local (não persiste), Redis (custo), banco de dados (overhead).

### D-03 — Autenticação WhatsApp via Pairing Code
**Data:** 22/06/2026 — commit `0e169ae`
**Decisão:** Substituir QR Code por `requestPairingCode()` do Baileys.
**Motivo:** Render é headless — impossível exibir ou escanear QR Code.
**Alternativas descartadas:** QR Code via imagem (não funciona headless), QR Code via webhook (complexidade).

---

## Arquitetura de Código

### D-04 — Separar lógica em módulos (bot / handlers / sheets / utils)
**Data:** junho/2026
**Decisão:** Dividir o código em 4 módulos com responsabilidades separadas.
**Motivo:** Versão original tinha tudo num único arquivo. Ficou impossível de manter.

### D-05 — Google Apps Script como backend da planilha
**Data:** junho/2026
**Decisão:** Manter o Apps Script como camada de lógica na planilha.
**Motivo:** O `onEdit` automático recalcula saldos. Remover exigiria reescrever tudo no Node.
**Risco conhecido:** trigger `onEdit` sem proteção de aba (Bug 8 — pendente).

### D-06 — Histórico de lançamentos em memória (não persistido)
**Data:** junho/2026
**Decisão:** `ULTIMOS_LANCAMENTOS` mantido apenas em RAM.
**Consequência aceita:** Reiniciar o bot limpa o histórico de cancelamentos.

### D-07 — Arquivos JSON locais para estado volátil
**Data:** junho/2026
**Decisão:** `precos.json`, `sinonimos.json` e `aliases.json` salvos em disco local.
**Limitação aceita:** Perdidos a cada deploy. Workaround: commitar quando houver mudanças.

### D-08 — Deduplicação de mensagens com Set + TTL
**Data:** junho/2026
**Decisão:** `Set` com `setTimeout` de 30s para ignorar mensagens duplicadas do Baileys.
**Motivo:** Baileys ocasionalmente dispara `messages.upsert` duas vezes para a mesma mensagem.

---

## Produto

### D-09 — Limite de crédito por cliente
**Data:** junho/2026
**Comportamento:** Nova compra que ultrapassaria o limite é bloqueada com aviso.

### D-10 — Confirmação antes de zerar cliente
**Data:** junho/2026
**Decisão:** Comando `zerar` requer `sim` dentro de 60 segundos.
**Motivo:** Operação irreversível — evitar acidentes.

### D-11 — Aliases de nomes persistidos
**Data:** junho/2026
**Regra:** Alias resolvido apenas na primeira palavra da mensagem.

### D-12 — Transcrição de áudio via Groq Whisper
**Data:** junho/2026
**Motivo:** Groq é mais rápido que OpenAI Whisper e tem tier gratuito generoso.
**Comportamento:** Se `GROQ_API_KEY` ausente, áudios são ignorados silenciosamente.

### D-13 — Agendamento automático de devedores — REVERTIDO
**Data:** 24/06/2026 — commit `428150e`
**Motivo:** Funcionalidade não desejada pelo dono do projeto.

### D-14 — Backup mensal via Apps Script (não via bot)
**Data:** 24/06/2026
**Motivo:** Duplicar aba exige escopos adicionais no service account. Apps Script resolve sem dependência do bot.

---

## 🗓️ Próximas decisões a tomar

| Questão | Contexto |
|---------|----------|
| Persistir `precos.json` / `aliases.json` entre deploys? | Hoje perdidos no restart. Salvar como env var? |
| Separadores da sugestão 4 (lote) | Só vírgula? Ou também `;` e `\n`? |
| Resposta do cancelar: `cancelar N` ou só `N`? | `cancelar 2` mais seguro, mais verboso |
