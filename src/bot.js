// ─── LÓGICA DO WHATSAPP / BAILEYS ──────────────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');

const { AUTH_DIR, RENDER_API_KEY, RENDER_SERVICE_ID, GRUPO_NOME, HORA_LEMBRETE, HORA_RESUMO } = require('./config');
const { horaAtualSP, agoraData, norm } = require('./utils');
const { verificarLembretes, gerarResumoDiario } = require('./sheets');
const { transcreverAudio, limparTranscricao, corrigirTranscricao, corrigirFoneticosProdutos, processarTexto } = require('./handlers');

// ── Estado compartilhado ──────────────────────────────────────────────────────
let botConectado          = false;
let sockGlobal            = null;
let jidGrupoGlobal        = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete     = '';
let ultimoDiaResumo       = '';
let pairingPendente       = false;
let pairingNumero         = '';
let tentativasReconexao   = 0;

// Flag que impede restaurar sessão após loggedOut — só novo pairing resolve
let sessaoInvalidada = false;

// ── Deduplicação de mensagens ─────────────────────────────────────────────────
const mensagensProcessadas = new Set();
const TTL_MENSAGEM_MS      = 30_000;

function getBotConectado()     { return botConectado; }
function getSockGlobal()       { return sockGlobal; }
function getPairingNumero()    { return pairingNumero; }
function setPairingPendente(v) { pairingPendente = v; }
function setPairingNumero(v)   { pairingNumero = v; }

// ── Helper: normaliza o array de env-vars da Render API ──────────────────────
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
  const raw   = await resGet.json();
  const lista = normalizarEnvVars(raw);
  console.log(`[Render API] ${lista.length} env-vars encontradas.`);
  return lista;
}

async function putEnvVarsRender(novas) {
  const payload = novas.map(v => ({ key: v.key, value: v.value }));
  const resPut = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resPut.ok) throw new Error(`Render PUT env-vars falhou: ${resPut.status} — ${(await resPut.text()).slice(0, 300)}`);
}

// ── Limpa sessão corrompida (401 / loggedOut) ─────────────────────────────────
function limparSessaoLocal() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[sessão] Pasta auth_info removida.');
    }
  } catch (e) { console.error('Erro ao limpar sessão local:', e.message); }
}

async function limparSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const existente = await buscarEnvVarsRender();
    const novas = existente.filter(v => v.key !== 'CREDS_JSON');
    await putEnvVarsRender(novas);
    console.log('[sessão] CREDS_JSON removido da Render API.');
    delete process.env.CREDS_JSON;
    _hashSalvo = null;
  } catch (e) { console.error('[sessão] Erro ao limpar CREDS_JSON no Render:', e.message); }
}

// ── Fila de salvamento — evita PUT simultâneo e race condition ────────────────
let _salvandoAgora  = false;
let _salvarNovamente = false;
let _hashSalvo      = null;

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function salvarSessaoNoRender() {
  if (_salvandoAgora) { _salvarNovamente = true; return; }
  _salvandoAgora = true;
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const conteudo = fs.readFileSync(credsPath, 'utf8');
    const hash     = md5(conteudo);
    if (hash === _hashSalvo) return;
    const existente = await buscarEnvVarsRender();
    const novas = [
      ...existente.filter(v => v.key !== 'CREDS_JSON'),
      { key: 'CREDS_JSON', value: conteudo },
    ];
    await putEnvVarsRender(novas);
    process.env.CREDS_JSON = conteudo;
    _hashSalvo = hash;
    console.log('[sessão] CREDS_JSON atualizado na Render API.');
  } catch (e) {
    console.error('[sessão] Erro ao salvar sessao:', e.message);
  } finally {
    _salvandoAgora = false;
    if (_salvarNovamente) { _salvarNovamente = false; salvarSessaoNoRender(); }
  }
}

// ── Sessão persistente ────────────────────────────────────────────────────────
function restaurarSessao() {
  if (sessaoInvalidada) {
    console.log('[restaurarSessao] Sessão invalidada — aguardando novo pareamento.');
    return false;
  }
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    const credsJson = process.env.CREDS_JSON;
    if (credsJson) {
      const localExiste   = fs.existsSync(credsPath);
      const localConteudo = localExiste ? fs.readFileSync(credsPath, 'utf8') : null;
      if (!localExiste || md5(localConteudo) !== md5(credsJson)) {
        fs.writeFileSync(credsPath, credsJson, 'utf8');
        console.log('[restaurarSessao] creds.json atualizado a partir do CREDS_JSON (env-var).');
      } else {
        console.log('[restaurarSessao] creds.json local já está em sincronia com CREDS_JSON.');
      }
      _hashSalvo = md5(credsJson);
      return true;
    }
    if (fs.existsSync(credsPath)) {
      console.log('[restaurarSessao] Usando creds.json local (sem CREDS_JSON na env-var).');
      return true;
    }
    console.log('[restaurarSessao] Nenhuma sessão encontrada — será necessário novo pairing.');
    return false;
  } catch (e) { console.error('Erro ao restaurar sessao:', e.message); return false; }
}

function precisaLimparSessao(statusCode, errorMessage) {
  if (statusCode === DisconnectReason.loggedOut)           return true;
  if (statusCode === DisconnectReason.multideviceMismatch) return true;
  if (errorMessage && (
    errorMessage.includes('Bad MAC') ||
    errorMessage.includes('bad mac') ||
    errorMessage.includes('Failed to decrypt')
  )) return true;
  return false;
}

// ── iniciarBot ────────────────────────────────────────────────────────────────
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
      sessaoInvalidada    = false;
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
      const deveLimpar   = precisaLimparSessao(statusCode, errorMessage);

      console.log(`[conexão] Fechada — código: ${statusCode} | msg: ${errorMessage.slice(0, 80)} | limpar: ${deveLimpar}`);

      if (deveLimpar) {
        console.log('[sessão] Limpando credenciais inválidas...');
        limparSessaoLocal();
        await limparSessaoNoRender();
        tentativasReconexao = 0;
        sessaoInvalidada = true;
        console.log('[sessão] ⚠️ Sessão expirada. Aguardando novo pareamento pelo formulário web...');
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
        const msgId = msg?.key?.id;
        if (msgId) {
          if (mensagensProcessadas.has(msgId)) {
            console.log(`[dedup] mensagem ignorada (duplicada): ${msgId}`);
            continue;
          }
          mensagensProcessadas.add(msgId);
          setTimeout(() => mensagensProcessadas.delete(msgId), TTL_MENSAGEM_MS);
        }

        if (msg.key.fromMe) continue;
        const jid     = msg.key.remoteJid || '';
        const isGroup = jid.endsWith('@g.us');
        if (!isGroup) continue;

        const groupMeta = await sock.groupMetadata(jid).catch(() => null);
        const nomeGrupo = groupMeta?.subject || '';
        if (!norm(nomeGrupo).includes(norm(GRUPO_NOME))) continue;
        jidGrupoGlobal = jid;

        // ── Áudio ──────────────────────────────────────────────────────────────
        const audioMsg = msg.message?.audioMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            const buffer = await downloadMediaMessage(
              msg, 'buffer', {},
              { logger, reuploadRequest: sock.updateMediaMessage }
            );

            if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 1000) {
              console.warn(`[áudio] Buffer inválido ou muito pequeno (${buffer?.length ?? 0} bytes) — ignorando.`);
              continue;
            }

            const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const textoRaw = await transcreverAudio(buffer, mimeType);

            if (textoRaw) {
              // Pipeline de correção: limpeza → correção de voz → correção fonética
              const textoCorrigido = corrigirFoneticosProdutos(
                corrigirTranscricao(
                  limparTranscricao(textoRaw)
                )
              );
              console.log('Transcrição:', textoRaw);
              if (textoCorrigido !== limparTranscricao(textoRaw)) {
                console.log('Transcrição corrigida:', textoCorrigido);
              }

              const resposta = await processarTexto(textoCorrigido, jid, sock);
              if (resposta) {
                // Confirmação: mostra o que o bot entendeu + resultado
                await sock.sendMessage(jid, {
                  text: `🎤 _"${textoRaw}"_\n\n${resposta}`,
                });
              } else {
                // Áudio não reconhecido — avisa para reenviar
                await sock.sendMessage(jid, {
                  text: `🎤 _"${textoRaw}"_\n\n⚠️ Não entendi esse áudio. Tente reenviar ou digite o comando.`,
                });
              }
            }
          } catch (e) { console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        // ── Texto ───────────────────────────────────────────────────────────────
        const textMsg = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        if (!textMsg.trim()) continue;
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });

      } catch (e) { console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

module.exports = { iniciarBot, getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero };
