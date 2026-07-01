// ─── LÓGICA DO WHATSAPP / BAILEYS ──────────────────────────────────────────────
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs   = require('fs');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');

const { AUTH_DIR, RENDER_API_KEY, RENDER_SERVICE_ID, GRUPO_NOME, HORA_LEMBRETE, HORA_RESUMO } = require('./config');
const { horaAtualSP, agoraData, norm, toProduto, toNumero } = require('./utils');
const { verificarLembretes, gerarResumoDiario } = require('./sheets');
const {
  transcreverAudio,
  limparTranscricao,
  corrigirTranscricao,
  corrigirFoneticosProdutos,
  dedupNomeInicio,
  processarTexto,
} = require('./handlers');

// ── Estado compartilhado ────────────────────────────────────────────────────────────
let botConectado          = false;
let sockGlobal            = null;
let jidGrupoGlobal        = null;
let agendamentosIniciados = false;
let ultimoDiaLembrete     = '';
let ultimoDiaResumo       = '';
let pairingPendente       = false;
let pairingNumero         = '';
let tentativasReconexao   = 0;
let sessaoInvalidada      = false;

const mensagensProcessadas = new Set();
const TTL_MENSAGEM_MS      = 5 * 60 * 1000; // 5 minutos
const IDADE_MAXIMA_MS      = 60 * 1000;      // mensagens com mais de 60s são histórico

function getBotConectado()     { return botConectado; }
function getSockGlobal()       { return sockGlobal; }
function getPairingNumero()    { return pairingNumero; }
function setPairingPendente(v) { pairingPendente = v; }
function setPairingNumero(v)   { pairingNumero = v; }

// ── Helper: normaliza env-vars da Render API ────────────────────────────────────
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

// ── Sessão ────────────────────────────────────────────────────────────────────────────────
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

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

let _hashSalvo        = null;
let _timerRender      = null;
const DEBOUNCE_RENDER = 5 * 60 * 1000; // 5 minutos

// Salva imediatamente no disco. Agenda envio para a Render API com debounce de 5 min.
async function salvarSessaoNoRender() {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) return;

  const conteudo = fs.readFileSync(credsPath, 'utf8');
  const hash     = md5(conteudo);

  if (hash === _hashSalvo) return;
  _hashSalvo = hash;

  if (_timerRender) clearTimeout(_timerRender);
  _timerRender = setTimeout(async () => {
    _timerRender = null;
    try {
      const existente = await buscarEnvVarsRender();
      const novas = [
        ...existente.filter(v => v.key !== 'CREDS_JSON'),
        { key: 'CREDS_JSON', value: conteudo },
      ];
      await putEnvVarsRender(novas);
      process.env.CREDS_JSON = conteudo;
      console.log('[sessão] CREDS_JSON atualizado na Render API.');
    } catch (e) {
      console.error('[sessão] Erro ao salvar sessao:', e.message);
    }
  }, DEBOUNCE_RENDER);
}

async function salvarSessaoNoRenderImediato() {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  const credsPath = path.join(AUTH_DIR, 'creds.json');
  if (!fs.existsSync(credsPath)) return;

  if (_timerRender) { clearTimeout(_timerRender); _timerRender = null; }

  try {
    const conteudo  = fs.readFileSync(credsPath, 'utf8');
    const hash      = md5(conteudo);
    const existente = await buscarEnvVarsRender();
    const novas = [
      ...existente.filter(v => v.key !== 'CREDS_JSON'),
      { key: 'CREDS_JSON', value: conteudo },
    ];
    await putEnvVarsRender(novas);
    process.env.CREDS_JSON = conteudo;
    _hashSalvo = hash;
    console.log('[sessão] CREDS_JSON atualizado na Render API (imediato).');
  } catch (e) {
    console.error('[sessão] Erro ao salvar sessao (imediato):', e.message);
  }
}

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
        console.log('[restaurarSessao] creds.json atualizado a partir do CREDS_JSON.');
      } else {
        console.log('[restaurarSessao] creds.json local já está em sincronia.');
      }
      _hashSalvo = md5(credsJson);
      return true;
    }
    if (fs.existsSync(credsPath)) {
      console.log('[restaurarSessao] Usando creds.json local.');
      return true;
    }
    console.log('[restaurarSessao] Nenhuma sessão encontrada — novo pairing necessário.');
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

// ── Pipeline de correção de áudio ─────────────────────────────────────────────────
function aplicarPipelineAudio(textoRaw) {
  if (!textoRaw) return textoRaw;
  const p1 = limparTranscricao(textoRaw);
  const p2 = corrigirTranscricao(p1);
  const p3 = dedupNomeInicio(p2);
  const p4 = corrigirFoneticosProdutos(p3);
  if (p4 !== p1) console.log(`[áudio] pipeline: "${textoRaw}" → "${p4}"`);
  return p4;
}

// ── Download de áudio com retry ────────────────────────────────────────────────────
async function downloadAudioComRetry(msg, sock, logger, tentativas = 2, espera = 2000) {
  for (let i = 1; i <= tentativas; i++) {
    try {
      const buffer = await downloadMediaMessage(
        msg, 'buffer', {},
        { logger, reuploadRequest: sock.updateMediaMessage }
      );
      if (buffer && Buffer.isBuffer(buffer) && buffer.length >= 1000) return buffer;
      console.warn(`[áudio] Tentativa ${i}/${tentativas}: buffer inválido (${buffer?.length ?? 0} bytes).`);
    } catch (e) {
      console.warn(`[áudio] Tentativa ${i}/${tentativas}: erro no download — ${e.message}`);
    }
    if (i < tentativas) await new Promise(r => setTimeout(r, espera));
  }
  return null;
}

// ── Quoted reply: completa mensagem incompleta ──────────────────────────────────────
function tentarCompletarViaQuoted(textoCitado, textoResposta) {
  if (!textoCitado || !textoResposta) return null;

  const citada   = textoCitado.trim();
  const resposta = textoResposta.trim();
  const palavrasCitada   = norm(citada).split(/\s+/).filter(Boolean);
  const palavrasResposta = norm(resposta).split(/\s+/).filter(Boolean);

  let temProdutoCitada   = false;
  let temQuantidadeCitada = false;
  for (const p of palavrasCitada) {
    if (toProduto(p))        temProdutoCitada    = true;
    if (toNumero(p) !== null) temQuantidadeCitada = true;
  }

  let produtoResposta   = null;
  let quantidadeResposta = null;
  for (let i = 0; i < palavrasResposta.length; i++) {
    if (!produtoResposta) {
      if (i + 1 < palavrasResposta.length) {
        const p2 = toProduto(palavrasResposta[i] + ' ' + palavrasResposta[i + 1]);
        if (p2) { produtoResposta = p2; i++; continue; }
      }
      const p1 = toProduto(palavrasResposta[i]);
      if (p1) { produtoResposta = p1; continue; }
    }
    if (quantidadeResposta === null) {
      const q = toNumero(palavrasResposta[i]);
      if (q !== null) { quantidadeResposta = q; continue; }
    }
  }

  if (temProdutoCitada && !temQuantidadeCitada && quantidadeResposta !== null) {
    const montado = `${citada} ${quantidadeResposta}`;
    console.log(`[quoted] Fluxo1: "${citada}" + "${resposta}" → "${montado}"`);
    return montado;
  }

  if (!temProdutoCitada && temQuantidadeCitada && produtoResposta) {
    let qtdFinal = quantidadeResposta !== null ? quantidadeResposta : null;
    if (qtdFinal === null) {
      for (const p of palavrasCitada) {
        const q = toNumero(p);
        if (q !== null) { qtdFinal = q; break; }
      }
    }
    const nomePalavras = [];
    for (const p of palavrasCitada) {
      if (toNumero(p) !== null) break;
      nomePalavras.push(p);
    }
    const nome = nomePalavras.join(' ');
    if (!nome || !qtdFinal) return null;
    const montado = `${nome} ${qtdFinal} ${produtoResposta}`;
    console.log(`[quoted] Fluxo2: "${citada}" + "${resposta}" → "${montado}"`);
    return montado;
  }

  return null;
}

// ── iniciarBot ───────────────────────────────────────────────────────────────────────
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

    if (update.qr) console.log('QR disponível (use o formulário web para parear por número)');

    if (connection === 'open') {
      botConectado        = true;
      pairingPendente     = false;
      sessaoInvalidada    = false;
      tentativasReconexao = 0;
      console.log('✅ Bot conectado ao WhatsApp!');
      await salvarSessaoNoRenderImediato();

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
        // ── Filtro de idade: descarta mensagens com mais de 60s (histórico do Baileys) ──
        const msgTimestamp = msg?.messageTimestamp;
        if (msgTimestamp) {
          const idadeSec = Math.floor(Date.now() / 1000) - Number(msgTimestamp);
          if (idadeSec > 60) {
            console.log(`[dedup] mensagem antiga ignorada (${idadeSec}s): ${msg?.key?.id}`);
            continue;
          }
        }

        // ── Deduplicar por ID ──────────────────────────────────────────────────────
        const msgId = msg?.key?.id;
        if (msgId) {
          if (mensagensProcessadas.has(msgId)) { console.log(`[dedup] mensagem ignorada: ${msgId}`); continue; }
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

        // ── Áudio ───────────────────────────────────────────────────────────────
        const audioMsg = msg.message?.audioMessage
                      || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.audioMessage;
        if (audioMsg) {
          try {
            const buffer = await downloadAudioComRetry(msg, sock, logger);

            if (!buffer) {
              console.error('[áudio] Falha no download após todas as tentativas.');
              await sock.sendMessage(jid, {
                text: '⚠️ Não consegui processar esse áudio. Por favor, reenvie.',
              });
              continue;
            }

            const mimeType = audioMsg.mimetype || 'audio/ogg; codecs=opus';
            const textoRaw = await transcreverAudio(buffer, mimeType);

            if (!textoRaw) {
              console.warn('[áudio] Whisper não retornou texto.');
              continue;
            }

            const textoCorrigido = aplicarPipelineAudio(textoRaw);
            console.log(`Transcrição: ${textoRaw}`);

            const resposta = await processarTexto(textoCorrigido, jid, sock);
            if (resposta) {
              await sock.sendMessage(jid, {
                text: `🎤 _"${textoRaw}"_\n\n${resposta}`,
              });
            } else {
              await sock.sendMessage(jid, {
                text: `🎤 _"${textoRaw}"_\n\n⚠️ Não entendi esse áudio.\nTente digitar o comando ou reenvie falando mais devagar.`,
              });
            }
          } catch (e) { console.error('Erro ao processar áudio:', e.message); }
          continue;
        }

        // ── Texto ───────────────────────────────────────────────────────────────
        const textMsg = msg.message?.conversation
                     || msg.message?.extendedTextMessage?.text
                     || '';
        if (!textMsg.trim()) continue;

        // ── Quoted reply ────────────────────────────────────────────────────────
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        if (quotedMsg) {
          const textoCitado = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || '';
          if (textoCitado.trim()) {
            const textoMontado = tentarCompletarViaQuoted(textoCitado.trim(), textMsg.trim());
            if (textoMontado) {
              const respostaQuoted = await processarTexto(textoMontado, jid, sock);
              if (respostaQuoted) {
                await sock.sendMessage(jid, { text: respostaQuoted });
                continue;
              }
            }
          }
        }

        // Fluxo normal
        const resposta = await processarTexto(textMsg, jid, sock);
        if (resposta) await sock.sendMessage(jid, { text: resposta });

      } catch (e) { console.error('Erro ao processar mensagem:', e.message); }
    }
  });
}

module.exports = { iniciarBot, getBotConectado, getSockGlobal, getPairingNumero, setPairingPendente, setPairingNumero };
