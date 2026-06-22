// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT }               = require('google-auth-library');

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

// ── Autenticação com cache ────────────────────────────────────────────────────
// Reutiliza o mesmo objeto JWT entre chamadas para evitar múltiplos handshakes OAuth
let _authCache = null;
function getAuth() {
  if (!_authCache) {
    _authCache = new JWT({
      email:  GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:    GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return _authCache;
}

// Aumentado para 6 tentativas — cobre casos de "Premature close" ao acordar do sleep
async function getDoc() {
  return comRetry(async () => {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, getAuth());
    await doc.loadInfo();
    return doc;
  }, 6, 'getDoc');
}

async function getSheetSaldo(doc) {
  const d = doc || await getDoc();
  return d.sheetsByIndex[0];
}

async function getSheetHistorico(doc) {
  const d = doc || await getDoc();
  if (d.sheetCount < 2)
    return await d.addSheet({ title: 'Historico', headerValues: ['Data','Cliente','Tipo','Produto','Quantidade','Valor'] });
  const sheet = d.sheetsByIndex[1];
  try { await sheet.loadHeaderRow(); } catch (e) { await sheet.setHeaderRow(['Data','Cliente','Tipo','Produto','Quantidade','Valor']); }
  return sheet;
}

// ── Operações de planilha ─────────────────────────────────────────────────────
async function registrarOuAcumular(clienteEnviado, produto, quantidade) {
  try {
    const doc        = await getDoc();
    const sheet      = await getSheetSaldo(doc);
    const rows       = await sheet.getRows();
    const precoAtual = PRECOS[produto] || 0;
    const valorNovo  = precoAtual * quantidade;
    const existente  = rows.find(r => mesmoNome(r.get('Cliente'), clienteEnviado) && norm(r.get('Produto')) === norm(produto));
    const cliente    = existente ? existente.get('Cliente') : capitalizarNome(clienteEnviado);
    if (LIMITE_CREDITO_PADRAO > 0) {
      const rowsC      = rows.filter(r => mesmoNome(r.get('Cliente'), clienteEnviado));
      const totalAtual = rowsC.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
      if (totalAtual + valorNovo > LIMITE_CREDITO_PADRAO)
        return { cliente, limiteBloqueado: true, totalAtual, valorNovo };
    }
    const sheetH = await getSheetHistorico(doc);
    if (existente) {
      const qtdAcumulada   = parseInt(existente.get('Quantidade') || '0') + quantidade;
      const totalAcumulado = parseFloat(existente.get('Total') || '0') + valorNovo;
      existente.set('Quantidade', qtdAcumulada);
      existente.set('Total', totalAcumulado.toFixed(2));
      existente.set('UltimaCompra', agora());
      await existente.save();
      await comRetry(() => sheetH.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) }), 6, 'addRow Historico Compra');
      return { cliente, totalAcumulado, qtdAcumulada };
    } else {
      await comRetry(() => sheet.addRow({ Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: valorNovo.toFixed(2), UltimaCompra: agora() }), 6, 'addRow Saldo');
      await comRetry(() => sheetH.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: valorNovo.toFixed(2) }), 6, 'addRow Historico Compra');
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
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const sheetH = await getSheetHistorico(doc);
    const rowsH  = await sheetH.getRows();
    if (lanc.tipo === 'compra') {
      const row = rows.find(r => r.get('Cliente') === lanc.cliente && norm(r.get('Produto')) === norm(lanc.produto));
      if (row) {
        const novaQtd   = parseInt(row.get('Quantidade') || '0') - lanc.quantidade;
        const novoTotal = parseFloat(row.get('Total') || '0') - lanc.valor;
        if (novaQtd <= 0 || novoTotal <= 0) { await row.delete(); }
        else { row.set('Quantidade', novaQtd); row.set('Total', novoTotal.toFixed(2)); await row.save(); }
      }
      for (let i = rowsH.length - 1; i >= 0; i--) {
        if (rowsH[i].get('Cliente') === lanc.cliente && norm(rowsH[i].get('Produto')) === norm(lanc.produto) && rowsH[i].get('Tipo') === 'Compra') {
          await rowsH[i].delete(); break;
        }
      }
      return `↗️ Lançamento cancelado: *${lanc.cliente}* - ${lanc.quantidade}x ${nomeProdutoExib(lanc.produto)} (R$ ${lanc.valor.toFixed(2)})`;
    }
    if (lanc.tipo === 'pagamento') {
      const rowsC = rows.filter(r => mesmoNome(r.get('Cliente'), lanc.cliente));
      if (rowsC.length) {
        let restante = lanc.valor;
        for (const r of rowsC) {
          if (restante <= 0) break;
          const novoTotal = parseFloat(r.get('Total') || '0') + restante;
          r.set('Total', novoTotal.toFixed(2));
          if (lanc.produto && lanc.produto !== 'geral' && norm(r.get('Produto')) === norm(lanc.produto) && typeof lanc.quantidade === 'number')
            r.set('Quantidade', parseInt(r.get('Quantidade') || '0') + lanc.quantidade);
          await r.save(); restante = 0;
        }
      } else {
        const produto = lanc.produto && lanc.produto !== 'geral' ? lanc.produto : 'trufa';
        const qtd     = typeof lanc.quantidade === 'number' ? lanc.quantidade : 0;
        await sheet.addRow({ Cliente: lanc.cliente, Produto: produto, Quantidade: qtd, Total: lanc.valor.toFixed(2), UltimaCompra: agora() });
      }
      for (let i = rowsH.length - 1; i >= 0; i--) {
        if (rowsH[i].get('Cliente') === lanc.cliente && rowsH[i].get('Tipo') === 'Pagamento') {
          await rowsH[i].delete(); break;
        }
      }
      return `↗️ Pagamento cancelado: *${lanc.cliente}* - R$ ${lanc.valor.toFixed(2)} devolvido ao saldo.`;
    }
    return '❌ Não foi possível cancelar.';
  } catch (err) { console.error('Erro cancelar:', err.message); return '❌ Erro ao cancelar lançamento.'; }
}

async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid) {
  try {
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const row    = rows.find(r => mesmoNome(r.get('Cliente'), clienteEnviado) && norm(r.get('Produto')) === norm(produto));
    const cliente = row ? row.get('Cliente') : capitalizarNome(clienteEnviado);
    if (!row) return { ok: false, msg: `❌ Nenhuma dívida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.` };
    const qtdAtual   = parseInt(row.get('Quantidade') || '0');
    const qtdPaga    = Math.min(quantidade, qtdAtual);
    const novaQtd    = qtdAtual - qtdPaga;
    const totalAtual = parseFloat(row.get('Total') || '0');
    const pago       = qtdAtual > 0 ? (totalAtual / qtdAtual) * qtdPaga : 0;
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente: row.get('Cliente'), produto, quantidade: qtdPaga, valor: pago });
    const sheetH = await getSheetHistorico(doc);
    await comRetry(() => sheetH.addRow({ Data: agora(), Cliente: row.get('Cliente'), Tipo: 'Pagamento', Produto: produto, Quantidade: qtdPaga, Valor: pago.toFixed(2) }), 6, 'addRow Pagamento Produto');
    if (novaQtd === 0) { await row.delete(); return { ok: true, msg: `✅ *${cliente}* quitou toda a dívida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.` }; }
    const novoTotal = totalAtual - pago;
    row.set('Quantidade', novaQtd); row.set('Total', novoTotal.toFixed(2)); await row.save();
    return { ok: true, msg: `✅ *${cliente}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { console.error('Erro pag produto:', err.message); return { ok: false, msg: '❌ Erro ao registrar pagamento.' }; }
}

async function processarPagamentoValor(clienteEnviado, valorPago, jid) {
  try {
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const nomesConhecidos = [...new Set(rows.map(r => (r.get('Cliente') || '').trim()).filter(Boolean))];
    const nomeCanon   = resolverNome(clienteEnviado, nomesConhecidos);
    const rowsCliente = nomeCanon
      ? rows.filter(r => r.get('Cliente') === nomeCanon)
      : rows.filter(r => mesmoNome(r.get('Cliente'), clienteEnviado));
    const cliente     = rowsCliente.length ? rowsCliente[0].get('Cliente') : capitalizarNome(clienteEnviado);
    if (!rowsCliente.length) return { ok: false, msg: `❌ Nenhuma dívida encontrada para *${capitalizarNome(clienteEnviado)}*.` };
    const totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    if (jid) pushLancamento(jid, { tipo: 'pagamento', cliente, produto: 'geral', quantidade: '-', valor: valorPago });
    const sheetH = await getSheetHistorico(doc);
    await comRetry(() => sheetH.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: valorPago.toFixed(2) }), 6, 'addRow Pagamento Valor');
    if (valorPago >= totalDevido) {
      for (const r of rowsCliente) await r.delete();
      return { ok: true, msg: `✅ *${cliente}* quitou toda a dívida! Pagou R$ ${valorPago.toFixed(2)}.` };
    }
    let restante = valorPago;
    for (const r of rowsCliente) {
      if (restante <= 0) break;
      const totalRow = parseFloat(r.get('Total') || '0');
      if (restante >= totalRow) { restante -= totalRow; await r.delete(); }
      else {
        const novoTotal = totalRow - restante;
        r.set('Total', novoTotal.toFixed(2));
        const qtdAtual = parseInt(r.get('Quantidade') || '0');
        r.set('Quantidade', Math.max(totalRow > 0 ? Math.round(qtdAtual * (novoTotal / totalRow)) : 0, 0));
        await r.save(); restante = 0;
      }
    }
    return { ok: true, msg: `✅ *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido - valorPago).toFixed(2)}` };
  } catch (err) { console.error('Erro pag valor:', err.message); return { ok: false, msg: '❌ Erro ao registrar pagamento.' }; }
}

// CORRIGIDO: estava chamando getSheetSaldo() sem doc, causando segundo getDoc() desnecessário
async function gerarRelatorioGeral() {
  try {
    const doc   = await getDoc();
    const sheet = await getSheetSaldo(doc);
    const rows  = await sheet.getRows();
    if (!rows.length) return 'Nenhuma dívida em aberto no momento.';
    const clientes = {};
    for (const row of rows) {
      const nome       = (row.get('Cliente') || '').trim();
      const produto    = norm(row.get('Produto') || '');
      const quantidade = parseInt(row.get('Quantidade') || '0');
      const total      = parseFloat(row.get('Total') || '0');
      if (!nome || !produto) continue;
      if (!clientes[nome]) clientes[nome] = { itens: [], totalDevido: 0 };
      clientes[nome].itens.push({ produto, quantidade, total });
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
  const doc       = await getDoc();
  const rowsSaldo = await doc.sheetsByIndex[0].getRows();
  const saldos    = {};
  for (const row of rowsSaldo) {
    const nome  = (row.get('Cliente') || '').trim();
    const total = parseFloat(row.get('Total') || '0');
    if (!nome) continue;
    if (!saldos[nome]) saldos[nome] = 0;
    saldos[nome] += total;
  }
  if (doc.sheetCount < 2) return { historico: {}, saldos };
  const sheetHist = doc.sheetsByIndex[1];
  try { await sheetHist.loadHeaderRow(); } catch (e) { return { historico: {}, saldos }; }
  const rowsHist       = await sheetHist.getRows();
  const nomesCanonicos = [...Object.keys(saldos)];
  const historico      = {};
  for (const row of rowsHist) {
    const nomeRaw = (row.get('Cliente') || '').trim();
    if (!nomeRaw) continue;
    if (filtroMes) {
      const data   = (row.get('Data') || '').trim();
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
      data:    (row.get('Data')       || '').trim(),
      tipo:    (row.get('Tipo')       || '').trim(),
      produto: norm(row.get('Produto') || ''),
      qtd:     (row.get('Quantidade') || '').trim(),
      valor:   parseFloat(row.get('Valor') || '0'),
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
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const nomesConhecidos = [...new Set(rows.map(r => (r.get('Cliente') || '').trim()).filter(Boolean))];
    const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
    if (!nomeCanon) {
      const { historico, saldos } = await carregarHistoricoAgrupado();
      const nomeHist = resolverNome(nomeDigitado, Object.keys(historico));
      if (nomeHist && !(saldos[nomeHist] > 0)) return `✅ *${nomeHist}* não tem dívidas em aberto. Conta quitada!`;
      return `❌ Nenhuma movimentação encontrada para *${capitalizarNome(nomeDigitado)}*.`;
    }
    const rowsCliente = rows.filter(r => r.get('Cliente') === nomeCanon);
    if (!rowsCliente.length) return `✅ *${nomeCanon}* não tem dívidas em aberto.`;
    let totalDevido = 0;
    let resposta = `*${nomeCanon}*\n───────────────\n`;
    for (const row of rowsCliente) {
      const produto = norm(row.get('Produto') || '');
      const qtd     = parseInt(row.get('Quantidade') || '0');
      const total   = parseFloat(row.get('Total') || '0');
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
    // carregarHistoricoAgrupado já chama getDoc internamente; reusamos o doc dela via getDoc()
    const doc        = await getDoc();
    const sheetSaldo = await getSheetSaldo(doc);
    const rows       = await sheetSaldo.getRows();
    const totalAberto = rows.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    return `*Resumo do Dia - ${hoje}*\n───────────────\nTrufas: ${qtdTrufa} | Bolos: ${qtdBolo}\nClientes atendidos: ${clientesSet.size}\nVendas do dia: R$ ${totalVendas.toFixed(2)}\nRecebido hoje: R$ ${totalPago.toFixed(2)}\n───────────────\nTotal em aberto: R$ ${totalAberto.toFixed(2)}`;
  } catch (err) { console.error('Erro resumo:', err.message); return '❌ Erro ao gerar resumo.'; }
}

async function verificarLembretes(sock, jid) {
  const { DIAS_LEMBRETE } = require('./config');
  try {
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const agora2 = new Date();
    const clientes = {};
    for (const row of rows) {
      const nome   = (row.get('Cliente') || '').trim();
      const total  = parseFloat(row.get('Total') || '0');
      const ultima = (row.get('UltimaCompra') || '').trim();
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
    const doc    = await getDoc();
    const sheet  = await getSheetSaldo(doc);
    const rows   = await sheet.getRows();
    const nomesConhecidos = [...new Set(rows.map(r => (r.get('Cliente') || '').trim()).filter(Boolean))];
    const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
    if (!nomeCanon) return `❌ Cliente *${capitalizarNome(nomeDigitado)}* não encontrado.`;
    const rowsCliente = rows.filter(r => r.get('Cliente') === nomeCanon);
    if (!rowsCliente.length) return `✅ *${nomeCanon}* já está sem dívidas.`;
    const totalZerado = rowsCliente.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    for (const r of rowsCliente) await r.delete();
    const sheetH = await getSheetHistorico(doc);
    await comRetry(() => sheetH.addRow({ Data: agora(), Cliente: nomeCanon, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: totalZerado.toFixed(2) }), 6, 'addRow Zerar');
    return `✅ Dívida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
  } catch (err) { console.error('Erro zerar:', err.message); return '❌ Erro ao zerar cliente.'; }
}

module.exports = {
  getDoc, getSheetSaldo, getSheetHistorico,
  registrarOuAcumular, cancelarLancamento,
  processarPagamentoProduto, processarPagamentoValor,
  gerarRelatorioGeral, gerarRelatorioDetalhado, gerarRelatorioQuitados,
  gerarSaldoIndividual, gerarHistoricoCliente, gerarRelatorioMes,
  gerarResumoDiario, verificarLembretes, zerarCliente,
  carregarHistoricoAgrupado,
};
