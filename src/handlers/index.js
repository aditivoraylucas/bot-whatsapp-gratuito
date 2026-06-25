// ─── HANDLERS — barrel de re-export ───────────────────────────────────────────
// Permite importar de './handlers' (pasta) de forma intercambiável
// com './handlers.js' (fachada). bot.js usa: require('./handlers')
// ─────────────────────────────────────────────────────────────────────────────
module.exports = require('../handlers');
