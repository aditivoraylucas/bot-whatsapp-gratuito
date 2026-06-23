// ─── ENTRADA PRINCIPAL ──────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

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

// Limpa auth_info se estiver corrompido (causa de 'Unexpected end of input')
function limparAuthSeCorreto() {
  const AUTH_DIR  = 'auth_info';
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) return;
  try {
    const conteudo = fs.readFileSync(credsPath, 'utf8').trim();
    if (!conteudo) throw new Error('vazio');
    JSON.parse(conteudo);
  } catch (e) {
    console.warn(`[startup] auth_info/creds.json corrompido (${e.message}) — removendo pasta...`);
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log('[startup] auth_info removido com sucesso.'); }
    catch (e2) { console.error('[startup] Erro ao remover auth_info:', e2.message); }
  }
}

limparAuthSeCorreto();

// Inicia o bot com tratamento de erro
bot.iniciarBot().catch(err => {
  console.error('[startup] Falha critica ao iniciar bot:', err.message);
  // Tenta limpar e reiniciar uma vez
  try {
    const AUTH_DIR = 'auth_info';
    if (fs.existsSync(AUTH_DIR)) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log('[startup] auth_info limpo após falha.'); }
  } catch (_) {}
  setTimeout(() => bot.iniciarBot().catch(e => console.error('[startup] Segunda tentativa falhou:', e.message)), 3000);
});
