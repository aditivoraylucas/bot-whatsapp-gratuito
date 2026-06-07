const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { execSync } = require('child_process');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');

const GRUPO_NOME = process.env.GRUPO_NOME || 'vendas';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const MEU_NUMERO = (process.env.Meu_numero || '').replace(/[^0-9]/g, '');
const PORT = process.env.PORT || 3000;

const PRECOS = { trufa: 5.0, bombom: 5.0, bolo: 12.0 };
const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'bombom', 'bombons'],
  bolo: ['bolo', 'bolinho', 'bolo de pote', 'bolo pote']
};

let pairingCode = null;
let botConectado = false;
let qrCodeData = null;

// Servidor web
http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (botConectado) {
    res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px">
      <h1>\u2705 Bot conectado!</h1><p>O bot est\u00e1 funcionando no grupo.</p>
    </body></html>`);
  } else if (pairingCode) {
    res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
      <h1>\ud83d\udcf1 C\u00f3digo de Pareamento</h1>
      <p>No WhatsApp: <b>Configura\u00e7\u00f5es \u2192 Aparelhos conectados \u2192 Conectar aparelho</b></p>
      <p>Digite este c\u00f3digo:</p>
      <h1 style="font-size:60px;letter-spacing:10px;color:#25D366">${pairingCode}</h1>
      <p><small>O c\u00f3digo expira em alguns minutos. Atualize a p\u00e1gina para um novo c\u00f3digo.</small></p>
      <script>setTimeout(()=>location.reload(),60000)</script>
    </body></html>`);
  } else if (qrCodeData) {
    try {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>\ud83d\udcf1 Escaneie o QR Code</h1>
        <img src="${qrImage}" style="width:300px;height:300px" />
        <script>setTimeout(()=>location.reload(),30000)</script>
      </body></html>`);
    } catch(e) { res.end('<h1>Erro QR</h1>'); }
  } else {
    res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px">
      <h1>\u23f3 Iniciando bot...</h1>
      <p>Aguarde e atualize a p\u00e1gina em alguns segundos.</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
  }
}).listen(PORT, () => console.log(`Servidor na porta ${PORT}`));

// Google Sheets
async function registrarVenda(vendedor, produto, quantidade) {
  try {
    const auth = new JWT({ email: GOOGLE_SERVICE_ACCOUNT_EMAIL, key: GOOGLE_PRIVATE_KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await sheet.addRow({ Data: agora, Vendedor: vendedor, Produto: produto, Quantidade: quantidade, Total: (PRECOS[produto] || 0) * quantidade });
    return true;
  } catch (err) { console.error('Erro planilha:', err.message); return false; }
}

function identificarProduto(texto) {
  const lower = texto.toLowerCase();
  for (const [produto, sins] of Object.entries(SINONIMOS))
    for (const sin of sins)
      if (lower.includes(sin)) return produto;
  return null;
}

function extrairVendas(texto) {
  const vendas = [];
  const regex = /(\d+)\s*([a-zA-Z\u00C0-\u00FA ]+)|([a-zA-Z\u00C0-\u00FA ]+)\s*(\d+)/gi;
  let match;
  while ((match = regex.exec(texto)) !== null) {
    const qtd = parseInt(match[1] || match[4]);
    const nomeProd = (match[2] || match[3] || '').trim();
    const produto = identificarProduto(nomeProd);
    if (produto && qtd > 0) vendas.push({ produto, quantidade: qtd });
  }
  return vendas;
}

async function transcreverAudio(buffer) {
  try {
    const tmpInput = `/tmp/audio_${Date.now()}.ogg`;
    const tmpWav = `/tmp/audio_${Date.now()}.wav`;
    fs.writeFileSync(tmpInput, buffer);
    execSync(`ffmpeg -i ${tmpInput} -ar 16000 -ac 1 ${tmpWav} -y 2>/dev/null`);
    const resultado = execSync(`python3 -c "import whisper; m=whisper.load_model('tiny'); r=m.transcribe('${tmpWav}', language='pt'); print(r['text'])"`, { encoding: 'utf8' });
    fs.unlinkSync(tmpInput); fs.unlinkSync(tmpWav);
    return resultado.trim();
  } catch (err) { console.error('Erro audio:', err.message); return null; }
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  // Solicita c\u00f3digo de pareamento por n\u00famero
  if (!sock.authState.creds.registered && MEU_NUMERO) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(MEU_NUMERO);
        pairingCode = code;
        console.log(`\ud83d\udd11 C\u00f3digo de pareamento: ${code}`);
        console.log('Acesse a URL do Render para ver o c\u00f3digo!');
      } catch (e) {
        console.error('Erro ao solicitar c\u00f3digo:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrCodeData = qr; console.log('QR Code gerado como fallback.'); }
    if (connection === 'close') {
      botConectado = false;
      pairingCode = null;
      const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : null;
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconectando...');
        setTimeout(iniciarBot, 5000);
      } else {
        console.log('Deslogado. Limpando sessao...');
        fs.rmSync('auth_info', { recursive: true, force: true });
        setTimeout(iniciarBot, 3000);
      }
    } else if (connection === 'open') {
      botConectado = true; pairingCode = null; qrCodeData = null;
      console.log('\u2705 Bot conectado ao WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (!msg.key.remoteJid?.endsWith('@g.us')) continue;
      try {
        const meta = await sock.groupMetadata(msg.key.remoteJid);
        if (!meta.subject.toLowerCase().includes(GRUPO_NOME.toLowerCase())) continue;
      } catch { continue; }

      const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Algu\u00e9m';
      let texto = null;
      if (msg.message.conversation) texto = msg.message.conversation;
      else if (msg.message.extendedTextMessage) texto = msg.message.extendedTextMessage.text;
      else if (msg.message.audioMessage) {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        texto = await transcreverAudio(buffer);
      }
      if (!texto) continue;

      const vendas = extrairVendas(texto);
      if (!vendas.length) continue;

      let resposta = `\u2705 Anotado, ${sender}!\n`;
      let totalGeral = 0;
      for (const { produto, quantidade } of vendas) {
        const total = (PRECOS[produto] || 0) * quantidade;
        totalGeral += total;
        const emoji = produto === 'bolo' ? '\ud83c\udf82' : '\ud83c\udf6b';
        resposta += `${emoji} ${produto === 'bolo' ? 'Bolo' : 'Bombom/Trufa'}: ${quantidade} unid. = R$ ${total.toFixed(2)}\n`;
        await registrarVenda(sender, produto, quantidade);
      }
      resposta += `\ud83d\udcb0 Total: R$ ${totalGeral.toFixed(2)}`;
      await sock.sendMessage(msg.key.remoteJid, { text: resposta });
    }
  });
}

iniciarBot();
