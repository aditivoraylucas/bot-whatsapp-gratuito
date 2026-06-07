process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
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
        <p><b>Toque em "Usar n\u00famero de telefone"</b> na tela do QR Code</p>
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

function getAuth() {
  return new JWT({ email: GOOGLE_SERVICE_ACCOUNT_EMAIL, key: GOOGLE_PRIVATE_KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function getSheet() {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, getAuth());
  await doc.loadInfo();
  return doc.sheetsByIndex[0];
}

// Acumula compras do cliente: atualiza linha existente ou cria nova
async function registrarOuAcumular(cliente, produto, quantidade) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const nomeNorm = cliente.toLowerCase().trim();
    const prodNorm = produto.toLowerCase().trim();

    // Procura linha existente do mesmo cliente + produto
    const existente = rows.find(r =>
      (r.get('Cliente') || '').toLowerCase().trim() === nomeNorm &&
      (r.get('Produto') || '').toLowerCase().trim() === prodNorm
    );

    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    if (existente) {
      const qtdAtual = parseInt(existente.get('Quantidade') || '0');
      const novaQtd = qtdAtual + quantidade;
      const novoTotal = (PRECOS[produto] || 0) * novaQtd;
      existente.set('Quantidade', novaQtd);
      existente.set('Total', novoTotal.toFixed(2));
      existente.set('UltimaCompra', agora);
      await existente.save();
      return { nova: false, totalAcumulado: novoTotal, qtdAcumulada: novaQtd };
    } else {
      const total = (PRECOS[produto] || 0) * quantidade;
      await sheet.addRow({
        Cliente: cliente,
        Produto: produto,
        Quantidade: quantidade,
        Total: total.toFixed(2),
        UltimaCompra: agora
      });
      return { nova: true, totalAcumulado: total, qtdAcumulada: quantidade };
    }
  } catch (err) {
    console.error('Erro planilha:', err.message);
    return null;
  }
}

function identificarProduto(texto) {
  const lower = texto.toLowerCase();
  for (const [produto, sins] of Object.entries(SINONIMOS))
    for (const sin of sins)
      if (lower.includes(sin)) return produto;
  return null;
}

// Parseia mensagem no formato: "Nome Completo X produto"
// Ex: "jose 2 trufas", "joao do barril 2 trufas"
function parsearMensagem(texto) {
  // Regex: captura (tudo antes do numero) (numero) (resto)
  const match = texto.match(/^(.+?)\s+(\d+)\s+(.+)$/);
  if (!match) return null;

  const nomeRaw = match[1].trim();
  const qtd = parseInt(match[2]);
  const produtoRaw = match[3].trim();
  const produto = identificarProduto(produtoRaw);

  if (!produto || qtd <= 0) return null;

  // Capitaliza o nome
  const nome = nomeRaw.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');

  return { nome, quantidade: qtd, produto };
}

let reconectando = false;

async function iniciarBot() {
  if (reconectando) return;
  reconectando = true;
  try {
    const { version } = await fetchLatestBaileysVersion();
    console.log(`Usando WA versao: ${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: Browsers.ubuntu('Chrome'),
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
          console.log(`\ud83d\udd11 Codigo: ${code}`);
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

          let texto = null;
          if (msg.message.conversation) texto = msg.message.conversation;
          else if (msg.message.extendedTextMessage) texto = msg.message.extendedTextMessage.text;
          if (!texto) continue;

          // Processa cada linha da mensagem separadamente
          const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
          const resultados = [];

          for (const linha of linhas) {
            const parsed = parsearMensagem(linha);
            if (!parsed) continue;
            const { nome, quantidade, produto } = parsed;
            const resultado = await registrarOuAcumular(nome, produto, quantidade);
            if (resultado) resultados.push({ nome, quantidade, produto, ...resultado });
          }

          if (!resultados.length) continue;

          let resposta = '\u2705 Anotado!\n';
          for (const r of resultados) {
            const emoji = r.produto === 'bolo' ? '\ud83c\udf82' : '\ud83c\udf6b';
            const label = r.produto === 'bolo' ? 'Bolo' : 'Trufa';
            resposta += `\n${emoji} *${r.nome}* \u2014 ${label}\n`;
            resposta += `   +${r.quantidade} agora | Total: ${r.qtdAcumulada} unid. = R$ ${r.totalAcumulado.toFixed(2)}\n`;
          }

          await sock.sendMessage(msg.key.remoteJid, { text: resposta.trim() });
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
