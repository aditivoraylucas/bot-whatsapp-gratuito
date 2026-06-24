# SHEETS.md
> Estrutura da planilha Google Sheets e configuração do Google Apps Script.

---

## Estrutura da Planilha

**ID da planilha:** configurado em `GOOGLE_SHEET_ID` (env var)

### Aba: Controle
Aba principal onde o bot lê e escreve.

| Coluna | Conteúdo | Observação |
|--------|----------|------------|
| A | Nome do cliente | Capitalizado |
| B | Produto | Chave interna (ex: `trufa`, `bolo`) |
| C | Quantidade | Número inteiro |
| D | Valor (R$) | Calculado: preço × quantidade |
| E | Data/Hora | `DD/MM/AAAA, HH:MM:SS` (fuso SP) |
| F | Tipo | `fiado` ou `vista` |
| G | Método de pagamento | `Pix`, `Dinheiro`, `Débito`, `Crédito` ou vazio |

### Aba: Histórico
Aba usada para relatórios e consultas de histórico.
_(confirmar nome exato com o dono do projeto antes de alterar)_

---

## Google Apps Script

**Arquivo no repositório:** `Codigo_Google_Apps_Script.gs`
**Como publicar:** Extensões → Apps Script → Implantar → Novo deploy → Web App → Executar como: eu → Acesso: qualquer pessoa
**URL gerada:** salvar em `GOOGLE_SCRIPT_URL` (env var do Render)

### Ações disponíveis (doPost)

| Ação | Descrição |
|------|-----------|
| `add` | Registra nova compra fiada |
| `pag` | Registra pagamento de dívida |
| `ver` | Consulta saldo do cliente |
| `relatorio` | Gera relatório geral |
| `del` | Remove lançamento (usado pelo cancelar) |

### Trigger onEdit
**Função:** Recalcula saldo automaticamente quando uma célula da aba Controle é editada.
**⚠️ Bug 8 pendente:** Não verifica o nome da aba — dispara para qualquer edição.
**Fix:** Adicionar no início: `if (e.range.getSheet().getName() !== 'Controle') return;`

---

## Backup Mensal Automático

Configurar diretamente no Apps Script da planilha:

```javascript
function backupMensal() {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const abaOrigem = ss.getSheetByName('Histórico'); // ajustar nome se necessário
  if (!abaOrigem) return;

  const mes  = Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'yyyy-MM');
  const nome = `Histórico ${mes}`;

  if (ss.getSheetByName(nome)) return; // já existe, não duplica

  abaOrigem.copyTo(ss).setName(nome);
}
```

**Como configurar o gatilho:**
1. Extensões → Apps Script
2. Ícone de relógio (Gatilhos) → **+ Adicionar gatilho**
3. Função: `backupMensal`
4. Tipo: Temporizador baseado em tempo → **Mensal**
5. Dia: 1 | Hora: 00h–01h
6. Salvar

**Resultado:** Toda dia 1º do mês é criada automaticamente uma aba `Histórico 2026-07`, `Histórico 2026-08`, etc. A aba original não é tocada.
