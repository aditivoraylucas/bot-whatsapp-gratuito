// ─── LÓGICA DO WHATSAPP / BAILEYS ────────────────────────────────────────────
// ÂNCORAS:
//   [ANCHOR:ESTADO]        — variáveis de estado compartilhado
//   [ANCHOR:RENDER-API]    — helpers para Render env-vars
//   [ANCHOR:SESSAO]        — salvar/restaurar/limpar credenciais
//   [ANCHOR:RECONEXAO]     — lógica de disconnect e reconnect
//   [ANCHOR:AGENDAMENTOS]  — lembretes e resumo diário
//   [ANCHOR:MENSAGENS]     — handler de messages.upsert
// ─────────────────────────────────────────────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');

const { AUTH_DIR, RENDER_API_KEY, RENDER_SERVICE_ID, GRUPO_NOME, HORA_LEMBRETE, HORA_RESUMO } = require('./config');
const { horaAtualSP, agoraData, norm } = require('./utils');
const { verificarLembretes, gerarResumoDiario } = require('./sheets');
const { transcreverAudio, limparTranscricao, corrigirTranscricao, processarTexto } = require('./handlers');

// ── [ANCHOR:ESTADO] Estado compartilhado ─────────────────────────────────────
let botConectado          = false;
let sockGlobal            = null;
let jidGrupoGlobal        = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete     = '';
let ultimoDiaResumo       = '';
let pairingPendente       = false;
let pairingNumero         = '';
let tentativasReconexao   = 0;
let sessaoInvalidada      = false; // true após loggedOut — só novo pairing resolve

function getBotConectado()     { return botConectado; }
function getSockGlobal()       { return sockGlobal; }
function getPairingNumero()    { return pairingNumero; }
function setPairingPendente(v) { pairingPendente = v; }
function setPairingNumero(v)   { pairingNumero = v; }

// ── [ANCHOR:RENDER-API] Helpers Render env-vars ───────────────────────────────
function normalizarEnvVars(raw) {
  if (!Array.isArray(raw)) raw = raw?.envVars || [];
  return raw
    .map(item => item.envVar ? { key: item.envVar.key, value: item.envVar.value } : { key: item.key, value: item.value })
    .filter(v => v.key && v.key.trim() !== '');
}
async function buscarEnvVarsRender() {
  const resGet = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Accept': 'application/json' },
  });
  if (!resGet.ok) throw new Error(`Render GET env-vars falhou: ${resGet.status}`);
  const lista = normalizarEnvVars(await resGet.json());
  console.log(`[Render API] ${lista.length} env-vars encontradas.`);
  return lista;
}
async function putEnvVarsRender(novas) {
  const resPut = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(novas.map(v => ({ key: v.key, value: v.value }))),
  });
  if (!resPut.ok) throw new Error(`Render PUT env-vars falhou: ${resPut.status} — ${(await resPut.text()).slice(0, 300)}`);
}

// ── [ANCHOR:SESSAO] Persistência de credenciais ───────────────────────────────
function isJsonValido(str) {
  if (!str || typeof str !== 'string' || str.trim() === '') return false;
  try { JSON.parse(str); return true; } catch { return false; }
}
function limparSessaoLocal() {
  try {
    if (fs.existsSync(AUTH_DIR)) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); console.log('[sessão] Pasta auth_info removida.'); }
  } catch (e) { console.error('Erro ao limpar sessão local:', e.message); }
}
async function limparSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const existente = await buscarEnvVarsRender();
    await putEnvVarsRender(existente.filter(v => v.key !== 'CREDS_JSON'));
    console.log('[sessão] CREDS_JSON removido da Render API.');
    delete process.env.CREDS_JSON;
  } catch (e) { console.error('[sessão] Erro ao limpar CREDS_JSON no Render:', e.message); }
}
function restaurarSessao() {
  if (sessaoInvalidada) { console.log('[restaurarSessao] Sessão invalidada — aguardando novo pareamento.'); return false; }
  try {
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (fs.existsSync(credsPath)) {
      const conteudoLocal = fs.readFileSync(credsPath, 'utf8');
      if (!isJsonValido(conteudoLocal)) {
        console.warn('[restaurarSessao] creds.json local inválido — descartando.');
        fs.unlinkSync(credsPath);
      } else {
        console.log('[restaurarSessao] Usando creds.json local existente.');
        return true;
      }
    }
    const credsJson = process.env.CREDS_JSON;
    if (!credsJson) { console.log('[restaurarSessao] CREDS_JSON não definido — necessário novo pairing.'); return false; }
    if (!isJsonValido(credsJson)) { console.warn('[restaurarSessao] CREDS_JSON inválido — ignorando.'); delete process.env.CREDS_JSON; return false; }
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), credsJson, 'utf8');
    console.log('[restaurarSessao] Sessão restaurada do CREDS_JSON.');
    return true;
  } catch (e) { console.error('Erro ao restaurar sessão:', e.message); return false; }
}
async function salvarSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const conteudo = fs.readFileSync(credsPath, 'utf8');
    if (conteudo === process.env.CREDS_JSON) return;
    const existente = await buscarEnvVarsRender();
    await putEnvVarsRender([...existente.filter(v => v.key !== 'CREDS_JSON'), { key: 'CREDS_JSON', value: conteudo }]);
    process.env.CREDS_JSON = conteudo;
    console.log('[sessão] CREDS_JSON atualizado na Render API.');
  } catch (e) { console.error('[sessão] Erro ao salvar sessão:', e.message); }
}

// ── [ANCHOR:RECONEXAO] Lógica de disconnect ───────────────────────────────────
function precisaLimparSessao(statusCode, errorMessage) {
  if (statusCode === DisconnectReason.loggedOut)           return true;
  if (statusCode === DisconnectReason.multideviceMismatch) return true;
  if (errorMessage && (errorMessage.includes('Bad MAC') || errorMessage.includes('bad mac') || errorMessage.includes('Failed to decrypt'))) return true;
  return false;
}

// ── [ANCHOR:AGENDAMENTOS] Lembretes e resumo diário ──────────────────────────
function iniciarAgendamentos(sock) {
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

// ── [ANCHOR:MENSAGENS] iniciarBot ─────────────────────────────────────────────
async function iniciarBot() {
  if (!sessaoInvalidada) restaurarSessao();

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
  sock.ev.on('creds.update', async () => { await saveCreds(); await salvarSessaoNoRender(); });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (update.qr) console.log('QR disponível (use o formulário web para parear por número)');

    if (connection === 'open') {
      botConectado        = true;
      pairingPendente     = false;
      sessaoInvalidada    = false;
      tentativasReconexao = 0;
      console.log('✅ Bot conectado ao WhatsApp!');
      await salvarSessaoNoRender();
      if (!agendamentosIniciados) { agendamentosIniciados = true; iniciarAgendamentos(sock); }
    }

    if (connection === 'close') {
      botConectado          = false;
      agendamentosIniciados = false;
      const statusCode   = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || '';
      const deveLimpar   = precisaLimparSessao(statusCode, errorMessage);
      console.log(`[conexão] Fechada — código: ${statusCode} | msg: ${errorMessage.slice(0, 80)} | limpar: ${deveLimpar}`);
      if (deveLimpar) {
        console.log('[sessão] Limpando credenciais inválidas...');
        limparSessaoLocal();
        await limparSessaoNoRender();
        tentativasReconexao = 0;
        sessaoInvalidada = true;
        console.log('[sessão] ⚠️ Sessão expirada. Aguardando novo pareamento...');
        setTimeout(iniciarBot, 5000);
      } else {
        tentativasReconexao++;
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
        const jid = msg.key.remoteJid || '';
        if (!jid.endsWith('@g.us')) continue;
        const groupMeta = await sock.groupMetadata(jid).catch(() => null);
        if (!norm(groupMeta?.subject || '').includes(norm(GRUPO_NOME))) continue;
        jidGrupoGlobal = jid;

        // Áudio
        const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            const buffer   = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const textoRaw = await transcreverAudio(buffer, audioMsg.mimetype || 'audio/ogg; codecs=opus');
            if (textoRaw) {
              const textoTranscrito = corrigirTranscricao(limparTranscricao(textoRaw));
              console.log('Transcrição:', textoRaw);
              const resposta = await processarTexto(textoTranscrito, jid, sock);
              if (resposta) await sock.sendMessage(jid, { text: `🎤 _"${textoRaw}"_\n\n${resposta}` });
            }
          } catch (e) { console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        // Texto
        const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!textMsg.trim()) continue;
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });

      } catch (e) { console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

module.exports = { iniciarBot, getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero };
