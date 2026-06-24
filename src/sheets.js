// ─── GOOGLE SHEETS — lógica de negócio ────────────────────────────────────────────
// Responsabilidade: operações de negócio (registrar, pagar, cancelar, zerar).
// Infra (auth, HTTP, CRUD de linhas) → sheets/auth.js e sheets/core.js
// Relatórios → sheetsReports.js
// ─────────────────────────────────────────────────────────────────────────────
const { LIMITE_CREDITO_PADRAO } = require('./config');
const {
  comRetry, norm, capitalizarNome, mesmoNome, resolverNome,
  agora, agoraData, soData,
  PRECOS, nomeProdutoExib,
  ULTIMOS_LANCAMENTOS, pushLancamento,
} = require('./utils');
const {
  HDR_SALDO, HDR_HIST,
  getSheetsMeta, ensureSaldoSheet, ensureHeaders, getOrCreateHistSheet,
  getRows, appendRow, updateRow, deleteRows,
} = require('./sheets/core');

// ── Registrar compra fiado ────────────────────────────────────────────────────
async function registrarOuAcumular(clienteEnviado, produto, quantidade) {
  try {
    const meta      = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    await ensureHeaders('Saldo', HDR_SALDO, saldoProp.sheetId);
    const histProp  = await getOrCreateHistSheet(meta);
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

// ── Venda à vista ───────────────────────────────────────────────────────────
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

    await appendRow('Historico', HDR_HIST, { Data: dataAgora, Cliente: cliente, Tipo: 'Compra',    Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2), Metodo: '' });
    await appendRow('Historico', HDR_HIST, { Data: dataAgora, Cliente: cliente, Tipo: 'Pagamento', Produto: produto, Quantidade: quantidade, Valor: valor.toFixed(2), Metodo: metodoStr });

    return { cliente, valor, metodo: metodoStr };
  } catch (err) { console.error('Erro venda à vista:', err.message); return null; }
}

// ── Cancelar último lançamento ───────────────────────────────────────────────
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

// ── Pagamento por produto ──────────────────────────────────────────────────
async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid, metodo) {
  try {
    const meta      = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId   = saldoProp.sheetId;
    await getOrCreateHistSheet(meta);
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

// ── Pagamento por valor ───────────────────────────────────────────────────
async function processarPagamentoValor(clienteEnviado, valorPago, jid, metodo) {
  try {
    const meta      = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId   = saldoProp.sheetId;
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

// ── Verificar lembretes ───────────────────────────────────────────────────
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

// ── Zerar cliente ────────────────────────────────────────────────────────────
async function zerarCliente(nomeDigitado) {
  try {
    const meta      = await getSheetsMeta();
    const saldoProp = await ensureSaldoSheet(meta);
    const saldoId   = saldoProp.sheetId;
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

// ── Relatórios (delegados para sheetsReports.js) ─────────────────────────────
const { createSheetsReports } = require('./sheetsReports');
const _reports = createSheetsReports({ getRows, HDR_SALDO, HDR_HIST });

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
