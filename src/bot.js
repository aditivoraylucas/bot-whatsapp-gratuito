// ─── LÓGICA DO WHATSAPP / BAILEYS ────────────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');

const { AUTH_DIR, RENDER_API_KEY, RENDER_SERVICE_ID, GRUPO_NOME, HORA_LEMBRETE, HORA_RESUMO } = require('./config');
const { horaAtualSP, agoraData, norm } = require('./utils');
const { verificarLembretes, gerarResumoDiario } = require('./sheets');
const { transcreverAudio, limparTranscricao, corrigirTranscricao, processarTexto } = require('./handlers');

// ── Estado compartilhado ────────────────────────────────────────────
let botConectado          = false;
let sockGlobal            = null;
let jidGrupoGlobal        = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete     = '';
let ultimoDiaResumo       = '';
let pairingPendente       = false;
let pairingNumero         = '';

function getBotConectado()     { return botConectado; }
function getSockGlobal()       { return sockGlobal; }
function getPairingNumero()    { return pairingNumero; }
function setPairingPendente(v) { pairingPendente = v; }
function setPairingNumero(v)   { pairingNumero = v; }

// ── Sessão persistente ──────────────────────────────────────────────────
function restaurarSessao() {
  try {
    const credsJson = process.env.CREDS_JSON;
    if (!credsJson) { console.log('[restaurarSessao] CREDS_JSON não definido – será necessário novo pairing.'); return false; }
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), credsJson, 'utf8');
    console.log('Sessao restaurada do CREDS_JSON');
    return true;
  } catch (e) { console.error('Erro ao restaurar sessao:', e.message); return false; }
}

async function salvarSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const conteudo = fs.readFileSync(credsPath, 'utf8');
    const fetch    = (await import('node-fetch')).default;
    const resGet   = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
    });
    const envVars   = await resGet.json();
    const existente = Array.isArray(envVars) ? envVars : (envVars.envVars || []);
    const novas     = [...existente.filter(v => v.key !== 'CREDS_JSON').map(v => ({ key: v.key, value: v.value })), { key: 'CREDS_JSON', value: conteudo }];
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(novas),
    });
    console.log('Sessao salva no Render!');
  } catch (e) { console.error('Erro ao salvar sessao:', e.message); }
}

// ── iniciarBot ──────────────────────────────────────────────────────────
async function iniciarBot() {
  restaurarSessao();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();
  const logger               = pino({ level: 'silent' });

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
    const { connection, lastDisconnect } = update;

    if (update.qr) {
      console.log('QR disponível (use o formulário web para parear por número)');
    }

    if (connection === 'open') {
      botConectado    = true;
      pairingPendente = false;
      console.log('✅ Bot conectado ao WhatsApp!');
      await salvarSessaoNoRender();

      if (!agendamentosIniciados) {
        agendamentosIniciados = true;
        setInterval(async () => {
          try {
            const horaNum = horaAtualSP();
            const hoje    = agoraData();
            if (horaNum === HORA_LEMBRETE && ultimoDiaLembrete !== hoje && jidGrupoGlobal) {
              ultimoDiaLembrete = hoje;
              await verificarLembretes(sock, jidGrupoGlobal);
            }
            if (horaNum === HORA_RESUMO && ultimoDiaResumo !== hoje && jidGrupoGlobal) {
              ultimoDiaResumo = hoje;
              await sock.sendMessage(jidGrupoGlobal, { text: await gerarResumoDiario() });
            }
          } catch (e) { console.error('Erro agendamento:', e.message); }
        }, 60 * 60 * 1000);
      }
    }

    if (connection === 'close') {
      botConectado          = false;
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
        const jid     = msg.key.remoteJid || '';
        const isGroup = jid.endsWith('@g.us');
        if (!isGroup) continue;

        const groupMeta = await sock.groupMetadata(jid).catch(() => null);
        const nomeGrupo = groupMeta?.subject || '';
        if (!norm(nomeGrupo).includes(norm(GRUPO_NOME))) continue;
        jidGrupoGlobal = jid;

        // ── Áudio ──
        const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            const buffer   = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const textoRaw = await transcreverAudio(buffer, mimeType);
            if (textoRaw) {
              const textoTranscrito = corrigirTranscricao(limparTranscricao(textoRaw));
              console.log('Transcrição:', textoRaw);
              const resposta = await processarTexto(textoTranscrito, jid, sock);
              if (resposta) await sock.sendMessage(jid, { text: `🎤 _"${textoRaw}"_\n\n${resposta}` });
            }
          } catch (e) { console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        // ── Texto ──
        const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!textMsg.trim()) continue;
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });

      } catch (e) { console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

module.exports = { iniciarBot, getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero };
