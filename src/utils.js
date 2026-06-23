// ─── UTILITÁRIOS COMPARTILHADOS ──────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

// ── Normalização de texto ──────────────────────────────────────────────────────────────────────
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

function agora() { return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
function agoraData() { return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }
// toLocaleString('pt-BR') gera "DD/MM/AAAA, HH:MM:SS" — o split(' ')[0] fica "DD/MM/AAAA," (com vírgula)
// O replace(',', '') remove essa vírgula para que a comparação com agoraData() funcione corretamente
function soData(str) { if (!str) return ''; return (str.trim().split(' ')[0] || str.trim()).replace(',', ''); }

function horaAtualSP() {
  const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
  return parseInt(formatter.format(new Date()));
}

// ── Levenshtein / fuzzy nome ────────────────────────────────────────────────────────────────
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

// ── Retry com backoff ─────────────────────────────────────────────────────────────────────────
async function comRetry(fn, tentativas = 4, labelErro = 'Google API') {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const isPrematureClose = err?.message?.includes('Premature close') || err?.message?.includes('fetch failed');
      const isUltimaTentativa = i === tentativas - 1;
      if (isPrematureClose && !isUltimaTentativa) {
        const espera = (i + 1) * 2000;
        console.log(`[${labelErro}] Tentativa ${i + 1}/${tentativas} falhou (${err.message}). Aguardando ${espera / 1000}s...`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw err;
      }
    }
  }
}

// ── Produtos e preços ───────────────────────────────────────────────────────────────────────────
const PRECOS_FILE = 'precos.json';
let PRECOS = { trufa: 5.0, bolo: 12.0 };
try { if (fs.existsSync(PRECOS_FILE)) PRECOS = JSON.parse(fs.readFileSync(PRECOS_FILE, 'utf8')); } catch (e) {}
function salvarPrecos() { try { fs.writeFileSync(PRECOS_FILE, JSON.stringify(PRECOS), 'utf8'); } catch (e) {} }

const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'trufinhas', 'bombom', 'bombons'],
  bolo:  ['bolo', 'bolos', 'bolinho', 'bolinhos', 'bolo de pote', 'bolo pote'],
};
const SINONIMOS_EXTRA = {};
try { if (fs.existsSync('sinonimos.json')) Object.assign(SINONIMOS_EXTRA, JSON.parse(fs.readFileSync('sinonimos.json', 'utf8'))); } catch (e) {}
function salvarSinonimosExtra() { try { fs.writeFileSync('sinonimos.json', JSON.stringify(SINONIMOS_EXTRA), 'utf8'); } catch (e) {} }

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

// ── Histórico de lançamentos (para cancelar) ─────────────────────────────────────────────────────
const ULTIMOS_LANCAMENTOS = {};
const MAX_HIST_CANCEL = 10;
function pushLancamento(jid, obj) {
  if (!ULTIMOS_LANCAMENTOS[jid]) ULTIMOS_LANCAMENTOS[jid] = [];
  ULTIMOS_LANCAMENTOS[jid].push(obj);
  if (ULTIMOS_LANCAMENTOS[jid].length > MAX_HIST_CANCEL) ULTIMOS_LANCAMENTOS[jid].shift();
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
};
