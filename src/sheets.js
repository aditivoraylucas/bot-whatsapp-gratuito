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

// ── Token OAuth cacheado ──────────────────────────────────────────────────────────────────────────────────────
let _tokenCache = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  const agora = Date.now();
  if (_tokenCache && agora < _tokenExpiry) return _tokenCache;

  const iat = Math.floor(agora / 1000);
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

  console.log('[sheets] getAccessToken — email:', GOOGLE_SERVICE_ACCOUNT_EMAIL);
  console.log('[sheets] getAccessToken — key inicia com:', key?.slice(0, 40));

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
  console.log('[sheets] OAuth OK — token obtido, expires_in:', data.expires_in);
  _tokenCache  = data.access_token;
  _tokenExpiry = agora + (data.expires_in - 300) * 1000;
  return _tokenCache;
}

// ── Helpers REST ─────────────────────────────────────────────────────────────────────────────────────────────
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`;

console.log('[sheets] BASE URL:', BASE);

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
  const url = `${BASE}:batchUpdate`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`batchUpdate => ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Estrutura da planilha ──────────────────────────────────────────────────────────────────────────────────────────────
const HDR_SALDO    = ['Cliente','Produto','Quantidade','Total','UltimaCompra'];
// Adicionada coluna Metodo (Pix / Dinheiro / '') para rastrear forma de pagamento
const HDR_HIST     = ['Data','Cliente','Tipo','Produto','Quantidade','Valor','Metodo'];

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
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2), Metodo: '' });
      return { cliente, totalAcumulado, qtdAcumulada };
    } else {
      await appendRow('Saldo', HDR_SALDO, { Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: valorNovo.toFixed(2), UltimaCompra: agora() });
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2), Metodo: '' });
      return { cliente, totalAcumulado: valorNovo, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

// ── Venda à vista: grava Compra + Pagamento no Histórico, sem tocar no Saldo ────────────
async function registrarVendaVista(clienteEnviado, produto, quantidade, metodo) {
  try {
    const meta     = await getSheetsMeta();
    await ensureSaldoSheet(meta);
    const histProp = await getOrCreateHistSheet(meta);
    await ensureHeaders('Historico', HDR_HIST, histProp.sheetId);

    const cliente   = capitalizarNome(clienteEnviado);
    const preco     = PRECOS[produto] || 0;
    const valor     = preco * quantidade;
    const dataAgora = agora();
    const metodoStr = metodo || '';

    await appendRow('Historico', HDR_HIST, {
      Data: dataAgora, Cliente: cliente, Tipo: 'Compra',
      Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2), Metodo: '',
    });
    await appendRow('Historico', HDR_HIST, {
      Data: dataAgora, Cliente: cliente, Tipo: 'Pagamento',
      Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2), Metodo: metodoStr,
    });

    return { cliente, valor, metodo: metodoStr };
  } catch (err) { console.error('Erro venda à vista:', err.message); return null; }
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
        if (rowsHist[i].Cliente === lanc.cliente && norm(rowsHist[i].Produto) === norm(lanc.produto) && rowsHist[i].Tipo === 'Compra') {
          await deleteRows(histId, [rowsHist[i]._rowIndex]); break;
        }
      }
      return `↗️ Lançamento cancelado: *${lanc.cliente}* - ${lanc.quantidade}x ${nomeProdutoExib(lanc.produto)} (R$ ${lanc.valor.toFixed(2)})`;
    }
    if (lanc.tipo === 'pagamento') {
      const rowsC = rowsSaldo.filter(r => mesmoNome(r.Cliente, lanc.cliente));
      if (rowsC.length) {
        let restante = lanc.valor;
        for (const r of rowsC) {
          if (restante <= 0) break;
          const novoTotal = parseFloat(r.Total || '0') + restante;
          const updated   = { ...r, Total: novoTotal.toFixed(2) };
          if (lanc.produto && lanc.produto !== 'geral' && norm(r.Produto) === norm(lanc.produto) && typeof lanc.quantidade === 'number')
            updated.Quantidade = parseInt(r.Quantidade || '0') + lanc.quantidade;
          await updateRow('Saldo', HDR_SALDO, r._rowIndex, updated);
          restante = 0;
        }
      } else {
        const produto = lanc.produto && lanc.produto !== 'geral' ? lanc.produto : 'trufa';
        const qtd     = typeof lanc.quantidade === 'number' ? lanc.quantidade : 0;
        await appendRow('Saldo', HDR_SALDO, { Cliente: lanc.cliente, Produto: produto, Quantidade: qtd, Total: lanc.valor.toFixed(2), UltimaCompra: agora() });
      }
      for (let i = rowsHist.length - 1; i >= 0; i--) {
        if (rowsHist[i].Cliente === lanc.cliente && rowsHist[i].Tipo === 'Pagamento') {
          await deleteRows(histId, [rowsHist[i]._rowIndex]); break;
        }
      }
      return `↗️ Pagamento cancelado: *${lanc.cliente}* - R$ ${lanc.valor.toFixed(2)} devolvido ao saldo.`;
    }
    return '❌ Não foi possível cancelar.';
  } catch (err) { console.error('Erro cancelar:', err.message); return '❌ Erro ao cancelar lançamento.'; }
}

async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid, metodo) {
  try {
    const meta    = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId = saldoProp.sheetId;
    const histProp = await getOrCreateHistSheet(meta);
    const rows    = await getRows('Saldo', HDR_SALDO);
    const row     = rows.find(r => mesmoNome(r.Cliente, clienteEnviado) && norm(r.Produto) === norm(produto));
    if (!row) return { ok: false, msg: `❌ Nenhuma dívida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.` };
    const cliente    = row.Cliente;
    const qtdAtual   = parseInt(row.Quantidade || '0');
    const qtdPaga    = Math.min(quantidade, qtdAtual);
    const novaQtd    = qtdAtual - qtdPaga;
    const totalAtual = parseFloat(row.Total || '0');
    const pago       = qtdAtual > 0 ? (totalAtual / qtdAtual) * qtdPaga : 0;
    const metodoStr  = metodo || '';
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente, produto, quantidade: qtdPaga, valor: pago });
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: produto, Quantidade: qtdPaga, Valor: pago.toFixed(2), Metodo: metodoStr });
    if (novaQtd === 0) {
      await deleteRows(saldoId, [row._rowIndex]);
      return { ok: true, msg: `✅ *${cliente}* quitou toda a dívida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.` };
    }
    const novoTotal = totalAtual - pago;
    await updateRow('Saldo', HDR_SALDO, row._rowIndex, { ...row, Quantidade: novaQtd, Total: novoTotal.toFixed(2) });
    return { ok: true, msg: `✅ *${cliente}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { console.error('Erro pag produto:', err.message); return { ok: false, msg: '❌ Erro ao registrar pagamento.' }; }
}

// ── FIX: usa nomeCanon consistentemente em todo o fluxo de pagamento por valor ───────────
async function processarPagamentoValor(clienteEnviado, valorPago, jid, metodo) {
  try {
    const meta    = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId = saldoProp.sheetId;
    await getOrCreateHistSheet(meta);
    const rows    = await getRows('Saldo', HDR_SALDO);
    const nomesConhecidos = [...new Set(rows.map(r => r.Cliente.trim()).filter(Boolean))];
    const nomeCanon   = resolverNome(clienteEnviado, nomesConhecidos);
    const nomeEfetivo = nomeCanon || capitalizarNome(clienteEnviado);
    const rowsCliente = nomeCanon
      ? rows.filter(r => r.Cliente === nomeCanon)
      : rows.filter(r => mesmoNome(r.Cliente, clienteEnviado));
    if (!rowsCliente.length) return { ok: false, msg: `❌ Nenhuma dívida encontrada para *${capitalizarNome(clienteEnviado)}*.` };
    const cliente     = rowsCliente[0].Cliente;
    const totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
    const metodoStr   = metodo || '';
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente, produto: 'geral', quantidade: '-', valor: valorPago });
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: valorPago.toFixed(2), Metodo: metodoStr });
    if (valorPago >= totalDevido) {
      await deleteRows(saldoId, rowsCliente.map(r => r._rowIndex));
      return { ok: true, msg: `✅ *${cliente}* quitou toda a dívida! Pagou R$ ${valorPago.toFixed(2)}.` };
    }
    let restante = valorPago;
    for (const r of rowsCliente) {
      if (restante <= 0) break;
      const totalRow = parseFloat(r.Total || '0');
      if (restante >= totalRow) { restante -= totalRow; await deleteRows(saldoId, [r._rowIndex]); }
      else {
        const novoTotal = totalRow - restante;
        const qtdAtual  = parseInt(r.Quantidade || '0');
        await updateRow('Saldo', HDR_SALDO, r._rowIndex, {
          ...r,
          Total: novoTotal.toFixed(2),
          Quantidade: Math.max(totalRow > 0 ? Math.round(qtdAtual * (novoTotal / totalRow)) : 0, 0),
        });
        restante = 0;
      }
    }
    return { ok: true, msg: `✅ *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido - valorPago).toFixed(2)}` };
  } catch (err) { console.error('Erro pag valor:', err.message); return { ok: false, msg: '❌ Erro ao registrar pagamento.' }; }
}

// ── Módulo de relatórios (extraído para sheetsReports.js) ─────────────────────────────────
const { createSheetsReports } = require('./sheetsReports');
const _reports = createSheetsReports({ getRows, HDR_SALDO, HDR_HIST });

async function verificarLembretes(sock, jid) {
  const { DIAS_LEMBRETE } = require('./config');
  try {
    const rows   = await getRows('Saldo', HDR_SALDO);
    const agora2 = new Date();
    const clientes = {};
    for (const row of rows) {
      const nome   = row.Cliente.trim();
      const total  = parseFloat(row.Total || '0');
      const ultima = row.UltimaCompra.trim();
      if (!nome || total <= 0 || !ultima) continue;
      const partes = ultima.split(' ')[0].split('/');
      if (partes.length < 3) continue;
      const dataUltima   = new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
      const diasPassados = Math.floor((agora2 - dataUltima) / (1000 * 60 * 60 * 24));
      if (diasPassados >= DIAS_LEMBRETE) {
        if (!clientes[nome]) clientes[nome] = { total: 0, dias: diasPassados };
        clientes[nome].total += total;
        clientes[nome].dias   = Math.max(clientes[nome].dias, diasPassados);
      }
    }
    for (const [nome, dados] of Object.entries(clientes))
      await sock.sendMessage(jid, { text: `⚠️ *Lembrete de cobrança*\n*${nome}* está com R$ ${dados.total.toFixed(2)} em aberto há *${dados.dias} dias*.` });
  } catch (e) { console.error('Erro lembrete:', e.message); }
}

async function zerarCliente(nomeDigitado) {
  try {
    const meta    = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId = saldoProp.sheetId;
    await getOrCreateHistSheet(meta);
    const rows    = await getRows('Saldo', HDR_SALDO);
    const nomesConhecidos = [...new Set(rows.map(r => r.Cliente.trim()).filter(Boolean))];
    const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
    if (!nomeCanon) return `❌ Cliente *${capitalizarNome(nomeDigitado)}* não encontrado.`;
    const rowsCliente = rows.filter(r => r.Cliente === nomeCanon);
    if (!rowsCliente.length) return `✅ *${nomeCanon}* já está sem dívidas.`;
    const totalZerado = rowsCliente.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
    await deleteRows(saldoId, rowsCliente.map(r => r._rowIndex));
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: nomeCanon, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: totalZerado.toFixed(2), Metodo: '' });
    return `✅ Dívida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
  } catch (err) { console.error('Erro zerar:', err.message); return '❌ Erro ao zerar cliente.'; }
}

module.exports = {
  getDoc: async () => ({}), getSheetSaldo: async () => ({}), getSheetHistorico: async () => ({}),
  registrarOuAcumular, registrarVendaVista, cancelarLancamento,
  processarPagamentoProduto, processarPagamentoValor,
  gerarRelatorioGeral:      _reports.gerarRelatorioGeral,
  gerarRelatorioDetalhado:  _reports.gerarRelatorioDetalhado,
  gerarRelatorioQuitados:   _reports.gerarRelatorioQuitados,
  gerarSaldoIndividual:     _reports.gerarSaldoIndividual,
  gerarHistoricoCliente:    _reports.gerarHistoricoCliente,
  gerarRelatorioMes:        _reports.gerarRelatorioMes,
  gerarResumoDiario:        _reports.gerarResumoDiario,
  verificarLembretes, zerarCliente,
  carregarHistoricoAgrupado: _reports.carregarHistoricoAgrupado,
};
