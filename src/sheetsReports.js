// ─── Módulo de relatórios extraído de sheets.js ───────────────────────────────────
const {
  norm,
  capitalizarNome,
  resolverNome,
  agoraData,
  soData,
  nomeProdutoExib,
} = require('./utils');

function ordenarClientes(entries, ordem) {
  switch (norm(ordem || 'valor')) {
    case 'nome':  return [...entries].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
    case 'data':  return [...entries].sort((a, b) => {
      const parseData = str => { const p = (str || '').split('/'); return p.length >= 3 ? new Date(`${p[2]}-${p[1]}-${p[0]}`) : new Date(0); };
      return parseData(b[1].ultimaCompra) - parseData(a[1].ultimaCompra);
    });
    default:      return [...entries].sort((a, b) => b[1].totalDevido - a[1].totalDevido);
  }
}

// Converte "DD/MM/YYYY" ou "DD/MM/YYYY HH:MM" para Date
function parseDateBR(str) {
  const s = (str || '').trim().split(' ')[0].split('/');
  if (s.length < 3) return null;
  return new Date(`${s[2]}-${s[1].padStart(2,'0')}-${s[0].padStart(2,'0')}`);
}

function createSheetsReports({ getRows, HDR_SALDO, HDR_HIST }) {

  async function gerarRelatorioGeral(ordem) {
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
        if (!clientes[nome]) clientes[nome] = { itens: [], totalDevido: 0, ultimaCompra: row.UltimaCompra || '' };
        clientes[nome].itens.push({ produto: prod, quantidade: qtd, total });
        clientes[nome].totalDevido += total;
        if (row.UltimaCompra > clientes[nome].ultimaCompra) clientes[nome].ultimaCompra = row.UltimaCompra;
      }
      if (!Object.keys(clientes).length) return 'Nenhuma dívida em aberto no momento.';
      const ordenados = ordenarClientes(Object.entries(clientes), ordem);
      const legendaOrdem = { nome: '🔤 A–Z', data: '📅 Data', valor: '💰 Valor' };
      let resposta = `*Relatório de Dívidas* (${legendaOrdem[norm(ordem || 'valor')] || '💰 Valor'})\n───────────────\n`;
      let totalGeral = 0;
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

  async function carregarHistoricoAgrupado(opts) {
    const filtroMes = typeof opts === 'string' ? opts : (opts && opts.filtroMes) || null;
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
        metodo:  (row.Metodo || '').trim(),
      });
    }
    return { historico, saldos };
  }

  function calcularSaldoPeloHistorico(movs) {
    const totalCompras    = movs.filter(m => m.tipo === 'Compra').reduce((s, m) => s + m.valor, 0);
    const totalPagamentos = movs.filter(m => m.tipo === 'Pagamento').reduce((s, m) => s + m.valor, 0);
    return Math.max(0, totalCompras - totalPagamentos);
  }

  async function gerarRelatorioDetalhado() {
    try {
      const { historico } = await carregarHistoricoAgrupado();
      if (!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
      const devedores = Object.keys(historico).filter(n => calcularSaldoPeloHistorico(historico[n]) > 0.001);
      if (!devedores.length) return '✅ Nenhuma dívida em aberto! Todos quitados.';
      devedores.sort((a, b) => calcularSaldoPeloHistorico(historico[b]) - calcularSaldoPeloHistorico(historico[a]));
      let resposta = '*Relatório Detalhado*\n───────────────\n'; let totalGeral = 0;
      for (const nome of devedores) {
        const movs       = historico[nome];
        const saldoAtual = calcularSaldoPeloHistorico(movs);
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
      const { historico } = await carregarHistoricoAgrupado();
      if (!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
      const quitados = Object.keys(historico).filter(n => calcularSaldoPeloHistorico(historico[n]) <= 0.001);
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
        const { historico } = await carregarHistoricoAgrupado();
        const nomeHist = resolverNome(nomeDigitado, Object.keys(historico));
        if (nomeHist) {
          const saldo = calcularSaldoPeloHistorico(historico[nomeHist]);
          if (saldo <= 0.001) return `✅ *${nomeHist}* não tem dívidas em aberto. Conta quitada!`;
        }
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
      const { historico } = await carregarHistoricoAgrupado();
      const nomesConhecidos = Object.keys(historico);
      const nomeCanon = resolverNome(nomeDigitado, nomesConhecidos);
      if (!nomeCanon || !historico[nomeCanon]) return `❌ Nenhum histórico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
      const movs = historico[nomeCanon];
      let resposta = `*Histórico de ${nomeCanon}*\n───────────────\n`;
      let totalComprado = 0, totalPago = 0;
      for (const m of movs) {
        if (m.tipo === 'Compra')         { resposta += `Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalComprado += m.valor; }
        else if (m.tipo === 'Pagamento') { resposta += `Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalPago += m.valor; }
      }
      const saldoAtual = Math.max(0, totalComprado - totalPago);
      resposta += `───────────────\nTotal comprado: R$ ${totalComprado.toFixed(2)}\nTotal pago: R$ ${totalPago.toFixed(2)}\n`;
      resposta += saldoAtual > 0.001 ? `*Saldo devedor: R$ ${saldoAtual.toFixed(2)}*` : '✅ *Conta quitada!*';
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
      let totalVendas = 0;
      let totalPix = 0, totalDinheiro = 0, totalOutros = 0;
      let qtdTrufa = 0, qtdBolo = 0;
      const clientesSet = new Set();
      for (const [nome, movs] of Object.entries(historico)) {
        for (const m of movs) {
          if (soData(m.data) !== hoje) continue;
          if (m.tipo === 'Compra') {
            totalVendas += m.valor;
            if (m.produto === 'trufa') qtdTrufa += parseInt(m.qtd || '0');
            if (m.produto === 'bolo')  qtdBolo  += parseInt(m.qtd || '0');
            clientesSet.add(nome);
          } else if (m.tipo === 'Pagamento') {
            const met = norm(m.metodo || '');
            if (met === 'pix' || met === 'transferiu' || met === 'transferencia') totalPix += m.valor;
            else if (met === 'dinheiro' || met === 'especie' || met === 'avista' || met === 'vista') totalDinheiro += m.valor;
            else totalOutros += m.valor;
          }
        }
      }
      const totalRecebido = totalPix + totalDinheiro + totalOutros;
      const rows        = await getRows('Saldo', HDR_SALDO);
      const totalAberto = rows.reduce((s, r) => s + parseFloat(r.Total || '0'), 0);
      const linhasRecebido = [];
      if (totalPix > 0)      linhasRecebido.push(`  💳 Pix: R$ ${totalPix.toFixed(2)}`);
      if (totalDinheiro > 0) linhasRecebido.push(`  💵 Dinheiro: R$ ${totalDinheiro.toFixed(2)}`);
      if (totalOutros > 0)   linhasRecebido.push(`  💰 Outros: R$ ${totalOutros.toFixed(2)}`);
      if (!linhasRecebido.length) linhasRecebido.push(`  R$ 0,00`);
      linhasRecebido.push(`  *Total: R$ ${totalRecebido.toFixed(2)}*`);
      return [
        `*Resumo do Dia - ${hoje}*`,
        `───────────────`,
        `Trufas: ${qtdTrufa} | Bolos: ${qtdBolo}`,
        `Clientes atendidos: ${clientesSet.size}`,
        `Vendas do dia: R$ ${totalVendas.toFixed(2)}`,
        `Recebido hoje:`,
        ...linhasRecebido,
        `───────────────`,
        `Total em aberto: R$ ${totalAberto.toFixed(2)}`,
      ].join('\n');
    } catch (err) { console.error('Erro resumo:', err.message); return '❌ Erro ao gerar resumo.'; }
  }

  // ── Relatório por período: hoje | semana | mes ─────────────────────────────────
  async function gerarRelatorioPeriodo(tipo) {
    try {
      const agora  = new Date();
      const hoje   = agoraData(); // DD/MM/YYYY

      // Define intervalo
      let dataInicio, labelPeriodo;
      if (tipo === 'hoje') {
        dataInicio   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
        labelPeriodo = `Hoje (${hoje})`;
      } else if (tipo === 'semana') {
        const diasPassados = agora.getDay() === 0 ? 6 : agora.getDay() - 1; // seg=0
        dataInicio   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - diasPassados);
        const ddIni  = String(dataInicio.getDate()).padStart(2,'0');
        const mmIni  = String(dataInicio.getMonth()+1).padStart(2,'0');
        labelPeriodo = `Esta semana (${ddIni}/${mmIni} – ${hoje})`;
      } else { // mes
        dataInicio   = new Date(agora.getFullYear(), agora.getMonth(), 1);
        const nomesMes = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        labelPeriodo = `${nomesMes[agora.getMonth()]} ${agora.getFullYear()}`;
      }

      const { historico } = await carregarHistoricoAgrupado();
      const clientes = {};

      for (const [nome, movs] of Object.entries(historico)) {
        const movsPerido = movs.filter(m => {
          const d = parseDateBR(m.data);
          return d && d >= dataInicio;
        });
        if (!movsPerido.length) continue;

        let comprado = 0, pago = 0, pix = 0, dinheiro = 0, outros = 0;
        const itens = {};
        for (const m of movsPerido) {
          if (m.tipo === 'Compra') {
            comprado += m.valor;
            itens[m.produto] = (itens[m.produto] || 0) + parseInt(m.qtd || '1');
          } else if (m.tipo === 'Pagamento') {
            pago += m.valor;
            const met = norm(m.metodo || '');
            if (met === 'pix' || met === 'transferiu' || met === 'transferencia') pix += m.valor;
            else if (met === 'dinheiro' || met === 'especie' || met === 'avista' || met === 'vista') dinheiro += m.valor;
            else outros += m.valor;
          }
        }
        clientes[nome] = { comprado, pago, pix, dinheiro, outros, itens, saldo: Math.max(0, comprado - pago) };
      }

      if (!Object.keys(clientes).length) return `Nenhuma movimentação registrada em *${labelPeriodo}*.`;

      // Ordena: devedores primeiro (saldo desc), depois quitados
      const ordenados = Object.entries(clientes).sort((a, b) => b[1].saldo - a[1].saldo);

      let totalVendas = 0, totalPago = 0;
      let resposta = `*📊 Relatório — ${labelPeriodo}*\n───────────────\n`;

      for (const [nome, d] of ordenados) {
        resposta += `\n*${nome}*\n`;
        // Itens comprados
        const produtosStr = Object.entries(d.itens)
          .map(([p, q]) => `${q}x ${nomeProdutoExib(p)}`).join(', ');
        if (produtosStr) resposta += `  Comprou: ${produtosStr} = R$ ${d.comprado.toFixed(2)}\n`;
        // Pagamentos por método
        if (d.pix > 0)      resposta += `  💳 Pix: R$ ${d.pix.toFixed(2)}\n`;
        if (d.dinheiro > 0) resposta += `  💵 Dinheiro: R$ ${d.dinheiro.toFixed(2)}\n`;
        if (d.outros > 0)   resposta += `  💰 Outros: R$ ${d.outros.toFixed(2)}\n`;
        // Status
        if (d.saldo > 0.001) {
          resposta += `  🔴 *Deve: R$ ${d.saldo.toFixed(2)}*\n`;
        } else if (d.comprado > 0) {
          resposta += `  ✅ Quitado\n`;
        } else {
          resposta += `  💰 Só pagamentos\n`;
        }
        totalVendas += d.comprado;
        totalPago   += d.pago;
      }

      const totalAberto = totalVendas - totalPago;
      resposta += `\n───────────────`;
      resposta += `\nTotal vendido: R$ ${totalVendas.toFixed(2)}`;
      resposta += `\nTotal recebido: R$ ${totalPago.toFixed(2)}`;
      resposta += `\n*A receber: R$ ${totalAberto.toFixed(2)}*`;
      return resposta;
    } catch (err) { console.error('Erro relatorio periodo:', err.message); return '❌ Erro ao gerar relatório por período.'; }
  }

  return {
    gerarRelatorioGeral,
    carregarHistoricoAgrupado,
    calcularSaldoPeloHistorico,
    gerarRelatorioDetalhado,
    gerarRelatorioQuitados,
    gerarSaldoIndividual,
    gerarHistoricoCliente,
    gerarRelatorioMes,
    gerarResumoDiario,
    gerarRelatorioPeriodo,
  };
}

module.exports = { createSheetsReports };
