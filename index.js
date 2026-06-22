process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const http = require('http');
const pino = require('pino');
const FormData = require('form-data');

const GRUPO_NOME   = process.env.GRUPO_NOME   || 'vendas';
const SPREADSHEET_ID               = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY           = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PORT             = process.env.PORT  || 3000;
const RENDER_API_KEY   = process.env.RENDER_API_KEY   || '';
const RENDER_SERVICE_ID= process.env.RENDER_SERVICE_ID|| '';
const GROQ_API_KEY     = process.env.GROQ_API_KEY     || '';

const AUTH_DIR = 'auth_info';

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
    if (!res.ok) {
      const err = await res.text();
      console.error('Groq erro:', err);
      return null;
    }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) {
    console.error('Erro transcrição Groq:', e.message);
    return null;
  }
}

// ─── LIMPAR TEXTO DE TRANSCRIÇÃO ─────────────────────────────────────────────
function limparTranscricao(texto) {
  if (!texto) return texto;
  return texto
    .replace(/([^\s])([.!?,;:]+)(\s|$)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── FUZZY MATCH PARA COMANDOS DE VOZ ────────────────────────────────────────
const CORRECOES_VOZ = {
  'saudo': 'saldo',
  'saud': 'saldo',
  'salvo': 'saldo',
  'salda': 'saldo',
  'saldos': 'saldo',
  'relatorio': 'relatorio',
  'relatorios': 'relatorio',
  'relato': 'relatorio',
  'rezumo': 'resumo',
  'resuno': 'resumo',
  'istorico': 'historico',
  'historico': 'historico',
  'cancelado': 'cancelar',
  'cancela': 'cancelar',
  'cancelas': 'cancelar',
  'zera': 'zerar',
  'ajudas': 'ajuda',
  'produto': 'produtos',
  'pagou': 'pagou',
  'pagol': 'pagou',
  'pago': 'pagou',
  'pix': 'pix',
  'pics': 'pix',
  'pik': 'pix',
  'transferio': 'transferiu',
  'transferiou': 'transferiu',
  'trufa': 'trufa',
  'trufas': 'trufas',
  'trufinha': 'trufinha',
  'bolo': 'bolo',
  'bolos': 'bolos',
  'bombon': 'bombom',
  'bombons': 'bombons',
};

function corrigirPalavra(palavra) {
  const n = norm(palavra);
  return CORRECOES_VOZ[n] || palavra;
}

function corrigirTranscricao(texto) {
  if (!texto) return texto;
  return texto.split(/\s+/).map(p => corrigirPalavra(p)).join(' ');
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

// ─── MESES VALIDOS ────────────────────────────────────────────────────────────
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

// ─── HISTORICO DE LANCAMENTOS (cancelar) ──────────────────────────────────────
const ULTIMOS_LANCAMENTOS = {};
const MAX_HIST_CANCEL = 10;
function pushLancamento(jid, obj) {
  if (!ULTIMOS_LANCAMENTOS[jid]) ULTIMOS_LANCAMENTOS[jid] = [];
  ULTIMOS_LANCAMENTOS[jid].push(obj);
  if (ULTIMOS_LANCAMENTOS[jid].length > MAX_HIST_CANCEL) ULTIMOS_LANCAMENTOS[jid].shift();
}

// ─── NORMALIZAÇÃO ─────────────────────────────────────────────────────────────
function norm(t) {
  return (t||'')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .trim();
}

// ─── FUZZY MATCH ─────────────────────────────────────────────────────────────
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

// ─── EXTRAIR VALOR MONETÁRIO ──────────────────────────────────────────────────
function extrairValor(texto) {
  if(!texto) return null;
  const t = norm(texto)
    .replace(/r\$\s*/g,' ')
    .replace(/\breais\b/g,' ')
    .replace(/\bpix\b/g,' ')
    .replace(/\bde\b/g,' ')
    .replace(/\btransferiu\b/g,' ')
    .replace(/\bdepositou\b/g,' ')
    .replace(/\bmandou\b/g,' ')
    .replace(/\benviou\b/g,' ')
    .replace(/\bpagou\b/g,' ')
    .trim();
  const m = t.match(/(\d+[,.]?\d*)/);
  if(!m) return null;
  const val = parseFloat(m[1].replace(',','.'));
  return isNaN(val) ? null : val;
}

// ─── DATA (só dd/mm/aaaa, sem hora) ──────────────────────────────────────────
function agora() { return new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}); }
function agoraData() { return new Date().toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'}); }
function soData(str) {
  if(!str) return '';
  return (str.trim().split(' ')[0]) || str.trim();
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

let botConectado=false;
// ─── ESTADO DO PAIRING CODE ───────────────────────────────────────────────────
let pairingCodeGerado=null;
let pairingAguardando=false;
let sockGlobal=null;
let jidGrupoGlobal=null;
let agendamentosIniciados=false;
let horaConexao=null;
let nomeGrupoConectado=null;

// ─── BUG 3 FIX: normalização robusta de escapes do CREDS_JSON ────────────────
// O Render pode serializar variáveis de ambiente introduzindo escapes duplos.
// Esta função normaliza TODOS os casos conhecidos antes de tentar JSON.parse().
function normalizarCredsJson(raw) {
  return raw
    .replace(/\\\\n/g, '\\n')   // \\n  → \n
    .replace(/\\\\t/g, '\\t')   // \\t  → \t
    .replace(/\\\\r/g, '\\r')   // \\r  → \r
    .replace(/\\\\\\\\/g, '\\\\'); // \\\\ → \\
}

function restaurarSessao() {
  try {
    let credsJson = process.env.CREDS_JSON;
    if (!credsJson) {
      console.log('[restaurarSessao] CREDS_JSON não definido — será necessário novo pairing.');
      return false;
    }

    console.log(`[restaurarSessao] CREDS_JSON recebido — tamanho: ${credsJson.length} chars.`);

    // Tenta primeiro sem normalização (caso o Render já entregue correto)
    let jsonValido = null;
    try {
      JSON.parse(credsJson);
      jsonValido = credsJson;
      console.log('[restaurarSessao] CREDS_JSON válido sem normalização.');
    } catch (_) {
      // Tenta com normalização de escapes duplos
      const normalizado = normalizarCredsJson(credsJson);
      try {
        JSON.parse(normalizado);
        jsonValido = normalizado;
        console.log('[restaurarSessao] CREDS_JSON válido após normalização de escapes.');
      } catch (parseErr) {
        console.error('[restaurarSessao] CREDS_JSON inválido mesmo após normalização.');
        console.error('[restaurarSessao] Erro do JSON.parse:', parseErr.message);
        console.error('[restaurarSessao] Primeiros 300 chars (raw)   :', credsJson.slice(0, 300));
        console.error('[restaurarSessao] Primeiros 300 chars (norm)  :', normalizado.slice(0, 300));
        return false;
      }
    }

    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), jsonValido, 'utf8');
    console.log('[restaurarSessao] Sessão restaurada com sucesso do CREDS_JSON.');
    return true;
  } catch (e) {
    console.error('[restaurarSessao] Erro inesperado:', e.message);
    return false;
  }
}

let _ultimoSalvamento = 0;
async function salvarSessaoNoRender() {
  try {
    const agora2 = Date.now();
    if (agora2 - _ultimoSalvamento < 60_000) return;
    _ultimoSalvamento = agora2;
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

// ─── LIMPAR CREDS_JSON NO RENDER ─────────────────────────────────────────────
async function limparCREDSnoRender() {
  try {
    if(!RENDER_API_KEY||!RENDER_SERVICE_ID) return;
    const fetch=(await import('node-fetch')).default;
    const resGet=await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,{
      headers:{'Authorization':`Bearer ${RENDER_API_KEY}`,'Content-Type':'application/json'}
    });
    const envVars=await resGet.json();
    const existente=Array.isArray(envVars)?envVars:(envVars.envVars||[]);
    const novas=existente
      .filter(v=>v.key!=='CREDS_JSON')
      .map(v=>({key:v.key,value:v.value}));
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`,{
      method:'PUT',
      headers:{'Authorization':`Bearer ${RENDER_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify(novas)
    });
    console.log('CREDS_JSON removido do Render — proximo inicio vai pedir novo codigo de emparelhamento.');
  } catch(e){console.error('Erro ao limpar CREDS no Render:',e.message);}
}

// ─── SERVIDOR HTTP (frontend de pairing code) ─────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/pair') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { number } = JSON.parse(body);
          const clean = (number || '').replace(/\D/g, '');
          if (!clean || clean.length < 10 || clean.length > 15) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Número inválido. Use formato E.164 sem o +, ex: 5511999999999' }));
          }
          if (!sockGlobal) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Bot ainda não inicializado. Aguarde alguns segundos.' }));
          }
          console.log(`Solicitando Pairing Code para o número: ${clean}`);
          const code = await sockGlobal.requestPairingCode(clean);
          pairingCodeGerado = code;
          console.log(`Pairing Code gerado: ${code}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code }));
        } catch (e) {
          console.error('Erro ao gerar pairing code:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (botConectado) {
      const grupoExib = nomeGrupoConectado || GRUPO_NOME;
      const horaExib = horaConexao ? horaConexao.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';
      res.end(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Bot conectado</title>
        <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f0faf0}</style>
      </head><body>
        <h1 style="color:#25D366">&#x2705; Bot conectado!</h1>
        <p style="font-size:18px">Monitorando grupo: <strong>${grupoExib}</strong></p>
        ${horaExib ? `<p style="color:#888;font-size:14px">Conectado desde: ${horaExib}</p>` : ''}
        <p style="color:#555;margin-top:20px">Funcionando normalmente. &#x1F680;</p>
        <script>setTimeout(()=>location.reload(),60000)</script>
      </body></html>`);
    } else {
      res.end(`<!DOCTYPE html><html lang="pt-BR"><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Conectar WhatsApp</title>
        <style>
          *{box-sizing:border-box}
          body{font-family:sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
          .card{background:#fff;border-radius:12px;padding:40px 32px;max-width:420px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center}
          h1{color:#128C7E;margin-bottom:8px;font-size:1.4rem}
          p.sub{color:#555;font-size:.9rem;margin-bottom:24px}
          input{width:100%;padding:12px 14px;border:1px solid #ccc;border-radius:8px;font-size:1rem;margin-bottom:14px;outline:none;transition:border .2s}
          input:focus{border-color:#128C7E}
          button{width:100%;padding:13px;background:#25D366;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600;transition:background .2s}
          button:hover{background:#128C7E}
          button:disabled{background:#aaa;cursor:not-allowed}
          .code-box{margin-top:24px;background:#f0faf0;border:2px solid #25D366;border-radius:10px;padding:18px}
          .code-box span{font-size:2rem;font-weight:700;letter-spacing:6px;color:#128C7E}
          .code-box p{margin:8px 0 0;font-size:.85rem;color:#555}
          .error{color:#c0392b;margin-top:10px;font-size:.9rem}
          .steps{text-align:left;margin-top:20px;font-size:.85rem;color:#444;line-height:1.8}
          .steps b{color:#128C7E}
        </style>
      </head><body>
        <div class="card">
          <h1>&#x1F4F1; Conectar WhatsApp</h1>
          <p class="sub">Insira o número do WhatsApp que será vinculado ao bot (com código do país, sem espaços ou traços).</p>
          <input id="num" type="tel" placeholder="Ex: 5511999999999" maxlength="15" autocomplete="off">
          <button id="btn" onclick="solicitar()">Gerar código de emparelhamento</button>
          <div id="error" class="error"></div>
          <div id="result" style="display:none" class="code-box">
            <p style="margin:0 0 8px;font-size:.9rem;font-weight:600;color:#333">Seu código:</p>
            <span id="code"></span>
            <p>Abra o WhatsApp &rarr; <b>Configurações</b> &rarr; <b>Aparelhos conectados</b> &rarr; <b>Conectar um aparelho</b> &rarr; <b>Conectar com número de telefone</b> e insira o código acima.</p>
          </div>
          <div class="steps">
            <b>Passo a passo:</b><br>
            1. Digite o número com DDI (55 para Brasil) + DDD + número<br>
            2. Clique em <b>Gerar código</b><br>
            3. No WhatsApp: Configurações &rarr; Aparelhos conectados &rarr; Conectar com número de telefone<br>
            4. Digite o código de 8 dígitos exibido acima
          </div>
        </div>
        <script>
          const input = document.getElementById('num');
          input.addEventListener('input', () => { input.value = input.value.replace(/\\D/g, ''); });
          async function solicitar() {
            const btn = document.getElementById('btn');
            const errEl = document.getElementById('error');
            const result = document.getElementById('result');
            const codeEl = document.getElementById('code');
            errEl.textContent = '';
            result.style.display = 'none';
            const number = input.value.replace(/\\D/g, '');
            if (!number || number.length < 10 || number.length > 15) {
              errEl.textContent = 'Número inválido. Use DDI + DDD + número (ex: 5511999999999).';
              return;
            }
            btn.disabled = true;
            btn.textContent = 'Aguardando...';
            try {
              const resp = await fetch('/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ number })
              });
              const data = await resp.json();
              if (!resp.ok || data.error) {
                errEl.textContent = data.error || 'Erro ao gerar código.';
                btn.disabled = false;
                btn.textContent = 'Gerar código de emparelhamento';
                return;
              }
              const raw = (data.code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
              codeEl.textContent = raw.length === 8 ? raw.slice(0,4) + '-' + raw.slice(4) : raw;
              result.style.display = 'block';
              btn.textContent = 'Código gerado! Aguardando vinculação...';
            } catch (e) {
              errEl.textContent = 'Erro de conexão com o servidor.';
              btn.disabled = false;
              btn.textContent = 'Gerar código de emparelhamento';
            }
          }
          setInterval(async () => {
            try {
              const r = await fetch('/');
              const html = await r.text();
              if (html.includes('Bot conectado')) location.reload();
            } catch(_) {}
          }, 8000);
        </script>
      </body></html>`);
    }
  } catch (e) {
    res.end('<html><body><h1>Carregando...</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
});

server.listen(PORT, () => console.log(`\u2705 Servidor rodando na porta ${PORT}`));

// ─── CACHE DO JWT ─────────────────────────────────────────────────────────────
let _jwtCache = null;
let _jwtCriadoEm = 0;
const JWT_TTL_MS = 50 * 60 * 1000;

function getAuth() {
  const agora2 = Date.now();
  if (_jwtCache && (agora2 - _jwtCriadoEm) < JWT_TTL_MS) return _jwtCache;
  _jwtCache = new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  _jwtCriadoEm = agora2;
  return _jwtCache;
}

// ─── RETRY COM BACKOFF EXPONENCIAL ───────────────────────────────────────────
async function comRetry(fn, tentativas = 4, espera = 2000) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const ehRede = err.message?.includes('Premature close') ||
                     err.message?.includes('fetch failed') ||
                     err.message?.includes('ECONNRESET') ||
                     err.message?.includes('ETIMEDOUT') ||
                     err.message?.includes('socket hang up') ||
                     err.message?.includes('network') ||
                     err.message?.includes('Invalid response body');
      if (ehRede && i < tentativas - 1) {
        console.log(`Erro de rede (tentativa ${i + 1}/${tentativas}): ${err.message}. Tentando novamente em ${espera}ms...`);
        await new Promise(r => setTimeout(r, espera));
        espera *= 2;
        _jwtCache = null;
      } else {
        throw err;
      }
    }
  }
}

async function getDoc() {
  return await comRetry(async () => {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, getAuth());
    await doc.loadInfo();
    return doc;
  });
}
async function getSheetSaldo() { return (await getDoc()).sheetsByIndex[0]; }
async function getSheetHistorico() {
  const doc=await getDoc();
  if(doc.sheetCount<2) return await doc.addSheet({title:'Historico',headerValues:['Data','Cliente','Tipo','Produto','Quantidade','Valor']});
  const sheet=doc.sheetsByIndex[1];
  try{await sheet.loadHeaderRow();}catch(e){await sheet.setHeaderRow(['Data','Cliente','Tipo','Produto','Quantidade','Valor']);}
  return sheet;
}

// ─── REGISTRAR COMPRA ─────────────────────────────────────────────────────────
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
      existente.set('Quantidade',qtdAcumulada);
      existente.set('Total',totalAcumulado.toFixed(2));
      existente.set('UltimaCompra',agora());
      await existente.save();
      await (await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)});
      return {cliente,totalAcumulado,qtdAcumulada};
    } else {
      await sheet.addRow({Cliente:cliente,Produto:produto,Quantidade:quantidade,Total:valorNovo.toFixed(2),UltimaCompra:agora()});
      await (await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)});
      return {cliente,totalAcumulado:valorNovo,qtdAcumulada:quantidade};
    }
  } catch(err){console.error('Erro planilha:',err.message);return null;}
}

// ─── CANCELAR LANCAMENTO ──────────────────────────────────────────────────────
async function cancelarLancamento(jid, nomeDigitado) {
  try {
    const hist = ULTIMOS_LANCAMENTOS[jid] || [];
    let idx = -1;
    for(let i=hist.length-1;i>=0;i--){
      if(mesmoNome(hist[i].cliente, nomeDigitado)){ idx=i; break; }
    }
    if(idx<0) return `\u274c Nenhum lan\u00e7amento recente encontrado para *${capitalizarNome(nomeDigitado)}*.`;
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
      return `\u2197\ufe0f Lan\u00e7amento cancelado: *${lanc.cliente}* - ${lanc.quantidade}x ${nomeProdutoExib(lanc.produto)} (R$ ${lanc.valor.toFixed(2)})`;
    }
    if(lanc.tipo==='pagamento'){
      const rowsC=rows.filter(r=>mesmoNome(r.get('Cliente'),lanc.cliente));
      if(rowsC.length){
        let restante=lanc.valor;
        for(const r of rowsC){
          if(restante<=0) break;
          const novoTotal=parseFloat(r.get('Total')||'0')+restante;
          r.set('Total',novoTotal.toFixed(2));
          await r.save();
          restante=0;
        }
      } else {
        const produto=lanc.produto&&lanc.produto!=='geral'?lanc.produto:'trufa';
        await sheet.addRow({Cliente:lanc.cliente,Produto:produto,Quantidade:0,Total:lanc.valor.toFixed(2),UltimaCompra:agora()});
      }
      for(let i=rowsH.length-1;i>=0;i--){
        if(rowsH[i].get('Cliente')===lanc.cliente&&rowsH[i].get('Tipo')==='Pagamento'){
          await rowsH[i].delete(); break;
        }
      }
      return `\u2197\ufe0f Pagamento cancelado: *${lanc.cliente}* - R$ ${lanc.valor.toFixed(2)} devolvido ao saldo.`;
    }
    return '\u274c N\u00e3o foi poss\u00edvel cancelar.';
  } catch(err){console.error('Erro cancelar:',err.message);return '\u274c Erro ao cancelar lan\u00e7amento.';}
}

// ─── PAGAMENTO POR PRODUTO ────────────────────────────────────────────────────
async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(clienteEnviado, nomesConhecidos);
    const row=rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
    const cliente = nomeCanon ? nomeCanon : (row ? row.get('Cliente') : capitalizarNome(clienteEnviado));
    if(!row) return {ok:false,msg:`\u274c Nenhuma d\u00edvida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.`};
    const qtdAtual  = parseInt(row.get('Quantidade')||'0');
    const qtdPaga   = Math.min(quantidade,qtdAtual);
    const novaQtd   = qtdAtual-qtdPaga;
    const totalAtual= parseFloat(row.get('Total')||'0');
    const pago = qtdAtual>0 ? (totalAtual/qtdAtual)*qtdPaga : 0;
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente,produto,quantidade:qtdPaga,valor:pago});
    await (await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Pagamento',Produto:produto,Quantidade:qtdPaga,Valor:pago.toFixed(2)});
    if(novaQtd===0){
      await row.delete();
      return {ok:true,msg:`\u2705 *${cliente}* quitou toda a d\u00edvida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.`};
    }
    const novoTotal=totalAtual-pago;
    row.set('Quantidade',novaQtd);
    row.set('Total',novoTotal.toFixed(2));
    await row.save();
    return {ok:true,msg:`\u2705 *${cliente}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}`};
  } catch(err){console.error('Erro pag produto:',err.message);return {ok:false,msg:'\u274c Erro ao registrar pagamento.'};}
}

// ─── PAGAMENTO POR VALOR ──────────────────────────────────────────────────────
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
    if(!rowsCliente.length) return {ok:false,msg:`\u274c Nenhuma d\u00edvida encontrada para *${capitalizarNome(clienteEnviado)}*.`};
    const totalDevido=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente,produto:'geral',quantidade:'-',valor:valorPago});
    await (await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:valorPago.toFixed(2)});
    if(valorPago>=totalDevido){
      for(const r of rowsCliente) await r.delete();
      return {ok:true,msg:`\u2705 *${cliente}* quitou toda a d\u00edvida! Pagou R$ ${valorPago.toFixed(2)}.`};
    }
    let restante=valorPago;
    for(const r of rowsCliente){
      if(restante<=0) break;
      const totalRow=parseFloat(r.get('Total')||'0');
      if(restante>=totalRow){
        restante-=totalRow;
        await r.delete();
      } else {
        const novoTotal=totalRow-restante;
        r.set('Total',novoTotal.toFixed(2));
        const qtdAtual=parseInt(r.get('Quantidade')||'0');
        const novaQtd=totalRow>0?Math.round(qtdAtual*(novoTotal/totalRow)):0;
        r.set('Quantidade',Math.max(novaQtd,0));
        await r.save();
        restante=0;
      }
    }
    return {ok:true,msg:`\u2705 *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido-valorPago).toFixed(2)}`};
  } catch(err){console.error('Erro pag valor:',err.message);return {ok:false,msg:'\u274c Erro ao registrar pagamento.'};}
}

// ─── RELATORIO GERAL ──────────────────────────────────────────────────────────
async function gerarRelatorioGeral() {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    if(!rows.length) return 'Nenhuma d\u00edvida em aberto no momento.';
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
    if(!Object.keys(clientes).length) return 'Nenhuma d\u00edvida em aberto no momento.';
    const ordenados=Object.entries(clientes).sort((a,b)=>b[1].totalDevido-a[1].totalDevido);
    let resposta='*Relat\u00f3rio de D\u00edvidas*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    let totalGeral=0;
    for(const [nome,dados] of ordenados){
      resposta+=`\n*${nome}*\n`;
      for(const item of dados.itens)
        resposta+=`  ${nomeProdutoExib(item.produto)}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;
      resposta+=`  *Total: R$ ${dados.totalDevido.toFixed(2)}*\n`;
      totalGeral+=dados.totalDevido;
    }
    resposta+=`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro relatorio:',err.message);return '\u274c Erro ao gerar relat\u00f3rio.';}
}

// ─── HELPER: historico agrupado ───────────────────────────────────────────────
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
      data:(row.get('Data')||'').trim(),
      tipo:(row.get('Tipo')||'').trim(),
      produto:norm(row.get('Produto')||''),
      qtd:(row.get('Quantidade')||'').trim(),
      valor:parseFloat(row.get('Valor')||'0')
    });
  }
  return{historico,saldos};
}

// ─── RELATORIO DETALHADO ──────────────────────────────────────────────────────
async function gerarRelatorioDetalhado() {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length) return 'Nenhuma movimenta\u00e7\u00e3o registrada ainda.';
    const devedores=Object.keys(historico).filter(n=>(saldos[n]||0)>0);
    if(!devedores.length) return '\u2705 Nenhuma d\u00edvida em aberto! Todos quitados.';
    devedores.sort((a,b)=>(saldos[b]||0)-(saldos[a]||0));
    let resposta='*Relat\u00f3rio Detalhado*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    let totalGeral=0;
    for(const nome of devedores){
      const movs=historico[nome];
      const saldoAtual=saldos[nome]||0;
      resposta+=`\n*${nome}*\n`;
      for(const m of movs){
        if(m.tipo==='Compra') resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if(m.tipo==='Pagamento') resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta+=`  *Saldo devedor: R$ ${saldoAtual.toFixed(2)}*\n`;
      totalGeral+=saldoAtual;
    }
    resposta+=`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro relatorio detalhado:',err.message);return '\u274c Erro ao gerar relat\u00f3rio detalhado.';}
}

// ─── COMPRAS QUITADAS ─────────────────────────────────────────────────────────
async function gerarRelatorioQuitados() {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length) return 'Nenhuma movimenta\u00e7\u00e3o registrada ainda.';
    const quitados=Object.keys(historico).filter(n=>!(saldos[n]>0));
    if(!quitados.length) return 'Nenhum cliente quitado ainda.';
    quitados.sort();
    let resposta='*Compras Quitadas*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    for(const nome of quitados){
      const movs=historico[nome];
      const totalPago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);
      resposta+=`\n*${nome}*\n`;
      for(const m of movs){
        if(m.tipo==='Compra') resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        else if(m.tipo==='Pagamento') resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
      }
      resposta+=`  \u2705 Quitado | Total pago: R$ ${totalPago.toFixed(2)}\n`;
    }
    resposta+=`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\u2705 *${quitados.length} cliente(s) com conta quitada*`;
    return resposta;
  } catch(err){console.error('Erro relatorio quitados:',err.message);return '\u274c Erro ao gerar relat\u00f3rio de quitados.';}
}

// ─── SALDO INDIVIDUAL ─────────────────────────────────────────────────────────
async function gerarSaldoIndividual(nomeDigitado) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon){
      const{historico,saldos}=await carregarHistoricoAgrupado();
      const nomeHist=resolverNome(nomeDigitado,Object.keys(historico));
      if(nomeHist && !(saldos[nomeHist]>0))
        return `\u2705 *${nomeHist}* n\u00e3o tem d\u00edvidas em aberto. Conta quitada!`;
      return `\u274c Nenhuma movimenta\u00e7\u00e3o encontrada para *${capitalizarNome(nomeDigitado)}*.`;
    }
    const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
    if(!rowsCliente.length) return `\u2705 *${nomeCanon}* n\u00e3o tem d\u00edvidas em aberto.`;
    let totalDevido=0;
    let resposta=`*${nomeCanon}*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
    for(const row of rowsCliente){
      const produto=norm(row.get('Produto')||'');
      const qtd=parseInt(row.get('Quantidade')||'0');
      const total=parseFloat(row.get('Total')||'0');
      resposta+=`${nomeProdutoExib(produto)}: ${qtd} unid. = R$ ${total.toFixed(2)}\n`;
      totalDevido+=total;
    }
    resposta+=`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n*Total devido: R$ ${totalDevido.toFixed(2)}*`;
    return resposta;
  } catch(err){console.error('Erro saldo:',err.message);return '\u274c Erro ao consultar saldo.';}
}

// ─── HISTORICO INDIVIDUAL ─────────────────────────────────────────────────────
async function gerarHistoricoCliente(nomeDigitado, filtroMes) {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado(filtroMes||null);
    const nomesConhecidos=Object.keys(historico);
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon||!historico[nomeCanon]) return `\u274c Nenhum hist\u00f3rico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const movs=historico[nomeCanon];
    const saldoAtual=saldos[nomeCanon]||0;
    const labelMes = filtroMes ? ` — ${capitalizarNome(filtroMes)}` : '';
    let resposta=`*Hist\u00f3rico de ${nomeCanon}${labelMes}*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
    let totalComprado=0, totalPago=0;
    for(const m of movs){
      if(m.tipo==='Compra'){
        resposta+=`Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        totalComprado+=m.valor;
      } else if(m.tipo==='Pagamento'){
        resposta+=`Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        totalPago+=m.valor;
      }
    }
    resposta+=`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
    resposta+=`Total comprado: R$ ${totalComprado.toFixed(2)}\n`;
    resposta+=`Total pago: R$ ${totalPago.toFixed(2)}\n`;
    resposta+=saldoAtual>0
      ?`*Saldo devedor: R$ ${saldoAtual.toFixed(2)}*`
      :'\u2705 *Conta quitada!*';
    return resposta;
  } catch(err){console.error('Erro historico:',err.message);return '\u274c Erro ao consultar hist\u00f3rico.';}
}

// ─── HELPER: getDocComSheets ──────────────────────────────────────────────────
async function getDocComSheets() {
  const doc = await getDoc();
  const sheetSaldo = doc.sheetsByIndex[0];
  const sheetHistorico = doc.sheetCount >= 2
    ? doc.sheetsByIndex[1]
    : await doc.addSheet({title:'Historico',headerValues:['Data','Cliente','Tipo','Produto','Quantidade','Valor']});
  return { doc, sheetSaldo, sheetHistorico };
}

// ─── PROCESSAR MENSAGEM ───────────────────────────────────────────────────────
async function processarMensagem(sock, msg, jidGrupo) {
  try {
    const jid = msg.key.remoteJid;
    if (jid !== jidGrupo) return;

    let texto = null;

    // Áudio: tenta transcrever via Groq
    const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
    if (msg.message?.audioMessage && GROQ_API_KEY) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg; codecs=opus';
        const transcrito = await transcreverAudio(buffer, mimeType);
        if (transcrito) {
          texto = limparTranscricao(corrigirTranscricao(transcrito));
          console.log('[VOZ] Transcrito:', texto);
        }
      } catch (e) {
        console.error('[VOZ] Erro ao transcrever áudio:', e.message);
      }
    }

    // Texto normal
    if (!texto) {
      texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || null;
    }

    if (!texto) return;

    const t = norm(texto);
    const partes = t.split(/\s+/).filter(Boolean);
    if (!partes.length) return;

    const responder = async (conteudo) => {
      await sock.sendMessage(jidGrupo, { text: conteudo }, { quoted: msg });
    };

    // ── AJUDA ──────────────────────────────────────────────────────────────────
    if (t === 'ajuda' || t === 'help' || t === '?') {
      return responder(
        '*Comandos disponíveis:*\n' +
        '─────────────────\n' +
        '*Registrar compra:* nome quantidade produto\n' +
        '  Ex: _julia 2 trufas_\n\n' +
        '*Registrar pagamento (valor):* nome pagou valor\n' +
        '  Ex: _julia pagou 10_ ou _julia pix 15_\n\n' +
        '*Registrar pagamento (produto):* nome pagou qtd produto\n' +
        '  Ex: _julia pagou 2 trufas_\n\n' +
        '*Ver saldo:* saldo nome\n' +
        '  Ex: _saldo julia_\n\n' +
        '*Histórico:* historico nome [mes]\n' +
        '  Ex: _historico julia_ ou _historico julia junho_\n\n' +
        '*Cancelar último:* cancelar nome\n' +
        '  Ex: _cancelar julia_\n\n' +
        '*Relatório geral:* relatorio\n' +
        '*Relatório detalhado:* resumo\n' +
        '*Quitados:* quitados\n' +
        '*Preços:* precos\n' +
        '*Produtos:* produtos'
      );
    }

    // ── PREÇOS ────────────────────────────────────────────────────────────────
    if (t === 'precos' || t === 'preco' || t === 'valor' || t === 'valores') {
      const lista = Object.entries(PRECOS)
        .map(([p, v]) => `${emojiProduto(p)} ${nomeProdutoExib(p)}: R$ ${v.toFixed(2)}`)
        .join('\n');
      return responder(`*Tabela de Preços:*\n─────────────────\n${lista}`);
    }

    // ── DEFINIR PREÇO: preco trufa 6 ─────────────────────────────────────────
    if (partes[0] === 'preco' && partes.length === 3) {
      const prod = toProduto(partes[1]);
      const val  = parseFloat(partes[2].replace(',', '.'));
      if (prod && !isNaN(val) && val > 0) {
        PRECOS[prod] = val;
        salvarPrecos();
        return responder(`\u2705 Preço de ${nomeProdutoExib(prod)} atualizado para R$ ${val.toFixed(2)}.`);
      }
    }

    // ── PRODUTOS ──────────────────────────────────────────────────────────────
    if (t === 'produtos') {
      const lista = Object.keys(todosOsSinonimos())
        .map(p => `${emojiProduto(p)} ${nomeProdutoExib(p)}`)
        .join('\n');
      return responder(`*Produtos cadastrados:*\n─────────────────\n${lista}`);
    }

    // ── RELATÓRIO GERAL ───────────────────────────────────────────────────────
    if (t === 'relatorio' || t === 'rel') {
      return responder(await gerarRelatorioGeral());
    }

    // ── RELATÓRIO DETALHADO ───────────────────────────────────────────────────
    if (t === 'resumo' || t === 'detalhado') {
      return responder(await gerarRelatorioDetalhado());
    }

    // ── QUITADOS ──────────────────────────────────────────────────────────────
    if (t === 'quitados' || t === 'pagos') {
      return responder(await gerarRelatorioQuitados());
    }

    // ── SALDO: saldo nome ─────────────────────────────────────────────────────
    if (partes[0] === 'saldo' && partes.length >= 2) {
      const nome = partes.slice(1).join(' ');
      return responder(await gerarSaldoIndividual(nome));
    }

    // ── HISTÓRICO: historico nome [mes] ───────────────────────────────────────
    // Suporta: "historico julia", "historico julia junho", "historico julia 06"
    if ((partes[0] === 'historico' || partes[0] === 'hist') && partes.length >= 2) {
      const resto = partes.slice(1);
      // Verifica se a última palavra é um mês válido
      let filtroMes = null;
      let nomeParts = resto;
      if (resto.length >= 2 && isMes(resto[resto.length - 1])) {
        filtroMes = resto[resto.length - 1];
        nomeParts = resto.slice(0, -1);
      }
      const nomeRaw = nomeParts.join(' ');
      return responder(await gerarHistoricoCliente(nomeRaw, filtroMes));
    }

    // ── CANCELAR: cancelar nome ───────────────────────────────────────────────
    if (partes[0] === 'cancelar' && partes.length >= 2) {
      const nome = partes.slice(1).join(' ');
      return responder(await cancelarLancamento(jid, nome));
    }

    // ── ZERAR: zerar nome ─────────────────────────────────────────────────────
    if (partes[0] === 'zerar' && partes.length >= 2) {
      try {
        const nome = partes.slice(1).join(' ');
        const sheet = await getSheetSaldo();
        const rows  = await sheet.getRows();
        const nomesConhecidos = [...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
        const nomeCanon = resolverNome(nome, nomesConhecidos);
        if (!nomeCanon) return responder(`\u274c Cliente *${capitalizarNome(nome)}* não encontrado.`);
        const rowsC = rows.filter(r => r.get('Cliente') === nomeCanon);
        for (const r of rowsC) await r.delete();
        return responder(`\u2705 Dívida de *${nomeCanon}* zerada com sucesso.`);
      } catch(e) {
        return responder('\u274c Erro ao zerar dívida.');
      }
    }

    // ── PAGAMENTO: nome pagou/pix/transferiu [qtd produto | valor] ────────────
    const verboPag = ['pagou','pix','transferiu','transfere','depositou','mandou','enviou'];
    const idxVerbo = partes.findIndex(p => verboPag.includes(p));
    if (idxVerbo > 0) {
      const nomeDigitado = partes.slice(0, idxVerbo).join(' ');
      const resto = partes.slice(idxVerbo + 1);

      // Tenta: nome pagou qtd produto
      if (resto.length >= 2) {
        const qtd = toNumero(resto[0]);
        const prod = toProduto(resto.slice(1).join(' '));
        if (qtd && prod) {
          const result = await processarPagamentoProduto(nomeDigitado, qtd, prod, jid);
          return responder(result.msg);
        }
      }

      // Tenta: nome pagou valor
      const valorStr = resto.join(' ');
      const valor = extrairValor(valorStr);
      if (valor && valor > 0) {
        const result = await processarPagamentoValor(nomeDigitado, valor, jid);
        return responder(result.msg);
      }

      return responder(`\u274c Não entendi o pagamento. Ex: _julia pagou 10_ ou _julia pagou 2 trufas_`);
    }

    // ── COMPRA: nome qtd produto ──────────────────────────────────────────────
    if (partes.length >= 3) {
      let qtdIdx = -1, qtd = null;
      for (let i = 0; i < partes.length; i++) {
        const n = toNumero(partes[i]);
        if (n) { qtdIdx = i; qtd = n; break; }
      }
      if (qtdIdx > 0 && qtd) {
        const nomeDigitado = partes.slice(0, qtdIdx).join(' ');
        const prodStr = partes.slice(qtdIdx + 1).join(' ');
        const prod = toProduto(prodStr);
        if (prod) {
          const result = await registrarOuAcumular(nomeDigitado, prod, qtd);
          if (!result) return responder('\u274c Erro ao registrar. Tente novamente.');
          if (result.limiteBloqueado) {
            return responder(
              `\u26a0\ufe0f *${result.cliente}* atingiu o limite de crédito de R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}.\n` +
              `Saldo atual: R$ ${result.totalAtual.toFixed(2)} | Novo lançamento: R$ ${result.valorNovo.toFixed(2)}`
            );
          }
          pushLancamento(jid, { tipo: 'compra', cliente: result.cliente, produto: prod, quantidade: qtd, valor: qtd * (PRECOS[prod] || 0) });
          return responder(
            `${emojiProduto(prod)} *${result.cliente}* — ${result.qtdAcumulada}x ${nomeProdutoExib(prod)}\n` +
            `Total: R$ ${result.totalAcumulado.toFixed(2)}`
          );
        }
      }
    }

  } catch (e) {
    console.error('[processarMensagem] Erro:', e.message);
  }
}

// ─── CONECTAR BOT ─────────────────────────────────────────────────────────────
async function conectarBot() {
  try {
    restaurarSessao();

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    sockGlobal = sock;
    console.log('\u2705 makeWASocket inicializado — sockGlobal pronto.');

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await salvarSessaoNoRender();
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        botConectado = true;
        horaConexao  = new Date();
        console.log('\u2705 Bot conectado ao WhatsApp!');

        if (!jidGrupoGlobal) {
          try {
            const grupos = await sock.groupFetchAllParticipating();
            for (const [jid, meta] of Object.entries(grupos)) {
              if (norm(meta.subject).includes(norm(GRUPO_NOME))) {
                jidGrupoGlobal     = jid;
                nomeGrupoConectado = meta.subject;
                console.log(`\u2705 Grupo encontrado: ${meta.subject} (${jid})`);
                break;
              }
            }
            if (!jidGrupoGlobal) console.warn(`\u26a0\ufe0f Grupo "${GRUPO_NOME}" não encontrado. Verifique a variável GRUPO_NOME.`);
          } catch (e) {
            console.error('Erro ao buscar grupos:', e.message);
          }
        }
      }

      if (connection === 'close') {
        botConectado = false;
        sockGlobal   = null;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`Conexão encerrada. Código: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Sessão encerrada (loggedOut). Limpando credenciais...');
          await limparCREDSnoRender();
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
          setTimeout(conectarBot, 3000);
        } else if (
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === DisconnectReason.connectionClosed  ||
          statusCode === DisconnectReason.timedOut
        ) {
          console.log('Reconectando em 5s...');
          setTimeout(conectarBot, 5000);
        } else {
          console.log('Reconectando em 10s...');
          setTimeout(conectarBot, 10000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!jidGrupoGlobal) continue;
        await processarMensagem(sock, msg, jidGrupoGlobal);
      }
    });

  } catch (e) {
    console.error('Erro em conectarBot():', e.message);
    setTimeout(conectarBot, 10000);
  }
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
conectarBot();
