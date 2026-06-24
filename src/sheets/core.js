// ─── CORE REST — helpers HTTP e acesso às abas ───────────────────────────────
// Responsabilidade: wraps HTTP para a API REST do Google Sheets (GET/POST/PUT/DELETE),
// estrutura de cabeçalhos das abas, leitura e escrita de linhas.
// Não contém lógica de negócio nem de relatórios.
// ─────────────────────────────────────────────────────────────────────────────
const { SPREADSHEET_ID } = require('../config');
const { comRetry }       = require('../utils');
const { getAccessToken } = require('./auth');

const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;
console.log('[sheets/core] BASE URL:', BASE);

// ── Headers das abas ───────────────────────────────────────────────────────────
const HDR_SALDO = ['Cliente','Produto','Quantidade','Total','UltimaCompra'];
const HDR_HIST  = ['Data','Cliente','Tipo','Produto','Quantidade','Valor','Metodo'];

// ── HTTP helpers ────────────────────────────────────────────────────────────────
async function sheetsGET(path) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path} => ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sheetsPOST(path, body) {
  const token = await getAccessToken();
  const url = path === ':batchUpdate' ? `${BASE}:batchUpdate` : `${BASE}${path}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} => ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sheetsPUT(path, body) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} => ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sheetsDELETE(path, body) {
  const token = await getAccessToken();
  const r = await fetch(`${BASE}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`batchUpdate => ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Estrutura e garantia das abas ──────────────────────────────────────────────
async function getSheetsMeta() {
  return comRetry(() => sheetsGET('?fields=sheets(properties(sheetId,title,index))'), 4, 'getSheetsMeta');
}

async function ensureSaldoSheet(meta) {
  const aba0 = meta.sheets[0].properties;
  if (aba0.title === 'Saldo') return aba0;
  const jaExiste = meta.sheets.find(s => s.properties.title === 'Saldo');
  if (jaExiste) return jaExiste.properties;
  console.log(`[core] Renomeando aba "${aba0.title}" → "Saldo"`);
  await comRetry(() => sheetsPOST(':batchUpdate', {
    requests: [{ updateSheetProperties: {
      properties: { sheetId: aba0.sheetId, title: 'Saldo' },
      fields: 'title',
    }}],
  }), 4, 'renomearSaldo');
  return { ...aba0, title: 'Saldo' };
}

async function ensureHeaders(sheetTitle, headers, sheetId) {
  const range = `${sheetTitle}!A1:${String.fromCharCode(64 + headers.length)}1`;
  const data  = await comRetry(() => sheetsGET(`/values/${encodeURIComponent(range)}`), 4, 'ensureHeaders');
  const first = (data.values || [[]])[0] || [];
  if (first.length === headers.length) return;
  await comRetry(() => sheetsPUT(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    range, majorDimension: 'ROWS', values: [headers],
  }), 4, 'setHeaders');
}

async function getOrCreateHistSheet(meta) {
  const exists = meta.sheets.find(s => s.properties.title === 'Historico');
  if (exists) return exists.properties;
  const resp = await comRetry(() => sheetsPOST(':batchUpdate', {
    requests: [{ addSheet: { properties: { title: 'Historico' } } }],
  }), 4, 'addSheet');
  const props = resp.replies[0].addSheet.properties;
  await ensureHeaders('Historico', HDR_HIST, props.sheetId);
  return props;
}

// ── CRUD de linhas ──────────────────────────────────────────────────────────────────
async function getRows(sheetTitle, headers) {
  const lastCol = String.fromCharCode(64 + headers.length);
  const data = await comRetry(
    () => sheetsGET(`/values/${encodeURIComponent(sheetTitle + '!A2:' + lastCol)}?majorDimension=ROWS`),
    4, 'getRows'
  );
  return (data.values || []).map((row, i) => {
    const obj = {};
    headers.forEach((h, j) => obj[h] = row[j] || '');
    obj._rowIndex = i + 2;
    return obj;
  });
}

async function appendRow(sheetTitle, headers, values) {
  const range = `${sheetTitle}!A:A`;
  await comRetry(() => sheetsPOST(`/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    majorDimension: 'ROWS',
    values: [headers.map(h => values[h] !== undefined ? String(values[h]) : '')],
  }), 4, 'appendRow');
}

async function updateRow(sheetTitle, headers, rowIndex, values) {
  const lastCol = String.fromCharCode(64 + headers.length);
  const range   = `${sheetTitle}!A${rowIndex}:${lastCol}${rowIndex}`;
  await comRetry(() => sheetsPUT(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    range, majorDimension: 'ROWS',
    values: [headers.map(h => values[h] !== undefined ? String(values[h]) : '')],
  }), 4, 'updateRow');
}

async function deleteRows(sheetId, rowIndexes) {
  const sorted = [...new Set(rowIndexes)].sort((a, b) => b - a);
  for (const ri of sorted) {
    await comRetry(() => sheetsDELETE(':batchUpdate', {
      requests: [{ deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: ri - 1, endIndex: ri },
      } }],
    }), 4, 'deleteRow');
  }
}

module.exports = {
  HDR_SALDO, HDR_HIST,
  sheetsGET, sheetsPOST, sheetsPUT, sheetsDELETE,
  getSheetsMeta, ensureSaldoSheet, ensureHeaders, getOrCreateHistSheet,
  getRows, appendRow, updateRow, deleteRows,
};
