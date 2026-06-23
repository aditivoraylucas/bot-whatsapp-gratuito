// ─── ENTRADA PRINCIPAL ──────────────────────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('Erro nao tratado:',   err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

// Inicia o servidor HTTP (health + pairing)
const health = require('./src/health');
const bot    = require('./src/bot');

// Injeta os getters/setters de estado do bot no servidor HTTP
health.init({
  getBotConectado:    bot.getBotConectado,
  getSockGlobal:      bot.getSockGlobal,
  getPairingNumero:   bot.getPairingNumero,
  setPairingPendente: bot.setPairingPendente,
  setPairingNumero:   bot.setPairingNumero,
});

// Inicia o bot
bot.iniciarBot();
