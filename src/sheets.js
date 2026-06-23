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

// ── Token OAuth cacheado ───────────────────────────────────────────────────────────────────
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

// ── Helpers REST ─────────────────────────────────────────────────────────────────────────────
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

// ── Estrutura da planilha ───────────────────────────────────────────────────────────────────────
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
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) });
      return { cliente, totalAcumulado, qtdAcumulada };
    } else {
      await appendRow('Saldo', HDR_SALDO, { Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: valorNovo.toFixed(2), UltimaCompra: agora() });
      await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) });
      return { cliente, totalAcumulado: valorNovo, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

// ── Venda à vista: grava Compra + Pagamento no Histórico, sem tocar no Saldo ────────────────
async function registrarVendaVista(clienteEnviado, produto, quantidade) {
  try {
    const meta     = await getSheetsMeta();
    await ensureSaldoSheet(meta);
    const histProp = await getOrCreateHistSheet(meta);
    await ensureHeaders('Historico', HDR_HIST, histProp.sheetId);

    const cliente   = capitalizarNome(clienteEnviado);
    const preco     = PRECOS[produto] || 0;
    const valor     = preco * quantidade;
    const dataAgora = agora();

    // Grava a compra no histórico
    await appendRow('Historico', HDR_HIST, {
      Data: dataAgora, Cliente: cliente, Tipo: 'Compra',
      Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2),
    });
    // Grava o pagamento imediato no histórico
    await appendRow('Historico', HDR_HIST, {
      Data: dataAgora, Cliente: cliente, Tipo: 'Pagamento',
      Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2),
    });

    return { cliente, valor };
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

async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid) {
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
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente, produto, quantidade: qtdPaga, valor: pago });
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: produto, Quantidade: qtdPaga, Valor: pago.toFixed(2) });
    if (novaQtd === 0) {
      await deleteRows(saldoId, [row._rowIndex]);
      return { ok: true, msg: `✅ *${cliente}* quitou toda a dívida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.` };
    }
    const novoTotal = totalAtual - pago;
    await updateRow('Saldo', HDR_SALDO, row._rowIndex, { ...row, Quantidade: novaQtd, Total: novoTotal.toFixed(2) });
    return { ok: true, msg: `✅ *${cliente}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { console.error('Erro pag produto:', err.message); return { ok: false, msg: '❌ Erro ao registrar pagamento.' }; }
}

async function processarPagamentoValor(clienteEnviado, valorPago, jid) {
  try {
    const meta    = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId = saldoProp.sheetId;
    await getOrCreateHistSheet(meta);
    const rows    = await getRows('Saldo', HDR_SALDO);
    const nomesConhecidos = [...new Set(rows.map(r => r.Cliente.trim()).filter(Boolean))];
    const nomeCanon   = resolverNome(clienteEnviado, nomesConhecidos);
    const rowsCliente = nomeCanon
      ? rows.filter(r => r.Cliente === nomeCanon)
      : rows.filter(r => mesmoNome(r.Cliente, clienteEnviado));
    if (!rowsCliente.length) return { ok: false, msg: `❌ Nenhuma dívida encontrada para *${capitalizarNome(clienteEnviado)}*.` };
    const cliente     = rowsCliente[0].Cliente;
    const totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente, produto: 'geral', quantidade: '-', valor: valorPago });
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: valorPago.toFixed(2) });
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

async function gerarRelatorioGeral() {
  try {
    const rows = await getRows('Saldo', HDR_SALDO);
    if (!rows.length) return 'Nenhuma dívida em aberto no momento.';
    const clientes = {};
    for (const row of rows) {
      const nome  = row.Cliente.trim();
      const prod  = norm(row.Produto);
      const qtd   = parseInt(row.Quantidade || '0');
      const total = parseFloat(row.Total || '0');
      if (!nome || !prod) continue;
      if (!clientes[nome]) clientes[nome] = { itens: [], totalDevido: 0 };
      clientes[nome].itens.push({ produto: prod, quantidade: qtd, total });
      clientes[nome].totalDevido += total;
    }
    if (!Object.keys(clientes).length) return 'Nenhuma dívida em aberto no momento.';
    const ordenados = Object.entries(clientes).sort((a, b) => b[1].totalDevido - a[1].totalDevido);
    let resposta = '*Relatório de Dívidas*\n───────────────\n'; let totalGeral = 0;
    for (const [nome, dados] of ordenados) {
      resposta += `\n*${nome}*\n`;
      for (const item of dados.itens) resposta += `  ${nomeProdutoExib(item.produto)}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;
      resposta += `  *Total: R$ ${dados.totalDevido.toFixed(2)}*\n`;
      totalGeral += dados.totalDevido;
    }
    resposta += `\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch (err) { console.error('Erro relatorio:', err.message); return '❌ Erro ao gerar relatório.'; }
}

async function carregarHistoricoAgrupado(filtroMes) {
  const rowsSaldo = await getRows('Saldo', HDR_SALDO);
  const saldos = {};
  for (const row of rowsSaldo) {
    const nome  = row.Cliente.trim();
    const total = parseFloat(row.Total || '0');
    if (!nome) continue;
    if (!saldos[nome]) saldos[nome] = 0;
    saldos[nome] += total;
  }
  let rowsHist = [];
  try { rowsHist = await getRows('Historico', HDR_HIST); } catch (e) { return { historico: {}, saldos }; }
  const nomesCanonicos = [...Object.keys(saldos)];
  const historico = {};
  for (const row of rowsHist) {
    const nomeRaw = row.Cliente.trim();
    if (!nomeRaw) continue;
    if (filtroMes) {
      const data   = row.Data.trim();
      if (!data) continue;
      const partes = data.split(' ')[0].split('/');
      if (partes.length >= 2) {
        const mesNum   = parseInt(partes[1]);
        const nomesArr = ['','janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        const filtroNorm   = norm(filtroMes);
        const filtroNumero = parseInt(filtroNorm);
        const bateu = isNaN(filtroNumero) ? norm(nomesArr[mesNum]) === filtroNorm : mesNum === filtroNumero;
        if (!bateu) continue;
      }
    }
    let nomeCanon = resolverNome(nomeRaw, nomesCanonicos);
    if (!nomeCanon) { nomesCanonicos.push(nomeRaw); nomeCanon = nomeRaw; }
    if (!historico[nomeCanon]) historico[nomeCanon] = [];
    historico[nomeCanon].push({
      data:    row.Data.trim(),
      tipo:    row.Tipo.trim(),
      produto: norm(row.Produto),
      qtd:     row.Quantidade.trim(),
      valor:   parseFloat(row.Valor || '0'),
    });
  }
  return { historico, saldos };
}

async function gerarRelatorioDetalhado() {
  try {
    const { historico, saldos } = await carregarHistoricoAgrupado();
    if (!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
    const devedores = Object.keys(historico).filter(n => (saldos[n] || 0) > 0);
    if (!devedores.length) return '✅ Nenhuma dívida em aberto! Todos quitados.';
    devedores.sort((a, b) => (saldos[b] || 0) - (saldos[a] || 0));
    let resposta = '*Relatório Detalhado*\n───────────────\n'; let totalGeral = 0;
    for (const nome of devedores) {
      const movs       = historico[nome];
      const saldoAtual = saldos[nome] || 0;
      resposta += `\n*${nome}*\n`;
      for (const m of movs) {
        if (m.tipo === 'Compra')         resposta += `  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if (m.tipo === 'Pagamento') resposta += `  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta += `  *Saldo devedor: R$ ${saldoAtual.toFixed(2)}*\n`;
      totalGeral += saldoAtual;
    }
    resposta += `\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch (err) { console.error('Erro relatorio detalhado:', err.message); return '❌ Erro ao gerar relatório detalhado.'; }
}

async function gerarRelatorioQuitados() {
  try {
    const { historico, saldos } = await carregarHistoricoAgrupado();
    if (!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
    const quitados = Object.keys(historico).filter(n => !(saldos[n] > 0));
    if (!quitados.length) return 'Nenhum cliente quitado ainda.';
    quitados.sort();
    let resposta = '*Compras Quitadas*\n───────────────\n';
    for (const nome of quitados) {
      const movs      = historico[nome];
      const totalPago = movs.filter(m => m.tipo === 'Pagamento').reduce((s, m) => s + m.valor, 0);
      resposta += `\n*${nome}*\n`;
      for (const m of movs) {
        if (m.tipo === 'Compra')         resposta += `  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if (m.tipo === 'Pagamento') resposta += `  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta += `  ✅ Quitado | Total pago: R$ ${totalPago.toFixed(2)}\n`;
    }
    resposta += `\n───────────────\n✅ *${quitados.length} cliente(s) com conta quitada*`;
    return resposta;
  } catch (err) { console.error('Erro relatorio quitados:', err.message); return '❌ Erro ao gerar relatório de quitados.'; }
}

async function gerarSaldoIndividual(nomeDigitado) {
  try {
    const rows = await getRows('Saldo', HDR_SALDO);
    const nomesConhecidos = [...new Set(rows.map(r => r.Cliente.trim()).filter(Boolean))];
    const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
    if (!nomeCanon) {
      const { historico, saldos } = await carregarHistoricoAgrupado();
      const nomeHist = resolverNome(nomeDigitado, Object.keys(historico));
      if (nomeHist && !(saldos[nomeHist] > 0)) return `✅ *${nomeHist}* não tem dívidas em aberto. Conta quitada!`;
      return `❌ Nenhuma movimentação encontrada para *${capitalizarNome(nomeDigitado)}*.`;
    }
    const rowsCliente = rows.filter(r => r.Cliente === nomeCanon);
    if (!rowsCliente.length) return `✅ *${nomeCanon}* não tem dívidas em aberto.`;
    let totalDevido = 0;
    let resposta = `*${nomeCanon}*\n───────────────\n`;
    for (const row of rowsCliente) {
      const produto = norm(row.Produto);
      const qtd     = parseInt(row.Quantidade || '0');
      const total   = parseFloat(row.Total || '0');
      resposta += `${nomeProdutoExib(produto)}: ${qtd} unid. = R$ ${total.toFixed(2)}\n`;
      totalDevido += total;
    }
    resposta += `───────────────\n*Total devido: R$ ${totalDevido.toFixed(2)}*`;
    return resposta;
  } catch (err) { console.error('Erro saldo:', err.message); return '❌ Erro ao consultar saldo.'; }
}

async function gerarHistoricoCliente(nomeDigitado) {
  try {
    const { historico, saldos } = await carregarHistoricoAgrupado();
    const nomesConhecidos = Object.keys(historico);
    const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
    if (!nomeCanon || !historico[nomeCanon]) return `❌ Nenhum histórico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const movs       = historico[nomeCanon];
    const saldoAtual = saldos[nomeCanon] || 0;
    let resposta = `*Histórico de ${nomeCanon}*\n───────────────\n`;
    let totalComprado = 0, totalPago = 0;
    for (const m of movs) {
      if (m.tipo === 'Compra')         { resposta += `Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalComprado += m.valor; }
      else if (m.tipo === 'Pagamento') { resposta += `Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalPago += m.valor; }
    }
    resposta += `───────────────\nTotal comprado: R$ ${totalComprado.toFixed(2)}\nTotal pago: R$ ${totalPago.toFixed(2)}\n`;
    resposta += saldoAtual > 0 ? `*Saldo devedor: R$ ${saldoAtual.toFixed(2)}*` : '✅ *Conta quitada!*';
    return resposta;
  } catch (err) { console.error('Erro historico:', err.message); return '❌ Erro ao buscar histórico.'; }
}

async function gerarRelatorioMes(mes) {
  try {
    const { historico } = await carregarHistoricoAgrupado(mes);
    const nomesMes  = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesNum    = parseInt(norm(mes));
    const nomeMesExib = isNaN(mesNum) ? capitalizarNome(mes) : (nomesMes[mesNum] || capitalizarNome(mes));
    const todosNomes  = Object.keys(historico);
    if (!todosNomes.length) return `Nenhuma movimentação registrada em ${nomeMesExib}.`;
    let totalVendas = 0, totalRecebido = 0, qtdTrufa = 0, qtdBolo = 0; let detalhe = '';
    for (const nome of todosNomes.sort()) {
      const movs     = historico[nome];
      const comprado = movs.filter(m => m.tipo === 'Compra').reduce((s, m) => s + m.valor, 0);
      const pago     = movs.filter(m => m.tipo === 'Pagamento').reduce((s, m) => s + m.valor, 0);
      qtdTrufa += movs.filter(m => m.tipo === 'Compra' && m.produto === 'trufa').reduce((s, m) => s + parseInt(m.qtd || '0'), 0);
      qtdBolo  += movs.filter(m => m.tipo === 'Compra' && m.produto === 'bolo').reduce((s, m) => s + parseInt(m.qtd || '0'), 0);
      totalVendas += comprado; totalRecebido += pago;
      detalhe += `\n*${nome}*: comprou R$ ${comprado.toFixed(2)} | pagou R$ ${pago.toFixed(2)}\n`;
    }
    return `*Relatório de ${nomeMesExib}*\n───────────────\n${detalhe}\n───────────────\nTrufas: ${qtdTrufa} unid. | Bolos: ${qtdBolo} unid.\nTotal em vendas: R$ ${totalVendas.toFixed(2)}\nTotal recebido: R$ ${totalRecebido.toFixed(2)}\nA receber: R$ ${(totalVendas - totalRecebido).toFixed(2)}`;
  } catch (err) { console.error('Erro relatorio mes:', err.message); return '❌ Erro ao gerar relatório do mês.'; }
}

async function gerarResumoDiario() {
  try {
    const hoje = agoraData();
    const { historico } = await carregarHistoricoAgrupado();
    let totalVendas = 0, totalPago = 0, qtdTrufa = 0, qtdBolo = 0;
    const clientesSet = new Set();
    for (const [nome, movs] of Object.entries(historico)) {
      for (const m of movs) {
        if (soData(m.data) !== hoje) continue;
        if (m.tipo === 'Compra') {
          totalVendas += m.valor;
          if (m.produto === 'trufa') qtdTrufa += parseInt(m.qtd || '0');
          if (m.produto === 'bolo')  qtdBolo  += parseInt(m.qtd || '0');
          clientesSet.add(nome);
        } else if (m.tipo === 'Pagamento') totalPago += m.valor;
      }
    }
    const rows        = await getRows('Saldo', HDR_SALDO);
    const totalAberto = rows.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
    return `*Resumo do Dia - ${hoje}*\n───────────────\nTrufas: ${qtdTrufa} | Bolos: ${qtdBolo}\nClientes atendidos: ${clientesSet.size}\nVendas do dia: R$ ${totalVendas.toFixed(2)}\nRecebido hoje: R$ ${totalPago.toFixed(2)}\n───────────────\nTotal em aberto: R$ ${totalAberto.toFixed(2)}`;
  } catch (err) { console.error('Erro resumo:', err.message); return '❌ Erro ao gerar resumo.'; }
}

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
    await appendRow('Historico', HDR_HIST, { Data: agora(), Cliente: nomeCanon, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: totalZerado.toFixed(2) });
    return `✅ Dívida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
  } catch (err) { console.error('Erro zerar:', err.message); return '❌ Erro ao zerar cliente.'; }
}

module.exports = {
  getDoc: async () => ({}), getSheetSaldo: async () => ({}), getSheetHistorico: async () => ({}),
  registrarOuAcumular, registrarVendaVista, cancelarLancamento,
  processarPagamentoProduto, processarPagamentoValor,
  gerarRelatorioGeral, gerarRelatorioDetalhado, gerarRelatorioQuitados,
  gerarSaldoIndividual, gerarHistoricoCliente, gerarRelatorioMes,
  gerarResumoDiario, verificarLembretes, zerarCliente,
  carregarHistoricoAgrupado,
};
