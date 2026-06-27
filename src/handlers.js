// ─── HANDLERS DE MENSAGENS ────────────────────────────────────────────
const { LIMITE_CREDITO_PADRAO } = require('./config');
const {
  norm, capitalizarNome, isMes,
  toProduto, toNumero, extrairValor,
  emojiProduto, nomeProdutoExib,
  PRECOS, pushLancamento,
  resolverAlias, definirAlias, ALIASES,
  todosOsSinonimos,
} = require('./utils');
const {
  registrarOuAcumular, cancelarLancamento,
  registrarVendaVista,
  processarPagamentoProduto, processarPagamentoValor,
  gerarRelatorioGeral, gerarRelatorioDetalhado, gerarRelatorioQuitados,
  gerarSaldoIndividual, gerarHistoricoCliente, gerarRelatorioMes,
  gerarResumoDiario, zerarCliente,
  renomearCliente, gerarRelatorioPeriodo,
} = require('./sheets');
const {
  transcreverAudio, limparTranscricao, corrigirTranscricao, corrigirFoneticosProdutos, dedupNomeInicio,
} = require('./handlers/audio');
const {
  mudarPreco, cadastrarNovoProduto, listarProdutos, mensagemAjuda,
} = require('./handlers/products');
const {
  ZERAR_PENDENTE, ZERAR_TTL_MS, ORDENS_RELATORIO,
  CONFIRMACAO_PENDENTE, limparConfirmacao,
  criarConfirmacaoProduto, criarConfirmacaoQuantidade,
} = require('./handlers/session');

// ── Monta menu numerado de produtos cadastrados ───────────────────────────────
function menuProdutos() {
  const produtos = Object.keys(PRECOS);
  return produtos.map((p, i) => `${i + 1}️⃣ ${nomeProdutoExib(p)}`).join('\n');
}

function produtoPorIndice(resposta) {
  const produtos = Object.keys(PRECOS);
  const idx = parseInt(norm(resposta)) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < produtos.length) return produtos[idx];
  // também aceita o nome direto
  return toProduto(norm(resposta)) || null;
}

// ── Parser de compra ─────────────────────────────────────────────────────
const PALAVRAS_RESERVADAS = new Set([
  'pagou','pix','transferiu','depositou','mandou','enviou',
  'cancelar','saldo','historico','relatorio','resumo',
  'cobrar','lembrete','lembretes','preco','produtos','zerar','novo','renomear',
]);

function parsearLinha(linha) {
  const limpa      = linha.replace(/,/g,' ').replace(/\b(mais|e|de)\b/gi,' ').replace(/\+/g,' ').replace(/[.!?;:]+( |$)/g,'$1').replace(/\s+/g,' ').trim();
  const palavrasOrig = limpa.split(' ').filter(Boolean);
  const palavrasNorm = palavrasOrig.map(norm);
  const n = palavrasNorm.length;
  let inicioItens = -1;
  for (let i = 0; i < n; i++) {
    if (toProduto(palavrasNorm[i])) { inicioItens = i; break; }
    const qtd = toNumero(palavrasNorm[i]);
    if (qtd !== null && i + 1 < n) {
      if (i + 2 < n && toProduto(palavrasNorm[i+1] + ' ' + palavrasNorm[i+2])) { inicioItens = i; break; }
      if (toProduto(palavrasNorm[i+1])) { inicioItens = i; break; }
    }
  }
  if (inicioItens < 1) return null;
  const nomeRaw = palavrasOrig.slice(0, inicioItens).join(' ').trim();
  if (!nomeRaw || PALAVRAS_RESERVADAS.has(norm(nomeRaw))) return null;
  const itens = []; let i = inicioItens;
  while (i < n) {
    const qtd = toNumero(palavrasNorm[i]);
    if (qtd !== null && i + 1 < n) {
      if (i + 2 < n) { const p2 = toProduto(palavrasNorm[i+1] + ' ' + palavrasNorm[i+2]); if (p2) { itens.push({ quantidade: qtd, produto: p2 }); i += 3; continue; } }
      const p1 = toProduto(palavrasNorm[i+1]); if (p1) { itens.push({ quantidade: qtd, produto: p1 }); i += 2; continue; }
    }
    if (i + 1 < n) { const p2 = toProduto(palavrasNorm[i] + ' ' + palavrasNorm[i+1]); if (p2) { itens.push({ quantidade: 1, produto: p2 }); i += 2; continue; } }
    const p1 = toProduto(palavrasNorm[i]); if (p1) { itens.push({ quantidade: 1, produto: p1 }); i++; continue; }
    i++;
  }
  if (!itens.length) return null;
  return { nome: capitalizarNome(nomeRaw), itens };
}

// ── Detecta compra com produto mas sem quantidade ─────────────────────────────
// Retorna { nome, produto } se encontrar "[nome] [produto]" sem número, ou null.
function parsearCompraSemQuantidade(texto) {
  const limpa      = norm(texto).replace(/,/g,' ').replace(/\s+/g,' ').trim();
  const palavras   = limpa.split(' ').filter(Boolean);
  const n          = palavras.length;
  if (n < 2) return null;

  // Procura produto em qualquer posição que não seja a primeira
  for (let i = 1; i < n; i++) {
    const p1 = toProduto(palavras[i]);
    if (p1) {
      const nomeRaw = palavras.slice(0, i).join(' ');
      if (PALAVRAS_RESERVADAS.has(norm(nomeRaw))) return null;
      // Não deve ter número antes do produto
      const temNumero = palavras.slice(0, i).some(p => toNumero(p) !== null);
      if (temNumero) return null;
      return { nome: capitalizarNome(nomeRaw), produto: p1 };
    }
    // produto de duas palavras
    if (i + 1 < n) {
      const p2 = toProduto(palavras[i] + ' ' + palavras[i+1]);
      if (p2) {
        const nomeRaw = palavras.slice(0, i).join(' ');
        if (PALAVRAS_RESERVADAS.has(norm(nomeRaw))) return null;
        const temNumero = palavras.slice(0, i).some(p => toNumero(p) !== null);
        if (temNumero) return null;
        return { nome: capitalizarNome(nomeRaw), produto: p2 };
      }
    }
  }
  return null;
}

const KW_VISTA = new Set([
  'pago','paga','vista','avista','dinheiro','especie',
  'pix','debito','credito','cartao',
]);

const KW_METODO = {
  'pix':      'Pix',
  'transferiu':'Pix',
  'debito':   'Débito',
  'credito':  'Crédito',
  'cartao':   'Crédito',
  'dinheiro': 'Dinheiro',
  'especie':  'Dinheiro',
  'avista':   'Dinheiro',
  'vista':    'Dinheiro',
  'pago':     '',
  'paga':     '',
  'pagou':    '',
};

function extrairMetodo(texto) {
  const tNorm = norm(texto);
  for (const [kw, metodo] of Object.entries(KW_METODO)) {
    if (new RegExp(`\\b${kw}\\b`).test(tNorm)) return metodo;
  }
  return '';
}

function parsearVendaVista(linha) {
  const tNorm = norm(linha);
  const temProduto = tNorm.split(/\s+/).some(p => !!toProduto(p));
  const temKwVista = [...KW_VISTA].some(kw => new RegExp(`\\b${kw}\\b`).test(tNorm));
  const temPagouComProduto = /\b(pagou|paga)\b/.test(tNorm) && temProduto;
  if (!temKwVista && !temPagouComProduto) return null;
  if (!temKwVista && temPagouComProduto) {
    const possPagDivida = /\b(pagou|paga)\b.*\b\d+([,.]\d+)?\b/.test(tNorm) && !temProduto;
    if (possPagDivida) return null;
  }
  const KW_VERBOS_COMPRA = /\b(pegou|comprou|levou|tomou|quer|quero|queria)\b/g;
  const metodo = extrairMetodo(linha);
  let linhaLimpa = tNorm;
  for (const kw of KW_VISTA) {
    linhaLimpa = linhaLimpa.replace(new RegExp(`\\b${kw}\\b`, 'g'), ' ');
  }
  linhaLimpa = linhaLimpa
    .replace(/\b(pagou|paga)\b/g, ' ')
    .replace(KW_VERBOS_COMPRA, ' ')
    .replace(/\b(no|na|em|pelo|pela)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const resultado = parsearLinha(linhaLimpa);
  if (!resultado) return null;
  const mapa = new Map();
  for (const item of resultado.itens) {
    mapa.set(item.produto, (mapa.get(item.produto) || 0) + item.quantidade);
  }
  const itensAgrupados = [...mapa.entries()].map(([produto, quantidade]) => ({ produto, quantidade }));
  return { ...resultado, itens: itensAgrupados, metodo };
}

function parsearPagamento(linha) {
  const tNorm = norm(linha);
  if (!/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/.test(tNorm)) return null;
  const kwMatch = tNorm.match(/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/);
  if (!kwMatch) return null;
  const keyword      = kwMatch[1];
  const palavrasNorm = tNorm.split(/\s+/).filter(Boolean);
  const palavrasOrig = linha.trim().split(/\s+/).filter(Boolean);
  let kwIdx = -1;
  for (let i = 0; i < palavrasNorm.length; i++) { if (palavrasNorm[i] === keyword) { kwIdx = i; break; } }
  if (kwIdx <= 0) return null;
  const nomeRaw = palavrasOrig.slice(0, kwIdx).join(' ').trim();
  if (!nomeRaw) return null;
  const metodo = extrairMetodo(linha);
  const resto = palavrasNorm.slice(kwIdx + 1).join(' ').trim();
  if (resto) {
    const partesResto = resto.split(/\s+/).filter(Boolean);
    let qtd = null, prod = null;
    for (let i = 0; i < partesResto.length; i++) {
      const q = toNumero(partesResto[i]);
      if (q !== null && !qtd) { qtd = q; continue; }
      if (qtd !== null) {
        if (i + 1 < partesResto.length) { const p2 = toProduto(partesResto[i] + ' ' + partesResto[i+1]); if (p2) { prod = p2; break; } }
        const p1 = toProduto(partesResto[i]); if (p1) { prod = p1; break; }
      } else {
        if (i + 1 < partesResto.length) { const p2 = toProduto(partesResto[i] + ' ' + partesResto[i+1]); if (p2) { prod = p2; break; } }
        const p1 = toProduto(partesResto[i]); if (p1) { prod = p1; qtd = qtd || 1; break; }
      }
    }
    if (prod && qtd) return { tipo: 'produto', nome: nomeRaw, quantidade: qtd, produto: prod, metodo };
  }
  const valor = extrairValor(resto || linha);
  if (valor && valor > 0) return { tipo: 'valor', nome: nomeRaw, valor, metodo };
  return null;
}

// ── Processador principal de texto ───────────────────────────────────────
async function processarTexto(texto, jid, sock) {
  if (!texto) return null;
  const t        = norm(texto);
  const palavras = t.split(/\s+/).filter(Boolean);
  const p0 = palavras[0]; const p1 = palavras[1]; const resto = palavras.slice(1).join(' ');

  // ══════════════════════════════════════════════════════════════════════════
  // ── Fluxo de confirmação pendente (produto ou quantidade) ─────────────────
  // ══════════════════════════════════════════════════════════════════════════
  const confirmacao = CONFIRMACAO_PENDENTE[jid];
  if (confirmacao) {
    if (Date.now() > confirmacao.expira) {
      limparConfirmacao(jid);
      // deixa cair para o processamento normal
    } else if (confirmacao.etapa === 'produto') {
      // Usuário está escolhendo o produto
      const prodEscolhido = produtoPorIndice(texto.trim());
      if (!prodEscolhido) {
        // Resposta inválida — repete o menu
        return `❓ Não entendi. Escolha o produto de *${confirmacao.nome}*:\n${menuProdutos()}\n\nResponda com o número ou o nome do produto.`;
      }
      // Produto escolhido — avança para etapa de quantidade
      criarConfirmacaoQuantidade(jid, confirmacao.nome, prodEscolhido);
      return `Quantos *${nomeProdutoExib(prodEscolhido).toLowerCase()}s* *${confirmacao.nome}* levou?\n\n1️⃣  1\n2️⃣  2\n3️⃣  3\n4️⃣  4\n5️⃣  5\n🔢  Outro — digite o número`;
    } else if (confirmacao.etapa === 'quantidade') {
      // Usuário está informando a quantidade
      const qtd = toNumero(texto.trim()) || parseInt(norm(texto.trim()));
      if (!qtd || qtd <= 0 || isNaN(qtd)) {
        return `❓ Não entendi a quantidade. Quantos *${nomeProdutoExib(confirmacao.produto).toLowerCase()}s* *${confirmacao.nome}* levou?\n\nDigite apenas o número (ex: *2*)`;
      }
      limparConfirmacao(jid);
      // Registra a compra
      const res = await registrarOuAcumular(confirmacao.nome, confirmacao.produto, qtd);
      if (!res) return `❌ Erro ao registrar ${confirmacao.nome}.`;
      if (res.limiteBloqueado) {
        return `⛔ *${res.cliente}* atingiu o limite de crédito!\nAtual: R$ ${res.totalAtual.toFixed(2)} + R$ ${res.valorNovo.toFixed(2)} = ultrapassaria R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}`;
      }
      pushLancamento(jid, { tipo: 'compra', cliente: res.cliente, produto: confirmacao.produto, quantidade: qtd, valor: PRECOS[confirmacao.produto] * qtd });
      return `${emojiProduto(confirmacao.produto)} *${res.cliente}*: ${res.qtdAcumulada} ${nomeProdutoExib(confirmacao.produto)}(s) = R$ ${res.totalAcumulado.toFixed(2)}`;
    }
  }

  // ── Confirmação de zerar pendente ─────────────────────────────────────────
  if (ZERAR_PENDENTE[jid] && (p0 === 'sim' || p0 === 's')) {
    const { cliente, expira } = ZERAR_PENDENTE[jid];
    delete ZERAR_PENDENTE[jid];
    if (Date.now() > expira) return `⏱️ Tempo expirado. Digite novamente _zerar ${cliente}_ para tentar de novo.`;
    return await zerarCliente(cliente);
  }
  if (ZERAR_PENDENTE[jid] && p0 !== 'sim' && p0 !== 's') {
    delete ZERAR_PENDENTE[jid];
  }

  // ── renomear ─────────────────────────────────────────────────────────────
  if (p0 === 'renomear') {
    const textoResto = texto.trim().slice('renomear'.length).trim();
    const sep = textoResto.includes('>') ? '>' : textoResto.includes(' para ') ? ' para ' : null;
    if (!sep) return '❌ Uso: _renomear [nome antigo] > [nome novo]_\nExemplo: _renomear Lucas com K > Lucas_';
    const partes = textoResto.split(sep);
    const nomeAntigo = partes[0].trim();
    const nomeNovo   = partes.slice(1).join(sep).trim();
    if (!nomeAntigo || !nomeNovo) return '❌ Informe o nome antigo e o novo.\nExemplo: _renomear Lucas com K > Lucas_';
    return await renomearCliente(nomeAntigo, nomeNovo);
  }

  // ── relatorio ─────────────────────────────────────────────────────────────
  if (p0 === 'relatorio' || p0 === 'relatorios') {
    if (p1 === 'hoje')                         return await gerarRelatorioPeriodo('hoje');
    if (p1 === 'semana')                       return await gerarRelatorioPeriodo('semana');
    if (p1 === 'mes' || p1 === 'mês')         return await gerarRelatorioPeriodo('mes');
    if (p1 === 'detalhado')                    return await gerarRelatorioDetalhado();
    if (p1 === 'quitados' || p1 === 'quitado') return await gerarRelatorioQuitados();
    if (p1 && isMes(p1))                       return await gerarRelatorioMes(p1);
    if (p1 && ORDENS_RELATORIO.has(p1))        return await gerarRelatorioGeral(p1);
    return await gerarRelatorioGeral();
  }
  if (p0 === 'resumo')               return await gerarResumoDiario();
  if (p0 === 'saldo'     && p1)      return await gerarSaldoIndividual(resto);
  if (p0 === 'historico' && p1)      return await gerarHistoricoCliente(resto);
  if (p0 === 'cancelar'  && p1)      return await cancelarLancamento(jid, resto);
  if (p0 === 'ajuda' || p0 === 'help') return mensagemAjuda();
  if (p0 === 'produtos')             return listarProdutos();

  // ── Zerar com confirmação ─────────────────────────────────────────────────
  if (p0 === 'zerar' && p1) {
    const nomeCliente = palavras.slice(1).join(' ');
    ZERAR_PENDENTE[jid] = { cliente: nomeCliente, expira: Date.now() + ZERAR_TTL_MS };
    setTimeout(() => { if (ZERAR_PENDENTE[jid]?.cliente === nomeCliente) delete ZERAR_PENDENTE[jid]; }, ZERAR_TTL_MS + 1000);
    return `⚠️ *Tem certeza que quer zerar o histórico de "${capitalizarNome(nomeCliente)}"?*\nEsta ação não pode ser desfeita.\n\nResponda *sim* para confirmar ou qualquer outra mensagem para cancelar.`;
  }

  // ── Aliases ───────────────────────────────────────────────────────────────
  if (p0 === 'aliases') {
    const entradas = Object.entries(ALIASES);
    if (!entradas.length) return '📋 Nenhum apelido cadastrado ainda.\n_Use: alias [apelido] [nome completo]_';
    const linhas = entradas.map(([ap, nome]) => `  _${ap}_ → *${nome}*`).join('\n');
    return `📋 *Apelidos cadastrados:*\n${linhas}`;
  }
  if (p0 === 'alias') {
    if (!p1) return '❌ Uso: _alias [apelido] [nome completo]_\nExemplo: _alias ray Raylucas_';
    const nomeCompleto = palavras.slice(2).join(' ').trim();
    if (!nomeCompleto) {
      if (!ALIASES[norm(p1)]) return `⚠️ Apelido _${p1}_ não existe.`;
      definirAlias(p1, null);
      return `🗑️ Apelido _${p1}_ removido.`;
    }
    definirAlias(p1, capitalizarNome(nomeCompleto));
    return `✅ Apelido salvo: _${norm(p1)}_ → *${capitalizarNome(nomeCompleto)}*\n_Agora você pode usar "${norm(p1)}" no lugar de "${capitalizarNome(nomeCompleto)}" em qualquer comando._`;
  }

  if (p0 === 'preco' && p1) {
    const prodTrecho    = palavras.slice(1, -1).join(' ');
    const ultimaPalavra = palavras[palavras.length - 1];
    const novoPreco     = extrairValor(ultimaPalavra);
    if (novoPreco && novoPreco > 0) return mudarPreco(prodTrecho, novoPreco);
    const prodTudo = palavras.slice(1).join(' ');
    const v2       = extrairValor(prodTudo);
    if (v2 && v2 > 0) { const prodSemVal = prodTudo.replace(/r?\$?\s*\d+[,.]?\d*/, '').trim(); return mudarPreco(prodSemVal || p1, v2); }
  }

  if (p0 === 'novo' && p1) {
    const partes  = palavras.slice(1);
    const ultimaP = partes[partes.length - 1];
    const preco   = extrairValor(ultimaP);
    if (preco && preco > 0) { const nomeProd = partes.slice(0, -1).join(' ').trim(); if (nomeProd) return cadastrarNovoProduto(nomeProd, preco); }
  }

  // ── Expandir alias ────────────────────────────────────────────────────────
  let textoResolvido = texto;
  {
    const primeiraOriginal = texto.trim().split(/\s+/)[0];
    const aliasResolvido   = resolverAlias(primeiraOriginal);
    if (aliasResolvido) {
      textoResolvido = aliasResolvido + texto.trim().slice(primeiraOriginal.length);
    }
  }

  // ── Venda à vista ─────────────────────────────────────────────────────────
  const vista = parsearVendaVista(textoResolvido);
  if (vista) {
    const msgs = [];
    for (const item of vista.itens) {
      const res = await registrarVendaVista(vista.nome, item.produto, item.quantidade, vista.metodo);
      if (!res) { msgs.push(`❌ Erro ao registrar venda à vista de ${vista.nome}.`); continue; }
      const valor = (PRECOS[item.produto] || 0) * item.quantidade;
      pushLancamento(jid, { tipo: 'compra', cliente: res.cliente, produto: item.produto, quantidade: item.quantidade, valor });
      const metodoLabel = vista.metodo ? ` — ${vista.metodo}` : '';
      msgs.push(`💵 *${res.cliente}*: ${item.quantidade} ${nomeProdutoExib(item.produto)}(s) = R$ ${valor.toFixed(2)} _(pago à vista${metodoLabel})_`);
    }
    return msgs.join('\n');
  }

  const pag = parsearPagamento(textoResolvido);
  if (pag) {
    if (pag.tipo === 'produto') { const r = await processarPagamentoProduto(pag.nome, pag.quantidade, pag.produto, jid, pag.metodo); return r.msg; }
    if (pag.tipo === 'valor')   { const r = await processarPagamentoValor(pag.nome, pag.valor, jid, pag.metodo); return r.msg; }
  }

  const compra = parsearLinha(textoResolvido);
  if (compra) {
    const msgs = [];
    for (const item of compra.itens) {
      const res = await registrarOuAcumular(compra.nome, item.produto, item.quantidade);
      if (!res) { msgs.push(`❌ Erro ao registrar ${compra.nome}.`); continue; }
      if (res.limiteBloqueado) {
        msgs.push(`⛔ *${res.cliente}* atingiu o limite de crédito!\nAtual: R$ ${res.totalAtual.toFixed(2)} + R$ ${res.valorNovo.toFixed(2)} = ultrapassaria R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}`);
        continue;
      }
      pushLancamento(jid, { tipo: 'compra', cliente: res.cliente, produto: item.produto, quantidade: item.quantidade, valor: PRECOS[item.produto] * item.quantidade });
      msgs.push(`${emojiProduto(item.produto)} *${res.cliente}*: ${res.qtdAcumulada} ${nomeProdutoExib(item.produto)}(s) = R$ ${res.totalAcumulado.toFixed(2)}`);
    }
    return msgs.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Fallback: produto sem quantidade ou produto não reconhecido ───────────
  // ══════════════════════════════════════════════════════════════════════════

  // Caso 1: nome + produto reconhecido mas sem número → pergunta quantidade
  const semQtd = parsearCompraSemQuantidade(textoResolvido);
  if (semQtd) {
    criarConfirmacaoQuantidade(jid, semQtd.nome, semQtd.produto);
    return `Quantos *${nomeProdutoExib(semQtd.produto).toLowerCase()}s* *${semQtd.nome}* levou?\n\n1️⃣  1\n2️⃣  2\n3️⃣  3\n4️⃣  4\n5️⃣  5\n🔢  Outro — digite o número`;
  }

  // Caso 2: parece ter nome mas produto irreconhecível → pergunta produto
  // Heurística: 2+ palavras, primeira parece nome próprio (capitalizada ou sem acento),
  // não é comando conhecido, não foi parseado por nenhum parser acima.
  const palavrasOrig = texto.trim().split(/\s+/).filter(Boolean);
  if (palavrasOrig.length >= 2 && !PALAVRAS_RESERVADAS.has(p0)) {
    const primeiraParece = /^[A-ZÀ-Ú]/.test(palavrasOrig[0]) || palavrasOrig[0].length >= 3;
    if (primeiraParece) {
      // Verifica se nenhuma palavra é produto — se fossem, parsearLinha já teria pego
      const algumProduto = palavrasOrig.some(p => toProduto(norm(p)));
      if (!algumProduto) {
        const nomeGuess = capitalizarNome(palavrasOrig[0]);
        criarConfirmacaoProduto(jid, nomeGuess, texto.trim());
        return `❓ Não reconheci o produto. O que *${nomeGuess}* comprou?\n\n${menuProdutos()}\n\nResponda com o número ou o nome do produto.`;
      }
    }
  }

  return null;
}

module.exports = {
  transcreverAudio, limparTranscricao, corrigirTranscricao, corrigirFoneticosProdutos, dedupNomeInicio,
  processarTexto, mensagemAjuda,
};
