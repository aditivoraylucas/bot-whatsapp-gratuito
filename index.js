process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
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

http.createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (botConectado) {
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u2705 Bot conectado!</h1><p>Funcionando normalmente.</p></body></html>');
    } else if (pairingCode) {
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>\ud83d\udd11 C\u00f3digo de Pareamento</h1>
        <p>WhatsApp \u2192 Configura\u00e7\u00f5es \u2192 Aparelhos conectados \u2192 Conectar aparelho</p>
        <h1 style="font-size:60px;letter-spacing:10px;color:#25D366;background:#111;padding:20px;border-radius:10px">${pairingCode}</h1>
        <p>Digite este c\u00f3digo no WhatsApp agora!</p>
        <script>setTimeout(()=>location.reload(),30000)</script>
      </body></html>`);
    } else if (qrCodeData) {
      const qrImage = await qrcode.toDataURL(qrCodeData).catch(() => null);
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>\ud83d\udcf1 QR Code</h1>
        ${qrImage ? `<img src="${qrImage}" style="width:300px;height:300px" />` : '<p>Gerando...</p>'}
        <script>setTimeout(()=>location.reload(),25000)</script>
      </body></html>`);
    } else {
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u23f3 Iniciando bot...</h1><p>Aguarde e atualize em alguns segundos.</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
    }
  } catch(e) {
    res.end('<html><body><h1>Carregando...</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }
}).listen(PORT, () => console.log(`\u2705 Servidor rodando na porta ${PORT}`));

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

let reconectando = false;

async function iniciarBot() {
  if (reconectando) return;
  reconectando = true;
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Usando Baileys versao: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: ['Bot Vendas', 'Chrome', '120.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 3000,
      maxMsgRetryCount: 3
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && MEU_NUMERO) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(MEU_NUMERO);
          pairingCode = code;
          console.log(`\ud83d\udd11 Codigo de pareamento: ${code}`);
        } catch (e) {
          console.error('Erro codigo pareamento:', e.message);
        }
      }, 5000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) { qrCodeData = qr; }
      if (connection === 'close') {
        botConectado = false;
        pairingCode = null;
        reconectando = false;
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : null;
        console.log(`Conexao fechada. Codigo: ${code}`);
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync('auth_info', { recursive: true, force: true }); } catch(e) {}
        }
        setTimeout(iniciarBot, 5000);
      } else if (connection === 'open') {
        botConectado = true;
        pairingCode = null;
        qrCodeData = null;
        reconectando = false;
        console.log('\u2705 Bot conectado ao WhatsApp!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          if (!msg.key.remoteJid?.endsWith('@g.us')) continue;
          const meta = await sock.groupMetadata(msg.key.remoteJid).catch(() => null);
          if (!meta || !meta.subject.toLowerCase().includes(GRUPO_NOME.toLowerCase())) continue;
          const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Alguem';
          let texto = null;
          if (msg.message.conversation) texto = msg.message.conversation;
          else if (msg.message.extendedTextMessage) texto = msg.message.extendedTextMessage.text;
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
        } catch(e) { console.error('Erro mensagem:', e.message); }
      }
    });

  } catch(e) {
    console.error('Erro ao iniciar bot:', e.message);
    reconectando = false;
    setTimeout(iniciarBot, 5000);
  }
}

iniciarBot();
