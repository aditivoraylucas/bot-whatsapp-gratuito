// ─── SERVIDOR HTTP (health, webhook, pairing) ─────────────────────────────────
// ÂNCORAS:
//   [ANCHOR:INIT]         — injeção de estado do bot
//   [ANCHOR:RATE-LIMIT]   — variáveis de rate limit do /parear
//   [ANCHOR:SELF-PING]    — loop de keep-alive
//   [ANCHOR:DIAG-SHEETS]  — diagnóstico /test-sheets
//   [ANCHOR:ROTAS]        — servidor HTTP e todas as rotas
// ─────────────────────────────────────────────────────────────────────────────
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { PORT, GITHUB_WEBHOOK_SECRET, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = require('./config');

const VIEWS = path.join(__dirname, 'views');
function lerView(nome) {
  return fs.readFileSync(path.join(VIEWS, nome), 'utf8');
}

// ── [ANCHOR:INIT] Estado injetado pelo bot.js ─────────────────────────────────
let _getBotConectado    = () => false;
let _getSockGlobal      = () => null;
let _getPairingNumero   = () => '';
let _setPairingPendente = () => {};
let _setPairingNumero   = () => {};

function init({ getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero }) {
  _getBotConectado    = getBotConectado;
  _getSockGlobal      = getSockGlobal;
  _getPairingNumero   = getPairingNumero;
  _setPairingPendente = setPairingPendente;
  _setPairingNumero   = setPairingNumero;
}

// ── [ANCHOR:RATE-LIMIT] 1 tentativa de pairing por minuto ────────────────────
let _ultimoPairingTs = 0;
const PAIRING_COOLDOWN_MS = 60_000;

// ── [ANCHOR:SELF-PING] Keep-alive para Render Free ───────────────────────────
function iniciarSelfPing() {
  const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const INTERVALO  = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const r = await fetch(`${RENDER_URL}/ping`);
      console.log(`[self-ping] ${new Date().toISOString()} — status: ${r.status}`);
    } catch (e) {
      console.warn('[self-ping] Falhou:', e.message);
    }
  }, INTERVALO);
  console.log(`[self-ping] Iniciado — ping a cada 10min para ${RENDER_URL}/ping`);
}

// ── [ANCHOR:DIAG-SHEETS] Diagnóstico Google Sheets ───────────────────────────
async function testarPlanilha() {
  const resultado = {
    spreadsheet_id:  SPREADSHEET_ID || '❌ VAZIO',
    service_account: GOOGLE_SERVICE_ACCOUNT_EMAIL || '❌ VAZIO',
    private_key_ok:  GOOGLE_PRIVATE_KEY ? '✅ presente' : '❌ AUSENTE',
    token_step:      null,
    sheets_step:     null,
    erro_detalhado:  null,
  };
  try {
    const agora = Date.now();
    const iat = Math.floor(agora / 1000);
    const exp = iat + 3600;
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat, exp,
    })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const jwt = `${signingInput}.${sign.sign(key, 'base64url')}`;
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const txt = await resp.text();
    if (!resp.ok) { resultado.token_step = `❌ FALHOU (${resp.status}): ${txt}`; return resultado; }
    const data = JSON.parse(txt);
    resultado.token_step = `✅ Token obtido (expira em ${data.expires_in}s)`;
    const r2   = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=spreadsheetId,properties(title)`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    const txt2 = await r2.text();
    if (!r2.ok) {
      resultado.sheets_step    = `❌ FALHOU (${r2.status})`;
      resultado.erro_detalhado = txt2.length > 500 ? txt2.slice(0, 500) + '...' : txt2;
    } else {
      const d2 = JSON.parse(txt2);
      resultado.sheets_step = `✅ Planilha acessada: "${d2.properties?.title}" (ID: ${d2.spreadsheetId})`;
    }
  } catch (e) { resultado.erro_detalhado = e.message; }
  return resultado;
}

// ── [ANCHOR:ROTAS] Servidor HTTP ──────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {

    // GET /ping
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pong: true, ts: Date.now(), conectado: _getBotConectado() }));
    }

    // GET /health
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), conectado: _getBotConectado() }));
    }

    // GET /status
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ conectado: _getBotConectado() }));
    }

    // GET /test-sheets
    if (req.method === 'GET' && req.url === '/test-sheets') {
      const r = await testarPlanilha();
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnóstico Planilha</title>
        <style>body{font-family:monospace;background:#f8fafc;padding:32px;max-width:780px;margin:auto}h1{font-family:sans-serif;color:#1e293b}table{width:100%;border-collapse:collapse;margin-top:20px}td{padding:12px 16px;border:1px solid #e2e8f0;vertical-align:top;word-break:break-all}td:first-child{font-weight:bold;color:#475569;white-space:nowrap;width:220px;background:#f1f5f9}.ok{color:#166534}.err{color:#991b1b}.box{background:#1e293b;color:#86efac;padding:20px;border-radius:10px;margin-top:24px;white-space:pre-wrap;font-size:0.88em}</style>
      </head><body><h1>🔍 Diagnóstico Google Sheets</h1><table>
        <tr><td>SPREADSHEET_ID</td><td>${r.spreadsheet_id}</td></tr>
        <tr><td>SERVICE_ACCOUNT</td><td>${r.service_account}</td></tr>
        <tr><td>PRIVATE_KEY</td><td>${r.private_key_ok}</td></tr>
        <tr><td>Token OAuth</td><td class="${r.token_step?.startsWith('✅') ? 'ok' : 'err'}">${r.token_step || '⏳'}</td></tr>
        <tr><td>Acesso à planilha</td><td class="${r.sheets_step?.startsWith('✅') ? 'ok' : 'err'}">${r.sheets_step || '⏳'}</td></tr>
      </table>${r.erro_detalhado ? `<div class="box">${r.erro_detalhado}</div>` : ''}
      <p style="margin-top:24px;font-family:sans-serif;color:#64748b;font-size:0.85em">Atualize para testar novamente.</p>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // POST /webhook (GitHub)
    if (req.method === 'POST' && req.url === '/webhook') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        if (GITHUB_WEBHOOK_SECRET) {
          const sig      = req.headers['x-hub-signature-256'] || '';
          const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(body).digest('hex');
          if (sig !== expected) { res.writeHead(401); return res.end('Unauthorized'); }
        }
        if (req.headers['x-github-event'] === 'push') {
          console.log('🔄 Webhook GitHub — reiniciando...');
          res.writeHead(200); res.end('OK');
          setTimeout(() => process.exit(0), 1000);
        } else { res.writeHead(200); res.end('ignored'); }
      });
      return;
    }

    // POST /parear — com rate limit
    if (req.method === 'POST' && req.url === '/parear') {
      const agora = Date.now();
      if (agora - _ultimoPairingTs < PAIRING_COOLDOWN_MS) {
        const restante = Math.ceil((PAIRING_COOLDOWN_MS - (agora - _ultimoPairingTs)) / 1000);
        const html = lerView('rate-limit.html').replace('__SEGUNDOS__', restante);
        res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        const numero = (params.get('numero') || '').replace(/\D/g, '').trim();
        if (!numero || numero.length < 10) { res.writeHead(302, { Location: '/' }); return res.end(); }
        _ultimoPairingTs = Date.now();
        _setPairingNumero(numero);
        _setPairingPendente(true);
        try {
          const sock = _getSockGlobal();
          if (sock) {
            const code = await sock.requestPairingCode(numero);
            console.log(`Pairing code para ${numero}:`, code);
            res.writeHead(302, { Location: `/codigo?c=${encodeURIComponent(code)}&n=${encodeURIComponent(numero)}` });
            res.end();
          } else {
            res.writeHead(302, { Location: '/?erro=bot_nao_iniciado' }); res.end();
          }
        } catch (e) {
          console.error('Erro ao solicitar pairing code:', e.message);
          res.writeHead(302, { Location: '/?erro=falha_codigo' }); res.end();
        }
      });
      return;
    }

    // GET /codigo
    if (req.method === 'GET' && req.url?.startsWith('/codigo')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(lerView('codigo.html'));
    }

    // GET / — página principal
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(lerView(_getBotConectado() ? 'conectado.html' : 'pairing.html'));

  } catch (e) {
    console.error('[health] Erro interno:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Erro interno</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  setTimeout(iniciarSelfPing, 30_000);
});

module.exports = { init };
