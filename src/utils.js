// ─── UTILITÁRIOS COMPARTILHADOS ────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const persist = require('./persist');

// ── Normalização de texto ────────────────────────────────────────────────────
function norm(t) {
  return (t || '')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function capitalizarNome(n) {
  if (!n) return '';
  return n.trim().split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function agoraData() { return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function soData(str) { if (!str) return ''; return (str.trim().split(' ')[0] || str.trim()).replace(',', ''); }

function horaAtualSP() {
  const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
  return parseInt(formatter.format(new Date()));
}

// ── Levenshtein / fuzzy nome ──────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function nomesFuzzyIguais(digitado, cadastrado) {
  const na = norm(digitado).split(/\s+/).filter(Boolean);
  const nb = norm(cadastrado).split(/\s+/).filter(Boolean);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    const maxLen = Math.max(na[i].length, nb[i].length);
    if (levenshtein(na[i], nb[i]) > (maxLen <= 5 ? 1 : 2)) return false;
  }
  return true;
}

function resolverNome(digitado, nomesConhecidos) {
  if (!digitado || !nomesConhecidos || !nomesConhecidos.length) return null;
  const nd = norm(digitado);
  for (const c of nomesConhecidos) if (norm(c) === nd) return c;
  for (const c of nomesConhecidos) if (nomesFuzzyIguais(digitado, c)) return c;
  return null;
}

function mesmoNome(a, b) { return norm(a) === norm(b) || nomesFuzzyIguais(a, b); }

// ── Retry com backoff ──────────────────────────────────────────────────────
function comRetry(fn, tentativas = 4, labelErro = 'Google API') {
  let i = 0;
  async function tentativa() {
    try {
      return await fn();
    } catch (err) {
      const msg = (err?.message || '').toLowerCase();
      const isRetryable =
        msg.includes('premature close') ||
        msg.includes('fetch failed') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('rate limit');
      if (isRetryable && i < tentativas - 1) {
        i++;
        const espera = i * 2000;
        console.log(`[${labelErro}] Tentativa ${i}/${tentativas} falhou (${msg.slice(0, 60)}). Aguardando ${espera / 1000}s...`);
        await new Promise(r => setTimeout(r, espera));
        return tentativa();
      }
      throw err;
    }
  }
  return tentativa();
}

// ── Produtos e preços ────────────────────────────────────────────────────────────
const PRECOS_PADRAO = { trufa: 5.0, bolo: 12.0 };

let PRECOS = persist.carregarPrecos(null);
if (!PRECOS) {
  try {
    if (fs.existsSync('precos.json')) {
      PRECOS = JSON.parse(fs.readFileSync('precos.json', 'utf8'));
      console.log('[utils] PRECOS carregados de precos.json (legado).');
    }
  } catch (e) {}
  if (!PRECOS) PRECOS = { ...PRECOS_PADRAO };
}

function salvarPrecos() {
  persist.salvarPrecos(PRECOS);
}

const SINONIMOS = {
  trufa: [
    'trufa', 'trufas', 'trufinha', 'trufinhas',
    'bombom', 'bombons', 'bombon',
    'momon', 'monom', 'momom', 'mombon',
    'bonbon', 'bonbom', 'bonbons',
    'pompon', 'pompom',
  ],
  bolo: ['bolo', 'bolos', 'bolinho', 'bolinhos', 'bolo de pote', 'bolo pote'],
};

// Sinônimos extras persistidos
let SINONIMOS_EXTRA = persist.carregarSinonimos(null);
if (!SINONIMOS_EXTRA) {
  try {
    if (fs.existsSync('sinonimos.json')) {
      SINONIMOS_EXTRA = JSON.parse(fs.readFileSync('sinonimos.json', 'utf8'));
      console.log('[utils] SINONIMOS_EXTRA carregados de sinonimos.json (legado).');
    }
  } catch (e) {}
  if (!SINONIMOS_EXTRA) SINONIMOS_EXTRA = {};
}

function salvarSinonimosExtra() {
  persist.salvarSinonimos(SINONIMOS_EXTRA);
}

const NUMEROS_EXTENSO = {
  'um':1,'uma':1,'dois':2,'duas':2,'tres':3,'quatro':4,'cinco':5,
  'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,'onze':11,'doze':12,
  'treze':13,'quatorze':14,'catorze':14,'quinze':15,'dezesseis':16,
  'dezessete':17,'dezoito':18,'dezenove':19,'vinte':20,
};

const MESES_VALIDOS = new Set([
  'janeiro','fevereiro','marco','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro',
  '01','02','03','04','05','06','07','08','09','10','11','12',
  '1','2','3','4','5','6','7','8','9',
]);
function isMes(str) {
  const n = norm(str);
  return MESES_VALIDOS.has(n) || /^\d{1,2}$/.test(n);
}

function todosOsSinonimos() {
  const mapa = { ...SINONIMOS };
  for (const [k, v] of Object.entries(SINONIMOS_EXTRA)) mapa[k] = (mapa[k] || []).concat(v);
  return mapa;
}

function toProduto(trecho) {
  const n = norm(trecho);
  if (!n) return null;
  for (const [produto, sins] of Object.entries(todosOsSinonimos()))
    for (const sin of sins)
      if (n === norm(sin)) return produto;
  return null;
}

function toNumero(p) {
  const n = norm(p);
  if (/^\d+$/.test(n)) return parseInt(n);
  return NUMEROS_EXTENSO[n] ?? null;
}

function extrairValor(texto) {
  if (!texto) return null;
  const t = norm(texto)
    .replace(/r\$\s*/g, ' ').replace(/\breais\b/g, ' ').replace(/\bpix\b/g, ' ')
    .replace(/\bde\b/g, ' ').replace(/\btransferiu\b/g, ' ').replace(/\bdepositou\b/g, ' ')
    .replace(/\bmandou\b/g, ' ').replace(/\benviou\b/g, ' ').replace(/\bpagou\b/g, ' ').trim();
  const m = t.match(/(\d+[,.]?\d*)/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(',', '.'));
  return isNaN(val) ? null : val;
}

function emojiProduto(produto) {
  if (produto === 'bolo')  return '\ud83c\udf82';
  if (produto === 'trufa') return '\ud83c\udf6b';
  return '\ud83e\udee4';
}

function nomeProdutoExib(produto) {
  if (produto === 'bolo')  return 'Bolo';
  if (produto === 'trufa') return 'Trufa';
  return capitalizarNome(produto.replace(/_/g, ' '));
}

// ── Histórico de lançamentos (para cancelar) ──────────────────────────────────
const ULTIMOS_LANCAMENTOS = {};
const MAX_HIST_CANCEL = 10;
function pushLancamento(jid, obj) {
  if (!ULTIMOS_LANCAMENTOS[jid]) ULTIMOS_LANCAMENTOS[jid] = [];
  ULTIMOS_LANCAMENTOS[jid].push(obj);
  if (ULTIMOS_LANCAMENTOS[jid].length > MAX_HIST_CANCEL) ULTIMOS_LANCAMENTOS[jid].shift();
}

// ── Aliases de nome ─────────────────────────────────────────────────────────────────
let ALIASES = persist.carregarAliases(null);
if (!ALIASES) {
  try {
    if (fs.existsSync('aliases.json')) {
      ALIASES = JSON.parse(fs.readFileSync('aliases.json', 'utf8'));
      console.log('[utils] ALIASES carregados de aliases.json (legado).');
    }
  } catch (e) {}
  if (!ALIASES) ALIASES = {};
}

function salvarAliases() {
  persist.salvarAliases(ALIASES);
}

function resolverAlias(digitado) {
  if (!digitado) return null;
  return ALIASES[norm(digitado)] || null;
}

function definirAlias(apelido, nomeCompleto) {
  const key = norm(apelido);
  if (!key) return;
  if (nomeCompleto === null || nomeCompleto === undefined) {
    delete ALIASES[key];
  } else {
    ALIASES[key] = nomeCompleto.trim();
  }
  salvarAliases();
}

module.exports = {
  norm, capitalizarNome, agora, agoraData, soData, horaAtualSP,
  levenshtein, nomesFuzzyIguais, resolverNome, mesmoNome,
  comRetry,
  PRECOS, salvarPrecos, SINONIMOS, SINONIMOS_EXTRA, salvarSinonimosExtra,
  NUMEROS_EXTENSO, MESES_VALIDOS, isMes,
  todosOsSinonimos, toProduto, toNumero, extrairValor,
  emojiProduto, nomeProdutoExib,
  ULTIMOS_LANCAMENTOS, pushLancamento,
  ALIASES, salvarAliases, resolverAlias, definirAlias,
};
