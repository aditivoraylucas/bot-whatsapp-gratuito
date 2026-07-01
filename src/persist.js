// ─── PERSISTÊNCIA VIA RENDER API ──────────────────────────────────────────────────
// Salva e carrega PRECOS, ALIASES, SINONIMOS_EXTRA e DEDUP_IDS como env-vars no Render.
//
// Chaves usadas na Render API:
//   BOT_PRECOS       → JSON com { trufa: 5, bolo: 12, ... }
//   BOT_ALIASES      → JSON com { ray: "Raylucas", ... }
//   BOT_SINONIMOS    → JSON com { brigadeiro: ["brigadeiro","brigue"], ... }
//   BOT_DEDUP_IDS    → JSON com [ ["ID", timestamp], ... ] — últimas 2h
// ─────────────────────────────────────────────────────────────────────────────
const { RENDER_API_KEY, RENDER_SERVICE_ID } = require('./config');

const CHAVE_PRECOS    = 'BOT_PRECOS';
const CHAVE_ALIASES   = 'BOT_ALIASES';
const CHAVE_SINONIMOS = 'BOT_SINONIMOS';
const CHAVE_DEDUP     = 'BOT_DEDUP_IDS';

const DEDUP_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

// ── Helpers HTTP ─────────────────────────────────────────────────────────────

function normalizarEnvVars(raw) {
  if (!Array.isArray(raw)) raw = raw?.envVars || [];
  return raw
    .map(item => item.envVar
      ? { key: item.envVar.key, value: item.envVar.value }
      : { key: item.key,       value: item.value })
    .filter(v => v.key && v.key.trim() !== '');
}

async function buscarEnvVars() {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return [];
  const r = await fetch(
    `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
    { headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(`Render GET env-vars: ${r.status}`);
  return normalizarEnvVars(await r.json());
}

async function putEnvVars(lista) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  const r = await fetch(
    `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,
    {
      method:  'PUT',
      headers: { Authorization: `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify(lista.map(v => ({ key: v.key, value: v.value }))),
    }
  );
  if (!r.ok) throw new Error(`Render PUT env-vars: ${r.status} — ${(await r.text()).slice(0,200)}`);
}

// ── Salvar uma chave específica ──────────────────────────────────────────────

async function salvarChave(chave, valor) {
  try {
    const novoValor = JSON.stringify(valor);
    if (process.env[chave] === novoValor) return;
    const existente = await buscarEnvVars();
    const novas = [
      ...existente.filter(v => v.key !== chave),
      { key: chave, value: novoValor },
    ];
    await putEnvVars(novas);
    process.env[chave] = novoValor;
    console.log(`[persist] ${chave} salvo na Render API.`);
  } catch (err) {
    console.error(`[persist] Erro ao salvar ${chave}:`, err.message);
  }
}

// ── Carregar uma chave ────────────────────────────────────────────────────────

function carregarChave(chave, padrao) {
  try {
    const raw = process.env[chave];
    if (!raw) return padrao;
    return JSON.parse(raw);
  } catch {
    return padrao;
  }
}

// ── Dedup persistente ─────────────────────────────────────────────────────────
// Armazena pares [id, timestamp] das últimas 2h.
// Ao carregar, descarta entradas expiradas automaticamente.

let _dedupCache = null;        // Map<id, timestamp> em memória
let _dedupTimer = null;        // debounce para salvar
const DEDUP_DEBOUNCE_MS = 10_000; // salva no máx a cada 10s

function _carregarDedupCache() {
  if (_dedupCache) return _dedupCache;
  const agora = Date.now();
  const raw   = carregarChave(CHAVE_DEDUP, []);
  _dedupCache = new Map();
  for (const [id, ts] of raw) {
    if (agora - ts < DEDUP_TTL_MS) _dedupCache.set(id, ts);
  }
  console.log(`[persist] dedup: ${_dedupCache.size} IDs carregados.`);
  return _dedupCache;
}

function _agendarSalvarDedup() {
  if (_dedupTimer) return;
  _dedupTimer = setTimeout(async () => {
    _dedupTimer = null;
    const agora   = Date.now();
    const cache   = _carregarDedupCache();
    // Limpa expirados antes de salvar
    for (const [id, ts] of cache) {
      if (agora - ts >= DEDUP_TTL_MS) cache.delete(id);
    }
    await salvarChave(CHAVE_DEDUP, [...cache.entries()]);
  }, DEDUP_DEBOUNCE_MS);
}

function dedupVerificar(id) {
  const cache = _carregarDedupCache();
  return cache.has(id);
}

function dedupRegistrar(id) {
  const cache = _carregarDedupCache();
  cache.set(id, Date.now());
  _agendarSalvarDedup();
}

// ── API pública ───────────────────────────────────────────────────────────────

const persist = {
  // Precos
  carregarPrecos:    (padrao) => carregarChave(CHAVE_PRECOS, padrao),
  salvarPrecos:      (obj)    => salvarChave(CHAVE_PRECOS, obj),

  // Aliases
  carregarAliases:   (padrao) => carregarChave(CHAVE_ALIASES, padrao),
  salvarAliases:     (obj)    => salvarChave(CHAVE_ALIASES, obj),

  // Sinonimos extras
  carregarSinonimos: (padrao) => carregarChave(CHAVE_SINONIMOS, padrao),
  salvarSinonimos:   (obj)    => salvarChave(CHAVE_SINONIMOS, obj),

  // Dedup persistente
  dedupVerificar,
  dedupRegistrar,
};

module.exports = persist;
