// ─── VARIÁVEIS DE AMBIENTE E CONSTANTES GLOBAIS ───────────────────────────────
process.env.GOOGLE_SDK_NODE_LOGGING = 'none';

const GRUPO_NOME                   = process.env.GRUPO_NOME   || 'vendas';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY           = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PORT                         = process.env.PORT  || 3000;
const RENDER_API_KEY               = process.env.RENDER_API_KEY   || '';
const RENDER_SERVICE_ID            = process.env.RENDER_SERVICE_ID|| '';
const GROQ_API_KEY                 = process.env.GROQ_API_KEY     || '';
const GITHUB_WEBHOOK_SECRET        = process.env.GITHUB_WEBHOOK_SECRET || '';
const AUTH_DIR                     = 'auth_info';
const LIMITE_CREDITO_PADRAO        = parseFloat(process.env.LIMITE_CREDITO || '0');
const DIAS_LEMBRETE                = parseInt(process.env.DIAS_LEMBRETE || '7');
const HORA_LEMBRETE                = parseInt(process.env.HORA_LEMBRETE || '20');
const HORA_RESUMO                  = parseInt(process.env.HORA_RESUMO   || '21');

// ─── SPREADSHEET_ID: aceita URL completa ou só o ID ──────────────────────────
const _rawUrl = process.env.SPREADSHEET_URL || process.env.SPREADSHEET_ID || '';
const SPREADSHEET_ID =
  _rawUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] ||
  _rawUrl.trim();

// ─── DEBUG startup ────────────────────────────────────────────────────────────
console.log('[config] SPREADSHEET_RAW:', _rawUrl || '❌ INDEFINIDO');
console.log('[config] SPREADSHEET_ID extraído:', SPREADSHEET_ID || '❌ VAZIO');
console.log('[config] SERVICE_ACCOUNT:', GOOGLE_SERVICE_ACCOUNT_EMAIL || '❌ INDEFINIDO');
console.log('[config] PRIVATE_KEY ok:', GOOGLE_PRIVATE_KEY ? '✅' : '❌ INDEFINIDA');
console.log('[config] ENV_VARS_COUNT:', Object.keys(process.env).length);

module.exports = {
  GRUPO_NOME, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY,
  PORT, RENDER_API_KEY, RENDER_SERVICE_ID, GROQ_API_KEY, GITHUB_WEBHOOK_SECRET,
  AUTH_DIR, LIMITE_CREDITO_PADRAO, DIAS_LEMBRETE, HORA_LEMBRETE, HORA_RESUMO,
};
