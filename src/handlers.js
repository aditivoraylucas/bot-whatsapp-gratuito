// ─── HANDLERS DE MENSAGENS ────────────────────────────────────────────────────────────
const FormData = require('form-data');
const { GROQ_API_KEY, LIMITE_CREDITO_PADRAO } = require('./config');
const {
  norm, capitalizarNome, isMes,
  toProduto, toNumero, extrairValor,
  emojiProduto, nomeProdutoExib,
  PRECOS, SINONIMOS_EXTRA, salvarPrecos, salvarSinonimosExtra, todosOsSinonimos,
  pushLancamento,
} = require('./utils');
const {
  registrarOuAcumular, cancelarLancamento,
  registrarVendaVista,
  processarPagamentoProduto, processarPagamentoValor,
  gerarRelatorioGeral, gerarRelatorioDetalhado, gerarRelatorioQuitados,
  gerarSaldoIndividual, gerarHistoricoCliente, gerarRelatorioMes,
  gerarResumoDiario, zerarCliente,
} = require('./sheets');

// ── Correções de transcrição de voz ────────────────────────────────────────────────
const CORRECOES_VOZ = {
  'saudo':'saldo','saud':'saldo','salvo':'saldo','salda':'saldo','saldos':'saldo',
  'relatorios':'relatorio','relato':'relatorio',
  'rezumo':'resumo','resuno':'resumo',
  'istorico':'historico',
  'cancelado':'cancelar','cancela':'cancelar','cancelas':'cancelar',
  'zera':'zerar','ajudas':'ajuda','produto':'produtos',
  'pagol':'pagou',
  // NOTA: 'pago' NÃO é corrigido para 'pagou' — "pago no pix" é venda à vista, não pagamento de dívida
  'pics':'pix','pik':'pix',
  'transferio':'transferiu','transferiou':'transferiu',
  'bombon':'bombom',
};
function corrigirPalavra(palavra) {
  const n = norm(palavra);
  return CORRECOES_VOZ[n] || palavra;
}
function limparTranscricao(texto) {
  if (!texto) return texto;
  return texto
    .replace(/([a-záàâãéèêíìîóòôõúùûçA-Z])([.!?;:]+)(\s|$)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}
function corrigirTranscricao(texto) {
  if (!texto) return texto;
  return texto.split(/\s+/).map(p => corrigirPalavra(p)).join(' ');
}

// ── Transcrição de áudio via Groq Whisper ─────────────────────────────────────────────
async function transcreverAudio(audioBuffer, mimeType) {
  if (!GROQ_API_KEY) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    const ext   = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'mp4' : 'ogg';
    const form  = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const promptWhisper = [
      'Comandos de venda: nomes de clientes seguidos de quantidade e produto.',
      'Produtos: trufa, trufas, bolo, bolos, bombom, bombons.',
      'Exemplos: "julia 1 bolo", "ana 3 trufas", "carlos 2 bolos", "maria pagou 10",',
      '"pedro pix 15", "joao pagou 2 trufas", "relatorio", "resumo", "cancelar julia".',
      '"calor 2 trufas pago pix", "raylucas 1 bombom pago dinheiro" (venda à vista).',
      'Os nomes são nomes próprios brasileiros. Os números são quantidades pequenas (1 a 20).',
    ].join(' ');
    form.append('prompt', promptWhisper);
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
      body: form,
    });
    if (!res.ok) { const err = await res.text(); console.error('Groq erro:', err); return null; }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) { console.error('Erro transcrição Groq:', e.message); return null; }
}

// ── Parser de compra ────────────────────────────────────────────────────────────────────────────
const PALAVRAS_RESERVADAS = new Set([
  'pagou','pix','transferiu','depositou','mandou','enviou',
  'cancelar','saldo','historico','relatorio','resumo',
  'cobrar','lembrete','lembretes','preco','produtos','zerar','novo',
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

// ── Palavras-chave que indicam pagamento imediato (à vista) ───────────────────────────────
const KW_VISTA = new Set([
  'pago','paga','vista','avista','dinheiro','especie',
  'pix','debito','credito','cartao',
]);

// ── Mapa de método de pagamento a partir da keyword ──────────────────────────────────
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

/**
 * Detecta frases do tipo:
 *   "Lucas 2 trufas pago pix"
 *   "Lucas uma trufa e um bombom pago no pix"
 *   "Lucas uma trufa e um bombom pagou no pix"   ← NOVO
 *   "Lucas pegou 1 bombom e pagou no dinheiro"   ← NOVO
 *   "Lucas comprou 2 trufas e pagou dinheiro"     ← NOVO
 *
 * Regra: há produto na frase + há indicação de quitação (KW_VISTA ou pagou/pagou).
 * Retorna { nome, itens, metodo } com itens agrupados por produto, ou null.
 */
function parsearVendaVista(linha) {
  const tNorm = norm(linha);

  // Verifica se há pelo menos um produto reconhecível na frase
  const temProduto = tNorm.split(/\s+/).some(p => !!toProduto(p));

  // Verifica se há indicação de quitação imediata:
  // KW_VISTA (pago, pix, dinheiro...) OU verbos pagou/pagou quando há produto
  const temKwVista = [...KW_VISTA].some(kw => new RegExp(`\\b${kw}\\b`).test(tNorm));
  const temPagouComProduto = /\b(pagou|paga)\b/.test(tNorm) && temProduto;

  if (!temKwVista && !temPagouComProduto) return null;

  // Pagamento de dívida puro: "Lucas pagou 10" ou "Lucas pagou 2 trufas" (sem KW_VISTA)
  // Se "pagou" está presente MAS não há KW_VISTA, só aceita como à vista se tiver produto
  if (!temKwVista && temPagouComProduto) {
    // Se vier valor numérico sem produto, é pagamento de dívida — deixa para parsearPagamento
    const possPagDivida = /\b(pagou|paga)\b.*\b\d+([,.]\d+)?\b/.test(tNorm) && !temProduto;
    if (possPagDivida) return null;
  }

  // Verbos de ação de compra que devem ser removidos da frase antes de parsear
  const KW_VERBOS_COMPRA = /\b(pegou|comprou|levou|tomou|quer|quero|queria)\b/g;

  // Extrai o método antes de limpar a linha
  const metodo = extrairMetodo(linha);

  // Limpa: remove KW_VISTA, pagou/paga, verbos de compra e preposições soltas
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

  // Agrupa itens com o mesmo produto (evita duplicatas por sinônimos)
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
  const keyword     = kwMatch[1];
  const palavrasNorm = tNorm.split(/\s+/).filter(Boolean);
  const palavrasOrig = linha.trim().split(/\s+/).filter(Boolean);
  let kwIdx = -1;
  for (let i = 0; i < palavrasNorm.length; i++) { if (palavrasNorm[i] === keyword) { kwIdx = i; break; } }
  if (kwIdx <= 0) return null;
  const nomeRaw = palavrasOrig.slice(0, kwIdx).join(' ').trim();
  if (!nomeRaw) return null;

  // Detecta método a partir da keyword principal e do restante da linha
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

// ── Comandos de produto/preço ───────────────────────────────────────────────────────────────────────
function mudarPreco(produto, novoPreco) {
  const p = toProduto(produto);
  if (!p) return `❌ Produto *${produto}* não encontrado.`;
  const precoAntigo = PRECOS[p] || 0;
  PRECOS[p] = novoPreco;
  salvarPrecos();
  return `✅ Preço de *${nomeProdutoExib(p)}* atualizado: R$ ${precoAntigo.toFixed(2)} → R$ ${novoPreco.toFixed(2)}\n_Saldos existentes não foram alterados. Vale para novas compras._`;
}

function cadastrarNovoProduto(nomeProduto, preco) {
  const key = norm(nomeProduto).replace(/\s+/g, '_');
  if (PRECOS[key] !== undefined) return `⚠️ Produto *${nomeProduto}* já existe. Para mudar o preço: _preco ${nomeProduto} R$XX_`;
  PRECOS[key] = preco;
  SINONIMOS_EXTRA[key] = [...new Set([norm(nomeProduto), nomeProduto.toLowerCase().trim()])];
  salvarPrecos();
  salvarSinonimosExtra();
  return `✅ Novo produto cadastrado!\n*${capitalizarNome(nomeProduto)}* = R$ ${preco.toFixed(2)}\nUso: _"cliente nome ${norm(nomeProduto)}"_`;
}

function listarProdutos() {
  const todos = todosOsSinonimos();
  let msg = '*Produtos cadastrados*\n───────────────\n';
  for (const [key] of Object.entries(todos)) {
    const preco = PRECOS[key];
    if (preco === undefined) continue;
    msg += `${nomeProdutoExib(key)}: R$ ${preco.toFixed(2)}\n`;
  }
  msg += '───────────────\n_Para mudar o preço: preco [produto] [valor]_';
  return msg;
}

function mensagemAjuda() {
  return [
    '*Bot de Vendas 🥇*','───────────────',
    '*Registrar compra (fiado):*','  `julia 2 trufas`','  `carlos 1 bolo 3 trufas`','',
    '*Venda à vista (pago na hora):*','  `julia 2 trufas pago`','  `carlos 1 bolo pago pix`','  `ana 3 trufas pago dinheiro`','  `ana pegou 2 trufas e pagou pix`','',
    '*Registrar pagamento de dívida:*','  `julia pagou 10`','  `carlos pix 15`','  `ana pagou 2 trufas`','',
    '*Relatórios:*','  `relatorio` — geral','  `relatorio detalhado`','  `relatorio quitados`','  `relatorio junho`','  `resumo` — resumo do dia','',
    '*Consultas:*','  `saldo julia`','  `historico carlos`','',
    '*Outros:*',
    '  `cancelar julia` — desfaz último lançamento',
    '  `zerar carlos` — zera dívida',
    '  `produtos` — lista produtos e preços',
    '  `preco trufa 6` — muda preço',
    '  `novo brigadeiro 3.50` — cadastra produto',
  ].join('\n');
}

// ── Processador principal de texto ───────────────────────────────────────────────────────────
async function processarTexto(texto, jid, sock) {
  if (!texto) return null;
  const t        = norm(texto);
  const palavras = t.split(/\s+/).filter(Boolean);
  const p0 = palavras[0]; const p1 = palavras[1]; const resto = palavras.slice(1).join(' ');

  if (p0 === 'relatorio' || p0 === 'relatorios') {
    if (p1 === 'detalhado')                    return await gerarRelatorioDetalhado();
    if (p1 === 'quitados' || p1 === 'quitado') return await gerarRelatorioQuitados();
    if (p1 && isMes(p1))                       return await gerarRelatorioMes(p1);
    return await gerarRelatorioGeral();
  }
  if (p0 === 'resumo')               return await gerarResumoDiario();
  if (p0 === 'saldo'     && p1)      return await gerarSaldoIndividual(resto);
  if (p0 === 'historico' && p1)      return await gerarHistoricoCliente(resto);
  if (p0 === 'cancelar'  && p1)      return await cancelarLancamento(jid, resto);
  if (p0 === 'zerar'     && p1)      return await zerarCliente(resto);
  if (p0 === 'ajuda' || p0 === 'help') return mensagemAjuda();
  if (p0 === 'produtos')             return listarProdutos();

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

  // ── Venda à vista (pago na hora) — verificar ANTES do pagamento de dívida ──
  const vista = parsearVendaVista(texto);
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

  const pag = parsearPagamento(texto);
  if (pag) {
    if (pag.tipo === 'produto') { const r = await processarPagamentoProduto(pag.nome, pag.quantidade, pag.produto, jid, pag.metodo); return r.msg; }
    if (pag.tipo === 'valor')   { const r = await processarPagamentoValor(pag.nome, pag.valor, jid, pag.metodo); return r.msg; }
  }

  const compra = parsearLinha(texto);
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

  return null;
}

module.exports = {
  transcreverAudio, limparTranscricao, corrigirTranscricao,
  processarTexto, mensagemAjuda,
};
