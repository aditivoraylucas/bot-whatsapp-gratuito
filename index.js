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
  } catch (e) { console.error('Erro ao restaurar sessao:', e.message); return false; }
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
        ${qrImage ? `<img src="${qrImage}" style="width:300px;height:300px;border:4px solid #25D366;border-radius:10px" />` : '<p>Gerando QR...</p>'}
        <script>setTimeout(()=>location.reload(),25000)</script>
      </body></html>`);
    } else {
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:50px"><h1>\u23f3 Iniciando bot...</h1><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
    }
  } catch(e) { res.end('<html><body><h1>Carregando...</h1><script>setTimeout(()=>location.reload(),3000)</script></body></html>'); }
}).listen(PORT, () => console.log(`\u2705 Servidor rodando na porta ${PORT}`));

function getAuth() {
  return new JWT({ email: GOOGLE_SERVICE_ACCOUNT_EMAIL, key: GOOGLE_PRIVATE_KEY, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function getDoc() {
  const doc = new GoogleSpreadsheet(SPREADSHEET_ID, getAuth());
  await doc.loadInfo();
  return doc;
}

async function getSheetSaldo() {
  const doc = await getDoc();
  return doc.sheetsByIndex[0];
}

async function getSheetHistorico() {
  const doc = await getDoc();
  // Usa segunda aba, cria se nao existir
  if (doc.sheetCount < 2) {
    const sheet = await doc.addSheet({ title: 'Historico', headerValues: ['Data', 'Cliente', 'Tipo', 'Produto', 'Quantidade', 'Valor'] });
    return sheet;
  }
  const sheet = doc.sheetsByIndex[1];
  // Garante cabecalho
  try { await sheet.loadHeaderRow(); } catch(e) {
    await sheet.setHeaderRow(['Data', 'Cliente', 'Tipo', 'Produto', 'Quantidade', 'Valor']);
  }
  return sheet;
}

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function registrarOuAcumular(cliente, produto, quantidade) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const nomeNorm = cliente.toLowerCase().trim();
    const prodNorm = produto.toLowerCase().trim();
    const existente = rows.find(r =>
      (r.get('Cliente') || '').toLowerCase().trim() === nomeNorm &&
      (r.get('Produto') || '').toLowerCase().trim() === prodNorm
    );
    const total = (PRECOS[produto] || 0) * quantidade;
    if (existente) {
      const novaQtd = parseInt(existente.get('Quantidade') || '0') + quantidade;
      const novoTotal = (PRECOS[produto] || 0) * novaQtd;
      existente.set('Quantidade', novaQtd); existente.set('Total', novoTotal.toFixed(2)); existente.set('UltimaCompra', agora());
      await existente.save();
      // Historico
      const hist = await getSheetHistorico();
      await hist.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: total.toFixed(2) });
      return { totalAcumulado: novoTotal, qtdAcumulada: novaQtd };
    } else {
      await sheet.addRow({ Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: total.toFixed(2), UltimaCompra: agora() });
      const hist = await getSheetHistorico();
      await hist.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: total.toFixed(2) });
      return { totalAcumulado: total, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

async function processarPagamentoProduto(cliente, quantidade, produto) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const row = rows.find(r =>
      (r.get('Cliente') || '').toLowerCase().trim() === cliente.toLowerCase().trim() &&
      (r.get('Produto') || '').toLowerCase().trim() === produto.toLowerCase().trim()
    );
    if (!row) return { ok: false, msg: `Nenhuma d\u00edvida de ${cliente} com ${produto} encontrada.` };
    const qtdAtual = parseInt(row.get('Quantidade') || '0');
    const qtdPaga = Math.min(quantidade, qtdAtual);
    const novaQtd = qtdAtual - qtdPaga;
    const pago = (PRECOS[produto] || 0) * qtdPaga;
    const hist = await getSheetHistorico();
    await hist.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: produto, Quantidade: qtdPaga, Valor: pago.toFixed(2) });
    if (novaQtd === 0) {
      await row.delete();
      return { ok: true, msg: `\u2705 *${cliente}* quitou toda a d\u00edvida de ${produto}! Pagou R$ ${pago.toFixed(2)}.` };
    }
    const novoTotal = (PRECOS[produto] || 0) * novaQtd;
    row.set('Quantidade', novaQtd); row.set('Total', novoTotal.toFixed(2)); await row.save();
    return { ok: true, msg: `\u2705 *${cliente}* pagou ${qtdPaga} ${produto}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { return { ok: false, msg: '\u274c Erro ao registrar pagamento.' }; }
}

async function processarPagamentoValor(cliente, valorPago) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const rowsCliente = rows.filter(r => (r.get('Cliente') || '').toLowerCase().trim() === cliente.toLowerCase().trim());
    if (!rowsCliente.length) return { ok: false, msg: `Nenhuma d\u00edvida encontrada para ${cliente}.` };
    let totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    const hist = await getSheetHistorico();
    await hist.addRow({ Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: valorPago.toFixed(2) });
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

async function gerarRelatorioGeral() {
  try {
    const doc = await getDoc();
    const sheetSaldo = doc.sheetsByIndex[0];
    const rowsSaldo = await sheetSaldo.getRows();

    // Historico
    let rowsHist = [];
    if (doc.sheetCount >= 2) {
      const sheetHist = doc.sheetsByIndex[1];
      try { await sheetHist.loadHeaderRow(); rowsHist = await sheetHist.getRows(); } catch(e) {}
    }

    if (!rowsSaldo.length && !rowsHist.length) return '\ud83d\udcca Nenhuma movimenta\u00e7\u00e3o registrada ainda.';

    // Agrupa historico por cliente
    const hist = {};
    for (const row of rowsHist) {
      const nome = (row.get('Cliente') || '').trim();
      const tipo = (row.get('Tipo') || '').trim();
      const valor = parseFloat(row.get('Valor') || '0');
      const qtd = row.get('Quantidade');
      const produto = (row.get('Produto') || '').trim();
      if (!nome) continue;
      if (!hist[nome]) hist[nome] = { totalComprado: 0, totalPago: 0, itensComprados: {} };
      if (tipo === 'Compra') {
        hist[nome].totalComprado += valor;
        if (!hist[nome].itensComprados[produto]) hist[nome].itensComprados[produto] = 0;
        hist[nome].itensComprados[produto] += parseInt(qtd) || 0;
      } else if (tipo === 'Pagamento') {
        hist[nome].totalPago += valor;
      }
    }

    // Saldo atual por cliente
    const saldos = {};
    for (const row of rowsSaldo) {
      const nome = (row.get('Cliente') || '').trim();
      const total = parseFloat(row.get('Total') || '0');
      if (!nome) continue;
      if (!saldos[nome]) saldos[nome] = 0;
      saldos[nome] += total;
    }

    const todosClientes = new Set([...Object.keys(hist), ...Object.keys(saldos)]);
    let resposta = '\ud83d\udcca *Relat\u00f3rio Geral*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    let totalGeral = 0;

    for (const nome of todosClientes) {
      const h = hist[nome] || { totalComprado: 0, totalPago: 0, itensComprados: {} };
      const saldo = saldos[nome] || 0;
      resposta += `\n\ud83d\udc64 *${nome}*\n`;
      if (Object.keys(h.itensComprados).length) {
        for (const [prod, qtd] of Object.entries(h.itensComprados)) {
          const emoji = prod === 'bolo' ? '\ud83c\udf82' : '\ud83c\udf6b';
          resposta += `   ${emoji} ${prod === 'bolo' ? 'Bolo' : 'Trufa'}: ${qtd} comprados\n`;
        }
      }
      resposta += `   \ud83d\uded2 Total comprado: R$ ${h.totalComprado.toFixed(2)}\n`;
      if (h.totalPago > 0) resposta += `   \u2705 Total pago: R$ ${h.totalPago.toFixed(2)}\n`;
      resposta += `   \ud83d\udcb0 *Saldo devedor: R$ ${saldo.toFixed(2)}*\n`;
      totalGeral += saldo;
    }

    resposta += `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\ud83d\udcb5 *TOTAL GERAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch (err) { console.error('Erro relatorio:', err.message); return '\u274c Erro ao gerar relat\u00f3rio.'; }
}

function identificarProduto(texto) {
  const lower = (texto || '').toLowerCase();
  for (const [produto, sins] of Object.entries(SINONIMOS))
    for (const sin of sins)
      if (lower.includes(sin)) return produto;
  return null;
}

function capitalizarNome(nome) {
  return nome.split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
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

function parsearMensagem(texto) {
  const match = texto.match(/^(.+?)\s+(\d+)\s+(.+)$/);
  if (!match) return null;
  const qtd = parseInt(match[2]);
  const produto = identificarProduto(match[3].trim());
  if (!produto || qtd <= 0) return null;
  return { nome: capitalizarNome(match[1].trim()), quantidade: qtd, produto };
}

function isRelatorio(texto) {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return t.includes('relatorio') || t.includes('saldo') || t.includes('me de o relatorio') || t.includes('relatorio geral');
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
      printQRInTerminal: false, logger,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000, retryRequestDelayMs: 3000, maxMsgRetryCount: 3
    });

    sock.ev.on('creds.update', async () => { await saveCreds(); await salvarSessaoNoRender(); });

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) { qrCodeData = qr; console.log('QR Code gerado'); }
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

          if (isRelatorio(texto)) {
            await sock.sendMessage(msg.key.remoteJid, { text: await gerarRelatorioGeral() });
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
