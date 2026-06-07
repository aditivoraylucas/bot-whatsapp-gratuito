const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { execSync } = require('child_process');
const http = require('http');
const qrcode = require('qrcode');

const GRUPO_NOME = process.env.GRUPO_NOME || 'vendas';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const PORT = process.env.PORT || 3000;

const PRECOS = { trufa: 5.0, bombom: 5.0, bolo: 12.0 };
const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'bombom', 'bombons'],
  bolo: ['bolo', 'bolinho', 'bolo de pote', 'bolo pote']
};

let qrCodeData = null;
let botConectado = false;

// Limpa sessão corrompida
function limparSessao() {
  try {
    if (fs.existsSync('auth_info')) {
      fs.rmSync('auth_info', { recursive: true, force: true });
      console.log('Sessão anterior removida.');
    }
  } catch (e) {
    console.log('Erro ao limpar sessão:', e.message);
  }
}

// Servidor web
http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (botConectado) {
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>✅ Bot conectado!</h1><p>O bot está funcionando normalmente no grupo.</p></body></html>');
  } else if (qrCodeData) {
    try {
      const qrImage = await qrcode.toDataURL(qrCodeData);
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>📱 Escaneie o QR Code</h1>
        <p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>
        <img src="${qrImage}" style="width:300px;height:300px" />
        <p><small>Atualize a página se o QR Code expirar</small></p>
        <script>setTimeout(()=>location.reload(),30000)</script>
      </body></html>`);
    } catch (e) {
      res.end('<html><body style="text-align:center;padding:50px"><h1>Erro ao gerar QR Code</h1></body></html>');
    }
  } else {
    res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>⏳ Iniciando bot...</h1><p>Aguarde alguns segundos e atualize a página.</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
  }
}).listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

// Google Sheets
async function registrarVenda(vendedor, produto, quantidade) {
  try {
    const serviceAccountAuth = new JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await sheet.addRow({ Data: agora, Vendedor: vendedor, Produto: produto, Quantidade: quantidade, Total: (PRECOS[produto] || 0) * quantidade });
    return true;
  } catch (err) {
    console.error('Erro planilha:', err.message);
    return false;
  }
}

function identificarProduto(texto) {
  const lower = texto.toLowerCase();
  for (const [produto, sinonimos] of Object.entries(SINONIMOS)) {
    for (const sin of sinonimos) {
      if (lower.includes(sin)) return produto;
    }
  }
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
    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpWav);
    return resultado.trim();
  } catch (err) {
    console.error('Erro transcrição:', err.message);
    return null;
  }
}

let tentativas = 0;

async function iniciarBot() {
  // Limpa sessão se tiver muitas tentativas falhas
  if (tentativas >= 3) {
    console.log('Muitas tentativas falhas, limpando sessão...');
    limparSessao();
    tentativas = 0;
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrCodeData = qr;
      botConectado = false;
      tentativas = 0;
      console.log('📱 QR Code gerado! Acesse a URL do Render para escanear.');
    }
    if (connection === 'close') {
      botConectado = false;
      const err = lastDisconnect?.error;
      const statusCode = (err instanceof Boom) ? err.output?.statusCode : null;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('Deslogado. Limpando sessão para novo QR Code...');
        limparSessao();
        tentativas = 0;
        setTimeout(iniciarBot, 2000);
      } else {
        tentativas++;
        console.log(`Reconectando... (tentativa ${tentativas})`);
        setTimeout(iniciarBot, 3000);
      }
    } else if (connection === 'open') {
      botConectado = true;
      qrCodeData = null;
      tentativas = 0;
      console.log('✅ Bot conectado ao WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const isGroup = msg.key.remoteJid?.endsWith('@g.us');
      if (!isGroup) continue;
      try {
        const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
        if (!groupMeta.subject.toLowerCase().includes(GRUPO_NOME.toLowerCase())) continue;
      } catch { continue; }

      const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Alguém';
      let texto = null;

      if (msg.message.conversation) texto = msg.message.conversation;
      else if (msg.message.extendedTextMessage) texto = msg.message.extendedTextMessage.text;
      else if (msg.message.audioMessage) {
        console.log(`🎙️ Áudio de ${sender}`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        texto = await transcreverAudio(buffer);
      }

      if (!texto) continue;
      const vendas = extrairVendas(texto);
      if (vendas.length === 0) continue;

      let resposta = `✅ Anotado, ${sender}!\n`;
      let totalGeral = 0;
      for (const { produto, quantidade } of vendas) {
        const total = (PRECOS[produto] || 0) * quantidade;
        totalGeral += total;
        const emoji = produto === 'bolo' ? '🎂' : '🍫';
        const nomeProd = produto === 'bolo' ? 'Bolo/Bolo de Pote' : 'Bombom/Trufa';
        resposta += `${emoji} ${nomeProd}: ${quantidade} unid. = R$ ${total.toFixed(2)}\n`;
        await registrarVenda(sender, produto, quantidade);
      }
      resposta += `💰 Total: R$ ${totalGeral.toFixed(2)}`;
      await sock.sendMessage(msg.key.remoteJid, { text: resposta });
    }
  });
}

// Limpa sessão na inicialização para garantir QR Code fresco
limparSessao();
iniciarBot();
