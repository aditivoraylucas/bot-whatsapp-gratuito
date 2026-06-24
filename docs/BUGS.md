# BUGS.md
> Bugs conhecidos do projeto.
> Formato: ID · Arquivo · Problema · Fix planejado · Impacto

---

## 🔴 Bugs Ativos (não corrigidos)

### Bug 7 — Dupla chamada `getDoc()` por operação
**Arquivo:** `src/sheets.js`
**Problema:** `registrarOuAcumular()` chama `getSheetSaldo()` + `getSheetHistorico()` separadamente, cada uma chamando `getDoc()` internamente → 2 chamadas à API Google por operação.
**Impacto:** Com volume moderado de mensagens, causa erro **429 Too Many Requests**. Bot para de registrar vendas silenciosamente.
**Fix planejado:**
```javascript
// Antes (problemático):
const sheetSaldo    = await getSheetSaldo();    // chama getDoc()
const sheetHist     = await getSheetHistorico(); // chama getDoc() de novo

// Depois (correto):
const doc           = await getDoc();           // uma única chamada
const sheetSaldo    = doc.sheetsByTitle['Controle'];
const sheetHist     = doc.sheetsByTitle['Histórico'];
```

### Bug 8 — `onEdit` no Apps Script sem proteção de aba
**Arquivo:** `Codigo_Google_Apps_Script.gs`
**Problema:** O trigger `onEdit` não verifica qual aba foi editada — dispara para qualquer edição em qualquer aba da planilha.
**Impacto:** Edição manual em qualquer aba (ex: ajuste de formatação) pode disparar lógica de recálculo de saldos indevidamente, potencialmente corrompendo dados.
**Fix planejado:**
```javascript
function onEdit(e) {
  // Adicionar esta linha no início:
  if (e.range.getSheet().getName() !== 'Controle') return;
  // ... resto do código ...
}
```

### Bug 9 — Sessão WhatsApp perdida a cada deploy
**Arquivo:** `src/bot.js` / infraestrutura Render
**Problema:** Render recria o container a cada deploy, perdendo a sessão em memória e forçando novo pairing code.
**Impacto:** Toda atualização de código exige novo pareamento manual no WhatsApp.
**Fix planejado:** Avaliar persistência de sessão em volume externo (Render Disk) ou estratégia zero-downtime.
**Complexidade:** Alta — envolve mudança na infraestrutura.

---

## ✅ Bugs Corrigidos (histórico)

| ID | Descrição | Commit | Data |
|----|-----------|--------|------|
| Bug 0 | Regex escapada incorretamente em `parsearLinha` | `9f6bd86` | 21/06/2026 |
| — | QR Code substituído por Pairing Code (headless) | `0e169ae` | 22/06/2026 |
| Bug 1 | Conflito da dependência `qrcode` | `289a671` | 22/06/2026 |
| Bug 2 | `sockGlobal` nunca inicializado → 503 no `/pair` | `878b22e` | 22/06/2026 |
| Bug 3 | `CREDS_JSON` com escapes duplos do Render | `2bf6c08` | 22/06/2026 |
| — | Código 515 tratado como `loggedOut` | `fbae200` | 20/06/2026 |
| — | Cache JWT inválido em erros de rede | `1745484` | 20/06/2026 |
| — | Sem retry no Google Sheets | `60b14ca` | 20/06/2026 |
| Bug 4 | `creds.update` não persistia sessão no Render | `69af2e9` | 22/06/2026 |
| Bug 5 | `agendamentosIniciados` nunca resetado no reconnect | `69af2e9` | 22/06/2026 |
| Bug 6 | `norm()` usada antes de ser declarada | `69af2e9` | 22/06/2026 |
| — | Bot ignorava mensagens do grupo (comparação exata) | `47e71e4` | 20/06/2026 |
| — | Crash em `processarPagamentoProduto` (3 problemas) | `a23f568` | 20/06/2026 |
