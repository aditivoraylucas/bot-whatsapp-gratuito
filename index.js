process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

// ─── FIX: força fetch nativo do Node.js (undici) para googleapis ──────────────
// Resolve "Premature close" ao renovar token OAuth no Render/Railway
if (typeof globalThis.fetch === 'undefined') {
  const { default: nodeFetch } = await import('node-fetch').catch(() => ({ default: undefined }));
  if (nodeFetch) globalThis.fetch = nodeFetch;
}
// Garante que o google-auth-library use o fetch nativo (Node 18+)
process.env.GOOGLE_SDK_NODE_LOGGING = 'none';

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const http = require('http');
const pino = require('pino');
const FormData = require('form-data');
const crypto = require('crypto');

const GRUPO_NOME   = process.env.GRUPO_NOME   || 'vendas';
const SPREADSHEET_ID               = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY           = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PORT             = process.env.PORT  || 3000;
const RENDER_API_KEY   = process.env.RENDER_API_KEY   || '';
const RENDER_SERVICE_ID= process.env.RENDER_SERVICE_ID|| '';
const GROQ_API_KEY     = process.env.GROQ_API_KEY     || '';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

const AUTH_DIR = 'auth_info';

// ─── RETRY COM BACKOFF para chamadas Google Sheets ───────────────────────────
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

// ─── TRANSCRIÇÃO DE ÁUDIO VIA GROQ WHISPER ───────────────────────────────────
async function transcreverAudio(audioBuffer, mimeType) {
  if (!GROQ_API_KEY) return null;
  try {
    const fetch = (await import('node-fetch')).default;
    const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('mp4') ? 'mp4' : 'ogg';
    const form = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType || 'audio/ogg' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const promptWhisper = [
      'Comandos de venda: nomes de clientes seguidos de quantidade e produto.',
      'Produtos: trufa, trufas, bolo, bolos, bombom, bombons.',
      'Exemplos: "julia 1 bolo", "ana 3 trufas", "carlos 2 bolos", "maria pagou 10",',
      '"pedro pix 15", "joao pagou 2 trufas", "relatorio", "resumo", "cancelar julia".',
      'Os nomes são nomes próprios brasileiros. Os números são quantidades pequenas (1 a 20).',
    ].join(' ');
    form.append('prompt', promptWhisper);
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, ...form.getHeaders() },
      body: form
    });
    if (!res.ok) { const err = await res.text(); console.error('Groq erro:', err); return null; }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) { console.error('Erro transcrição Groq:', e.message); return null; }
}

// ─── PRECOS E PRODUTOS ────────────────────────────────────────────────────────
const PRECOS_FILE = 'precos.json';
let PRECOS = { trufa: 5.0, bolo: 12.0 };
try { if (fs.existsSync(PRECOS_FILE)) PRECOS = JSON.parse(fs.readFileSync(PRECOS_FILE, 'utf8')); } catch(e) {}
function salvarPrecos() { try { fs.writeFileSync(PRECOS_FILE, JSON.stringify(PRECOS), 'utf8'); } catch(e) {} }

const LIMITE_CREDITO_PADRAO = parseFloat(process.env.LIMITE_CREDITO || '0');

const SINONIMOS = {
  trufa: ['trufa','trufas','trufinha','trufinhas','bombom','bombons'],
  bolo:  ['bolo','bolos','bolinho','bolinhos','bolo de pote','bolo pote']
};
const SINONIMOS_EXTRA = {};
try { if (fs.existsSync('sinonimos.json')) Object.assign(SINONIMOS_EXTRA, JSON.parse(fs.readFileSync('sinonimos.json','utf8'))); } catch(e) {}
function salvarSinonimosExtra() { try { fs.writeFileSync('sinonimos.json', JSON.stringify(SINONIMOS_EXTRA),'utf8'); } catch(e) {} }

const NUMEROS_EXTENSO = {
  'um':1,'uma':1,'dois':2,'duas':2,'tres':3,'quatro':4,'cinco':5,
  'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,'onze':11,'doze':12,
  'treze':13,'quatorze':14,'catorze':14,'quinze':15,'dezesseis':16,
  'dezessete':17,'dezoito':18,'dezenove':19,'vinte':20
};

const MESES_VALIDOS = new Set([
  'janeiro','fevereiro','marco','abril','maio','junho',
  'julho','agosto','setembro','outubro','novembro','dezembro',
  '01','02','03','04','05','06','07','08','09','10','11','12',
  '1','2','3','4','5','6','7','8','9'
]);
function isMes(str) {
  const n = norm(str);
  return MESES_VALIDOS.has(n) || /^\d{1,2}$/.test(n);
}

const ULTIMOS_LANCAMENTOS = {};
const MAX_HIST_CANCEL = 10;
function pushLancamento(jid, obj) {
  if (!ULTIMOS_LANCAMENTOS[jid]) ULTIMOS_LANCAMENTOS[jid] = [];
  ULTIMOS_LANCAMENTOS[jid].push(obj);
  if (ULTIMOS_LANCAMENTOS[jid].length > MAX_HIST_CANCEL) ULTIMOS_LANCAMENTOS[jid].shift();
}

function norm(t) {
  return (t||'')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .trim();
}

function limparTranscricao(texto) {
  if (!texto) return texto;
  return texto
    .replace(/([a-záàâãéèêíìîóòôõúùûçA-Z])([.!?;:]+)(\s|$)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

const CORRECOES_VOZ = {
  'saudo':'saldo','saud':'saldo','salvo':'saldo','salda':'saldo','saldos':'saldo',
  'relatorios':'relatorio','relato':'relatorio',
  'rezumo':'resumo','resuno':'resumo',
  'istorico':'historico',
  'cancelado':'cancelar','cancela':'cancelar','cancelas':'cancelar',
  'zera':'zerar','ajudas':'ajuda','produto':'produtos',
  'pagol':'pagou','pago':'pagou',
  'pics':'pix','pik':'pix',
  'transferio':'transferiu','transferiou':'transferiu',
  'bombon':'bombom',
};
function corrigirPalavra(palavra) {
  const n = norm(palavra);
  return CORRECOES_VOZ[n] || palavra;
}
function corrigirTranscricao(texto) {
  if (!texto) return texto;
  return texto.split(/\s+/).map(p => corrigirPalavra(p)).join(' ');
}

function levenshtein(a, b) {
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>[i]);
  for(let j=1;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++)
    for(let j=1;j<=n;j++)
      dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
function nomesFuzzyIguais(digitado, cadastrado) {
  const na=norm(digitado).split(/\s+/).filter(Boolean);
  const nb=norm(cadastrado).split(/\s+/).filter(Boolean);
  if(na.length!==nb.length) return false;
  for(let i=0;i<na.length;i++){
    const maxLen=Math.max(na[i].length,nb[i].length);
    if(levenshtein(na[i],nb[i])>(maxLen<=5?1:2)) return false;
  }
  return true;
}
function resolverNome(digitado, nomesConhecidos) {
  if(!digitado||!nomesConhecidos||!nomesConhecidos.length) return null;
  const nd=norm(digitado);
  for(const c of nomesConhecidos) if(norm(c)===nd) return c;
  for(const c of nomesConhecidos) if(nomesFuzzyIguais(digitado,c)) return c;
  return null;
}
function mesmoNome(a,b) { return norm(a)===norm(b)||nomesFuzzyIguais(a,b); }

function toNumero(p) {
  const n=norm(p);
  if(/^\d+$/.test(n)) return parseInt(n);
  return NUMEROS_EXTENSO[n]??null;
}
function todosOsSinonimos() {
  const mapa = { ...SINONIMOS };
  for(const [k,v] of Object.entries(SINONIMOS_EXTRA)) mapa[k] = (mapa[k]||[]).concat(v);
  return mapa;
}
function toProduto(trecho) {
  const n=norm(trecho);
  if(!n) return null;
  for(const [produto,sins] of Object.entries(todosOsSinonimos()))
    for(const sin of sins)
      if(n===norm(sin)) return produto;
  return null;
}

function extrairValor(texto) {
  if(!texto) return null;
  const t = norm(texto)
    .replace(/r\$\s*/g,' ').replace(/\breais\b/g,' ').replace(/\bpix\b/g,' ')
    .replace(/\bde\b/g,' ').replace(/\btransferiu\b/g,' ').replace(/\bdepositou\b/g,' ')
    .replace(/\bmandou\b/g,' ').replace(/\benviou\b/g,' ').replace(/\bpagou\b/g,' ').trim();
  const m = t.match(/(\d+[,.]?\d*)/);
  if(!m) return null;
  const val = parseFloat(m[1].replace(',','.'));
  return isNaN(val) ? null : val;
}

function agora() { return new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}); }
function agoraData() { return new Date().toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}); }
function soData(str) { if(!str) return ''; return (str.trim().split(' ')[0]) || str.trim(); }

function horaAtualSP() {
  const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
  return parseInt(formatter.format(new Date()));
}

function capitalizarNome(n) {
  if(!n) return '';
  return n.trim().split(' ').map(p=>p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()).join(' ');
}
function emojiProduto(produto) {
  if(produto==='bolo') return '\ud83c\udf82';
  if(produto==='trufa') return '\ud83c\udf6b';
  return '\ud83e\udee4';
}
function nomeProdutoExib(produto) {
  if(produto==='bolo') return 'Bolo';
  if(produto==='trufa') return 'Trufa';
  return capitalizarNome(produto.replace(/_/g,' '));
}

let botConectado = false;
let sockGlobal   = null;
let jidGrupoGlobal = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete = '';
let ultimoDiaResumo   = '';
// Pairing Code: estado
let pairingPendente = false;
let pairingNumero   = '';

function restaurarSessao() {
  try {
    const credsJson=process.env.CREDS_JSON;
    if(!credsJson) { console.log('[restaurarSessao] CREDS_JSON não definido – será necessário novo pairing.'); return false; }
    if(!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR,{recursive:true});
    fs.writeFileSync(path.join(AUTH_DIR,'creds.json'),credsJson,'utf8');
    console.log('Sessao restaurada do CREDS_JSON');
    return true;
  } catch(e){console.error('Erro ao restaurar sessao:',e.message);return false;}
}

async function salvarSessaoNoRender() {
  try {
    if(!RENDER_API_KEY||!RENDER_SERVICE_ID) return;
    const credsPath=path.join(AUTH_DIR,'creds.json');
    if(!fs.existsSync(credsPath)) return;
    const conteudo=fs.readFileSync(credsPath,'utf8');
    const fetch=(await import('node-fetch')).default;
    const resGet=await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,{
      headers:{'Authorization':`Bearer ${RENDER_API_KEY}`,'Content-Type':'application/json'}
    });
    const envVars=await resGet.json();
    const existente=Array.isArray(envVars)?envVars:(envVars.envVars||[]);
    const novas=[...existente.filter(v=>v.key!=='CREDS_JSON').map(v=>({key:v.key,value:v.value})),{key:'CREDS_JSON',value:conteudo}];
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,{
      method:'PUT',
      headers:{'Authorization':`Bearer ${RENDER_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify(novas)
    });
    console.log('Sessao salva no Render!');
  } catch(e){console.error('Erro ao salvar sessao:',e.message);}
}

// ─── HTML DA PÁGINA DE PAREAMENTO (Pairing Code) ──────────────────────────────
function paginaPairing(estado) {
  if (estado === 'conectado') {
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot Vendas</title>
    <style>body{font-family:sans-serif;background:#f0fdf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px #0001;text-align:center;max-width:400px;width:90%}
    h1{color:#16a34a;font-size:2em;margin-bottom:8px} p{color:#555}</style></head>
    <body><div class="card"><h1>✅ Bot Conectado!</h1><p>O bot está ativo e monitorando o grupo.</p></div></body></html>`;
  }

  if (estado === 'aguardando_codigo') {
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bot Vendas</title>
    <style>body{font-family:sans-serif;background:#fffbeb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px #0001;text-align:center;max-width:420px;width:90%}
    h1{color:#d97706;font-size:1.6em} .badge{background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;padding:18px 24px;font-size:1.8em;letter-spacing:6px;font-weight:bold;color:#92400e;margin:20px 0;display:inline-block}
    p{color:#555;line-height:1.6} .sub{font-size:0.85em;color:#888;margin-top:16px}</style>
    <script>setTimeout(()=>location.reload(),10000)</script></head>
    <body><div class="card">
      <h1>📲 Código Enviado!</h1>
      <p>Abra o WhatsApp do número <strong>${pairingNumero}</strong></p>
      <p>Vá em <strong>Configurações → Aparelhos conectados → Conectar com número de telefone</strong></p>
      <p>Digite o código que aparece abaixo:</p>
      <div class="badge" id="code">Aguardando...</div>
      <p class="sub">Esta página atualiza automaticamente.</p>
    </div></body></html>`;
  }

  // Estado padrão: formulário para digitar número
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

// ─── SERVIDOR HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    // ── Endpoint de health check (para UptimeRobot / keep-alive) ──
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), conectado: botConectado }));
      return;
    }

    // Webhook GitHub
    if (req.method === 'POST' && req.url === '/webhook') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        if (GITHUB_WEBHOOK_SECRET) {
          const sig = req.headers['x-hub-signature-256'] || '';
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

    // Formulário de pareamento: recebe o número e solicita o Pairing Code
    if (req.method === 'POST' && req.url === '/parear') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(body);
        const numero = (params.get('numero') || '').replace(/\D/g, '').trim();
        if (!numero || numero.length < 10) {
          res.writeHead(302, { Location: '/' }); res.end(); return;
        }
        pairingNumero = numero;
        pairingPendente = true;
        try {
          if (sockGlobal) {
            const code = await sockGlobal.requestPairingCode(numero);
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

    // Página que exibe o código
    if (req.method === 'GET' && req.url?.startsWith('/codigo')) {
      const urlObj = new URL(req.url, `http://localhost:${PORT}`);
      const code = urlObj.searchParams.get('c') || '';
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
        <p>Número: <strong>${pairingNumero}</strong></p>
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

    // Endpoint JSON de status
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conectado: botConectado }));
      return;
    }

    // Página principal
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(paginaPairing(botConectado ? 'conectado' : 'formulario'));

  } catch(e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body><h1>Erro interno</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
});

server.listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));

function getAuth() {
  return new JWT({email:GOOGLE_SERVICE_ACCOUNT_EMAIL,key:GOOGLE_PRIVATE_KEY,scopes:['https://www.googleapis.com/auth/spreadsheets']});
}
async function getDoc() {
  return comRetry(async () => {
    const doc=new GoogleSpreadsheet(SPREADSHEET_ID,getAuth());
    await doc.loadInfo();
    return doc;
  }, 4, 'getDoc');
}
async function getSheetSaldo() { return (await getDoc()).sheetsByIndex[0]; }
async function getSheetHistorico() {
  const doc=await getDoc();
  if(doc.sheetCount<2) return await doc.addSheet({title:'Historico',headerValues:['Data','Cliente','Tipo','Produto','Quantidade','Valor']});
  const sheet=doc.sheetsByIndex[1];
  try{await sheet.loadHeaderRow();}catch(e){await sheet.setHeaderRow(['Data','Cliente','Tipo','Produto','Quantidade','Valor']);}
  return sheet;
}

async function registrarOuAcumular(clienteEnviado, produto, quantidade) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const precoAtual = PRECOS[produto] || 0;
    const valorNovo  = precoAtual * quantidade;
    const existente  = rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
    const cliente    = existente ? existente.get('Cliente') : capitalizarNome(clienteEnviado);
    if(LIMITE_CREDITO_PADRAO>0){
      const rowsC=rows.filter(r=>mesmoNome(r.get('Cliente'),clienteEnviado));
      const totalAtual=rowsC.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
      if(totalAtual+valorNovo>LIMITE_CREDITO_PADRAO) return { cliente, limiteBloqueado: true, totalAtual, valorNovo };
    }
    if(existente){
      const qtdAcumulada   = parseInt(existente.get('Quantidade')||'0')+quantidade;
      const totalAcumulado = parseFloat(existente.get('Total')||'0')+valorNovo;
      existente.set('Quantidade',qtdAcumulada); existente.set('Total',totalAcumulado.toFixed(2)); existente.set('UltimaCompra',agora());
      await existente.save();
      await comRetry(() => getSheetHistorico().then(sh => sh.addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)})), 4, 'addRow Historico Compra');
      return {cliente,totalAcumulado,qtdAcumulada};
    } else {
      await comRetry(() => sheet.addRow({Cliente:cliente,Produto:produto,Quantidade:quantidade,Total:valorNovo.toFixed(2),UltimaCompra:agora()}), 4, 'addRow Saldo');
      await comRetry(() => getSheetHistorico().then(sh => sh.addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)})), 4, 'addRow Historico Compra');
      return {cliente,totalAcumulado:valorNovo,qtdAcumulada:quantidade};
    }
  } catch(err){console.error('Erro planilha:',err.message);return null;}
}

async function cancelarLancamento(jid, nomeDigitado) {
  try {
    const hist = ULTIMOS_LANCAMENTOS[jid] || [];
    let idx = -1;
    for(let i=hist.length-1;i>=0;i--){
      if(mesmoNome(hist[i].cliente, nomeDigitado)){ idx=i; break; }
    }
    if(idx<0) return `❌ Nenhum lançamento recente encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const lanc = hist[idx];
    hist.splice(idx,1);
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const sheetH=await getSheetHistorico();
    const rowsH=await sheetH.getRows();
    if(lanc.tipo==='compra'){
      const row=rows.find(r=>r.get('Cliente')===lanc.cliente&&norm(r.get('Produto'))===norm(lanc.produto));
      if(row){
        const novaQtd  = parseInt(row.get('Quantidade')||'0')-lanc.quantidade;
        const novoTotal= parseFloat(row.get('Total')||'0')-lanc.valor;
        if(novaQtd<=0||novoTotal<=0){ await row.delete(); }
        else { row.set('Quantidade',novaQtd); row.set('Total',novoTotal.toFixed(2)); await row.save(); }
      }
      for(let i=rowsH.length-1;i>=0;i--){
        if(rowsH[i].get('Cliente')===lanc.cliente&&norm(rowsH[i].get('Produto'))===norm(lanc.produto)&&rowsH[i].get('Tipo')==='Compra'){
          await rowsH[i].delete(); break;
        }
      }
      return `↗️ Lançamento cancelado: *${lanc.cliente}* - ${lanc.quantidade}x ${nomeProdutoExib(lanc.produto)} (R$ ${lanc.valor.toFixed(2)})`;
    }
    if(lanc.tipo==='pagamento'){
      const rowsC=rows.filter(r=>mesmoNome(r.get('Cliente'),lanc.cliente));
      if(rowsC.length){
        let restante=lanc.valor;
        for(const r of rowsC){
          if(restante<=0) break;
          const novoTotal=parseFloat(r.get('Total')||'0')+restante;
          r.set('Total',novoTotal.toFixed(2));
          if(lanc.produto&&lanc.produto!=='geral'&&norm(r.get('Produto'))===norm(lanc.produto)&&typeof lanc.quantidade==='number'){
            r.set('Quantidade',parseInt(r.get('Quantidade')||'0')+lanc.quantidade);
          }
          await r.save(); restante=0;
        }
      } else {
        const produto=lanc.produto&&lanc.produto!=='geral'?lanc.produto:'trufa';
        const qtd=typeof lanc.quantidade==='number'?lanc.quantidade:0;
        await sheet.addRow({Cliente:lanc.cliente,Produto:produto,Quantidade:qtd,Total:lanc.valor.toFixed(2),UltimaCompra:agora()});
      }
      for(let i=rowsH.length-1;i>=0;i--){
        if(rowsH[i].get('Cliente')===lanc.cliente&&rowsH[i].get('Tipo')==='Pagamento'){
          await rowsH[i].delete(); break;
        }
      }
      return `↗️ Pagamento cancelado: *${lanc.cliente}* - R$ ${lanc.valor.toFixed(2)} devolvido ao saldo.`;
    }
    return '❌ Não foi possível cancelar.';
  } catch(err){console.error('Erro cancelar:',err.message);return '❌ Erro ao cancelar lançamento.';}
}

async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const row=rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
    const cliente = row ? row.get('Cliente') : capitalizarNome(clienteEnviado);
    if(!row) return{ok:false,msg:`❌ Nenhuma dívida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.`};
    const qtdAtual  = parseInt(row.get('Quantidade')||'0');
    const qtdPaga   = Math.min(quantidade,qtdAtual);
    const novaQtd   = qtdAtual-qtdPaga;
    const totalAtual= parseFloat(row.get('Total')||'0');
    const pago = qtdAtual>0 ? (totalAtual/qtdAtual)*qtdPaga : 0;
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente:row.get('Cliente'),produto,quantidade:qtdPaga,valor:pago});
    await comRetry(() => getSheetHistorico().then(sh => sh.addRow({Data:agora(),Cliente:row.get('Cliente'),Tipo:'Pagamento',Produto:produto,Quantidade:qtdPaga,Valor:pago.toFixed(2)})), 4, 'addRow Pagamento Produto');
    if(novaQtd===0){ await row.delete(); return{ok:true,msg:`✅ *${row.get('Cliente')}* quitou toda a dívida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.`}; }
    const novoTotal=totalAtual-pago;
    row.set('Quantidade',novaQtd); row.set('Total',novoTotal.toFixed(2)); await row.save();
    return{ok:true,msg:`✅ *${row.get('Cliente')}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}`};
  } catch(err){console.error('Erro pag produto:',err.message);return{ok:false,msg:'❌ Erro ao registrar pagamento.';};}
}

async function processarPagamentoValor(clienteEnviado, valorPago, jid) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(clienteEnviado, nomesConhecidos);
    const rowsCliente=nomeCanon
      ? rows.filter(r=>r.get('Cliente')===nomeCanon)
      : rows.filter(r=>mesmoNome(r.get('Cliente'),clienteEnviado));
    const cliente=rowsCliente.length?rowsCliente[0].get('Cliente'):capitalizarNome(clienteEnviado);
    if(!rowsCliente.length) return{ok:false,msg:`❌ Nenhuma dívida encontrada para *${capitalizarNome(clienteEnviado)}*.`};
    const totalDevido=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente,produto:'geral',quantidade:'-',valor:valorPago});
    await comRetry(() => getSheetHistorico().then(sh => sh.addRow({Data:agora(),Cliente:cliente,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:valorPago.toFixed(2)})), 4, 'addRow Pagamento Valor');
    if(valorPago>=totalDevido){
      for(const r of rowsCliente) await r.delete();
      return{ok:true,msg:`✅ *${cliente}* quitou toda a dívida! Pagou R$ ${valorPago.toFixed(2)}.`};
    }
    let restante=valorPago;
    for(const r of rowsCliente){
      if(restante<=0) break;
      const totalRow=parseFloat(r.get('Total')||'0');
      if(restante>=totalRow){ restante-=totalRow; await r.delete(); }
      else {
        const novoTotal=totalRow-restante;
        r.set('Total',novoTotal.toFixed(2));
        const qtdAtual=parseInt(r.get('Quantidade')||'0');
        r.set('Quantidade',Math.max(totalRow>0?Math.round(qtdAtual*(novoTotal/totalRow)):0,0));
        await r.save(); restante=0;
      }
    }
    return{ok:true,msg:`✅ *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido-valorPago).toFixed(2)}`};
  } catch(err){console.error('Erro pag valor:',err.message);return{ok:false,msg:'❌ Erro ao registrar pagamento.';};}
}

async function gerarRelatorioGeral() {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    if(!rows.length) return 'Nenhuma dívida em aberto no momento.';
    const clientes={};
    for(const row of rows){
      const nome=(row.get('Cliente')||'').trim();
      const produto=norm(row.get('Produto')||'');
      const quantidade=parseInt(row.get('Quantidade')||'0');
      const total=parseFloat(row.get('Total')||'0');
      if(!nome||!produto) continue;
      if(!clientes[nome]) clientes[nome]={itens:[],totalDevido:0};
      clientes[nome].itens.push({produto,quantidade,total});
      clientes[nome].totalDevido+=total;
    }
    if(!Object.keys(clientes).length) return 'Nenhuma dívida em aberto no momento.';
    const ordenados=Object.entries(clientes).sort((a,b)=>b[1].totalDevido-a[1].totalDevido);
    let resposta='*Relatório de Dívidas*\n───────────────\n'; let totalGeral=0;
    for(const [nome,dados] of ordenados){
      resposta+=`\n*${nome}*\n`;
      for(const item of dados.itens) resposta+=`  ${nomeProdutoExib(item.produto)}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;
      resposta+=`  *Total: R$ ${dados.totalDevido.toFixed(2)}*\n`;
      totalGeral+=dados.totalDevido;
    }
    resposta+=`\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro relatorio:',err.message);return '❌ Erro ao gerar relatório.';}
}

async function carregarHistoricoAgrupado(filtroMes) {
  const doc=await getDoc();
  const rowsSaldo=await doc.sheetsByIndex[0].getRows();
  const saldos={};
  for(const row of rowsSaldo){
    const nome=(row.get('Cliente')||'').trim();
    const total=parseFloat(row.get('Total')||'0');
    if(!nome) continue;
    if(!saldos[nome]) saldos[nome]=0;
    saldos[nome]+=total;
  }
  if(doc.sheetCount<2) return{historico:{},saldos};
  const sheetHist=doc.sheetsByIndex[1];
  try{await sheetHist.loadHeaderRow();}catch(e){return{historico:{},saldos};}
  const rowsHist=await sheetHist.getRows();
  const nomesCanonicos=[...Object.keys(saldos)];
  const historico={};
  for(const row of rowsHist){
    const nomeRaw=(row.get('Cliente')||'').trim();
    if(!nomeRaw) continue;
    if(filtroMes){
      const data=(row.get('Data')||'').trim();
      if(!data) continue;
      const partes=data.split(' ')[0].split('/');
      if(partes.length>=2){
        const mesNum=parseInt(partes[1]);
        const nomesArr=['','janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        const filtroNorm=norm(filtroMes);
        const filtroNumero=parseInt(filtroNorm);
        const bateu=isNaN(filtroNumero)?norm(nomesArr[mesNum])===filtroNorm:mesNum===filtroNumero;
        if(!bateu) continue;
      }
    }
    let nomeCanon=resolverNome(nomeRaw,nomesCanonicos);
    if(!nomeCanon){nomesCanonicos.push(nomeRaw);nomeCanon=nomeRaw;}
    if(!historico[nomeCanon]) historico[nomeCanon]=[];
    historico[nomeCanon].push({
      data:(row.get('Data')||'').trim(), tipo:(row.get('Tipo')||'').trim(),
      produto:norm(row.get('Produto')||''), qtd:(row.get('Quantidade')||'').trim(),
      valor:parseFloat(row.get('Valor')||'0')
    });
  }
  return{historico,saldos};
}

async function gerarRelatorioDetalhado() {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
    const devedores=Object.keys(historico).filter(n=>(saldos[n]||0)>0);
    if(!devedores.length) return '✅ Nenhuma dívida em aberto! Todos quitados.';
    devedores.sort((a,b)=>(saldos[b]||0)-(saldos[a]||0));
    let resposta='*Relatório Detalhado*\n───────────────\n'; let totalGeral=0;
    for(const nome of devedores){
      const movs=historico[nome]; const saldoAtual=saldos[nome]||0;
      resposta+=`\n*${nome}*\n`;
      for(const m of movs){
        if(m.tipo==='Compra') resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if(m.tipo==='Pagamento') resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta+=`  *Saldo devedor: R$ ${saldoAtual.toFixed(2)}*\n`; totalGeral+=saldoAtual;
    }
    resposta+=`\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro relatorio detalhado:',err.message);return '❌ Erro ao gerar relatório detalhado.';}
}

async function gerarRelatorioQuitados() {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length) return 'Nenhuma movimentação registrada ainda.';
    const quitados=Object.keys(historico).filter(n=>!(saldos[n]>0));
    if(!quitados.length) return 'Nenhum cliente quitado ainda.';
    quitados.sort();
    let resposta='*Compras Quitadas*\n───────────────\n';
    for(const nome of quitados){
      const movs=historico[nome];
      const totalPago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);
      resposta+=`\n*${nome}*\n`;
      for(const m of movs){
        if(m.tipo==='Compra') resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if(m.tipo==='Pagamento') resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta+=`  ✅ Quitado | Total pago: R$ ${totalPago.toFixed(2)}\n`;
    }
    resposta+=`\n───────────────\n✅ *${quitados.length} cliente(s) com conta quitada*`;
    return resposta;
  } catch(err){console.error('Erro relatorio quitados:',err.message);return '❌ Erro ao gerar relatório de quitados.';}
}

async function gerarSaldoIndividual(nomeDigitado) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon){
      const{historico,saldos}=await carregarHistoricoAgrupado();
      const nomeHist=resolverNome(nomeDigitado,Object.keys(historico));
      if(nomeHist&&!(saldos[nomeHist]>0)) return `✅ *${nomeHist}* não tem dívidas em aberto. Conta quitada!`;
      return `❌ Nenhuma movimentação encontrada para *${capitalizarNome(nomeDigitado)}*.`;
    }
    const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
    if(!rowsCliente.length) return `✅ *${nomeCanon}* não tem dívidas em aberto.`;
    let totalDevido=0;
    let resposta=`*${nomeCanon}*\n───────────────\n`;
    for(const row of rowsCliente){
      const produto=norm(row.get('Produto')||'');
      const qtd=parseInt(row.get('Quantidade')||'0');
      const total=parseFloat(row.get('Total')||'0');
      resposta+=`${nomeProdutoExib(produto)}: ${qtd} unid. = R$ ${total.toFixed(2)}\n`;
      totalDevido+=total;
    }
    resposta+=`───────────────\n*Total devido: R$ ${totalDevido.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro saldo:',err.message);return '❌ Erro ao consultar saldo.';}
}

async function gerarHistoricoCliente(nomeDigitado) {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    const nomesConhecidos=Object.keys(historico);
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon||!historico[nomeCanon]) return `❌ Nenhum histórico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const movs=historico[nomeCanon]; const saldoAtual=saldos[nomeCanon]||0;
    let resposta=`*Histórico de ${nomeCanon}*\n───────────────\n`;
    let totalComprado=0, totalPago=0;
    for(const m of movs){
      if(m.tipo==='Compra'){ resposta+=`Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalComprado+=m.valor; }
      else if(m.tipo==='Pagamento'){ resposta+=`Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`; totalPago+=m.valor; }
    }
    resposta+=`───────────────\nTotal comprado: R$ ${totalComprado.toFixed(2)}\nTotal pago: R$ ${totalPago.toFixed(2)}\n`;
    resposta+=saldoAtual>0?`*Saldo devedor: R$ ${saldoAtual.toFixed(2)}*`:'✅ *Conta quitada!*';
    return resposta;
  } catch(err){console.error('Erro historico:',err.message);return '❌ Erro ao buscar histórico.';}
}

async function gerarRelatorioMes(mes) {
  try {
    const{historico}=await carregarHistoricoAgrupado(mes);
    const nomesMes=['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesNum=parseInt(norm(mes));
    const nomeMesExib=isNaN(mesNum)?capitalizarNome(mes):(nomesMes[mesNum]||capitalizarNome(mes));
    const todosNomes=Object.keys(historico);
    if(!todosNomes.length) return `Nenhuma movimentação registrada em ${nomeMesExib}.`;
    let totalVendas=0, totalRecebido=0, qtdTrufa=0, qtdBolo=0; let detalhe='';
    for(const nome of todosNomes.sort()){
      const movs=historico[nome];
      const comprado=movs.filter(m=>m.tipo==='Compra').reduce((s,m)=>s+m.valor,0);
      const pago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);
      qtdTrufa+=movs.filter(m=>m.tipo==='Compra'&&m.produto==='trufa').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);
      qtdBolo +=movs.filter(m=>m.tipo==='Compra'&&m.produto==='bolo').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);
      totalVendas+=comprado; totalRecebido+=pago;
      detalhe+=`\n*${nome}*: comprou R$ ${comprado.toFixed(2)} | pagou R$ ${pago.toFixed(2)}\n`;
    }
    return `*Relatório de ${nomeMesExib}*\n───────────────\n${detalhe}\n───────────────\nTrufas: ${qtdTrufa} unid. | Bolos: ${qtdBolo} unid.\nTotal em vendas: R$ ${totalVendas.toFixed(2)}\nTotal recebido: R$ ${totalRecebido.toFixed(2)}\nA receber: R$ ${(totalVendas-totalRecebido).toFixed(2)}`;
  } catch(err){console.error('Erro relatorio mes:',err.message);return '❌ Erro ao gerar relatório do mês.';}
}

async function gerarResumoDiario() {
  try {
    const hoje=agoraData();
    const{historico}=await carregarHistoricoAgrupado();
    let totalVendas=0,totalPago=0,qtdTrufa=0,qtdBolo=0,clientes=new Set();
    for(const [nome,movs] of Object.entries(historico)){
      for(const m of movs){
        if(soData(m.data)!==hoje) continue;
        if(m.tipo==='Compra'){ totalVendas+=m.valor; if(m.produto==='trufa') qtdTrufa+=parseInt(m.qtd||'0'); if(m.produto==='bolo') qtdBolo+=parseInt(m.qtd||'0'); clientes.add(nome); }
        else if(m.tipo==='Pagamento') totalPago+=m.valor;
      }
    }
    const sheetSaldo=await getSheetSaldo();
    const rows=await sheetSaldo.getRows();
    const totalAberto=rows.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    return `*Resumo do Dia - ${hoje}*\n───────────────\nTrufas: ${qtdTrufa} | Bolos: ${qtdBolo}\nClientes atendidos: ${clientes.size}\nVendas do dia: R$ ${totalVendas.toFixed(2)}\nRecebido hoje: R$ ${totalPago.toFixed(2)}\n───────────────\nTotal em aberto: R$ ${totalAberto.toFixed(2)}`;
  } catch(err){console.error('Erro resumo:',err.message);return '❌ Erro ao gerar resumo.';}
}

const DIAS_LEMBRETE = parseInt(process.env.DIAS_LEMBRETE||'7');
const HORA_LEMBRETE = parseInt(process.env.HORA_LEMBRETE||'20');
const HORA_RESUMO   = parseInt(process.env.HORA_RESUMO  ||'21');

async function verificarLembretes(sock, jid) {
  try {
    const sheet=await getSheetSaldo(); const rows=await sheet.getRows(); const agora2=new Date(); const clientes={};
    for(const row of rows){
      const nome=(row.get('Cliente')||'').trim(); const total=parseFloat(row.get('Total')||'0'); const ultima=(row.get('UltimaCompra')||'').trim();
      if(!nome||total<=0||!ultima) continue;
      const partes=ultima.split(' ')[0].split('/');
      if(partes.length<3) continue;
      const dataUltima=new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
      const diasPassados=Math.floor((agora2-dataUltima)/(1000*60*60*24));
      if(diasPassados>=DIAS_LEMBRETE){ if(!clientes[nome]) clientes[nome]={total:0,dias:diasPassados}; clientes[nome].total+=total; clientes[nome].dias=Math.max(clientes[nome].dias,diasPassados); }
    }
    for(const [nome,dados] of Object.entries(clientes)){
      await sock.sendMessage(jid,{text:`⚠️ *Lembrete de cobrança*\n*${nome}* está com R$ ${dados.total.toFixed(2)} em aberto há *${dados.dias} dias*.`});
    }
  } catch(e){console.error('Erro lembrete:',e.message);}
}

function mudarPreco(produto, novoPreco) {
  const p=toProduto(produto);
  if(!p) return `❌ Produto *${produto}* não encontrado.`;
  const precoAntigo=PRECOS[p]||0; PRECOS[p]=novoPreco; salvarPrecos();
  return `✅ Preço de *${nomeProdutoExib(p)}* atualizado: R$ ${precoAntigo.toFixed(2)} → R$ ${novoPreco.toFixed(2)}\n_Saldos existentes não foram alterados. Vale para novas compras._`;
}
function cadastrarNovoProduto(nomeProduto, preco) {
  const key=norm(nomeProduto).replace(/\s+/g,'_');
  if(PRECOS[key]!==undefined) return `⚠️ Produto *${nomeProduto}* já existe. Para mudar o preço: _preco ${nomeProduto} R$XX_`;
  PRECOS[key]=preco; SINONIMOS_EXTRA[key]=[...new Set([norm(nomeProduto), nomeProduto.toLowerCase().trim()])];
  salvarPrecos(); salvarSinonimosExtra();
  return `✅ Novo produto cadastrado!\n*${capitalizarNome(nomeProduto)}* = R$ ${preco.toFixed(2)}\nUso: _"cliente nome ${norm(nomeProduto)}"_`;
}
function listarProdutos() {
  const todos=todosOsSinonimos();
  let msg='*Produtos cadastrados*\n───────────────\n';
  for(const [key] of Object.entries(todos)){ const preco=PRECOS[key]; if(preco===undefined) continue; msg+=`${nomeProdutoExib(key)}: R$ ${preco.toFixed(2)}\n`; }
  msg+='───────────────\n_Para mudar o preço: preco [produto] [valor]_';
  return msg;
}
async function zerarCliente(nomeDigitado) {
  try {
    const sheet=await getSheetSaldo(); const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon) return `❌ Cliente *${capitalizarNome(nomeDigitado)}* não encontrado.`;
    const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
    if(!rowsCliente.length) return `✅ *${nomeCanon}* já está sem dívidas.`;
    const totalZerado=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    for(const r of rowsCliente) await r.delete();
    await comRetry(() => getSheetHistorico().then(sh => sh.addRow({Data:agora(),Cliente:nomeCanon,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:totalZerado.toFixed(2)})), 4, 'addRow Zerar');
    return `✅ Dívida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
  } catch(err){console.error('Erro zerar:',err.message);return '❌ Erro ao zerar cliente.';}
}

const PALAVRAS_RESERVADAS = new Set([
  'pagou','pix','transferiu','depositou','mandou','enviou',
  'cancelar','saldo','historico','relatorio','resumo',
  'cobrar','lembrete','lembretes','preco','produtos','zerar','novo'
]);
function parsearLinha(linha) {
  const limpa=linha.replace(/,/g,' ').replace(/\b(mais|e|de)\b/gi,' ').replace(/\+/g,' ').replace(/[.!?;:]+( |$)/g,'$1').replace(/\s+/g,' ').trim();
  const palavrasOrig=limpa.split(' ').filter(Boolean);
  const palavrasNorm=palavrasOrig.map(norm); const n=palavrasNorm.length;
  let inicioItens=-1;
  for(let i=0;i<n;i++){
    if(toProduto(palavrasNorm[i])){inicioItens=i;break;}
    const qtd=toNumero(palavrasNorm[i]);
    if(qtd!==null&&i+1<n){
      if(i+2<n&&toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2])){inicioItens=i;break;}
      if(toProduto(palavrasNorm[i+1])){inicioItens=i;break;}
    }
  }
  if(inicioItens<1) return null;
  const nomeRaw=palavrasOrig.slice(0,inicioItens).join(' ').trim();
  if(!nomeRaw||PALAVRAS_RESERVADAS.has(norm(nomeRaw))) return null;
  const itens=[]; let i=inicioItens;
  while(i<n){
    const qtd=toNumero(palavrasNorm[i]);
    if(qtd!==null&&i+1<n){
      if(i+2<n){const p2=toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2]);if(p2){itens.push({quantidade:qtd,produto:p2});i+=3;continue;}}
      const p1=toProduto(palavrasNorm[i+1]);if(p1){itens.push({quantidade:qtd,produto:p1});i+=2;continue;}
    }
    if(i+1<n){const p2=toProduto(palavrasNorm[i]+' '+palavrasNorm[i+1]);if(p2){itens.push({quantidade:1,produto:p2});i+=2;continue;}}
    const p1=toProduto(palavrasNorm[i]);if(p1){itens.push({quantidade:1,produto:p1});i++;continue;}
    i++;
  }
  if(!itens.length) return null;
  return{nome:capitalizarNome(nomeRaw),itens};
}

function parsearPagamento(linha) {
  const tNorm=norm(linha);
  if(!/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/.test(tNorm)) return null;
  const kwMatch=tNorm.match(/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/);
  if(!kwMatch) return null;
  const keyword=kwMatch[1];
  const palavrasNorm=tNorm.split(/\s+/).filter(Boolean);
  const palavrasOrig=linha.trim().split(/\s+/).filter(Boolean);
  let kwIdx=-1;
  for(let i=0;i<palavrasNorm.length;i++){ if(palavrasNorm[i]===keyword){kwIdx=i;break;} }
  if(kwIdx<=0) return null;
  const nomeRaw=palavrasOrig.slice(0,kwIdx).join(' ').trim();
  if(!nomeRaw) return null;
  const resto=palavrasNorm.slice(kwIdx+1).join(' ').trim();
  if(resto){
    const partesResto=resto.split(/\s+/).filter(Boolean);
    let qtd=null,prod=null;
    for(let i=0;i<partesResto.length;i++){
      const q=toNumero(partesResto[i]);
      if(q!==null&&!qtd){qtd=q;continue;}
      if(qtd!==null){
        if(i+1<partesResto.length){const p2=toProduto(partesResto[i]+' '+partesResto[i+1]);if(p2){prod=p2;break;}}
        const p1=toProduto(partesResto[i]);if(p1){prod=p1;break;}
      } else {
        if(i+1<partesResto.length){const p2=toProduto(partesResto[i]+' '+partesResto[i+1]);if(p2){prod=p2;break;}}
        const p1=toProduto(partesResto[i]);if(p1){prod=p1;qtd=qtd||1;break;}
      }
    }
    if(prod&&qtd) return{tipo:'produto',nome:nomeRaw,quantidade:qtd,produto:prod};
  }
  const valor=extrairValor(resto||linha);
  if(valor&&valor>0) return{tipo:'valor',nome:nomeRaw,valor};
  return null;
}

async function processarTexto(texto, jid, sock) {
  if(!texto) return null;
  const t=norm(texto); const palavras=t.split(/\s+/).filter(Boolean);
  const p0=palavras[0]; const p1=palavras[1]; const resto=palavras.slice(1).join(' ');
  if(p0==='relatorio'||p0==='relatorios'){
    if(p1==='detalhado') return await gerarRelatorioDetalhado();
    if(p1==='quitados'||p1==='quitado') return await gerarRelatorioQuitados();
    if(p1&&isMes(p1)) return await gerarRelatorioMes(p1);
    return await gerarRelatorioGeral();
  }
  if(p0==='resumo') return await gerarResumoDiario();
  if(p0==='saldo'&&p1) return await gerarSaldoIndividual(resto);
  if(p0==='historico'&&p1) return await gerarHistoricoCliente(resto);
  if(p0==='cancelar'&&p1) return await cancelarLancamento(jid, resto);
  if(p0==='zerar'&&p1) return await zerarCliente(resto);
  if(p0==='ajuda'||p0==='help') return mensagemAjuda();
  if(p0==='produtos') return listarProdutos();
  if(p0==='preco'&&p1){
    const prodTrecho=palavras.slice(1,-1).join(' '); const ultimaPalavra=palavras[palavras.length-1];
    const novoPreco=extrairValor(ultimaPalavra);
    if(novoPreco&&novoPreco>0) return mudarPreco(prodTrecho,novoPreco);
    const prodTudo=palavras.slice(1).join(' '); const v2=extrairValor(prodTudo);
    if(v2&&v2>0){ const prodSemVal=prodTudo.replace(/r?\$?\s*\d+[,.]?\d*/,'').trim(); return mudarPreco(prodSemVal||p1,v2); }
  }
  if(p0==='novo'&&p1){
    const partes=palavras.slice(1); const ultimaP=partes[partes.length-1]; const preco=extrairValor(ultimaP);
    if(preco&&preco>0){ const nomeProd=partes.slice(0,-1).join(' ').trim(); if(nomeProd) return cadastrarNovoProduto(nomeProd,preco); }
  }
  const pag=parsearPagamento(texto);
  if(pag){
    if(pag.tipo==='produto'){const r=await processarPagamentoProduto(pag.nome,pag.quantidade,pag.produto,jid);return r.msg;}
    if(pag.tipo==='valor'){const r=await processarPagamentoValor(pag.nome,pag.valor,jid);return r.msg;}
  }
  const compra=parsearLinha(texto);
  if(compra){
    const msgs=[];
    for(const item of compra.itens){
      const res=await registrarOuAcumular(compra.nome,item.produto,item.quantidade);
      if(!res){msgs.push(`❌ Erro ao registrar ${compra.nome}.`);continue;}
      if(res.limiteBloqueado){msgs.push(`⛔ *${res.cliente}* atingiu o limite de crédito!\nAtual: R$ ${res.totalAtual.toFixed(2)} + R$ ${res.valorNovo.toFixed(2)} = ultrapassaria R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}`);continue;}
      pushLancamento(jid,{tipo:'compra',cliente:res.cliente,produto:item.produto,quantidade:item.quantidade,valor:PRECOS[item.produto]*item.quantidade});
      msgs.push(`${emojiProduto(item.produto)} *${res.cliente}*: ${res.qtdAcumulada} ${nomeProdutoExib(item.produto)}(s) = R$ ${res.totalAcumulado.toFixed(2)}`);
    }
    return msgs.join('\n');
  }
  return null;
}

function mensagemAjuda() {
  return ['*Bot de Vendas 🥇*','───────────────','*Registrar compra:*','  `julia 2 trufas`','  `carlos 1 bolo 3 trufas`','','*Registrar pagamento:*','  `julia pagou 10`','  `carlos pix 15`','  `ana pagou 2 trufas`','','*Relatórios:*','  `relatorio` — geral','  `relatorio detalhado`','  `relatorio quitados`','  `relatorio junho`','  `resumo` — resumo do dia','','*Consultas:*','  `saldo julia`','  `historico carlos`','','*Outros:*','  `cancelar julia` — desfaz último lançamento','  `zerar carlos` — zera dívida','  `produtos` — lista produtos e preços','  `preco trufa 6` — muda preço','  `novo brigadeiro 3.50` — cadastra produto'].join('\n');
}

async function iniciarBot() {
  restaurarSessao();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
  });

  sockGlobal = sock;

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await salvarSessaoNoRender();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR disponível (use o formulário web para parear por número)');
    }

    if (connection === 'open') {
      botConectado = true;
      pairingPendente = false;
      console.log('✅ Bot conectado ao WhatsApp!');
      await salvarSessaoNoRender();
      if (!agendamentosIniciados) {
        agendamentosIniciados = true;
        setInterval(async () => {
          try {
            const horaNum = horaAtualSP();
            const hoje = agoraData();
            if (horaNum === HORA_LEMBRETE && ultimoDiaLembrete !== hoje && jidGrupoGlobal) {
              ultimoDiaLembrete = hoje;
              await verificarLembretes(sock, jidGrupoGlobal);
            }
            if (horaNum === HORA_RESUMO && ultimoDiaResumo !== hoje && jidGrupoGlobal) {
              ultimoDiaResumo = hoje;
              await sock.sendMessage(jidGrupoGlobal, { text: await gerarResumoDiario() });
            }
          } catch(e) { console.error('Erro agendamento:', e.message); }
        }, 60 * 60 * 1000);
      }
    }

    if (connection === 'close') {
      botConectado = false;
      agendamentosIniciados = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Conexão fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(iniciarBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid || '';
        const isGroup = jid.endsWith('@g.us');
        if (!isGroup) continue;
        const groupMeta = await sock.groupMetadata(jid).catch(() => null);
        const nomeGrupo = groupMeta?.subject || '';
        if (!norm(nomeGrupo).includes(norm(GRUPO_NOME))) continue;
        jidGrupoGlobal = jid;

        const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const textoRaw = await transcreverAudio(buffer, mimeType);
            if (textoRaw) {
              const textoTranscrito = corrigirTranscricao(limparTranscricao(textoRaw));
              console.log('Transcrição:', textoRaw);
              const resposta = await processarTexto(textoTranscrito, jid, sock);
              if (resposta) await sock.sendMessage(jid, { text: `🎤 _"${textoRaw}"_\n\n${resposta}` });
            }
          } catch(e) { console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!textMsg.trim()) continue;
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });
      } catch(e) { console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

iniciarBot();
