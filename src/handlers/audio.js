// ─── MÓDULO DE ÁUDIO ─────────────────────────────────────────────────────────
// Responsabilidade: transcrição via Groq Whisper e limpeza/correção de texto
// transcrito. Sem dependência de fluxo de negócio ou comandos do bot.
// ─────────────────────────────────────────────────────────────────────────────
const FormData = require('form-data');
const { GROQ_API_KEY } = require('../config');
const { norm, PRECOS } = require('../utils');

// ── Correções de transcrição de voz ──────────────────────────────────────────
const CORRECOES_VOZ = {
  'saudo':'saldo','saud':'saldo','salvo':'saldo','salda':'saldo','saldos':'saldo',
  'relatorios':'relatorio','relato':'relatorio',
  'rezumo':'resumo','resuno':'resumo',
  'istorico':'historico',
  'cancelado':'cancelar','cancela':'cancelar','cancelas':'cancelar',
  'zera':'zerar','ajudas':'ajuda','produto':'produtos',
  'pagol':'pagou',
  // NOTA: 'pago' NÃO é corrigido para 'pagou' — "pago no pix" é venda à vista
  'pics':'pix','pik':'pix',
  'transferio':'transferiu','transferiou':'transferiu',
  // Erros fonéticos de bombom/trufa
  'bombon':'bombom','bonbon':'bombom','bonbom':'bombom',
  'momon':'bombom','monom':'bombom','momom':'bombom',
  'mombon':'bombom','pompon':'bombom','pompom':'bombom',
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
 */
function dedupNomeInicio(texto) {
  if (!texto) return texto;
  const palavras = texto.trim().split(/\s+/);
  const n = palavras.length;
  if (n < 2) return texto;

  for (let bloco = Math.floor(n / 2); bloco >= 1; bloco--) {
    const parte1 = palavras.slice(0, bloco).map(norm).join(' ');
    const parte2 = palavras.slice(bloco, bloco * 2).map(norm).join(' ');
    if (parte1 === parte2) {
      return palavras.slice(bloco).join(' ');
    }
  }
  return texto;
}

// ── Distância de Levenshtein ──────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/**
 * Todos os sinônimos de todos os produtos — usados como alvo para correção fonética.
 * Inclui os sinônimos hardcoded de utils.js para garantir que bombom/momon sejam alvos.
 */
function getAllSinonimos() {
  const { todosOsSinonimos } = require('../utils');
  const mapa = todosOsSinonimos();
  const todos = new Set();
  for (const sins of Object.values(mapa)) {
    for (const s of sins) todos.add(norm(s));
  }
  return [...todos];
}

/**
 * Corrige palavras não reconhecidas que soam parecido com produtos cadastrados.
 *
 * Melhorias v2:
 *  - Compara contra TODOS os sinônimos (não só as chaves do PRECOS)
 *    → "momon" bate em "bombom" (dist 3 em 6 letras) e é corrigido para o produto
 *  - Distância máxima: comprimento_palavra * 0.5, mínimo 2, máximo 4
 *    → Permite pegar variações fonéticas mais distantes em palavras longas
 *  - Em caso de empate de distância, mantém a palavra original
 */
const PALAVRAS_RESERVADAS_AUDIO = new Set([
  'pagou','pix','transferiu','depositou','mandou','enviou',
  'cancelar','saldo','historico','relatorio','resumo',
  'cobrar','lembrete','lembretes','preco','produtos','zerar','novo','renomear',
  'sim','nao','um','uma','dois','duas','tres','quatro','cinco',
  'seis','sete','oito','nove','dez','e','de','mais','para','no','na',
]);

function corrigirFoneticosProdutos(texto) {
  if (!texto) return texto;

  const { toProduto, todosOsSinonimos } = require('../utils');
  const produtos = Object.keys(PRECOS);
  if (!produtos.length) return texto;

  // Constrói mapa: sinonimo_normalizado → produto
  const mapaAlvo = {};
  for (const [prod, sins] of Object.entries(todosOsSinonimos())) {
    for (const sin of sins) mapaAlvo[norm(sin)] = prod;
  }
  const sinonimosList = Object.keys(mapaAlvo);

  const palavras = texto.trim().split(/\s+/);
  let corrigido = false;

  const resultado = palavras.map(palavra => {
    const n = norm(palavra);

    if (PALAVRAS_RESERVADAS_AUDIO.has(n)) return palavra;
    if (/^\d+([,.]\d+)?$/.test(n)) return palavra;
    if (toProduto(n)) return palavra; // já reconhecido

    // Distância máxima dinâmica: 50% do comprimento, entre 2 e 4
    const MAX_DIST = Math.min(4, Math.max(2, Math.floor(n.length * 0.5)));
    let melhorSin  = null;
    let melhorDist = Infinity;
    let empate     = false;

    for (const sin of sinonimosList) {
      const dist = levenshtein(n, sin);
      if (dist < melhorDist) {
        melhorDist = dist;
        melhorSin  = sin;
        empate     = false;
      } else if (dist === melhorDist) {
        empate = true;
      }
    }

    if (!empate && melhorSin && melhorDist <= MAX_DIST) {
      const prodAlvo = mapaAlvo[melhorSin];
      console.log(`[áudio] correção fonética: "${palavra}" → "${prodAlvo}" via "${melhorSin}" (dist ${melhorDist})`);
      corrigido = true;
      return prodAlvo;
    }

    return palavra;
  });

  let textoCorrigido = resultado.join(' ');

  if (corrigido) {
    const temNumero = /\b(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\b/.test(norm(textoCorrigido));
    if (!temNumero) {
      const partes  = textoCorrigido.split(/\s+/);
      const idxProd = partes.findIndex(p => toProduto(norm(p)));
      if (idxProd > 0) {
        partes.splice(idxProd, 0, '1');
        textoCorrigido = partes.join(' ');
        console.log(`[áudio] quantidade injetada: "${textoCorrigido}"`);
      }
    }
  }

  return textoCorrigido;
}

// ── Transcrição de áudio via Groq Whisper ────────────────────────────────────
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

module.exports = {
  CORRECOES_VOZ,
  corrigirPalavra,
  limparTranscricao,
  corrigirTranscricao,
  corrigirFoneticosProdutos,
  dedupNomeInicio,
  transcreverAudio,
};
