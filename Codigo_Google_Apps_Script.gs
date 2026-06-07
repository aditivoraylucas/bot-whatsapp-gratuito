const PRECO_BOMBOM = 5.00;
const PRECO_BOLO = 12.00;
const ABA = "Controle";

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const acao = body.acao || "";
  let reply = "";

  if (acao === "add") reply = cmdAdicionar(body);
  else if (acao === "pag") reply = cmdPagar(body);
  else if (acao === "ver") reply = cmdVer(body);
  else if (acao === "relatorio") reply = cmdRelatorio();
  else if (acao === "del") reply = cmdDeletar(body);

  return ContentService
    .createTextOutput(JSON.stringify({ reply: reply }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ABA);
  if (!sh) {
    sh = ss.insertSheet(ABA);
    sh.appendRow(["Nome", "Bombom (qtd)", "Bolo (qtd)", "Total R$", "Atualizado"]);
  }
  return sh;
}

function findRow(sh, nome) {
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]).toLowerCase() === String(nome).toLowerCase()) return i + 1;
  }
  return -1;
}

function money(v) {
  return "R$ " + Number(v).toFixed(2).replace(".", ",");
}

function cmdAdicionar(b) {
  const sh = getSheet();
  const nome = String(b.nome || "").trim();
  const bombom = Number(b.bombom || 0);
  const bolo = Number(b.bolo || 0);

  let row = findRow(sh, nome);
  if (row === -1) { sh.appendRow([nome, 0, 0, 0, new Date()]); row = sh.getLastRow(); }

  const bAt = Number(sh.getRange(row, 2).getValue() || 0);
  const boAt = Number(sh.getRange(row, 3).getValue() || 0);
  const nb = bAt + bombom;
  const nbo = boAt + bolo;
  const total = nb * PRECO_BOMBOM + nbo * PRECO_BOLO;

  sh.getRange(row, 2).setValue(nb);
  sh.getRange(row, 3).setValue(nbo);
  sh.getRange(row, 4).setValue(total);
  sh.getRange(row, 5).setValue(new Date());

  return `✅ ${nome} atualizado. Saldo: ${money(total)}`;
}

function cmdPagar(b) {
  const sh = getSheet();
  const nome = String(b.nome || "").trim();
  const bombom = Number(b.bombom || 0);
  const bolo = Number(b.bolo || 0);

  let row = findRow(sh, nome);
  if (row === -1) return `❌ ${nome} não encontrado`;

  const bAt = Number(sh.getRange(row, 2).getValue() || 0);
  const boAt = Number(sh.getRange(row, 3).getValue() || 0);
  const nb = Math.max(0, bAt - bombom);
  const nbo = Math.max(0, boAt - bolo);
  const total = nb * PRECO_BOMBOM + nbo * PRECO_BOLO;

  sh.getRange(row, 2).setValue(nb);
  sh.getRange(row, 3).setValue(nbo);
  sh.getRange(row, 4).setValue(total);
  sh.getRange(row, 5).setValue(new Date());

  return `💳 Pagamento registrado. Saldo: ${money(total)}`;
}

function cmdVer(b) {
  const sh = getSheet();
  const nome = String(b.nome || "").trim();
  const row = findRow(sh, nome);

  if (row === -1) return `❌ ${nome} não encontrado`;

  const bombom = Number(sh.getRange(row, 2).getValue() || 0);
  const bolo = Number(sh.getRange(row, 3).getValue() || 0);
  const total = Number(sh.getRange(row, 4).getValue() || 0);

  return `📋 ${nome} | Bombom: ${bombom} | Bolo: ${bolo} | Total: ${money(total)}`;
}

function cmdRelatorio() {
  const sh = getSheet();
  const vals = sh.getDataRange().getValues();
  let txt = "📊 RELATÓRIO\n";
  let tot = 0;

  for (let i = 1; i < vals.length; i++) {
    const t = Number(vals[i][3] || 0);
    if (t > 0) { txt += `${vals[i][0]}: ${money(t)}\n`; tot += t; }
  }

  txt += `TOTAL: ${money(tot)}`;
  return txt;
}

function cmdDeletar(b) {
  const sh = getSheet();
  const nome = String(b.nome || "").trim();
  const row = findRow(sh, nome);

  if (row === -1) return `❌ ${nome} não encontrado`;

  sh.deleteRow(row);
  return `🗑️ ${nome} removido`;
}
