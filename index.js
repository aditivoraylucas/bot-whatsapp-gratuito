process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const http = require('http');
const qrcode = require('qrcode');
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

// ─── LIMPAR TEXTO DE TRANSCRIÇÃO ─────────────────────────────────────────────
// Remove pontuação final das palavras e corrige erros comuns do Whisper
// NOTA: não remove pontuação de valores monetários (ex: R$10,50)
function limparTranscricao(texto) {
  if (!texto) return texto;
  return texto
    .replace(/([a-záàâãéèêíìîóòôõúùûçA-Z])([.!?;:]+)(\s|$)/g, '$1$3')  // remove pontuação ao final de palavras (não afeta vírgula em números)
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── FUZZY MATCH PARA COMANDOS DE VOZ ────────────────────────────────────────
// Mapeia palavras que o Whisper erra com frequência para as corretas
// DEVE ficar APÓS norm() pois corrigirPalavra() a utiliza
const CORRECOES_VOZ = {
  // comandos
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
  // pagamentos
  'pagou': 'pagou',
  'pagol': 'pagou',
  'pago': 'pagou',
  'pix': 'pix',
  'pics': 'pix',
  'pik': 'pix',
  'transferio': 'transferiu',
  'transferiou': 'transferiu',
  // produtos
  'trufa': 'trufa',
  'trufas': 'trufas',
  'trufinha': 'trufinha',
  'bolo': 'bolo',
  'bolos': 'bolos',
  'bombon': 'bombom',
  'bombons': 'bombons',
};

function corrigirPalavra(palavra) {
  const n = norm(palavra);  // norm() já definida acima
  return CORRECOES_VOZ[n] || palavra;
}

function corrigirTranscricao(texto) {
  if (!texto) return texto;
  return texto.split(/\s+/).map(p => corrigirPalavra(p)).join(' ');
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
let qrCodeData=null;
let sockGlobal=null;
let jidGrupoGlobal=null;
let agendamentosIniciados=false;

function restaurarSessao() {
  try {
    const credsJson=process.env.CREDS_JSON;
    if(!credsJson) return false;
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

http.createServer(async(req,res)=>{
  try {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    if(botConectado){
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u2705 Bot conectado!</h1><p>Funcionando normalmente.</p></body></html>');
    } else if(qrCodeData){
      const qrImage=await qrcode.toDataURL(qrCodeData).catch(()=>null);
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>\ud83d\udcf1 Escanear QR Code</h1>
        <p>WhatsApp \u2192 Configura\u00e7\u00f5es \u2192 Aparelhos conectados \u2192 Conectar aparelho</p>
        ${qrImage?`<img src="${qrImage}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:10px" />`:'<p>Gerando QR...</p>'}
        <script>setTimeout(()=>location.reload(),25000)</script>
      </body></html>`);
    } else {
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u23f3 Iniciando bot...</h1><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
    }
  } catch(e){res.end('<html><body><h1>Carregando...</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');}
}).listen(PORT,()=>console.log(`\u2705 Servidor rodando na porta ${PORT}`));

function getAuth() {
  return new JWT({email:GOOGLE_SERVICE_ACCOUNT_EMAIL,key:GOOGLE_PRIVATE_KEY,scopes:['https://www.googleapis.com/auth/spreadsheets']});
}
async function getDoc() {
  const doc=new GoogleSpreadsheet(SPREADSHEET_ID,getAuth());
  await doc.loadInfo();
  return doc;
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
      if(totalAtual+valorNovo>LIMITE_CREDITO_PADRAO){
        return { cliente, limiteBloqueado: true, totalAtual, valorNovo };
      }
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

// ─── PAGAMENTO POR PRODUTO (ex: julia pagou 2 trufas) ─────────────────────────
async function processarPagamentoProduto(clienteEnviado, quantidade, produto, jid) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(clienteEnviado, nomesConhecidos);
    const row=rows.find(r=>mesmoNome(r.get('Cliente'),clienteEnviado)&&norm(r.get('Produto'))===norm(produto));
    const cliente=nomeCanon||row?row.get('Cliente'):capitalizarNome(clienteEnviado);
    if(!row) return{ok:false,msg:`\u274c Nenhuma d\u00edvida de *${capitalizarNome(clienteEnviado)}* com ${nomeProdutoExib(produto)} encontrada.`};
    const qtdAtual  = parseInt(row.get('Quantidade')||'0');
    const qtdPaga   = Math.min(quantidade,qtdAtual);
    const novaQtd   = qtdAtual-qtdPaga;
    const totalAtual= parseFloat(row.get('Total')||'0');
    const pago = qtdAtual>0 ? (totalAtual/qtdAtual)*qtdPaga : 0;
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente:row.get('Cliente'),produto,quantidade:qtdPaga,valor:pago});
    await (await getSheetHistorico()).addRow({Data:agora(),Cliente:row.get('Cliente'),Tipo:'Pagamento',Produto:produto,Quantidade:qtdPaga,Valor:pago.toFixed(2)});
    if(novaQtd===0){
      await row.delete();
      return{ok:true,msg:`\u2705 *${row.get('Cliente')}* quitou toda a d\u00edvida de ${nomeProdutoExib(produto)}! Pagou R$ ${pago.toFixed(2)}.`};
    }
    const novoTotal=totalAtual-pago;
    row.set('Quantidade',novaQtd);
    row.set('Total',novoTotal.toFixed(2));
    await row.save();
    return{ok:true,msg:`\u2705 *${row.get('Cliente')}* pagou ${qtdPaga} ${nomeProdutoExib(produto)}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}`};
  } catch(err){console.error('Erro pag produto:',err.message);return{ok:false,msg:'\u274c Erro ao registrar pagamento.'};}
}

// ─── PAGAMENTO POR VALOR (ex: julia pagou 10, julia pix 10) ───────────────────
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
    if(!rowsCliente.length) return{ok:false,msg:`\u274c Nenhuma d\u00edvida encontrada para *${capitalizarNome(clienteEnviado)}*.`};
    const totalDevido=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    if(jid) pushLancamento(jid,{tipo:'pagamento',cliente,produto:'geral',quantidade:'-',valor:valorPago});
    await (await getSheetHistorico()).addRow({Data:agora(),Cliente:cliente,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:valorPago.toFixed(2)});
    if(valorPago>=totalDevido){
      for(const r of rowsCliente) await r.delete();
      return{ok:true,msg:`\u2705 *${cliente}* quitou toda a d\u00edvida! Pagou R$ ${valorPago.toFixed(2)}.`};
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
    return{ok:true,msg:`\u2705 *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido-valorPago).toFixed(2)}`};
  } catch(err){console.error('Erro pag valor:',err.message);return{ok:false,msg:'\u274c Erro ao registrar pagamento.'};}
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
      for(const item of dados.itens){
        resposta+=`  ${nomeProdutoExib(item.produto)}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;
      }
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

// ─── RELATORIO DETALHADO (só devedores) ───────────────────────────────────────
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
        if(m.tipo==='Compra'){
          resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        } else if(m.tipo==='Pagamento'){
          resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        }
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
        if(m.tipo==='Compra'){
          resposta+=`  Compra: ${m.qtd}x ${nomeProdutoExib(m.produto)} = R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        } else if(m.tipo==='Pagamento'){
          resposta+=`  Pagamento: R$ ${m.valor.toFixed(2)}  (${soData(m.data)})\n`;
        }
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
async function gerarHistoricoCliente(nomeDigitado) {
  try {
    const{historico,saldos}=await carregarHistoricoAgrupado();
    const nomesConhecidos=Object.keys(historico);
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon||!historico[nomeCanon]) return `\u274c Nenhum hist\u00f3rico encontrado para *${capitalizarNome(nomeDigitado)}*.`;
    const movs=historico[nomeCanon];
    const saldoAtual=saldos[nomeCanon]||0;
    let resposta=`*Hist\u00f3rico de ${nomeCanon}*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`;
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
  } catch(err){console.error('Erro historico:',err.message);return '\u274c Erro ao buscar hist\u00f3rico.';}
}

// ─── RELATORIO DO MES ─────────────────────────────────────────────────────────
async function gerarRelatorioMes(mes) {
  try {
    const{historico}=await carregarHistoricoAgrupado(mes);
    const nomesMes=['','Janeiro','Fevereiro','Mar\u00e7o','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const mesNum=parseInt(norm(mes));
    const nomeMesExib=isNaN(mesNum)?capitalizarNome(mes):(nomesMes[mesNum]||capitalizarNome(mes));
    const todosNomes=Object.keys(historico);
    if(!todosNomes.length) return `Nenhuma movimenta\u00e7\u00e3o registrada em ${nomeMesExib}.`;
    let totalVendas=0, totalRecebido=0, qtdTrufa=0, qtdBolo=0;
    let detalhe='';
    for(const nome of todosNomes.sort()){
      const movs=historico[nome];
      const comprado=movs.filter(m=>m.tipo==='Compra').reduce((s,m)=>s+m.valor,0);
      const pago=movs.filter(m=>m.tipo==='Pagamento').reduce((s,m)=>s+m.valor,0);
      qtdTrufa+=movs.filter(m=>m.tipo==='Compra'&&m.produto==='trufa').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);
      qtdBolo +=movs.filter(m=>m.tipo==='Compra'&&m.produto==='bolo').reduce((s,m)=>s+parseInt(m.qtd||'0'),0);
      totalVendas+=comprado; totalRecebido+=pago;
      detalhe+=`\n*${nome}*: comprou R$ ${comprado.toFixed(2)} | pagou R$ ${pago.toFixed(2)}\n`;
    }
    return `*Relat\u00f3rio de ${nomeMesExib}*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n${detalhe}\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nTrufas: ${qtdTrufa} unid. | Bolos: ${qtdBolo} unid.\nTotal em vendas: R$ ${totalVendas.toFixed(2)}\nTotal recebido: R$ ${totalRecebido.toFixed(2)}\nA receber: R$ ${(totalVendas-totalRecebido).toFixed(2)}`;
  } catch(err){console.error('Erro relatorio mes:',err.message);return '\u274c Erro ao gerar relat\u00f3rio do m\u00eas.';}
}

// ─── RESUMO DIARIO ────────────────────────────────────────────────────────────
async function gerarResumoDiario() {
  try {
    const hoje=agoraData();
    const{historico}=await carregarHistoricoAgrupado();
    let totalVendas=0,totalPago=0,qtdTrufa=0,qtdBolo=0,clientes=new Set();
    for(const [nome,movs] of Object.entries(historico)){
      for(const m of movs){
        const dataMovStr=soData(m.data);
        if(dataMovStr!==hoje) continue;
        if(m.tipo==='Compra'){
          totalVendas+=m.valor;
          if(m.produto==='trufa') qtdTrufa+=parseInt(m.qtd||'0');
          if(m.produto==='bolo')  qtdBolo +=parseInt(m.qtd||'0');
          clientes.add(nome);
        } else if(m.tipo==='Pagamento'){
          totalPago+=m.valor;
        }
      }
    }
    const sheetSaldo=await getSheetSaldo();
    const rows=await sheetSaldo.getRows();
    const totalAberto=rows.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    return `*Resumo do Dia - ${hoje}*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nTrufas: ${qtdTrufa} | Bolos: ${qtdBolo}\nClientes atendidos: ${clientes.size}\nVendas do dia: R$ ${totalVendas.toFixed(2)}\nRecebido hoje: R$ ${totalPago.toFixed(2)}\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nTotal em aberto: R$ ${totalAberto.toFixed(2)}`;
  } catch(err){console.error('Erro resumo:',err.message);return '\u274c Erro ao gerar resumo.';}
}

// ─── LEMBRETE DE COBRANCA ─────────────────────────────────────────────────────
const DIAS_LEMBRETE = parseInt(process.env.DIAS_LEMBRETE||'7');
const HORA_LEMBRETE = parseInt(process.env.HORA_LEMBRETE||'20');
const HORA_RESUMO   = parseInt(process.env.HORA_RESUMO  ||'20');

async function verificarLembretes(sock, jid) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const agora2=new Date();
    const clientes={};
    for(const row of rows){
      const nome=(row.get('Cliente')||'').trim();
      const total=parseFloat(row.get('Total')||'0');
      const ultima=(row.get('UltimaCompra')||'').trim();
      if(!nome||total<=0||!ultima) continue;
      const partes=ultima.split(' ')[0].split('/');
      if(partes.length<3) continue;
      const dataUltima=new Date(`${partes[2]}-${partes[1]}-${partes[0]}`);
      const diasPassados=Math.floor((agora2-dataUltima)/(1000*60*60*24));
      if(diasPassados>=DIAS_LEMBRETE){
        if(!clientes[nome]) clientes[nome]={total:0,dias:diasPassados};
        clientes[nome].total+=total;
        clientes[nome].dias=Math.max(clientes[nome].dias,diasPassados);
      }
    }
    const nomes=Object.keys(clientes);
    if(!nomes.length) return;
    for(const [nome,dados] of Object.entries(clientes)){
      const msg=`\u26a0\ufe0f *Lembrete de cobran\u00e7a*\n*${nome}* est\u00e1 com R$ ${dados.total.toFixed(2)} em aberto h\u00e1 *${dados.dias} dias*.`;
      await sock.sendMessage(jid,{text:msg});
    }
  } catch(e){console.error('Erro lembrete:',e.message);}
}

// ─── MUDAR PRECO ──────────────────────────────────────────────────────────────
function mudarPreco(produto, novoPreco) {
  const p=toProduto(produto);
  if(!p) return `\u274c Produto *${produto}* n\u00e3o encontrado.`;
  const precoAntigo=PRECOS[p]||0;
  PRECOS[p]=novoPreco;
  salvarPrecos();
  return `\u2705 Pre\u00e7o de *${nomeProdutoExib(p)}* atualizado: R$ ${precoAntigo.toFixed(2)} \u2192 R$ ${novoPreco.toFixed(2)}\n_Saldos existentes n\u00e3o foram alterados. Vale para novas compras._`;
}

// ─── NOVO PRODUTO ─────────────────────────────────────────────────────────────
function cadastrarNovoProduto(nomeProduto, preco) {
  const key=norm(nomeProduto).replace(/\s+/g,'_');
  if(PRECOS[key]!==undefined) return `\u26a0\ufe0f Produto *${nomeProduto}* j\u00e1 existe. Para mudar o pre\u00e7o: _preco ${nomeProduto} R$XX_`;
  PRECOS[key]=preco;
  SINONIMOS_EXTRA[key]=[norm(nomeProduto), nomeProduto.toLowerCase().trim()];
  SINONIMOS_EXTRA[key]=[...new Set(SINONIMOS_EXTRA[key])];
  salvarPrecos();
  salvarSinonimosExtra();
  return `\u2705 Novo produto cadastrado!\n*${capitalizarNome(nomeProduto)}* = R$ ${preco.toFixed(2)}\nUso: _"cliente nome ${norm(nomeProduto)}"_`;
}

// ─── LISTAR PRODUTOS ──────────────────────────────────────────────────────────
function listarProdutos() {
  const todos=todosOsSinonimos();
  let msg='*Produtos cadastrados*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
  for(const [key] of Object.entries(todos)){
    const preco=PRECOS[key];
    if(preco===undefined) continue;
    msg+=`${nomeProdutoExib(key)}: R$ ${preco.toFixed(2)}\n`;
  }
  msg+='\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n_Para mudar o pre\u00e7o: preco [produto] [valor]_';
  return msg;
}

// ─── ZERAR CLIENTE ────────────────────────────────────────────────────────────
async function zerarCliente(nomeDigitado) {
  try {
    const sheet=await getSheetSaldo();
    const rows=await sheet.getRows();
    const nomesConhecidos=[...new Set(rows.map(r=>(r.get('Cliente')||'').trim()).filter(Boolean))];
    const nomeCanon=resolverNome(nomeDigitado,nomesConhecidos);
    if(!nomeCanon) return `\u274c Cliente *${capitalizarNome(nomeDigitado)}* n\u00e3o encontrado.`;
    const rowsCliente=rows.filter(r=>r.get('Cliente')===nomeCanon);
    if(!rowsCliente.length) return `\u2705 *${nomeCanon}* j\u00e1 est\u00e1 sem d\u00edvidas.`;
    const totalZerado=rowsCliente.reduce((s,r)=>s+parseFloat(r.get('Total')||'0'),0);
    for(const r of rowsCliente) await r.delete();
    await (await getSheetHistorico()).addRow({Data:agora(),Cliente:nomeCanon,Tipo:'Pagamento',Produto:'geral',Quantidade:'-',Valor:totalZerado.toFixed(2)});
    return `\u2705 D\u00edvida de *${nomeCanon}* zerada! (R$ ${totalZerado.toFixed(2)} removido)`;
  } catch(err){console.error('Erro zerar:',err.message);return '\u274c Erro ao zerar cliente.';}
}

// ─── PARSER DE LINHA (COMPRAS) ────────────────────────────────────────────────
const PALAVRAS_RESERVADAS = new Set([
  'pagou','pix','transferiu','depositou','mandou','enviou',
  'cancelar','saldo','historico','relatorio','resumo',
  'cobrar','lembrete','lembretes','preco','produtos','zerar','novo'
]);

function parsearLinha(linha) {
  const limpa=linha
    .replace(/,/g,' ')                         // vírgulas viram espaços primeiro
    .replace(/\b(mais|e|de)\b/gi,' ')          // remove conectivos
    .replace(/\+/g,' ')
    .replace(/[.!?;:]+( |$)/g, '$1')          // remove pontuação final de palavras (APÓS tratar vírgulas)
    .replace(/\s+/g,' ')
    .trim();
  const palavrasOrig=limpa.split(' ').filter(Boolean);
  const palavrasNorm=palavrasOrig.map(norm);
  const n=palavrasNorm.length;
  let inicioItens=-1;
  for(let i=0;i<n;i++){
    const p1=toProduto(palavrasNorm[i]);
    if(p1){inicioItens=i;break;}
    const qtd=toNumero(palavrasNorm[i]);
    if(qtd!==null&&i+1<n){
      const ok2=i+2<n&&toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2]);
      const ok1=toProduto(palavrasNorm[i+1]);
      if(ok2||ok1){inicioItens=i;break;}
    }
  }
  if(inicioItens<1) return null;
  const nomeRaw=palavrasOrig.slice(0,inicioItens).join(' ').trim();
  if(!nomeRaw) return null;
  if(PALAVRAS_RESERVADAS.has(norm(nomeRaw))) return null;
  const itens=[];
  let i=inicioItens;
  while(i<n){
    const qtd=toNumero(palavrasNorm[i]);
    if(qtd!==null&&i+1<n){
      if(i+2<n){const p2=toProduto(palavrasNorm[i+1]+' '+palavrasNorm[i+2]);if(p2){itens.push({quantidade:qtd,produto:p2});i+=3;continue;}}
      const p1=toProduto(palavrasNorm[i+1]);if(p1){itens.push({quantidade:qtd,produto:p1});i+=2;continue;}
    }
    if(i+1<n){const p2=toProduto(palavrasNorm[i]+' '+palavrasNorm[i+1]);if(p2){itens.push({quantidade:1,produto:p2});i+=2;continue;}}
    const p1=toProduto(palavrasNorm[i]);if(p1){itens.push({quantidade:1,produto:p1});i+=1;continue;}
    i++;
  }
  if(!itens.length) return null;
  return{nome:capitalizarNome(nomeRaw),itens};
}

// ─── PARSEAR PAGAMENTO ────────────────────────────────────────────────────────
function parsearPagamento(linha) {
  const tNorm = norm(linha);
  if (!/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/.test(tNorm)) return null;
  const kwMatch = tNorm.match(/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/);
  if (!kwMatch) return null;
  const keyword = kwMatch[1];
  const palavrasNorm = tNorm.split(/\s+/).filter(Boolean);
  const palavrasOrig = linha.trim().split(/\s+/).filter(Boolean);
  let kwIdx = -1;
  for(let i=0;i<palavrasNorm.length;i++){
    if(palavrasNorm[i]===keyword){ kwIdx=i; break; }
  }
  if(kwIdx<=0) return null;
  const nomeRaw = palavrasOrig.slice(0,kwIdx).join(' ').trim();
  if(!nomeRaw) return null;
  const resto = palavrasNorm.slice(kwIdx+1).join(' ').trim();
  // tenta pagamento por produto (ex: julia pagou 2 trufas)
  if(resto){
    const partesResto = resto.split(/\s+/).filter(Boolean);
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
  // pagamento por valor (ex: julia pagou 10, julia pix 15.50)
  const valor=extrairValor(resto||linha);
  if(valor&&valor>0) return{tipo:'valor',nome:nomeRaw,valor};
  return null;
}

// ─── PROCESSAR TEXTO ──────────────────────────────────────────────────────────
async function processarTexto(texto, jid, sock) {
  if(!texto) return null;
  const t = norm(texto);
  const palavras = t.split(/\s+/).filter(Boolean);
  const p0 = palavras[0];
  const p1 = palavras[1];
  const resto = palavras.slice(1).join(' ');

  // Comandos de relatório
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

  // Mudar preço: "preco trufa 6" ou "preco trufa R$6"
  if(p0==='preco'&&p1){
    const prodTrecho=palavras.slice(1,-1).join(' ');
    const ultimaPalavra=palavras[palavras.length-1];
    const novoPreco=extrairValor(ultimaPalavra);
    if(novoPreco&&novoPreco>0) return mudarPreco(prodTrecho,novoPreco);
    const prodTudo=palavras.slice(1).join(' ');
    const v2=extrairValor(prodTudo);
    if(v2&&v2>0){
      const prodSemVal=prodTudo.replace(/r?\$?\s*\d+[,.]?\d*/,'').trim();
      return mudarPreco(prodSemVal||p1,v2);
    }
  }

  // Novo produto: "novo produto brigadeiro 3.50"
  if(p0==='novo'&&p1){
    const partes=palavras.slice(1);
    const ultimaP=partes[partes.length-1];
    const preco=extrairValor(ultimaP);
    if(preco&&preco>0){
      const nomeProd=partes.slice(0,-1).join(' ').trim();
      if(nomeProd) return cadastrarNovoProduto(nomeProd,preco);
    }
  }

  // Pagamento
  const pag=parsearPagamento(texto);
  if(pag){
    if(pag.tipo==='produto') {
      const r=await processarPagamentoProduto(pag.nome,pag.quantidade,pag.produto,jid);
      return r.msg;
    }
    if(pag.tipo==='valor') {
      const r=await processarPagamentoValor(pag.nome,pag.valor,jid);
      return r.msg;
    }
  }

  // Compra
  const compra=parsearLinha(texto);
  if(compra){
    const msgs=[];
    for(const item of compra.itens){
      const res=await registrarOuAcumular(compra.nome,item.produto,item.quantidade);
      if(!res){ msgs.push(`\u274c Erro ao registrar ${compra.nome}.`); continue; }
      if(res.limiteBloqueado){
        msgs.push(`\u26d4 *${res.cliente}* atingiu o limite de cr\u00e9dito!\nAtual: R$ ${res.totalAtual.toFixed(2)} + R$ ${res.valorNovo.toFixed(2)} = ultrapassaria R$ ${LIMITE_CREDITO_PADRAO.toFixed(2)}`);
        continue;
      }
      pushLancamento(jid,{tipo:'compra',cliente:res.cliente,produto:item.produto,quantidade:item.quantidade,valor:PRECOS[item.produto]*item.quantidade});
      msgs.push(`${emojiProduto(item.produto)} *${res.cliente}*: ${res.qtdAcumulada} ${nomeProdutoExib(item.produto)}(s) = R$ ${res.totalAcumulado.toFixed(2)}`);
    }
    return msgs.join('\n');
  }

  return null;
}

function mensagemAjuda() {
  return [
    '*Bot de Vendas \ud83e\udd47*',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '*Registrar compra:*',
    '  `julia 2 trufas`',
    '  `carlos 1 bolo 3 trufas`',
    '',
    '*Registrar pagamento:*',
    '  `julia pagou 10`',
    '  `carlos pix 15`',
    '  `ana pagou 2 trufas`',
    '',
    '*Relatórios:*',
    '  `relatorio` — geral',
    '  `relatorio detalhado`',
    '  `relatorio quitados`',
    '  `relatorio junho`',
    '  `resumo` — resumo do dia',
    '',
    '*Consultas:*',
    '  `saldo julia`',
    '  `historico carlos`',
    '',
    '*Outros:*',
    '  `cancelar julia` — desfaz último lançamento',
    '  `zerar carlos` — zera dívida',
    '  `produtos` — lista produtos e preços',
    '  `preco trufa 6` — muda preço',
    '  `novo brigadeiro 3.50` — cadastra produto',
  ].join('\n');
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
      qrCodeData = qr;
      botConectado = false;
      console.log('QR gerado');
    }
    if (connection === 'open') {
      botConectado = true;
      qrCodeData = null;
      console.log('\u2705 Bot conectado ao WhatsApp!');
      await salvarSessaoNoRender();
      if (!agendamentosIniciados) {
        agendamentosIniciados = true;
        // Agendamentos de lembrete e resumo
        setInterval(async () => {
          try {
            const hora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split(' ')[1]?.split(':')[0];
            const horaNum = parseInt(hora);
            if (horaNum === HORA_LEMBRETE && jidGrupoGlobal) await verificarLembretes(sock, jidGrupoGlobal);
            if (horaNum === HORA_RESUMO   && jidGrupoGlobal) await sock.sendMessage(jidGrupoGlobal, { text: await gerarResumoDiario() });
          } catch(e) { console.error('Erro agendamento:', e.message); }
        }, 60 * 60 * 1000);
      }
    }
    if (connection === 'close') {
      botConectado = false;
      agendamentosIniciados = false;  // reset para recriar agendamentos na reconexão
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

        // Mensagem de áudio
        const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            console.log('\u00c1udio recebido, transcrevendo...');
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const textoRaw = await transcreverAudio(buffer, mimeType);
            if(textoRaw){
              const textoTranscrito = corrigirTranscricao(limparTranscricao(textoRaw));
              console.log('Transcrição:', textoRaw);
              if(textoRaw !== textoTranscrito) console.log('Transcrição corrigida:', textoTranscrito);
              const resposta = await processarTexto(textoTranscrito, jid, sock);
              if(resposta){
                await sock.sendMessage(jid, { text: `\ud83c\udfa4 _"${textoRaw}"_\n\n${resposta}` });
              }
            }
          } catch(e){ console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        // Mensagem de texto
        const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!textMsg.trim()) continue;
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });
      } catch(e){ console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

iniciarBot();
