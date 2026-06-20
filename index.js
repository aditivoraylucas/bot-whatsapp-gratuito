process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs   = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const http = require('http');
const pino = require('pino');
const FormData = require('form-data');

const GRUPO_NOME    = process.env.GRUPO_NOME   || 'vendas';
const SPREADSHEET_ID               = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY           = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const PORT              = process.env.PORT   || 3000;
const RENDER_API_KEY    = process.env.RENDER_API_KEY    || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';
const GROQ_API_KEY      = process.env.GROQ_API_KEY      || '';

const AUTH_DIR = 'auth_info';

// ─── ESTADO GLOBAL ──────────────────────────────────────────────────────
let botConectado       = false;
let pairingCode        = null;
let pairingPhone       = null;
let sockGlobal         = null;
let jidGrupoGlobal     = null;
let agendamentosIniciados = false;
let reconectando       = false;
let tentativasReconexao = 0;
const MAX_BACKOFF_MS    = 60_000;

function delayReconexao() {
  const delay = Math.min(5000 * Math.pow(1.5, tentativasReconexao), MAX_BACKOFF_MS);
  tentativasReconexao++;
  return delay;
}

// ─── DEBOUNCE PARA SALVAR SESSÃO NO RENDER ───────────────────────────────
// O Baileys dispara creds.update várias vezes por segundo durante a conexão.
// Sem debounce, cada disparo faria um PUT na API do Render, causando redeploy
// em loop. Com debounce de 30s, só salva após 30s sem novas atualizações.
let _salvarSessaoTimer = null;
function agendarSalvarSessao() {
  if (_salvarSessaoTimer) clearTimeout(_salvarSessaoTimer);
  _salvarSessaoTimer = setTimeout(async () => {
    _salvarSessaoTimer = null;
    await salvarSessaoNoRender();
  }, 30_000);
}

// ─── RETRY PARA GOOGLE SHEETS ────────────────────────────────────────────
async function comRetry(fn, tentativas = 8, delayMs = 5000) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message || '';
      const reintentavel =
        msg.includes('Premature close') ||
        msg.includes('ECONNRESET') ||
        msg.includes('socket hang up') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('fetch failed') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('network') ||
        msg.includes('connect ETIMEDOUT') ||
        msg.includes('read ECONNRESET') ||
        msg.includes('getaddrinfo') ||
        msg.includes('Invalid response body') ||
        msg.includes('invalid_grant') ||
        msg.includes('Could not refresh access token') ||
        msg.includes('No access') ||
        msg.includes('token') ||
        msg.includes('oauth');
      if (reintentavel && i < tentativas - 1) {
        const espera = delayMs * Math.pow(1.5, i);
        console.log(`Google Sheets: erro de rede/token (${msg.split('\n')[0]}), tentativa ${i + 2}/${tentativas} em ${Math.round(espera / 1000)}s...`);
        _jwtInstance = null;
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw err;
      }
    }
  }
}

// ─── SERVIDOR HTTP ──────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/solicitar-codigo') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        const params = new URLSearchParams(body);
        const phone  = (params.get('phone') || '').replace(/\D/g, '');
        if (!phone || phone.length < 10) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paginaFormulario('⚠️ Número inválido. Tente novamente.', ''));
          return;
        }
        if (botConectado) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paginaConectado());
          return;
        }
        if (!sockGlobal) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paginaFormulario('⏳ Bot ainda iniciando. Aguarde 10s e tente novamente.', ''));
          return;
        }
        try {
          const code = await sockGlobal.requestPairingCode(phone);
          pairingCode  = code;
          pairingPhone = phone;
          console.log(`Pairing code para ${phone}: ${code}`);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paginaFormulario('', code));
        } catch (e) {
          console.error('Erro ao gerar pairing code:', e.message);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(paginaFormulario('❌ Erro ao gerar código: ' + e.message, ''));
        }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(botConectado ? paginaConectado() : paginaFormulario('', pairingCode || ''));
  } catch (e) {
    res.end('<html><body><h1>Carregando...</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
}).listen(PORT, () => console.log(`✅ Servidor rodando na porta ${PORT}`));

// ─── TEMPLATES HTML ──────────────────────────────────────────────────────
function paginaConectado() {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Bot WhatsApp</title>
  <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
  .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px #0001;text-align:center;max-width:400px;width:90%}
  h1{color:#25D366}p{color:#555}</style></head>
  <body><div class="card"><h1>✅ Bot Conectado!</h1><p>Funcionando normalmente.</p></div></body></html>`;
}

function paginaFormulario(erro, codigo) {
  const codigoHTML = codigo
    ? `<div class="code-box">
        <p class="label">Seu código de vinculação:</p>
        <div class="code">${codigo}</div>
        <p class="instrucoes">📱 No WhatsApp: <strong>Configurações → Aparelhos conectados → Conectar com número de telefone</strong> e digite o código acima.</p>
       </div>`
    : '';
  const erroHTML = erro ? `<p class="erro">${erro}</p>` : '';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Conectar Bot WhatsApp</title>
  <style>
    body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
    .card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px #0001;text-align:center;max-width:420px;width:90%}
    h1{color:#25D366;margin-bottom:8px}p.sub{color:#888;margin-bottom:24px;font-size:14px}
    input[type=tel]{width:100%;padding:12px 16px;border:2px solid #ddd;border-radius:8px;font-size:16px;box-sizing:border-box;outline:none;transition:border .2s}
    input[type=tel]:focus{border-color:#25D366}
    button{margin-top:14px;width:100%;padding:13px;background:#25D366;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;transition:background .2s}
    button:hover{background:#1da851}
    .code-box{margin-top:24px;background:#f6fff9;border:2px solid #25D366;border-radius:12px;padding:20px}
    .code{font-size:36px;font-weight:900;letter-spacing:8px;color:#25D366;margin:8px 0}
    .label{color:#555;font-size:13px;margin:0}.instrucoes{font-size:13px;color:#444;margin-top:10px;line-height:1.5}
    .erro{color:#e53935;background:#fff3f3;border-radius:8px;padding:10px;font-size:14px;margin-top:12px}
  </style></head>
  <body><div class="card">
    <h1>📱 Conectar Bot</h1>
    <p class="sub">Digite seu número do WhatsApp para receber o código de vinculação</p>
    <form method="POST" action="/solicitar-codigo">
      <input type="tel" name="phone" placeholder="Ex: 5511999999999" required autofocus />
      <button type="submit">Gerar código</button>
    </form>
    ${erroHTML}
    ${codigoHTML}
  </div></body></html>`;
}

// ─── TRANSCRIÇÃO DE ÁUDIO VIA GROQ WHISPER ──────────────────────────────
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
    if (!res.ok) { console.error('Groq erro:', await res.text()); return null; }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) { console.error('Erro transcrição Groq:', e.message); return null; }
}

function limparTranscricao(texto) {
  if (!texto) return texto;
  return texto.replace(/([^\s])([.!?,;:]+)(\s|$)/g, '$1$3').replace(/\s+/g, ' ').trim();
}

const CORRECOES_VOZ = {
  'saudo':'saldo','saud':'saldo','salvo':'saldo','salda':'saldo','saldos':'saldo',
  'relatorio':'relatorio','relatorios':'relatorio','relato':'relatorio',
  'rezumo':'resumo','resuno':'resumo','istorico':'historico','historico':'historico',
  'cancelado':'cancelar','cancela':'cancelar','cancelas':'cancelar',
  'zera':'zerar','ajudas':'ajuda','produto':'produtos',
  'pagou':'pagou','pagol':'pagou','pago':'pagou','pix':'pix','pics':'pix','pik':'pix',
  'transferio':'transferiu','transferiou':'transferiu',
  'trufa':'trufa','trufas':'trufas','trufinha':'trufinha',
  'bolo':'bolo','bolos':'bolos','bombon':'bombom','bombons':'bombons',
};
function corrigirPalavra(palavra) { const n=norm(palavra); return CORRECOES_VOZ[n]||palavra; }
function corrigirTranscricao(texto) {
  if(!texto) return texto;
  return texto.split(/\s+/).map(p=>corrigirPalavra(p)).join(' ');
}

// ─── PRECOS E PRODUTOS ────────────────────────────────────────────────────
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
function isMes(str) { const n=norm(str); return MESES_VALIDOS.has(n)||/^\d{1,2}$/.test(n); }

const ULTIMOS_LANCAMENTOS = {};
const MAX_HIST_CANCEL = 10;
function pushLancamento(jid, obj) {
  if (!ULTIMOS_LANCAMENTOS[jid]) ULTIMOS_LANCAMENTOS[jid] = [];
  ULTIMOS_LANCAMENTOS[jid].push(obj);
  if (ULTIMOS_LANCAMENTOS[jid].length > MAX_HIST_CANCEL) ULTIMOS_LANCAMENTOS[jid].shift();
}

function norm(t) {
  return (t||'')
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g,'')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
}
function levenshtein(a,b) {
  const m=a.length,n=b.length,dp=Array.from({length:m+1},(_,i)=>[i]);
  for(let j=1;j<=n;j++) dp[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
function nomesFuzzyIguais(digitado,cadastrado) {
  const na=norm(digitado).split(/\s+/).filter(Boolean);
  const nb=norm(cadastrado).split(/\s+/).filter(Boolean);
  if(na.length!==nb.length) return false;
  for(let i=0;i<na.length;i++){
    const maxLen=Math.max(na[i].length,nb[i].length);
    if(levenshtein(na[i],nb[i])>(maxLen<=5?1:2)) return false;
  }
  return true;
}
function resolverNome(digitado,nomesConhecidos) {
  if(!digitado||!nomesConhecidos||!nomesConhecidos.length) return null;
  const nd=norm(digitado);
  for(const c of nomesConhecidos) if(norm(c)===nd) return c;
  for(const c of nomesConhecidos) if(nomesFuzzyIguais(digitado,c)) return c;
  return null;
}
function mesmoNome(a,b){return norm(a)===norm(b)||nomesFuzzyIguais(a,b);}
function toNumero(p){const n=norm(p);if(/^\d+$/.test(n))return parseInt(n);return NUMEROS_EXTENSO[n]??null;}
function todosOsSinonimos(){const m={...SINONIMOS};for(const[k,v]of Object.entries(SINONIMOS_EXTRA))m[k]=(m[k]||[]).concat(v);return m;}
function toProduto(trecho){
  const n=norm(trecho);if(!n)return null;
  for(const[produto,sins]of Object.entries(todosOsSinonimos()))for(const sin of sins)if(n===norm(sin))return produto;
  return null;
}
function extrairValor(texto){
  if(!texto)return null;
  const t=norm(texto).replace(/r\$\s*/g,' ').replace(/\b(reais|pix|de|transferiu|depositou|mandou|enviou|pagou)\b/g,' ').trim();
  const m=t.match(/(\d+[,.]?\d*)/);
  if(!m)return null;
  const val=parseFloat(m[1].replace(',','.'));
  return isNaN(val)?null:val;
}
function agora(){return new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});}
function agoraData(){return new Date().toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});}
function soData(str){if(!str)return '';return(str.trim().split(' ')[0])||str.trim();}
function capitalizarNome(n){if(!n)return '';return n.trim().split(' ').map(p=>p.charAt(0).toUpperCase()+p.slice(1).toLowerCase()).join(' ');}
function nomeProdutoExib(produto){
  if(produto==='bolo')return 'Bolo';
  if(produto==='trufa')return 'Trufa';
  return capitalizarNome(produto.replace(/_/g,' '));
}

function restaurarSessao(){
  try{
    const credsJson=process.env.CREDS_JSON;
    if(!credsJson)return false;
    if(!fs.existsSync(AUTH_DIR))fs.mkdirSync(AUTH_DIR,{recursive:true});
    fs.writeFileSync(path.join(AUTH_DIR,'creds.json'),credsJson,'utf8');
    console.log('Sessao restaurada do CREDS_JSON');
    return true;
  }catch(e){console.error('Erro ao restaurar sessao:',e.message);return false;}
}

async function salvarSessaoNoRender(){
  try{
    if(!RENDER_API_KEY||!RENDER_SERVICE_ID)return;
    const credsPath=path.join(AUTH_DIR,'creds.json');
    if(!fs.existsSync(credsPath))return;
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
  }catch(e){console.error('Erro ao salvar sessao:',e.message);}
}

// ─── AUTENTICAÇÃO GOOGLE COM CACHE E RETRY DE TOKEN ──────────────────────────
let _jwtInstance = null;

function getAuth() {
  if (!_jwtInstance) {
    _jwtInstance = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key:   GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      keyAlgorithm: 'RS256',
    });
  }
  return _jwtInstance;
}

async function preAquecerToken() {
  try {
    const auth = getAuth();
    await auth.getAccessToken();
    console.log('Token OAuth Google pré-aquecido com sucesso.');
  } catch (e) {
    console.warn('Aviso: falha ao pré-aquecer token OAuth:', e.message);
    _jwtInstance = null;
  }
}

// Renova o token a cada 10 minutos para evitar expiração no plano gratuito do Render
setInterval(async () => {
  try {
    _jwtInstance = null;
    const auth = getAuth();
    await auth.getAccessToken();
    console.log('Token OAuth Google renovado.');
  } catch (e) {
    console.warn('Aviso: falha ao renovar token OAuth:', e.message);
    _jwtInstance = null;
  }
}, 10 * 60 * 1000);

// Força reset do JWT antes de cada operação para garantir token fresco
async function getDoc(){return await comRetry(async()=>{_jwtInstance=null;const doc=new GoogleSpreadsheet(SPREADSHEET_ID,getAuth());await doc.loadInfo();return doc;});}
async function getSheetSaldo(){return(await getDoc()).sheetsByIndex[0];}
async function getSheetHistorico(){
  const doc=await getDoc();
  if(doc.sheetCount<2)return await comRetry(()=>doc.addSheet({title:'Historico',headerValues:['Data','Cliente','Tipo','Produto','Quantidade','Valor']}));
  const sheet=doc.sheetsByIndex[1];
  try{await comRetry(()=>sheet.loadHeaderRow());}catch(e){await comRetry(()=>sheet.setHeaderRow(['Data','Cliente','Tipo','Produto','Quantidade','Valor']));}
  return sheet;
}

async function registrarOuAcumular(clienteEnviado,produto,quantidade){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const precoAtual=PRECOS[produto]||0,valorNovo=precoAtual*quantidade;
      const existente=rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
      const cliente=existente?existente.get('Cliente'):capitalizarNome(clienteEnviado);
      if(LIMITE_CREDITO_PADRAO>0){
        const rowsC=rows.filter(r=>mesmoNome(r.get('Cliente'),clienteEnviado));
        const totalAtual=rowsC.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
        if(totalAtual+valorNovo>LIMITE_CREDITO_PADRAO)return{cliente,limiteBloqueado:true,totalAtual,valorNovo};
      }
      if(existente){
        const qtdAcumulada=parseInt(existente.get('Quantidade')||'0')+quantidade;
        const totalAcumulado=parseFloat(existente.get('Total')||'0')+valorNovo;
        existente.set('Quantidade',qtdAcumulada);existente.set('Total',totalAcumulado.toFixed(2));existente.set('UltimaCompra',agora());
        await existente.save();
        await(await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)});
        return{cliente,totalAcumulado,qtdAcumulada};
      }else{
        await sheet.addRow({Cliente:cliente,Produto:produto,Quantidade:quantidade,Total:valorNovo.toFixed(2),UltimaCompra:agora()});
        await(await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Compra',Produto:produto,Quantidade:quantidade,Valor:valorNovo.toFixed(2)});
        return{cliente,totalAcumulado:valorNovo,qtdAcumulada:quantidade};
      }
    });
  }catch(err){console.error('Erro planilha:',err.message);return null;}
}

async function cancelarLancamento(jid,nomeDigitado){
  try{
    const hist=ULTIMOS_LANCAMENTOS[jid]||[];
    let idx=-1;
    for(let i=hist.length-1;i>=0;i--){if(mesmoNome(hist[i].cliente,nomeDigitado)){idx=i;break;}}
    if(idx<0)return `❌ Nenhum lançamento recente encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const lanc=hist[idx];hist.splice(idx,1);
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const sheetH=await getSheetHistorico(),rowsH=await sheetH.getRows();
      if(lanc.tipo==='compra'){
        const row=rows.find(r=>r.get('Cliente')===lanc.cliente&&norm(r.get('Produto'))===norm(lanc.produto));
        if(row){const nq=parseInt(row.get('Quantidade')||'0')-lanc.quantidade,nt=parseFloat(row.get('Total')||'0')-lanc.valor;
          if(nq<=0||nt<=0)await row.delete();else{row.set('Quantidade',nq);row.set('Total',nt.toFixed(2));await row.save();}}
        for(let i=rowsH.length-1;i>=0;i--)if(rowsH[i].get('Cliente')===lanc.cliente&&norm(rowsH[i].get('Produto'))===norm(lanc.produto)&&rowsH[i].get('Tipo')==='Compra'){await rowsH[i].delete();break;}
        return `↗️ Lançamento cancelado: *${lanc.cliente}* - ${lanc.quantidade}x ${nomeProdutoExib(lanc.produto)} (R$ ${lanc.valor.toFixed(2)})`;
      }
      if(lanc.tipo==='pagamento'){
        const rowsC=rows.filter(r=>mesmoNome(r.get('Cliente'),lanc.cliente));
        if(rowsC.length){let restante=lanc.valor;for(const r of rowsC){if(restante<=0)break;r.set('Total',(parseFloat(r.get('Total')||'0')+restante).toFixed(2));await r.save();restante=0;}}
        else{const produto=lanc.produto&&lanc.produto!=='geral'?lanc.produto:'trufa';await sheet.addRow({Cliente:lanc.cliente,Produto:produto,Quantidade:0,Total:lanc.valor.toFixed(2),UltimaCompra:agora()});}
        for(let i=rowsH.length-1;i>=0;i--)if(rowsH[i].get('Cliente')===lanc.cliente&&rowsH[i].get('Tipo')==='Pagamento'){await rowsH[i].delete();break;}
        return `↗️ Pagamento cancelado: *${lanc.cliente}* - R$ ${lanc.valor.toFixed(2)} devolvido ao saldo.`;
      }
      return '❌ Não foi possível cancelar.';
    });
  }catch(err){console.error('Erro cancelar:',err.message);return '❌ Erro ao cancelar lançamento.';}
}

async function processarPagamentoProduto(clienteEnviado,quantidade,produto,jid){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const row=rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
      if(!row)return{ok:false,msg:`❌ Nenhuma dívida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.`};
      const qtdAtual=parseInt(row.get('Quantidade')||'0'),qtdPaga=Math.min(quantidade,qtdAtual),novaQtd=qtdAtual-qtdPaga;
      const totalAtual=parseFloat(row.get('Total')||'0'),pago=qtdAtual>0?(totalAtual/qtdAtual)*qtdPaga:0;
      if(jid)pushLancamento(jid,{tipo:'pagamento',cliente:row.get('Cliente'),produto,quantidade:qtdPaga,valor:pago});
      await(await getSheetHistorico()).addRow({Data:agora(),Cliente:row.get('Cliente'),Tipo:'Pagamento',Produto:produto,Quantidade:qtdPaga,Valor:pago.toFixed(2)});
      if(novaQtd===0){await row.delete();return{ok:true,msg:`✅ *${row.get('Cliente')}* quitou toda a dívida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.`};}
      row.set('Quantidade',novaQtd);row.set('Total',(totalAtual-pago).toFixed(2));await row.save();
      return{ok:true,msg:`✅ *${row.get('Cliente')}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${(totalAtual-pago).toFixed(2)}`};
    });
  }catch(err){console.error('Erro pag produto:',err.message);return{ok:false,msg:'❌ Erro ao registrar pagamento.'};  }
}

async function processarPagamentoValor(clienteEnviado,valorPago,jid){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const nomeCanon=resolverNome(clienteEnviado,[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))]);
      const rowsCliente=nomeCanon?rows.filter(r=>r.get('Cliente')===nomeCanon):rows.filter(r=>mesmoNome(r.get('Cliente'),clienteEnviado));
      if(!rowsCliente.length)return{ok:false,msg:`❌ Nenhuma dívida encontrada para *${capitalizarNome(clienteEnviado)}*.`};
      const cliente=rowsCliente[0].get('Cliente');
      const totalDevido=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
      if(jid)pushLancamento(jid,{tipo:'pagamento',cliente,produto:'geral',quantidade:'-',valor:valorPago});
      await(await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:valorPago.toFixed(2)});
      if(valorPago>=totalDevido){for(const r of rowsCliente)await r.delete();return{ok:true,msg:`✅ *${cliente}* quitou toda a dívida! Pagou R$ ${valorPago.toFixed(2)}.`};}
      let restante=valorPago;
      for(const r of rowsCliente){
        if(restante<=0)break;
        const totalRow=parseFloat(r.get('Total')||'0');
        if(restante>=totalRow){restante-=totalRow;await r.delete();}
        else{const novoTotal=totalRow-restante,qtdAtual=parseInt(r.get('Quantidade')||'0'),novaQtd=totalRow>0?Math.round(qtdAtual*(novoTotal/totalRow)):0;
          r.set('Total',novoTotal.toFixed(2));r.set('Quantidade',Math.max(novaQtd,0));await r.save();restante=0;}
      }
      return{ok:true,msg:`✅ *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido-valorPago).toFixed(2)}`};
    });
  }catch(err){console.error('Erro pag valor:',err.message);return{ok:false,msg:'❌ Erro ao registrar pagamento.'};  }
}

async function gerarRelatorioGeral(){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      if(!rows.length)return 'Nenhuma dívida em aberto no momento.';
      const clientes={};
      for(const row of rows){
        const nome=(row.get('Cliente')||'').trim(),produto=norm(row.get('Produto')||'');
        const quantidade=parseInt(row.get('Quantidade')||'0'),total=parseFloat(row.get('Total')||'0');
        if(!nome||!produto)continue;
        if(!clientes[nome])clientes[nome]={itens:[],totalDevido:0};
        clientes[nome].itens.push({produto,quantidade,total});clientes[nome].totalDevido+=total;
      }
      if(!Object.keys(clientes).length)return 'Nenhuma dívida em aberto no momento.';
      const ordenados=Object.entries(clientes).sort((a,b)=>b[1].totalDevido-a[1].totalDevido);
      let resp='*Relatório de Dívidas*\n───────────────\n',totalGeral=0;
      for(const[nome,dados]of ordenados){resp+=`\n*${nome}*\n`;for(const item of dados.itens)resp+=`  ${nomeProdutoExib(item.produto)}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;resp+=`  *Total: R$ ${dados.totalDevido.toFixed(2)}*\n`;totalGeral+=dados.totalDevido;}
      return resp+`\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    });
  }catch(err){console.error('Erro relatorio:',err.message);return '❌ Erro ao gerar relatório.';}
}

async function carregarHistoricoAgrupado(filtroMes){
  return await comRetry(async()=>{
    const doc=await getDoc(),rowsSaldo=await doc.sheetsByIndex[0].getRows(),saldos={};
    for(const row of rowsSaldo){const nome=(row.get('Cliente')||'').trim(),total=parseFloat(row.get('Total')||'0');if(!nome)continue;if(!saldos[nome])saldos[nome]=0;saldos[nome]+=total;}
    if(doc.sheetCount<2)return{historico:{},saldos};
    const sheetHist=doc.sheetsByIndex[1];
    try{await sheetHist.loadHeaderRow();}catch(e){return{historico:{},saldos};}
    const rowsHist=await sheetHist.getRows(),nomesCanonicos=[...Object.keys(saldos)],historico={};
    for(const row of rowsHist){
      const nomeRaw=(row.get('Cliente')||'').trim();if(!nomeRaw)continue;
      if(filtroMes){const data=(row.get('Data')||'').trim();if(!data)continue;const partes=data.split(' ')[0].split('/');if(partes.length>=2){const mesNum=parseInt(partes[1]),nomesArr=['','janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'],filtroNorm=norm(filtroMes),filtroNumero=parseInt(filtroNorm),bateu=isNaN(filtroNumero)?norm(nomesArr[mesNum])===filtroNorm:mesNum===filtroNumero;if(!bateu)continue;}}
      let nomeCanon=resolverNome(nomeRaw,nomesCanonicos);if(!nomeCanon){nomesCanonicos.push(nomeRaw);nomeCanon=nomeRaw;}
      if(!historico[nomeCanon])historico[nomeCanon]=[];
      historico[nomeCanon].push({data:(row.get('Data')||'').trim(),tipo:(row.get('Tipo')||'').trim(),produto:norm(row.get('Produto')||''),qtd:(row.get('Quantidade')||'').trim(),valor:parseFloat(row.get('Valor')||'0')});
    }
    return{historico,saldos};
  });
}

async function gerarRelatorioDetalhado(){
  try{
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length)return 'Nenhuma movimentação registrada ainda.';
    const devedores=Object.keys(historico).filter(n=>(saldos[n]||0)>0);
    if(!devedores.length)return '✅ Nenhuma dívida em aberto! Todos quitados.';
    devedores.sort((a,b)=>(saldos[b]||0)-(saldos[a]||0));
    let resp='*Relatório Detalhado*\n───────────────\n',totalGeral=0;
    for(const nome of devedores){const movs=historico[nome],saldoAtual=saldos[nome]||0;resp+=`\n*${nome}*\n`;for(const m of movs){if(m.tipo==='Compra')resp+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;else if(m.tipo==='Pagamento')resp+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;}resp+=`  *Saldo devedor: R$ ${saldoAtual.toFixed(2)}*\n`;totalGeral+=saldoAtual;}
    return resp+`\n───────────────\n*TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
  }catch(err){console.error('Erro relatorio detalhado:',err.message);return '❌ Erro ao gerar relatório detalhado.';}
}

async function gerarRelatorioQuitados(){
  try{
    const{historico,saldos}=await carregarHistoricoAgrupado();
    if(!Object.keys(historico).length)return 'Nenhuma movimentação registrada ainda.';
    const quitados=Object.keys(historico).filter(n=>!(saldos[n]>0));
    if(!quitados.length)return 'Nenhum cliente quitado ainda.';
    quitados.sort();
    let resp='*Compras Quitadas*\n───────────────\n';
    for(const nome of quitados){const movs=historico[nome],totalPago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);resp+=`\n*${nome}*\n`;for(const m of movs){if(m.tipo==='Compra')resp+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;else if(m.tipo==='Pagamento')resp+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;}resp+=`  ✅ Quitado | Total pago: R$ ${totalPago.toFixed(2)}\n`;}
    return resp+`\n───────────────\n✅ *${quitados.length} cliente(s) com conta quitada*`;
  }catch(err){console.error('Erro relatorio quitados:',err.message);return '❌ Erro ao gerar relatório de quitados.';}
}

async function gerarSaldoIndividual(nomeDigitado){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
      const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
      if(!nomeCanon){const{historico,saldos}=await carregarHistoricoAgrupado();const nomeHist=resolverNome(nomeDigitado,Object.keys(historico));if(nomeHist&&!(saldos[nomeHist]>0))return `✅ *${nomeHist}* não tem dívidas em aberto. Conta quitada!`;return `❌ Nenhuma movimentação encontrada para *${capitalizarNome(nomeDigitado)}*.`;}
      const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
      if(!rowsCliente.length)return `✅ *${nomeCanon}* não tem dívidas em aberto.`;
      let totalDevido=0,resp=`*${nomeCanon}*\n───────────────\n`;
      for(const row of rowsCliente){const produto=norm(row.get('Produto')||''),qtd=parseInt(row.get('Quantidade')||'0'),total=parseFloat(row.get('Total')||'0');resp+=`${nomeProdutoExib(produto)}: ${qtd} unid. = R$ ${total.toFixed(2)}\n`;totalDevido+=total;}
      return resp+`───────────────\n*Total devido: R$ ${totalDevido.toFixed(2)}*`;
    });
  }catch(err){console.error('Erro saldo:',err.message);return '❌ Erro ao consultar saldo.';}
}

async function gerarHistoricoCliente(nomeDigitado){
  try{
    const{historico,saldos}=await carregarHistoricoAgrupado();
    const nomeCanon=resolverNome(nomeDigitado,Object.keys(historico));
    if(!nomeCanon||!historico[nomeCanon])return `❌ Nenhum histórico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const movs=historico[nomeCanon],saldoAtual=saldos[nomeCanon]||0;
    let resp=`*Histórico de ${nomeCanon}*\n───────────────\n`,totalComprado=0,totalPago=0;
    for(const m of movs){if(m.tipo==='Compra'){resp+=`Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;totalComprado+=m.valor;}else if(m.tipo==='Pagamento'){resp+=`Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;totalPago+=m.valor;}}
    resp+=`───────────────\nTotal comprado: R$ ${totalComprado.toFixed(2)}\nTotal pago: R$ ${totalPago.toFixed(2)}\n`;
    return resp+(saldoAtual>0?`*Saldo devedor: R$ ${saldoAtual.toFixed(2)}*`:'✅ *Conta quitada!*');
  }catch(err){console.error('Erro historico:',err.message);return '❌ Erro ao buscar histórico.';}
}

async function gerarRelatorioMes(mes){
  try{
    const{historico}=await carregarHistoricoAgrupado(mes);
    const nomesMes=['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesNum=parseInt(norm(mes)),nomeMesExib=isNaN(mesNum)?capitalizarNome(mes):(nomesMes[mesNum]||capitalizarNome(mes));
    const todosNomes=Object.keys(historico);
    if(!todosNomes.length)return `Nenhuma movimentação registrada em ${nomeMesExib}.`;
    let totalVendas=0,totalRecebido=0,qtdTrufa=0,qtdBolo=0,detalhe='';
    for(const nome of todosNomes.sort()){const movs=historico[nome],comprado=movs.filter(m=>m.tipo==='Compra').reduce((s,m)=>s+m.valor,0),pago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);qtdTrufa+=movs.filter(m=>m.tipo==='Compra'&&m.produto==='trufa').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);qtdBolo+=movs.filter(m=>m.tipo==='Compra'&&m.produto==='bolo').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);totalVendas+=comprado;totalRecebido+=pago;detalhe+=`\n*${nome}*: comprou R$ ${comprado.toFixed(2)} | pagou R$ ${pago.toFixed(2)}\n`;}
    return `*Relatório de ${nomeMesExib}*\n───────────────\n${detalhe}\n───────────────\nTrufas: ${qtdTrufa} unid. | Bolos: ${qtdBolo} unid.\nTotal em vendas: R$ ${totalVendas.toFixed(2)}\nTotal recebido: R$ ${totalRecebido.toFixed(2)}\nA receber: R$ ${(totalVendas-totalRecebido).toFixed(2)}`;
  }catch(err){console.error('Erro relatorio mes:',err.message);return '❌ Erro ao gerar relatório do mês.';}
}

async function gerarResumoDiario(){
  try{
    return await comRetry(async()=>{
      const hoje=agoraData(),{historico}=await carregarHistoricoAgrupado();
      let totalVendas=0,totalPago=0,qtdTrufa=0,qtdBolo=0,clientes=new Set();
      for(const[nome,movs]of Object.entries(historico)){for(const m of movs){if(soData(m.data)!==hoje)continue;if(m.tipo==='Compra'){totalVendas+=m.valor;if(m.produto==='trufa')qtdTrufa+=parseInt(m.qtd||'0');if(m.produto==='bolo')qtdBolo+=parseInt(m.qtd||'0');clientes.add(nome);}else if(m.tipo==='Pagamento')totalPago+=m.valor;}}
      const rows=await(await getSheetSaldo()).getRows(),totalAberto=rows.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
      return `*Resumo do Dia - ${hoje}*\n───────────────\nTrufas: ${qtdTrufa} | Bolos: ${qtdBolo}\nClientes atendidos: ${clientes.size}\nVendas do dia: R$ ${totalVendas.toFixed(2)}\nRecebido hoje: R$ ${totalPago.toFixed(2)}\n───────────────\nTotal em aberto: R$ ${totalAberto.toFixed(2)}`;
    });
  }catch(err){console.error('Erro resumo:',err.message);return '❌ Erro ao gerar resumo.';}
}

const DIAS_LEMBRETE=parseInt(process.env.DIAS_LEMBRETE||'7');
const HORA_LEMBRETE=parseInt(process.env.HORA_LEMBRETE||'20');
const HORA_RESUMO  =parseInt(process.env.HORA_RESUMO  ||'20');

async function verificarLembretes(sock,jid){
  try{
    await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows(),agora2=new Date(),clientes={};
      for(const row of rows){
        const nome=(row.get('Cliente')||'').trim(),total=parseFloat(row.get('Total')||'0'),ultima=(row.get('UltimaCompra')||'').trim();
        if(!nome||total<=0||!ultima)continue;
        const partes=ultima.split(' ')[0].split('/');
        if(partes.length<3)continue;
        const diasPassados=Math.floor((agora2-new Date(`${partes[2]}-${partes[1]}-${partes[0]}`))/(864e5));
        if(diasPassados>=DIAS_LEMBRETE){if(!clientes[nome])clientes[nome]={total:0,dias:diasPassados};clientes[nome].total+=total;clientes[nome].dias=Math.max(clientes[nome].dias,diasPassados);}
      }
      for(const[nome,dados]of Object.entries(clientes))await sock.sendMessage(jid,{text:`⚠️ *Lembrete de cobrança*\n*${nome}* está com R$ ${dados.total.toFixed(2)} em aberto há *${dados.dias} dias*.`});
    });
  }catch(e){console.error('Erro lembrete:',e.message);}
}

function mudarPreco(produto,novoPreco){const p=toProduto(produto);if(!p)return `❌ Produto *${produto}* não encontrado.`;const precoAntigo=PRECOS[p]||0;PRECOS[p]=novoPreco;salvarPrecos();return `✅ Preço de *${nomeProdutoExib(p)}* atualizado: R$ ${precoAntigo.toFixed(2)} → R$ ${novoPreco.toFixed(2)}\n_Saldos existentes não foram alterados. Vale para novas compras._`;}
function cadastrarNovoProduto(nomeProduto,preco){const key=norm(nomeProduto).replace(/\s+/g,'_');if(PRECOS[key]!==undefined)return `⚠️ Produto *${nomeProduto}* já existe. Para mudar o preço: _preco ${nomeProduto} R$XX_`;PRECOS[key]=preco;SINONIMOS_EXTRA[key]=[...new Set([norm(nomeProduto),nomeProduto.toLowerCase().trim()])];salvarPrecos();salvarSinonimosExtra();return `✅ Novo produto cadastrado!\n*${capitalizarNome(nomeProduto)}* = R$ ${preco.toFixed(2)}\nUso: _"cliente nome ${norm(nomeProduto)}"_`;}
function listarProdutos(){const todos=todosOsSinonimos();let msg='*Produtos cadastrados*\n───────────────\n';for(const[key]of Object.entries(todos)){const preco=PRECOS[key];if(preco===undefined)continue;msg+=`${nomeProdutoExib(key)}: R$ ${preco.toFixed(2)}\n`;}return msg+'───────────────\n_Para mudar o preço: preco [produto] [valor]_';}
async function zerarCliente(nomeDigitado){
  try{
    return await comRetry(async()=>{
      const sheet=await getSheetSaldo(),rows=await sheet.getRows();
      const nomeCanon=resolverNome(nomeDigitado,[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))]);
      if(!nomeCanon)return `❌ Cliente *${capitalizarNome(nomeDigitado)}* não encontrado.`;
      const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
      if(!rowsCliente.length)return `✅ *${nomeCanon}* já está sem dívidas.`;
      const totalZerado=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
      for(const r of rowsCliente)await r.delete();
      await(await getSheetHistorico()).addRow({Data:agora(),Cliente:nomeCanon,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:totalZerado.toFixed(2)});
      return `✅ Dívida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
    });
  }catch(err){console.error('Erro zerar:',err.message);return '❌ Erro ao zerar cliente.';}
}

const PALAVRAS_RESERVADAS=new Set(['pagou','pix','transferiu','depositou','mandou','enviou','cancelar','saldo','historico','relatorio','resumo','cobrar','lembrete','lembretes','preco','produtos','zerar','novo']);

function parsearLinha(linha){
  const limpa=linha.replace(/[.!?,;:]+(\s|$)/g,'$1').replace(/,/g,' ').replace(/\b(mais|e|de)\b/gi,' ').replace(/\+/g,' ').replace(/\s+/g,' ').trim();
  const palavrasOrig=limpa.split(' ').filter(Boolean),palavrasNorm=palavrasOrig.map(norm),n=palavrasNorm.length;
  let inicioItens=-1;
  for(let i=0;i<n;i++){const p1=toProduto(palavrasNorm[i]);if(p1){inicioItens=i;break;}const qtd=toNumero(palavrasNorm[i]);if(qtd!==null&&i+1<n){const ok2=i+2<n&&toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2]),ok1=toProduto(palavrasNorm[i+1]);if(ok2||ok1){inicioItens=i;break;}}}
  if(inicioItens<1)return null;
  const nomeRaw=palavrasOrig.slice(0,inicioItens).join(' ').trim();
  if(!nomeRaw||PALAVRAS_RESERVADAS.has(norm(nomeRaw)))return null;
  const itens=[];let i=inicioItens;
  while(i<n){const qtd=toNumero(palavrasNorm[i]);if(qtd!==null&&i+1<n){if(i+2<n){const p2=toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2]);if(p2){itens.push({quantidade:qtd,produto:p2});i+=3;continue;}}const p1=toProduto(palavrasNorm[i+1]);if(p1){itens.push({quantidade:qtd,produto:p1});i+=2;continue;}}if(i+1<n){const p2=toProduto(palavrasNorm[i]+' '+palavrasNorm[i+1]);if(p2){itens.push({quantidade:1,produto:p2});i+=2;continue;}}const p1=toProduto(palavrasNorm[i]);if(p1){itens.push({quantidade:1,produto:p1});i+=1;continue;}i++;}
  if(!itens.length)return null;
  return{nome:capitalizarNome(nomeRaw),itens};
}

function parsearPagamento(linha){
  const tNorm=norm(linha);
  if(!/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/.test(tNorm))return null;
  const kwMatch=tNorm.match(/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/);
  if(!kwMatch)return null;
  const keyword=kwMatch[1],palavrasNorm=tNorm.split(/\s+/).filter(Boolean),palavrasOrig=linha.trim().split(/\s+/).filter(Boolean);
  let kwIdx=-1;for(let i=0;i<palavrasNorm.length;i++){if(palavrasNorm[i]===keyword){kwIdx=i;break;}}
  if(kwIdx<=0)return null;
  const nomeRaw=palavrasOrig.slice(0,kwIdx).join(' ').trim();if(!nomeRaw)return null;
  const nome=capitalizarNome(nomeRaw),restoOrig=palavrasOrig.slice(kwIdx+1).join(' ').trim();
  const palavrasResto=palavrasNorm.slice(kwIdx+1).join(' ').replace(/\b(de|pix|reais)\b/g,' ').replace(/r\$\s*/g,' ').split(/\s+/).filter(Boolean);
  for(let i=0;i<palavrasResto.length;i++){const qtd=toNumero(palavrasResto[i]);if(qtd===null)continue;if(i+2<palavrasResto.length){const p2=toProduto(palavrasResto[i+1]+' '+palavrasResto[i+2]);if(p2)return{tipo:'produto',nome,qtd,produto:p2};}if(i+1<palavrasResto.length){const p1=toProduto(palavrasResto[i+1]);if(p1)return{tipo:'produto',nome,qtd,produto:p1};}}
  for(let i=0;i<palavrasResto.length;i++){if(i+1<palavrasResto.length){const p2=toProduto(palavrasResto[i]+' '+palavrasResto[i+1]);if(p2)return{tipo:'produto',nome,qtd:1,produto:p2};}const p1=toProduto(palavrasResto[i]);if(p1)return{tipo:'produto',nome,qtd:1,produto:p1};}
  const valor=extrairValor(restoOrig);
  if(valor!==null&&valor>0)return{tipo:'valor',nome,valor};
  return null;
}

function detectarComando(texto){
  const t=norm(texto);
  if(t.includes('compras quitadas')||t==='quitadas')return{tipo:'quitadas'};
  if(t.includes('relatorio detalhado'))return{tipo:'detalhado'};
  if(t==='relatorio'||t==='relatorio geral')return{tipo:'geral'};
  if(t==='resumo'||t==='resumo do dia'||t==='resumo diario')return{tipo:'resumo'};
  if(t==='produtos'||t==='lista produtos'||t==='listar produtos')return{tipo:'produtos'};
  if(t==='ajuda'||t==='!ajuda'||t==='help')return{tipo:'ajuda'};
  const mRelArg=texto.match(/^relat[oó]rio\s+(.+)$/i);if(mRelArg){const arg=mRelArg[1].trim();if(isMes(arg))return{tipo:'mes',mes:arg};return{tipo:'individual',nome:arg};}
  const mSaldo=texto.match(/^saldo\s+(.+)$/i);if(mSaldo)return{tipo:'individual',nome:mSaldo[1].trim()};
  const mHist=texto.match(/^hist[oó]rico\s+(.+)$/i);if(mHist)return{tipo:'historico',nome:mHist[1].trim()};
  const mCancel=texto.match(/^cancelar\s+(.+)$/i);if(mCancel)return{tipo:'cancelar',nome:mCancel[1].trim()};
  const mZerar=texto.match(/^zerar\s+(.+)$/i);if(mZerar)return{tipo:'zerar',nome:mZerar[1].trim()};
  const mPreco=texto.match(/^pre[cç]o\s+(\S+)\s+(.+)$/i);if(mPreco){const val=extrairValor(mPreco[2]);if(val&&val>0)return{tipo:'mudarpreco',produto:mPreco[1].trim(),valor:val};}
  const mNovoProd=texto.match(/^novo\s+produto[:\s]+([a-zà-ü\s]+?)\s+(R?\$?\s*[\d]+[,.]?[\d]*)\s*(reais)?$/i);if(mNovoProd){const val=extrairValor(mNovoProd[2]);if(val&&val>0)return{tipo:'novoproduto',nome:mNovoProd[1].trim(),valor:val};}
  if(t==='cobrar'||t==='lembrete'||t==='lembretes')return{tipo:'lembrete'};
  return{tipo:null};
}

function gerarAjuda(){return `🤖 *Comandos do Bot*\n───────────────\n🛒 *Registrar compra:*\n_julia 3 trufas_\n_ana 2 bolos e 1 trufa_\n\n💳 *Registrar pagamento:*\n_julia pagou 10_\n_julia pix 10_\n_julia pagou 2 trufas_\n\n📊 *Relatórios:*\n_relatorio_ — dívidas em aberto\n_relatorio detalhado_ — com histórico\n_relatorio julia_ — saldo de um cliente\n_relatorio junho_ — relatório do mês\n_compras quitadas_ — clientes quitados\n_historico julia_ — histórico completo\n_resumo_ — resumo do dia\n\n🛠 *Administrar:*\n_produtos_ — lista produtos e preços\n_preco trufa 6_ — muda preço\n_novo produto brownie 8_ — novo produto\n_cancelar julia_ — cancela último lançamento\n_zerar julia_ — zera dívida de um cliente\n_lembrete_ — envia cobranças manualmente\n\n🎤 *Áudio:*\n_Envie um áudio no grupo e o bot transcreve automaticamente!_`;}

function agendarTarefas(sock,jid){
  if(agendamentosIniciados)return;
  agendamentosIniciados=true;
  console.log('Agendamentos iniciados.');
  setInterval(async()=>{
    try{
      const now=new Date(new Date().toLocaleString('en-US',{timeZone:'America/Sao_Paulo'}));
      const hora=now.getHours(),min=now.getMinutes();
      if(min>=0&&min<5){if(hora===HORA_RESUMO){const r=await gerarResumoDiario();await sock.sendMessage(jid,{text:r});}if(hora===HORA_LEMBRETE)await verificarLembretes(sock,jid);}
    }catch(e){console.error('Erro agendamento:',e.message);}
  },60*60*1000);
}

async function processarTexto(texto,jid,sock){
  const cmd=detectarComando(texto);
  if(cmd.tipo==='quitadas')return await gerarRelatorioQuitados();
  if(cmd.tipo==='detalhado')return await gerarRelatorioDetalhado();
  if(cmd.tipo==='geral')return await gerarRelatorioGeral();
  if(cmd.tipo==='resumo')return await gerarResumoDiario();
  if(cmd.tipo==='mes')return await gerarRelatorioMes(cmd.mes);
  if(cmd.tipo==='individual')return await gerarSaldoIndividual(cmd.nome);
  if(cmd.tipo==='historico')return await gerarHistoricoCliente(cmd.nome);
  if(cmd.tipo==='cancelar')return await cancelarLancamento(jid,cmd.nome);
  if(cmd.tipo==='zerar')return await zerarCliente(cmd.nome);
  if(cmd.tipo==='produtos')return listarProdutos();
  if(cmd.tipo==='ajuda')return gerarAjuda();
  if(cmd.tipo==='lembrete'){await verificarLembretes(sock,jid);return null;}
  if(cmd.tipo==='mudarpreco')return mudarPreco(cmd.produto,cmd.valor);
  if(cmd.tipo==='novoproduto')return cadastrarNovoProduto(cmd.nome,cmd.valor);
  const linhas=texto.split('\n').map(l=>l.trim()).filter(Boolean),respostas=[];
  for(const linha of linhas){
    const pagamento=parsearPagamento(linha);
    if(pagamento){let result;if(pagamento.tipo==='valor')result=await processarPagamentoValor(pagamento.nome,pagamento.valor,jid);else result=await processarPagamentoProduto(pagamento.nome,pagamento.qtd,pagamento.produto,jid);respostas.push(result.msg);continue;}
    const parsed=parsearLinha(linha);if(!parsed)continue;
    const linhasResposta=[];
    for(const item of parsed.itens){
      const resultado=await registrarOuAcumular(parsed.nome,item.produto,item.quantidade);
      if(!resultado)linhasResposta.push(`❌ Erro ao registrar ${nomeProdutoExib(item.produto)}.`);
      else if(resultado.limiteBloqueado)linhasResposta.push(`⚠️ *${resultado.cliente}* atingiu o limite de crédito de R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}!`);
      else{pushLancamento(jid,{tipo:'compra',cliente:resultado.cliente,produto:item.produto,quantidade:item.quantidade,valor:(PRECOS[item.produto]||0)*item.quantidade});linhasResposta.push(`${nomeProdutoExib(item.produto)}: +${item.quantidade} | Total: ${resultado.qtdAcumulada} unid. = R$ ${resultado.totalAcumulado.toFixed(2)}`);}
    }
    if(linhasResposta.length)respostas.push(`*${parsed.nome}*\n`+linhasResposta.join('\n'));
  }
  return respostas.length?respostas.join('\n\n'):null;
}

// ─── INICIAR BOT ──────────────────────────────────────────────────────────────
async function iniciarBot(){
  if(reconectando)return;
  reconectando=true;
  restaurarSessao();

  await preAquecerToken();

  try{
    const{version}=await fetchLatestBaileysVersion();
    const{state,saveCreds}=await useMultiFileAuthState(AUTH_DIR);
    const logger=pino({level:'silent'});

    const sock=makeWASocket({
      version,
      auth:{creds:state.creds,keys:makeCacheableSignalKeyStore(state.keys,logger)},
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs:       60_000,
      defaultQueryTimeoutMs:  60_000,
      keepAliveIntervalMs:    25_000,
      retryRequestDelayMs:     2_000,
      maxMsgRetryCount:            5,
      emitOwnEvents:          false,
      fireInitQueries:        true,
      generateHighQualityLinkPreview: false,
      syncFullHistory:        false,
      markOnlineOnConnect:    true,
    });
    sockGlobal=sock;

    // creds.update dispara várias vezes por segundo — usamos debounce de 30s
    // para evitar loop de redeploys no Render
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      agendarSalvarSessao();
    });

    sock.ev.on('connection.update',async({connection,lastDisconnect})=>{
      if(connection==='connecting'){console.log('Conectando ao WhatsApp...');}
      if(connection==='open'){
        botConectado=true;pairingCode=null;reconectando=false;
        tentativasReconexao=0;
        console.log('✅ Bot conectado!');
        // Salva imediatamente ao conectar (só uma vez)
        await salvarSessaoNoRender();
        if(jidGrupoGlobal)agendarTarefas(sock,jidGrupoGlobal);
      }
      if(connection==='close'){
        botConectado=false;reconectando=false;pairingCode=null;
        // Cancela qualquer salvamento pendente ao desconectar
        if(_salvarSessaoTimer){clearTimeout(_salvarSessaoTimer);_salvarSessaoTimer=null;}
        const err=lastDisconnect?.error;
        const code=err instanceof Boom?err.output?.statusCode:null;
        console.log(`Conexao fechada. Codigo: ${code}`);
        if(code===DisconnectReason.loggedOut||code===401){
          console.log('Sessão expirada. Limpando credenciais...');
          try{fs.rmSync(AUTH_DIR,{recursive:true,force:true});}catch(e){}
          tentativasReconexao=0;
          setTimeout(iniciarBot,3000);
          return;
        }
        if(code===440||code===409){
          console.log('Conflito de sessão. Aguardando 15s...');
          setTimeout(iniciarBot,15_000);
          return;
        }
        const delay=delayReconexao();
        console.log(`Reconectando em ${Math.round(delay/1000)}s (tentativa ${tentativasReconexao})...`);
        setTimeout(iniciarBot,delay);
      }
    });

    const keepAliveTimer=setInterval(async()=>{
      if(!botConectado||!sockGlobal)return;
      try{
        await sockGlobal.sendPresenceUpdate('unavailable');
      }catch(e){
        console.log('Keepalive falhou, forçando reconexão...');
        clearInterval(keepAliveTimer);
        botConectado=false;
        reconectando=false;
        setTimeout(iniciarBot,2000);
      }
    },2*60*1000);

    sock.ev.on('messages.upsert',async({messages})=>{
      for(const msg of messages){
        try{
          if(!msg.message||msg.key.fromMe)continue;
          if(!msg.key.remoteJid?.endsWith('@g.us'))continue;
          const meta=await sock.groupMetadata(msg.key.remoteJid).catch(()=>null);
          if(!meta||!meta.subject.toLowerCase().includes(GRUPO_NOME.toLowerCase()))continue;
          const jid=msg.key.remoteJid;
          if(!jidGrupoGlobal){jidGrupoGlobal=jid;agendarTarefas(sock,jid);}

          const audioMsg=msg.message.audioMessage||msg.message.pttMessage;
          if(audioMsg&&GROQ_API_KEY){
            try{
              console.log('Áudio recebido, transcrevendo...');
              const buffer=await downloadMediaMessage(msg,'buffer',{},{logger,reuploadRequest:sock.updateMediaMessage});
              const mimeType=audioMsg.mimetype||'audio/ogg; codecs=opus';
              const textoRaw=await transcreverAudio(buffer,mimeType);
              if(textoRaw){
                const textoTranscrito=corrigirTranscricao(limparTranscricao(textoRaw));
                console.log('Transcrição:',textoRaw);
                if(textoRaw!==textoTranscrito)console.log('Transcrição corrigida:',textoTranscrito);
                const resposta=await processarTexto(textoTranscrito,jid,sock);
                if(resposta)await sock.sendMessage(jid,{text:`🎤 _"${textoTranscrito}"_\n\n${resposta}`},{quoted:msg});
              }
            }catch(e){console.error('Erro ao processar áudio:',e.message);}
            continue;
          }

          const texto=msg.message.conversation||msg.message.extendedTextMessage?.text||'';
          if(!texto.trim())continue;
          const resposta=await processarTexto(texto.trim(),jid,sock);
          if(resposta)await sock.sendMessage(jid,{text:resposta},{quoted:msg});
        }catch(e){console.error('Erro ao processar mensagem:',e.message);}
      }
    });
  }catch(e){
    console.error('Erro ao iniciar bot:',e.message);
    reconectando=false;
    const delay=delayReconexao();
    setTimeout(iniciarBot,delay);
  }
}

iniciarBot();
