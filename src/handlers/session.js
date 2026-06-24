// ─── MÓDULO DE ESTADO DE SESSÃO ──────────────────────────────────────────────
// Responsabilidade: estado em memória por JID (confirmação de zerar).
// Isolado para facilitar futura migração para Redis ou outro store.
// ─────────────────────────────────────────────────────────────────────────────

// Confirmação pendente de "zerar cliente" por JID
const ZERAR_PENDENTE = {};
const ZERAR_TTL_MS   = 60_000;

// Ordens válidas para o comando "relatorio"
const ORDENS_RELATORIO = new Set(['nome', 'data', 'valor']);

module.exports = { ZERAR_PENDENTE, ZERAR_TTL_MS, ORDENS_RELATORIO };
