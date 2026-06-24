// ─── MÓDULO DE ÁUDIO ─────────────────────────────────────────────────────────
// Responsabilidade: transcrição via Groq Whisper e limpeza/correção de texto
// transcrito. Sem dependência de fluxo de negócio ou comandos do bot.
// ─────────────────────────────────────────────────────────────────────────────
const FormData = require('form-data');
const { GROQ_API_KEY } = require('../config');
const { norm } = require('../utils');

// ── Correções de transcrição de voz ──────────────────────────────────────────
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

  for (let bloco = Math.floor(n / 2); bloco >= 1; bloco--) {
    const parte1 = palavras.slice(0, bloco).map(norm).join(' ');
    const parte2 = palavras.slice(bloco, bloco * 2).map(norm).join(' ');
    if (parte1 === parte2) {
      return palavras.slice(bloco).join(' ');
    }
  }
  return texto;
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
  dedupNomeInicio,
  transcreverAudio,
};
