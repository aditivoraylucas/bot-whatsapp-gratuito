process.on('uncaughtException', err => console.error('Erro nao tratado:', err.message));
process.on('unhandledRejection', err => console.error('Promise rejeitada:', err?.message || err));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
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
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

const AUTH_DIR = 'auth_info';

const PRECOS = { trufa: 5.0, bombom: 5.0, bolo: 12.0 };
const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'bombom', 'bombons'],
  bolo: ['bolo', 'bolinho', 'bolo de pote', 'bolo pote']
};

let botConectado = false;
let qrCodeData = null;

function restaurarSessao() {
  try {
    const credsJson = process.env.CREDS_JSON;
    if (!credsJson) return false;
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), credsJson, 'utf8');
    console.log('Sessao restaurada do CREDS_JSON');
    return true;
  } catch (e) {
    console.error('Erro ao restaurar sessao:', e.message);
    return false;
  }
}

async function salvarSessaoNoRender() {
  try {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
    const credsPath = path.join(AUTH_DIR, 'creds.json');
    if (!fs.existsSync(credsPath)) return;
    const conteudo = fs.readFileSync(credsPath, 'utf8');
    const fetch = (await import('node-fetch')).default;
    const resGet = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' }
    });
    const envVars = await resGet.json();
    const existente = Array.isArray(envVars) ? envVars : (envVars.envVars || []);
    const novas = [...existente.filter(v => v.key !== 'CREDS_JSON').map(v => ({ key: v.key, value: v.value })), { key: 'CREDS_JSON', value: conteudo }];
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(novas)
    });
    console.log('Sessao salva no Render!');
  } catch (e) { console.error('Erro ao salvar sessao:', e.message); }
}

http.createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (botConectado) {
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u2705 Bot conectado!</h1><p>Funcionando normalmente.</p></body></html>');
    } else if (qrCodeData) {
      const qrImage = await qrcode.toDataURL(qrCodeData).catch(() => null);
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px">
        <h1>\ud83d\udcf1 Escanear QR Code</h1>
        <p>WhatsApp \u2192 Configura\u00e7\u00f5es \u2192 Aparelhos conectados \u2192 Conectar aparelho</p>
        <p>Aponte a c\u00e2mera do WhatsApp para o QR Code abaixo:</p>
        ${qrImage ? `<img src="${qrImage}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:10px" />` : '<p>Gerando QR...</p>'}
        <p style="color:#888">O QR Code atualiza automaticamente a cada 25 segundos</p>
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

async function registrarOuAcumular(cliente, produto, quantidade) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const nomeNorm = cliente.toLowerCase().trim();
    const prodNorm = produto.toLowerCase().trim();
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
      return { totalAcumulado: novoTotal, qtdAcumulada: novaQtd };
    } else {
      const total = (PRECOS[produto] || 0) * quantidade;
      await sheet.addRow({ Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: total.toFixed(2), UltimaCompra: agora });
      return { totalAcumulado: total, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

async function processarPagamentoProduto(cliente, quantidade, produto) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r =>
      (r.get('Cliente') || '').toLowerCase().trim() === cliente.toLowerCase().trim() &&
      (r.get('Produto') || '').toLowerCase().trim() === produto.toLowerCase().trim()
    );
    if (!row) return { ok: false, msg: `Nenhuma d\u00edvida de ${cliente} com ${produto} encontrada.` };
    const qtdAtual = parseInt(row.get('Quantidade') || '0');
    const novaQtd = Math.max(0, qtdAtual - quantidade);
    const pago = (PRECOS[produto] || 0) * Math.min(quantidade, qtdAtual);
    if (novaQtd === 0) {
      await row.delete();
      return { ok: true, msg: `\u2705 *${cliente}* quitou toda a d\u00edvida de ${produto}! Pagou R$ ${pago.toFixed(2)}.` };
    }
    const novoTotal = (PRECOS[produto] || 0) * novaQtd;
    row.set('Quantidade', novaQtd); row.set('Total', novoTotal.toFixed(2)); await row.save();
    return { ok: true, msg: `\u2705 *${cliente}* pagou ${Math.min(quantidade, qtdAtual)} ${produto}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { return { ok: false, msg: '\u274c Erro ao registrar pagamento.' }; }
}

async function processarPagamentoValor(cliente, valorPago) {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const rowsCliente = rows.filter(r => (r.get('Cliente') || '').toLowerCase().trim() === cliente.toLowerCase().trim());
    if (!rowsCliente.length) return { ok: false, msg: `Nenhuma d\u00edvida encontrada para ${cliente}.` };
    let totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    if (valorPago >= totalDevido) {
      for (const r of rowsCliente) await r.delete();
      return { ok: true, msg: `\u2705 *${cliente}* quitou toda a d\u00edvida! Pagou R$ ${valorPago.toFixed(2)}.` };
    }
    let restante = valorPago;
    for (const r of rowsCliente) {
      if (restante <= 0) break;
      const totalRow = parseFloat(r.get('Total') || '0');
      const preco = PRECOS[r.get('Produto')] || 5;
      if (restante >= totalRow) { restante -= totalRow; await r.delete(); }
      else { r.set('Total', (totalRow - restante).toFixed(2)); r.set('Quantidade', Math.ceil((totalRow - restante) / preco)); await r.save(); restante = 0; }
    }
    return { ok: true, msg: `\u2705 *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${(totalDevido - valorPago).toFixed(2)}` };
  } catch (err) { return { ok: false, msg: '\u274c Erro ao registrar pagamento.' }; }
}

function parsearPagamento(texto) {
  if (!texto.toLowerCase().includes('pagou')) return null;
  const porValor = texto.match(/^(.+?)\s+pagou\s+(\d+[.,]?\d*)\s*(reais|r\$)?$/i);
  if (porValor) return { tipo: 'valor', nome: capitalizarNome(porValor[1].trim()), valor: parseFloat(porValor[2].replace(',', '.')) };
  const porProduto = texto.match(/^(.+?)\s+pagou\s+(\d+)\s+(.+?)(?:\s+hoje)?$/i);
  if (porProduto) {
    const produto = identificarProduto(porProduto[3]);
    if (produto) return { tipo: 'produto', nome: capitalizarNome(porProduto[1].trim()), qtd: parseInt(porProduto[2]), produto };
  }
  return null;
}

function capitalizarNome(nome) {
  return nome.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

async function gerarRelatorio() {
  try {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    if (!rows.length) return '\ud83d\udcca Nenhuma venda registrada ainda.';
    const clientes = {};
    for (const row of rows) {
      const nome = (row.get('Cliente') || '').trim();
      const produto = (row.get('Produto') || '').trim();
      const qtd = parseInt(row.get('Quantidade') || '0');
      const total = parseFloat(row.get('Total') || '0');
      if (!nome) continue;
      if (!clientes[nome]) clientes[nome] = [];
      clientes[nome].push({ produto, qtd, total });
    }
    let resposta = '\ud83d\udcca *Relat\u00f3rio de Saldos*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    let totalGeral = 0;
    for (const [nome, itens] of Object.entries(clientes)) {
      let totalCliente = 0;
      resposta += `\n\ud83d\udc64 *${nome}*\n`;
      for (const { produto, qtd, total } of itens) {
        resposta += `   ${produto === 'bolo' ? '\ud83c\udf82 Bolo' : '\ud83c\udf6b Trufa'}: ${qtd} unid. = R$ ${total.toFixed(2)}\n`;
        totalCliente += total;
      }
      resposta += `   \ud83d\udcb0 Deve: *R$ ${totalCliente.toFixed(2)}*\n`;
      totalGeral += totalCliente;
    }
    resposta += `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\ud83d\udcb5 *TOTAL GERAL: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch (err) { return '\u274c Erro ao gerar relat\u00f3rio.'; }
}

function identificarProduto(texto) {
  const lower = (texto || '').toLowerCase();
  for (const [produto, sins] of Object.entries(SINONIMOS))
    for (const sin of sins)
      if (lower.includes(sin)) return produto;
  return null;
}

function parsearMensagem(texto) {
  const match = texto.match(/^(.+?)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  const qtd = parseInt(match[2]);
  const produto = identificarProduto(match[3].trim());
  if (!produto || qtd <= 0) return null;
  return { nome: capitalizarNome(match[1].trim()), quantidade: qtd, produto };
}

let reconectando = false;

async function iniciarBot() {
  if (reconectando) return;
  reconectando = true;
  restaurarSessao();
  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await salvarSessaoNoRender();
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrCodeData = qr;
        console.log('QR Code gerado — acesse o link para escanear');
      }
      if (connection === 'close') {
        botConectado = false; reconectando = false;
        const code = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output?.statusCode : null;
        console.log(`Conexao fechada. Codigo: ${code}`);
        if (code === DisconnectReason.loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e) {}
        }
        setTimeout(iniciarBot, 5000);
      } else if (connection === 'open') {
        botConectado = true; qrCodeData = null; reconectando = false;
        console.log('\u2705 Bot conectado!');
        salvarSessaoNoRender();
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
          const textoNorm = texto.trim().toLowerCase();
          if (['relatorio', 'relat\u00f3rio', 'saldo', 'saldos'].includes(textoNorm)) {
            await sock.sendMessage(msg.key.remoteJid, { text: await gerarRelatorio() });
            continue;
          }
          const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean);
          const respostas = [];
          for (const linha of linhas) {
            const pagamento = parsearPagamento(linha);
            if (pagamento) {
              const result = pagamento.tipo === 'valor'
                ? await processarPagamentoValor(pagamento.nome, pagamento.valor)
                : await processarPagamentoProduto(pagamento.nome, pagamento.qtd, pagamento.produto);
              respostas.push(result.msg); continue;
            }
            const parsed = parsearMensagem(linha);
            if (!parsed) continue;
            const resultado = await registrarOuAcumular(parsed.nome, parsed.produto, parsed.quantidade);
            if (resultado) {
              respostas.push(`${parsed.produto === 'bolo' ? '\ud83c\udf82' : '\ud83c\udf6b'} *${parsed.nome}* \u2014 ${parsed.produto === 'bolo' ? 'Bolo' : 'Trufa'}\n   +${parsed.quantidade} agora | Total: ${resultado.qtdAcumulada} unid. = R$ ${resultado.totalAcumulado.toFixed(2)}`);
            }
          }
          if (respostas.length) await sock.sendMessage(msg.key.remoteJid, { text: respostas.join('\n\n').trim() });
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
