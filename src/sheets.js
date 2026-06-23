// ─── GOOGLE SHEETS via REST API direta (sem google-auth-library) ──────────────
const crypto = require('crypto');

const {
  SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
  LIMITE_CREDITO_PADRAO,
} = require('./config');

const {
  comRetry, norm, capitalizarNome, mesmoNome, resolverNome,
  agora, agoraData, soData,
  PRECOS, nomeProdutoExib,
  ULTIMOS_LANCAMENTOS, pushLancamento,
} = require('./utils');

// ── Token OAuth cacheado ──────────────────────────────────────────────────
let _tokenCache = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && now < _tokenExpiry) return _tokenCache;

  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    iat,
    exp,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const key = GOOGLE_PRIVATE_KEY;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key, 'base64url');
  const jwt = `${signingInput}.${signature}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OAuth token error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  _tokenCache  = data.access_token;
  _tokenExpiry = now + (data.expires_in - 300) * 1000;
  return _tokenCache;
}

// ── Helpers REST ─────────────────────────────────────────────────────
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;

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

// ── Estrutura da planilha ───────────────────────────────────────────────────
const HDR_SALDO    = ['Cliente','Produto','Quantidade','Total','UltimaCompra'];
const HDR_HIST     = ['Data','Cliente','Tipo','Produto','Quantidade','Valor'];

async function getSheetsMeta() {
  return comRetry(() => sheetsGET('?fields=sheets(properties(sheetId,title,index))'), 4, 'getSheetsMeta');
}

async function ensureSaldoSheet(meta) {
  const aba0 = meta.sheets[0].properties;
  if (aba0.title === 'Saldo') return aba0;
  const jaExiste = meta.sheets.find(s => s.properties.title === 'Saldo');
  if (jaExiste) return jaExiste.properties;
  console.log(`[sheets] Renomeando aba "${aba0.title}" → "Saldo"`);
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

// MELHORIA 3: deleteRows em um único batchUpdate (antes: 1 request por linha)
async function deleteRows(sheetId, rowIndexes) {
  const sorted = [...new Set(rowIndexes)].sort((a, b) => b - a);
  if (!sorted.length) return;
  await comRetry(() => sheetsDELETE(':batchUpdate', {
    requests: sorted.map(ri => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: ri - 1, endIndex: ri },
      },
    })),
  }), 4, 'deleteRows');
}

async function registrarOuAcumular(clienteEnviado, produto, quantidade) {
  try {
    const meta     = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    await ensureHeaders('Saldo', HDR_SALDO, saldoProp.sheetId);
    const histProp = await getOrCreateHistSheet(meta);
    await ensureHeaders('Historico', HDR_HIST, histProp.sheetId);

    const rows       = await getRows('Saldo', HDR_SALDO);
    const precoAtual = PRECOS[produto] || 0;
    const valorNovo  = precoAtual * quantidade;
    const existente  = rows.find(r => mesmoNome(r.Cliente, clienteEnviado) && norm(r.Produto) === norm(produto));
    const cliente    = existente ? existente.Cliente : capitalizarNome(clienteEnviado);

    if (LIMITE_CREDITO_PADRAO > 0) {
      const rowsC      = rows.filter(r => mesmoNome(r.Cliente, clienteEnviado));
      const totalAtual = rowsC.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
      if (totalAtual + valorNovo > LIMITE_CREDITO_PADRAO)
        return { cliente, limiteBloqueado: true, totalAtual, valorNovo };
    }

    if (existente) {
      const qtdAcumulada   = parseInt(existente.Quantidade || '0') + quantidade;
      const totalAcumulado = parseFloat(existente.Total || '0') + valorNovo;
      await updateRow('Saldo', HDR_SALDO, existente._rowIndex, {
        ...existente, Quantidade: qtdAcumulada, Total: totalAcumulado.toFixed(2), UltimaCompra: agora(),
      });
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) });
      return { cliente, totalAcumulado, qtdAcumulada };
    } else {
      await appendRow('Saldo', HDR_SALDO, { Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: valorNovo.toFixed(2), UltimaCompra: agora() });
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) });
      return { cliente, totalAcumulado: valorNovo, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

async function cancelarLancamento(jid, nomeDigitado) {
  try {
    const hist = ULTIMOS_LANCAMENTOS[jid] || [];
    let idx = -1;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (mesmoNome(hist[i].cliente, nomeDigitado)) { idx = i; break; }
    }
    if (idx < 0) return `❌ Nenhum lançamento recente encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const lanc = hist[idx];
    hist.splice(idx, 1);

    const meta      = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId   = saldoProp.sheetId;
    const histSheet = meta.sheets.find(s => s.properties.title === 'Historico');
    const histId    = histSheet ? histSheet.properties.sheetId : null;
    const rowsSaldo = await getRows('Saldo', HDR_SALDO);
    const rowsHist  = histId ? await getRows('Historico', HDR_HIST) : [];

    if (lanc.tipo === 'compra') {
      const row = rowsSaldo.find(r => r.Cliente === lanc.cliente && norm(r.Produto) === norm(lanc.produto));
      if (row) {
        const novaQtd   = parseInt(row.Quantidade || '0') - lanc.quantidade;
        const novoTotal = parseFloat(row.Total || '0') - lanc.valor;
        if (novaQtd <= 0 || novoTotal <= 0) await deleteRows(saldoId, [row._rowIndex]);
        else await updateRow('Saldo', HDR_SALDO, row._rowIndex, { ...row, Quantidade: novaQtd, Total: novoTotal.toFixed(2) });
      }
      for (let i = rowsHist.length - 1; i >= 0; i--) {
        if (rowsHist[i].Cliente === lanc.cliente && norm(rowsHist[i].Produto) === norm(lanc.produto) && rowsHist[i].Tipo === 'Compra'