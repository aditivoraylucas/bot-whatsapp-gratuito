// ─── SERVIDOR HTTP (health, webhook, pairing) ─────────────────────────────────
const http   = require('http');
const crypto = require('crypto');
const { PORT, GITHUB_WEBHOOK_SECRET, SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = require('./config');

// Referências de estado injetadas pelo bot.js
let _getBotConectado  = () => false;
let _getSockGlobal    = () => null;
let _getPairingNumero = () => '';
let _setPairingPendente = () => {};
let _setPairingNumero   = () => {};

function init({ getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero }) {
  _getBotConectado    = getBotConectado;
  _getSockGlobal      = getSockGlobal;
  _getPairingNumero   = getPairingNumero;
  _setPairingPendente = setPairingPendente;
  _setPairingNumero   = setPairingNumero;
}

// ── Diagnóstico Google Sheets ──────────────────────────────────────────────
async function testarPlanilha() {
  const resultado = {
    spreadsheet_id:    SPREADSHEET_ID || '❌ VAZIO',
    service_account:   GOOGLE_SERVICE_ACCOUNT_EMAIL || '❌ VAZIO',
    private_key_ok:    GOOGLE_PRIVATE_KEY ? '✅ presente' : '❌ AUSENTE',
    token_step:        null,
    sheets_step:       null,
    erro_detalhado:    null,
  };

  // Passo 1: obter token OAuth
  try {
    const agora = Date.now();
    const iat = Math.floor(agora / 1000);
    const exp = iat + 3600;
    const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss:   GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud:   'https://oauth2.googleapis.com/token',
      iat, exp,
    })).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const key = (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signingInput);
    const signature = sign.sign(key, 'base64url');
    const jwt = `${signingInput}.${signature}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
    const txt = await resp.text();
    if (!resp.ok) {
      resultado.token_step = `❌ FALHOU (${resp.status}): ${txt}`;
      return resultado;
    }
    const data = JSON.parse(txt);
    resultado.token_step = `✅ Token obtido (expira em ${data.expires_in}s)`;
    const token = data.access_token;

    // Passo 2: acessar a planilha
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?fields=spreadsheetId,properties(title)`;
    const r2 = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const txt2 = await r2.text();
    if (!r2.ok) {
      resultado.sheets_step = `❌ FALHOU (${r2.status})`;
      resultado.erro_detalhado = txt2.length > 500 ? txt2.substring(0, 500) + '...' : txt2;
    } else {
      const d2 = JSON.parse(txt2);
      resultado.sheets_step = `✅ Planilha acessada: "${d2.properties?.title}" (ID: ${d2.spreadsheetId})`;
    }
  } catch (e) {
    resultado.erro_detalhado = e.message;
  }
  return resultado;
}

// ── Páginas HTML de pareamento ────────────────────────────────────────────────
function paginaPairing(estado) {
  if (estado === 'conectado') {
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot Vendas</title>
    <style>body{font-family:sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px #0001;text-align:center;max-width:400px;width:90%}
    h1{color:#16a34a;font-size:2em;margin-bottom:8px} p{color:#555}</style></head>
    <body><div class="card"><h1>✅ Bot Conectado!</h1><p>O bot está ativo e monitorando o grupo.</p></div></body></html>`;
  }
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot Vendas — Pareamento</title>
  <style>
    body{font-family:sans-serif;background:linear-gradient(135deg,#dcfce7,#bbf7d0);display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#fff;border-radius:20px;padding:44px 36px;box-shadow:0 8px 32px #0002;text-align:center;max-width:420px;width:90%}
    h1{color:#15803d;font-size:1.8em;margin-bottom:6px} .sub{color:#666;margin-bottom:28px;font-size:0.95em}
    label{display:block;text-align:left;font-weight:600;color:#374151;margin-bottom:6px}
    input{width:100%;box-sizing:border-box;padding:14px 16px;font-size:1.1em;border:2px solid #d1fae5;border-radius:10px;outline:none;transition:border .2s}
    input:focus{border-color:#16a34a}
    button{margin-top:18px;width:100%;padding:14px;background:#16a34a;color:#fff;font-size:1.1em;font-weight:700;border:none;border-radius:10px;cursor:pointer;transition:background .2s}
    button:hover{background:#15803d}
    .hint{font-size:0.82em;color:#9ca3af;margin-top:10px}
    .logo{font-size:2.6em;margin-bottom:8px}
  </style></head>
  <body><div class="card">
    <div class="logo">🤖</div>
    <h1>Bot de Vendas</h1>
    <p class="sub">Digite o número do WhatsApp para conectar o bot</p>
    <form method="POST" action="/parear">
      <label for="tel">Número de telefone</label>
      <input type="tel" id="tel" name="numero" placeholder="5511999999999" required autofocus />
      <p class="hint">Inclua o código do país e DDD. Exemplo: 5511999999999</p>
      <button type="submit">📲 Receber código no WhatsApp</button>
    </form>
  </div></body></html>`;
}

// ── Servidor HTTP ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // GET /health
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), conectado: _getBotConectado() }));
      return;
    }

    // GET /status
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conectado: _getBotConectado() }));
      return;
    }

    // GET /test-sheets — diagnóstico completo da planilha
    if (req.method === 'GET' && req.url === '/test-sheets') {
      const r = await testarPlanilha();
      const cor = (v) => v && v.startsWith('✅') ? '#166534' : '#991b1b';
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Diagnóstico Planilha</title>
        <style>
          body{font-family:monospace;background:#f8fafc;padding:32px;max-width:780px;margin:auto}
          h1{font-family:sans-serif;color:#1e293b} table{width:100%;border-collapse:collapse;margin-top:20px}
          td{padding:12px 16px;border:1px solid #e2e8f0;vertical-align:top;word-break:break-all}
          td:first-child{font-weight:bold;color:#475569;white-space:nowrap;width:220px;background:#f1f5f9}
          .ok{color:#166534} .err{color:#991b1b}
          .box{background:#1e293b;color:#86efac;padding:20px;border-radius:10px;margin-top:24px;white-space:pre-wrap;font-size:0.88em}
        </style></head><body>
        <h1>🔍 Diagnóstico Google Sheets</h1>
        <table>
          <tr><td>SPREADSHEET_ID</td><td>${r.spreadsheet_id}</td></tr>
          <tr><td>SERVICE_ACCOUNT</td><td>${r.service_account}</td></tr>
          <tr><td>PRIVATE_KEY</td><td>${r.private_key_ok}</td></tr>
          <tr><td>Token OAuth</td><td class="${r.token_step?.startsWith('✅')?'ok':'err'}">${r.token_step || '⏳ não testado'}</td></tr>
          <tr><td>Acesso à planilha</td><td class="${r.sheets_step?.startsWith('✅')?'ok':'err'}">${r.sheets_step || '⏳ não testado'}</td></tr>
        </table>
        ${r.erro_detalhado ? `<div class="box">${r.erro_detalhado}</div>` : ''}
        <p style="margin-top:24px;font-family:sans-serif;color:#64748b;font-size:0.85em">
          Atualize a página a qualquer momento para testar novamente.
        </p>
      </body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
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
          if (sig !== expected) { res.writeHead(401); res.end('Unauthorized'); return; }
        }
        if (req.headers['x-github-event'] === 'push') {
          console.log('🔄 Webhook GitHub — reiniciando para atualizar...');
          res.writeHead(200); res.end('OK');
          setTimeout(() => process.exit(0), 1000);
        } else { res.writeHead(200); res.end('ignored'); }
      });
      return;
    }

    // POST /parear
    if (req.method === 'POST' && req.url === '/parear') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body   = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(body);
        const numero = (params.get('numero') || '').replace(/\D/g, '').trim();
        if (!numero || numero.length < 10) { res.writeHead(302, { Location: '/' }); res.end(); return; }
        _setPairingNumero(numero);
        _setPairingPendente(true);
        try {
          const sock = _getSockGlobal();
          if (sock) {
            const code = await sock.requestPairingCode(numero);
            console.log(`Pairing code para ${numero}:`, code);
            res.writeHead(302, { Location: `/codigo?c=${encodeURIComponent(code)}` });
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
      const urlObj = new URL(req.url, `http://localhost:${PORT}`);
      const code   = urlObj.searchParams.get('c') || '';
      const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Código de Pareamento</title>
      <style>body{font-family:sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .card{background:#fff;border-radius:20px;padding:44px 36px;box-shadow:0 8px 32px #0002;text-align:center;max-width:440px;width:90%}
      h1{color:#d97706;font-size:1.6em} .badge{background:#fef3c7;border:2px solid #f59e0b;border-radius:14px;padding:20px 28px;font-size:2.2em;letter-spacing:8px;font-weight:bold;color:#92400e;margin:24px 0;display:inline-block}
      ol{text-align:left;color:#374151;line-height:2;padding-left:20px} .sub{font-size:0.85em;color:#9ca3af;margin-top:16px}
      a{display:inline-block;margin-top:20px;color:#16a34a;text-decoration:none;font-weight:600}</style>
      <script>
        setInterval(async()=>{ const r=await fetch('/status'); const d=await r.json(); if(d.conectado) location.href='/'; }, 5000);
      </script></head>
      <body><div class="card">
        <h1>📲 Código de Pareamento</h1>
        <p>Número: <strong>${_getPairingNumero()}</strong></p>
        <p>Abra o WhatsApp → <strong>Configurações → Aparelhos conectados → Conectar com número de telefone</strong></p>
        <div class="badge">${code || '--------'}</div>
        <ol>
          <li>Abra o WhatsApp no celular</li>
          <li>Toque em <strong>⋮ Menu → Aparelhos conectados</strong></li>
          <li>Toque em <strong>Conectar aparelho</strong></li>
          <li>Escolha <strong>"Conectar com número de telefone"</strong></li>
          <li>Digite o código acima</li>
        </ol>
        <p class="sub">O código expira em ~60 segundos. Esta página detecta a conexão automaticamente.</p>
        <a href="/">← Tentar com outro número</a>
      </div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // GET / — página principal
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paginaPairing(_getBotConectado() ? 'conectado' : 'formulario'));

  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Erro interno</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
});

server.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));

module.exports = { init };
