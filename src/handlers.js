// ─── HANDLERS DE MENSAGENS ────────────────────────────────────────────────────────────
const FormData = require('form-data');
const { GROQ_API_KEY, LIMITE_CREDITO_PADRAO } = require('./config');
const {
  norm, capitalizarNome, isMes,
  toProduto, toNumero, extrairValor,
  emojiProduto, nomeProdutoExib,
  PRECOS, SINONIMOS_EXTRA, salvarPrecos, salvarSinonimosExtra, todosOsSinonimos,
  pushLancamento,
  resolverAlias, definirAlias, ALIASES,
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

/**
 * Remove palavras duplicadas CONSECUTIVAS no início da frase.
 * Exemplos:
 *   "Rodrigo Rodrigo um bolo"  →  "Rodrigo um bolo"
 *   "Ana Maria Ana Maria 2 trufas"  →  "Ana Maria 2 trufas"
 *   "Carlos Carlos pagou 10"  →  "Carlos pagou 10"
 * Não afeta: "Ana e Maria" (palavras diferentes), meio da frase, etc.
 */
function dedupNomeInicio(texto) {
  if (!texto) return texto;
  const palavras = texto.trim().split(/\s+/);
  const n = palavras.length;
  if (n < 2) return texto;

  // Tenta tamanhos de bloco decrescentes (2 palavras, depois 1)
  for (let bloco = Math.floor(n / 2); bloco >= 1; bloco--) {
    const parte1 = palavras.slice(0, bloco).map(norm).join(' ');
    const parte2 = palavras.slice(bloco, bloco * 2).map(norm).join(' ');
    if (parte1 === parte2) {
      // Remove o bloco duplicado
      return palavras.slice(bloco).join(' ');
    }
  }
  return texto;
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
    // Prompt guia o Whisper a reconhecer nomes próprios brasileiros corretamente
    // e não inventar frases quando não entende uma palavra
    const promptWhisper = [
      'Contexto: sistema de vendas de doces. Formato das mensagens: nome de cliente seguido de quantidade e produto.',
      'Nomes próprios brasileiros comuns: Ana, Carlos, Julia, Maria, Pedro, Lucas, Rodrigo, Raissa, Fernanda, Gabriel, Beatriz, Rafaela.',
      'Produtos: trufa, trufas, bolo, bolos, bombom, bombons.',
      'Exemplos exatos de entradas válidas:',
      '"Rodrigo 1 bolo", "Ana 3 trufas", "Carlos 2 bolos", "Julia 1 bombom",',
      '"Maria pagou 10", "Pedro pix 15", "Joao pagou 2 trufas",',
      '"Raissa 1 bolo", "Rodrigo 2 trufas pago pix", "Ana pegou 1 bolo e pagou dinheiro".',
      'IMPORTANTE: se não entender uma palavra, transcreva o som mais próximo. Não invente frases como "o que é" ou "não sei".',
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
 *   "Lucas uma trufa e um bombom pagou no pix"
 *   "Lucas pegou 1 bombom e pagou no dinheiro"
 *   "Lucas comprou 2 trufas e pagou dinheiro"
 *
 * Regra: há produto na frase + há indicação de quitação (KW_VISTA ou pagou/paga).
 * Retorna { nome, itens, metodo } com itens agrupados por produto, ou null.
 */
function parsearVendaVista(linha) {
  const tNorm = norm(linha);

  // Verifica se há pelo menos um produto reconhecível na frase
  const temProduto = tNorm.split(/\s+/).some(p => !!toProduto(p));

  // Verifica se há indicação de quitação imediata:
  // KW_VISTA (pago, pix, dinheiro...) OU verbos pagou/paga quando há produto
  const temKwVista = [...KW_VISTA].some(kw => new RegExp(`\\b${kw}\\b`).test(tNorm));
  const temPagouComProduto = /\b(pagou|paga)\b/.test(tNorm) && temProduto;

  if (!temKwVista && !temPagouComProduto) return null;

  // Pagamento de dívida puro: "Lucas pagou 10" ou "Lucas pagou 2 trufas" (sem KW_VISTA)
  // Se "pagou" está presente MAS não há KW_VISTA, só aceita como à vista se tiver produto
  if (!temKwVista && temPagouComProduto) {
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
    '*Aliases (apelidos):*',
    '  `alias ray Raylucas` — define "ray" como apelido de "Raylucas"',
    '  `alias ju Julia Souza` — define "ju" como apelido de "Julia Souza"',
    '  `alias ray` — remove o apelido "ray"',
    '  `aliases` — lista todos os apelidos cadastrados',
    '',
    '*Outros:*',
    '  `cancelar julia` — desfaz último lançamento',
    '  `zerar carlos` — zera dívida (pede confirmação)',
    '  `produtos` — lista produtos e preços',
    '  `preco trufa 6` — muda preço',
    '  `novo brigadeiro 3.50` — cadastra produto',
  ].join('\n');
}

// ── Estado de confirmação pendente para zerar (sugestão 2) ───────────────────────────────────────
// Armazena por jid: { cliente: string, expira: timestamp }
// Se o usuário confirmar com "sim" dentro de 60s, o zerar é executado.
const ZERAR_PENDENTE = {};
const ZERAR_TTL_MS = 60_000; // 60 segundos para confirmar

// ── Processador principal de texto ───────────────────────────────────────────────────────────
async function processarTexto(texto, jid, sock) {
  if (!texto) return null;
  const t        = norm(texto);
  const palavras = t.split(/\s+/).filter(Boolean);
  const p0 = palavras[0]; const p1 = palavras[1]; const resto = palavras.slice(1).join(' ');

  // ── Sugestão 2: confirmação de zerar pendente ─────────────────────────────────────────────
  // Se há uma confirmação pendente e o usuário digitou "sim", executa o zerar
  if (ZERAR_PENDENTE[jid] && (p0 === 'sim' || p0 === 's')) {
    const { cliente, expira } = ZERAR_PENDENTE[jid];
    delete ZERAR_PENDENTE[jid];
    if (Date.now() > expira) return `⏱️ Tempo expirado. Digite novamente _zerar ${cliente}_ para tentar de novo.`;
    return await zerarCliente(cliente);
  }
  // Se havia pendente mas digitou qualquer outra coisa, cancela silenciosamente
  if (ZERAR_PENDENTE[jid] && p0 !== 'sim' && p0 !== 's') {
    delete ZERAR_PENDENTE[jid];
    // Não retorna aqui — continua processando o comando normalmente
  }

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
  if (p0 === 'ajuda' || p0 === 'help') return mensagemAjuda();
  if (p0 === 'produtos')             return listarProdutos();

  // ── Sugestão 2: zerar com confirmação ────────────────────────────────────────────────────
  if (p0 === 'zerar' && p1) {
    const nomeCliente = palavras.slice(1).join(' ');
    ZERAR_PENDENTE[jid] = { cliente: nomeCliente, expira: Date.now() + ZERAR_TTL_MS };
    // Limpa automaticamente após TTL para não poluir memória
    setTimeout(() => { if (ZERAR_PENDENTE[jid]?.cliente === nomeCliente) delete ZERAR_PENDENTE[jid]; }, ZERAR_TTL_MS + 1000);
    return `⚠️ *Tem certeza que quer zerar o histórico de "${capitalizarNome(nomeCliente)}"?*\nEsta ação não pode ser desfeita.\n\nResponda *sim* para confirmar ou qualquer outra mensagem para cancelar.`;
  }

  // ── Sugestão 1: gerenciar aliases ────────────────────────────────────────────────────────
  // "alias" — lista todos
  if (p0 === 'aliases') {
    const entradas = Object.entries(ALIASES);
    if (!entradas.length) return '📋 Nenhum apelido cadastrado ainda.\n_Use: alias [apelido] [nome completo]_';
    const linhas = entradas.map(([ap, nome]) => `  _${ap}_ → *${nome}*`).join('\n');
    return `📋 *Apelidos cadastrados:*\n${linhas}`;
  }
  // "alias ray" (sem nome) — remove
  // "alias ray Raylucas" — cadastra
  if (p0 === 'alias') {
    if (!p1) return '❌ Uso: _alias [apelido] [nome completo]_\nExemplo: _alias ray Raylucas_';
    const nomeCompleto = palavras.slice(2).join(' ').trim();
    if (!nomeCompleto) {
      // Remove o alias
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

  // ── Sugestão 1: expandir alias no texto antes de parsear ─────────────────────────────────
  // Se a primeira palavra é um alias conhecido, substitui pelo nome completo
  let textoResolvido = texto;
  {
    const primeiraOriginal = texto.trim().split(/\s+/)[0];
    const aliasResolvido   = resolverAlias(primeiraOriginal);
    if (aliasResolvido) {
      // Substitui SOMENTE a primeira palavra pelo nome completo
      textoResolvido = aliasResolvido + texto.trim().slice(primeiraOriginal.length);
    }
  }

  // ── Venda à vista (pago na hora) — verificar ANTES do pagamento de dívida ──
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

  return null;
}

module.exports = {
  transcreverAudio, limparTranscricao, corrigirTranscricao, dedupNomeInicio,
  processarTexto, mensagemAjuda,
};
