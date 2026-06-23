// ─── LÓGICA DO WHATSAPP / BAILEYS ──────────────────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');

const { AUTH_DIR, RENDER_API_KEY, RENDER_SERVICE_ID, GRUPO_NOME, HORA_LEMBRETE, HORA_RESUMO } = require('./config');
const { horaAtualSP, agoraData, norm } = require('./utils');
const { verificarLembretes, gerarResumoDiario } = require('./sheets');
const { transcreverAudio, limparTranscricao, corrigirTranscricao, processarTexto } = require('./handlers');

// ── Estado compartilhado ──────────────────────────────────────────────────────────────
let botConectado          = false;
let sockGlobal            = null;
let jidGrupoGlobal        = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete     = '';
let ultimoDiaResumo       = '';
let pairingPendente       = false;
let pairingNumero         = '';
let tentativasReconexao   = 0;

function getBotConectado()     { return botConectado; }
function getSockGlobal()       { return sockGlobal; }
function getPairingNumero()    { return pairingNumero; }
function setPairingPendente(v) { pairingPendente = v; }
function setPairingNumero(v)   { pairingNumero = v; }

// ── Limpa sessão corrompida (401 / loggedOut) ───────────────────────────────
function limparSessaoLocal() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[sessão] Pasta auth_info removida (sessão inválida).');
    }
  } catch (e) { console.error('Erro ao limpar sessão local:', e.message); }
}

async function limparSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const resGet  = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
    });
    const envVars   = await resGet.json();
    const existente = Array.isArray(envVars) ? envVars : (envVars.envVars || []);
    const novas = existente
      .filter(v => v.key && v.key.trim() !== '' && v.key !== 'CREDS_JSON')
      .map(v => ({ key: v.key, value: v.value }));
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(novas),
    });
    console.log('[sessão] CREDS_JSON inválido removido da Render API.');
  } catch (e) { console.error('Erro ao limpar CREDS_JSON no Render:', e.message); }
}

// ── Sessão persistente ─────────────────────────────────────────────────────���───────────
function restaurarSessao() {
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      console.log('[restaurarSessao] Usando creds.json local existente.');
      return true;
    }
    const credsJson = process.env.CREDS_JSON;
    if (!credsJson) {
      console.log('[restaurarSessao] CREDS_JSON não definido – será necessário novo pairing.');
      return false;
    }
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(credsPath, credsJson, 'utf8');
    console.log('[restaurarSessao] Sessao restaurada do CREDS_JSON.');
    return true;
  } catch (e) { console.error('Erro ao restaurar sessao:', e.message); return false; }
}

async function salvarSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
      console.warn('[sessão] RENDER_API_KEY ou RENDER_SERVICE_ID não definidos — sessão não será salva.');
      return;
    }
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      console.warn('[sessão] creds.json não encontrado — nada a salvar.');
      return;
    }
    const conteudo = fs.readFileSync(credsPath, 'utf8');
    if (conteudo === process.env.CREDS_JSON) return;

    const resGet = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Accept': 'application/json' },
    });
    if (!resGet.ok) {
      const txt = await resGet.text();
      console.error(`[sessão] Erro ao buscar env-vars (${resGet.status}):`, txt.slice(0, 200));
      return;
    }
    const envVars   = await resGet.json();
    const existente = Array.isArray(envVars) ? envVars : (envVars.envVars || []);

    const novas = [
      ...existente
        .filter(v => v.key && v.key.trim() !== '' && v.key !== 'CREDS_JSON')
        .map(v => ({ key: v.key, value: v.value })),
      { key: 'CREDS_JSON', value: conteudo },
    ];

    const resPut = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(novas),
    });
    if (!resPut.ok) {
      const txt = await resPut.text();
      console.error(`[sessão] Erro ao salvar CREDS_JSON (${resPut.status}):`, txt.slice(0, 200));
      return;
    }
    console.log('[sessão] CREDS_JSON atualizado na Render API (será usado no próximo deploy).');
  } catch (e) { console.error('Erro ao salvar sessao na Render API:', e.message); }
}

// ── Determina se o disconnect exige limpeza total de sessão ─────────────────────────
// Cobre: logout explícito (401), stream error (515), Bad MAC / sessão corrompida
function precisaLimparSessao(statusCode, errorMessage) {
  if (statusCode === DisconnectReason.loggedOut)    return true; // 401 - desconectado pelo telefone
  if (statusCode === DisconnectReason.multideviceMismatch) return true; // 411
  if (statusCode === 515) return true; // Stream error — sessão válida mas stream reiniciado pelo WA
  if (errorMessage && (
    errorMessage.includes('Bad MAC') ||
    errorMessage.includes('bad mac') ||
    errorMessage.includes('Failed to decrypt') ||
    errorMessage.includes('invalid') ||
    errorMessage.includes('401')
  )) return true;
  return false;
}

// ── iniciarBot ───────────────────────────────────────────────────────────────────────
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
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 2_000,
    maxMsgRetryCount: 5,
    getMessage: async () => undefined,
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
      botConectado        = true;
      pairingPendente     = false;
      tentativasReconexao = 0;
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

      const statusCode   = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || '';
      const deveLinpar   = precisaLimparSessao(statusCode, errorMessage);

      console.log(`[conexão] Fechada — código: ${statusCode} | msg: ${errorMessage.slice(0, 80)} | limpar: ${deveLinpar}`);

      if (deveLinpar) {
        console.log('[sessão] Sessão inválida detectada. Limpando credenciais e aguardando novo pairing...');
        limparSessaoLocal();
        await limparSessaoNoRender();
        tentativasReconexao = 0;
        // Aguarda 5s antes de reiniciar para garantir que o Render não salve o CREDS_JSON antigo
        setTimeout(iniciarBot, 5000);
      } else {
        tentativasReconexao++;
        // Backoff exponencial: 5s, 10s, 20s, 30s (máx)
        const delay = Math.min(5000 * tentativasReconexao, 30000);
        console.log(`[reconexão] Tentativa ${tentativasReconexao} em ${delay / 1000}s...`);
        setTimeout(iniciarBot, delay);
      }
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
