const { default: makeWASocket, useMultiFileAuthState, downloadMediaMessage, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { execSync } = require('child_process');
const { createWriteStream } = require('fs');

// ==================== CONFIGURAÇÕES ====================
const GRUPO_NOME = process.env.GRUPO_NOME || 'vendas'; // parte do nome do grupo
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const PRECOS = {
  trufa: 5.0,
  bombom: 5.0,
  bolo: 12.0
};

const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'bombom', 'bombons'],
  bolo: ['bolo', 'bolinho', 'bolo de pote', 'bolo pote']
};

// ==================== GOOGLE SHEETS ====================
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
    await sheet.addRow({
      Data: agora,
      Vendedor: vendedor,
      Produto: produto,
      Quantidade: quantidade,
      Total: (PRECOS[produto] || 0) * quantidade
    });
    return true;
  } catch (err) {
    console.error('Erro ao registrar na planilha:', err.message);
    return false;
  }
}

// ==================== INTERPRETAR MENSAGEM ====================
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
  // Padrão: número + produto ou produto + número
  const regex = /(\d+)\s*([a-zA-ZÀ-ú ]+)|([a-zA-ZÀ-ú ]+)\s*(\d+)/gi;
  let match;
  while ((match = regex.exec(texto)) !== null) {
    const qtd = parseInt(match[1] || match[4]);
    const nomeProd = (match[2] || match[3] || '').trim();
    const produto = identificarProduto(nomeProd);
    if (produto && qtd > 0) {
      vendas.push({ produto, quantidade: qtd });
    }
  }
  return vendas;
}

// ==================== TRANSCREVER ÁUDIO ====================
async function transcreverAudio(buffer) {
  try {
    const tmpInput = `/tmp/audio_${Date.now()}.ogg`;
    const tmpWav = `/tmp/audio_${Date.now()}.wav`;
    fs.writeFileSync(tmpInput, buffer);
    // Converter ogg para wav
    execSync(`ffmpeg -i ${tmpInput} -ar 16000 -ac 1 ${tmpWav} -y 2>/dev/null`);
    // Transcrever com whisper
    const resultado = execSync(`python3 -c "import whisper; m=whisper.load_model('tiny'); r=m.transcribe('${tmpWav}', language='pt'); print(r['text'])"`, { encoding: 'utf8' });
    fs.unlinkSync(tmpInput);
    fs.unlinkSync(tmpWav);
    return resultado.trim();
  } catch (err) {
    console.error('Erro na transcrição:', err.message);
    return null;
  }
}

// ==================== BOT PRINCIPAL ====================
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('\n📱 Escaneie o QR Code acima com seu WhatsApp!\n');
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Reconectando...');
        iniciarBot();
      } else {
        console.log('Desconectado. Escaneie o QR Code novamente.');
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado ao WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      // Só responde em grupos
      const isGroup = msg.key.remoteJid?.endsWith('@g.us');
      if (!isGroup) continue;

      // Verifica se é o grupo certo pelo nome
      try {
        const groupMeta = await sock.groupMetadata(msg.key.remoteJid);
        if (!groupMeta.subject.toLowerCase().includes(GRUPO_NOME.toLowerCase())) continue;
      } catch { continue; }

      const sender = msg.pushName || msg.key.participant?.split('@')[0] || 'Alguém';
      let texto = null;

      // Mensagem de texto
      if (msg.message.conversation) {
        texto = msg.message.conversation;
      } else if (msg.message.extendedTextMessage) {
        texto = msg.message.extendedTextMessage.text;
      }
      // Mensagem de áudio
      else if (msg.message.audioMessage) {
        console.log(`🎙️ Áudio recebido de ${sender}, transcrevendo...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        texto = await transcreverAudio(buffer);
        if (texto) console.log(`📝 Transcrição: ${texto}`);
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

iniciarBot();
