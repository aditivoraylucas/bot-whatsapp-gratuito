// ─── MÓDULO DE ÁUDIO ─────────────────────────────────────────────────────────
// Responsabilidade: transcrição via Groq Whisper e limpeza/correção de texto
// transcrito. Sem dependência de fluxo de negócio ou comandos do bot.
// ─────────────────────────────────────────────────────────────────────────────
const FormData = require('form-data');
const { GROQ_API_KEY } = require('../config');
const { norm, PRECOS } = require('../utils');

// ── Correções de transcrição de voz ──────────────────────────────────────────
const CORRECOES_VOZ = {
  // Comandos
  'saudo':'saldo','saud':'saldo','salvo':'saldo','salda':'saldo','saldos':'saldo',
  'relatorios':'relatorio','relato':'relatorio',
  'rezumo':'resumo','resuno':'resumo',
  'istorico':'historico',
  'cancelado':'cancelar','cancela':'cancelar','cancelas':'cancelar',
  'zera':'zerar','ajudas':'ajuda','produto':'produtos',
  'pagol':'pagou',
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
 * Ex: "Julia Julia 2 trufas" → "Julia 2 trufas"
 */
function dedupNomeInicio(texto) {
  if (!texto) return texto;
  const palavras = texto.trim().split(/\s+/);
  const n = palavras.length;
  if (n < 2) return texto;
  for (let bloco = Math.floor(n / 2); bloco >= 1; bloco--) {
    const parte1 = palavras.slice(0, bloco).map(norm).join(' ');
    const parte2 = palavras.slice(bloco, bloco * 2).map(norm).join(' ');
    if (parte1 === parte2) return palavras.slice(bloco).join(' ');
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
 * Corrige palavras não reconhecidas foneticaménte contra todos os sinônimos.
 * Distância máxima dinâmica: 50% do tamanho da palavra, entre 2 e 4.
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

  // Mapa sinônimo normalizado → produto
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
    if (/^\d+([,.]\d+)?$/.test(n))        return palavra;
    if (toProduto(n))                      return palavra; // já reconhecido

    const MAX_DIST = Math.min(4, Math.max(2, Math.floor(n.length * 0.5)));
    let melhorSin  = null;
    let melhorDist = Infinity;
    let empate     = false;

    for (const sin of sinonimosList) {
      const dist = levenshtein(n, sin);
      if (dist < melhorDist) { melhorDist = dist; melhorSin = sin; empate = false; }
      else if (dist === melhorDist)         { empate = true; }
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

  // Se houve correção e não há número, injeta "1" antes do produto
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

/**
 * Gera o prompt do Whisper dinamicamente.
 *
 * Estratégia:
 * - O Whisper usa o prompt como "contexto de estilo" — ele tenta continuar
 *   o texto do prompt. Por isso o prompt deve TERMINAR com exemplos no
 *   mesmo formato exato que as mensagens chegam.
 * - Incluir os produtos com seus sinônimos reais ajuda o modelo a
 *   reconhecer as palavras corretamente.
 * - Incluir nomes reais dos clientes (lidos da planilha) reduz erros
 *   em nomes incomuns.
 */
function gerarPromptWhisper() {
  const { todosOsSinonimos } = require('../utils');
  const sins = todosOsSinonimos();

  // Monta lista de produtos com seus sinônimos para o prompt
  const listaProdutos = Object.entries(sins)
    .map(([prod, lista]) => {
      const unicos = [...new Set(lista.map(s => s.toLowerCase()))].slice(0, 6);
      return unicos.join(', ');
    })
    .join('; ');

  return [
    // Contexto geral
    'Contexto: sistema de registro de vendas de doces no atacado.',
    'As mensagens são comandos de voz curtos em português brasileiro informal.',
    '',
    // Formato esperado (o mais importante — Whisper tenta "continuar" esse estilo)
    'Formato: [Nome do cliente] [quantidade] [produto]',
    'Exemplos reais de comandos:',
    'Carla 2 bombons.',
    'Jéssica 1 trufa.',
    'Elayne 4 trufas.',
    'Maria Clara 2 bombons.',
    'Lucas 3 trufas.',
    'Ana pagou 15.',
    'Pedro pix 20.',
    'Carla 1 bolo.',
    '',
    // Produtos cadastrados com sinônimos
    `Produtos cadastrados: ${listaProdutos}.`,
    '',
    // Instruções
    'IMPORTANTE: transcreva exatamente o que foi dito, mesmo que pareça errado.',
    'Não corrija nomes de pessoas.',
    'Não adicione pontuação extra.',
    'Se não entender uma palavra, escreva o som mais próximo.',
  ].join(' ');
}

async function transcreverAudio(audioBuffer, mimeType) {
  if (!GROQ_API_KEY) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    const ext   = mimeType?.includes('ogg') ? 'ogg'
                : mimeType?.includes('mp4') ? 'mp4'
                : mimeType?.includes('webm') ? 'webm'
                : 'ogg';
    const form  = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg; codecs=opus' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'pt');
    form.append('response_format', 'verbose_json'); // mais detalhes no retorno
    form.append('temperature', '0');               // temperatura 0 = mais determinístico
    form.append('prompt', gerarPromptWhisper());

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
      body: form,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('Groq erro:', err);
      return null;
    }

    const data = await res.json();

    // verbose_json retorna { text, segments, ... }
    const textoRaw = data.text?.trim() || null;
    if (!textoRaw) return null;

    // Log de confiança se disponível
    if (data.segments?.length) {
      const avgLogprob = data.segments.reduce((s, seg) => s + (seg.avg_logprob || 0), 0) / data.segments.length;
      const noSpeech   = data.segments.some(seg => (seg.no_speech_prob || 0) > 0.6);
      console.log(`[áudio] avg_logprob=${avgLogprob.toFixed(3)} no_speech=${noSpeech}`);
      // Se alta probabilidade de silêncio, descarta
      if (noSpeech && textoRaw.length < 10) {
        console.warn('[áudio] áudio descartado: prob de silêncio alta');
        return null;
      }
    }

    return textoRaw;
  } catch (e) {
    console.error('Erro transcrição Groq:', e.message);
    return null;
  }
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
