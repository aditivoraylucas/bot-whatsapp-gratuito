// ─── PERSISTÊNCIA VIA RENDER API ──────────────────────────────────────────────────
// Salva e carrega PRECOS, ALIASES e SINONIMOS_EXTRA como env-vars no Render.
// Isso garante que dados cadastrados via comando (novo, preco, alias) sobrevivam
// a deploys e reinicializacões do servidor.
//
// Chaves usadas na Render API:
//   BOT_PRECOS       → JSON com { trufa: 5, bolo: 12, brigadeiro: 3.5, ... }
//   BOT_ALIASES      → JSON com { ray: "Raylucas", ju: "Julia Souza", ... }
//   BOT_SINONIMOS    → JSON com { brigadeiro: ["brigadeiro","brigue"], ... }
// ─────────────────────────────────────────────────────────────────────────────
const { RENDER_API_KEY, RENDER_SERVICE_ID } = require('./config');

// Chaves que este módulo gerencia na Render API
const CHAVE_PRECOS    = 'BOT_PRECOS';
const CHAVE_ALIASES   = 'BOT_ALIASES';
const CHAVE_SINONIMOS = 'BOT_SINONIMOS';

// ── Helpers HTTP (mesmo padrão de bot.js) ────────────────────────────────────

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
    // Evita chamada à API se o valor já está atualizado na memória de processo
    if (process.env[chave] === novoValor) return;
    const existente = await buscarEnvVars();
    const novas = [
      ...existente.filter(v => v.key !== chave),
      { key: chave, value: novoValor },
    ];
    await putEnvVars(novas);
    process.env[chave] = novoValor; // cacheia para evitar chamadas repetidas
    console.log(`[persist] ${chave} salvo na Render API.`);
  } catch (err) {
    console.error(`[persist] Erro ao salvar ${chave}:`, err.message);
  }
}

// ── Carregar uma chave (env-var já injetada pelo Render ou via process.env) ──

function carregarChave(chave, padrao) {
  try {
    const raw = process.env[chave];
    if (!raw) return padrao;
    return JSON.parse(raw);
  } catch {
    return padrao;
  }
}

// ── API pública ───────────────────────────────────────────────────────────────────────

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
};

module.exports = persist;
