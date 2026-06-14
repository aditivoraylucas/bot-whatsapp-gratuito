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
const PORT = process.env.PORT || 3000;
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

const AUTH_DIR = 'auth_info';
const PRECOS = { trufa: 5.0, bolo: 12.0 };

const SINONIMOS = {
  trufa: ['trufa', 'trufas', 'trufinha', 'trufinhas', 'bombom', 'bombons'],
  bolo:  ['bolo', 'bolos', 'bolinho', 'bolinhos', 'bolo de pote', 'bolo pote']
};

const NUMEROS_EXTENSO = {
  'um': 1, 'uma': 1, 'dois': 2, 'duas': 2,
  'tres': 3, 'quatro': 4, 'cinco': 5,
  'seis': 6, 'sete': 7, 'oito': 8, 'nove': 9,
  'dez': 10, 'onze': 11, 'doze': 12, 'treze': 13,
  'quatorze': 14, 'catorze': 14, 'quinze': 15,
  'dezesseis': 16, 'dezessete': 17, 'dezoito': 18,
  'dezenove': 19, 'vinte': 20
};

function norm(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function mesmoNome(a, b) { return norm(a) === norm(b); }

function toNumero(palavra) {
  const n = norm(palavra);
  if (/^\d+$/.test(n)) return parseInt(n);
  return NUMEROS_EXTENSO[n] ?? null;
}

function toProduto(trecho) {
  const n = norm(trecho);
  for (const [produto, sins] of Object.entries(SINONIMOS))
    for (const sin of sins)
      if (n === norm(sin)) return produto;
  return null;
}

function extrairValor(texto) {
  const t = norm(texto).replace(/r\$\s*/g, '').replace(/reais/g, '').replace(/pix/g, '').trim();
  const m = t.match(/(\d+[,.]?\d*)/);
  if (!m) return null;
  return parseFloat(m[1].replace(',', '.'));
}

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
async function getSheetSaldo() { return (await getDoc()).sheetsByIndex[0]; }
async function getSheetHistorico() {
  const doc = await getDoc();
  if (doc.sheetCount < 2) return await doc.addSheet({ title: 'Historico', headerValues: ['Data', 'Cliente', 'Tipo', 'Produto', 'Quantidade', 'Valor'] });
  const sheet = doc.sheetsByIndex[1];
  try { await sheet.loadHeaderRow(); } catch(e) { await sheet.setHeaderRow(['Data', 'Cliente', 'Tipo', 'Produto', 'Quantidade', 'Valor']); }
  return sheet;
}
function agora() { return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); }

function capitalizarNome(nome) {
  return nome.trim().split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

async function registrarOuAcumular(clienteEnviado, produto, quantidade) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const existente = rows.find(r => mesmoNome(r.get('Cliente'), clienteEnviado) && norm(r.get('Produto')) === norm(produto));
    const cliente = existente ? existente.get('Cliente') : capitalizarNome(clienteEnviado);
    const total = (PRECOS[produto] || 0) * quantidade;
    if (existente) {
      const novaQtd = parseInt(existente.get('Quantidade') || '0') + quantidade;
      const novoTotal = (PRECOS[produto] || 0) * novaQtd;
      existente.set('Quantidade', novaQtd); existente.set('Total', novoTotal.toFixed(2)); existente.set('UltimaCompra', agora());
      await existente.save();
      await (await getSheetHistorico()).addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: total.toFixed(2) });
      return { cliente, totalAcumulado: novoTotal, qtdAcumulada: novaQtd };
    } else {
      await sheet.addRow({ Cliente: cliente, Produto: produto, Quantidade: quantidade, Total: total.toFixed(2), UltimaCompra: agora() });
      await (await getSheetHistorico()).addRow({ Data: agora(), Cliente: cliente, Tipo: 'Compra', Produto: produto, Quantidade: quantidade, Valor: total.toFixed(2) });
      return { cliente, totalAcumulado: total, qtdAcumulada: quantidade };
    }
  } catch (err) { console.error('Erro planilha:', err.message); return null; }
}

async function processarPagamentoProduto(clienteEnviado, quantidade, produto) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const row = rows.find(r => mesmoNome(r.get('Cliente'), clienteEnviado) && norm(r.get('Produto')) === norm(produto));
    const cliente = row ? row.get('Cliente') : capitalizarNome(clienteEnviado);
    if (!row) return { ok: false, msg: `Nenhuma d\u00edvida de ${cliente} com ${produto} encontrada.` };
    const qtdAtual = parseInt(row.get('Quantidade') || '0');
    const qtdPaga = Math.min(quantidade, qtdAtual);
    const novaQtd = qtdAtual - qtdPaga;
    const pago = (PRECOS[produto] || 0) * qtdPaga;
    await (await getSheetHistorico()).addRow({ Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: produto, Quantidade: qtdPaga, Valor: pago.toFixed(2) });
    if (novaQtd === 0) { await row.delete(); return { ok: true, msg: `\u2705 *${cliente}* quitou toda a d\u00edvida de ${produto}! Pagou R$ ${pago.toFixed(2)}.` }; }
    const novoTotal = (PRECOS[produto] || 0) * novaQtd;
    row.set('Quantidade', novaQtd); row.set('Total', novoTotal.toFixed(2)); await row.save();
    return { ok: true, msg: `\u2705 *${cliente}* pagou ${qtdPaga} ${produto}(s) = R$ ${pago.toFixed(2)}\nRestante: ${novaQtd} unid. = R$ ${novoTotal.toFixed(2)}` };
  } catch (err) { return { ok: false, msg: '\u274c Erro ao registrar pagamento.' }; }
}

async function processarPagamentoValor(clienteEnviado, valorPago) {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();
    const rowsCliente = rows.filter(r => mesmoNome(r.get('Cliente'), clienteEnviado));
    const cliente = rowsCliente.length ? rowsCliente[0].get('Cliente') : capitalizarNome(clienteEnviado);
    if (!rowsCliente.length) return { ok: false, msg: `Nenhuma d\u00edvida encontrada para ${cliente}.` };
    let totalDevido = rowsCliente.reduce((s, r) => s + parseFloat(r.get('Total') || '0'), 0);
    await (await getSheetHistorico()).addRow({ Data: agora(), Cliente: cliente, Tipo: 'Pagamento', Produto: 'geral', Quantidade: '-', Valor: valorPago.toFixed(2) });
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
      else {
        const novoTotal = totalRow - restante;
        r.set('Total', novoTotal.toFixed(2));
        r.set('Quantidade', Math.ceil(novoTotal / preco));
        await r.save();
        restante = 0;
      }
    }
    const saldoRestante = totalDevido - valorPago;
    return { ok: true, msg: `\u2705 *${cliente}* pagou R$ ${valorPago.toFixed(2)}\nRestante devido: R$ ${saldoRestante.toFixed(2)}` };
  } catch (err) { return { ok: false, msg: '\u274c Erro ao registrar pagamento.' }; }
}

/**
 * Relatorio usa EXCLUSIVAMENTE a aba Saldo como fonte de verdade.
 * O saldo ja reflete todos os pagamentos realizados (reducoes feitas em tempo real).
 * Isso garante que o relatorio esteja sempre atualizado e correto.
 */
async function gerarRelatorioGeral() {
  try {
    const sheet = await getSheetSaldo();
    const rows = await sheet.getRows();

    if (!rows.length) return '\ud83d\udcca Nenhuma d\u00edvida em aberto no momento.';

    // Agrupa por cliente
    const clientes = {};
    for (const row of rows) {
      const nome = (row.get('Cliente') || '').trim();
      const produto = norm(row.get('Produto') || '');
      const quantidade = parseInt(row.get('Quantidade') || '0');
      const total = parseFloat(row.get('Total') || '0');
      if (!nome || !produto) continue;
      if (!clientes[nome]) clientes[nome] = { itens: [], totalDevido: 0 };
      clientes[nome].itens.push({ produto, quantidade, total });
      clientes[nome].totalDevido += total;
    }

    if (!Object.keys(clientes).length) return '\ud83d\udcca Nenhuma d\u00edvida em aberto no momento.';

    // Ordena por maior devedor
    const ordenados = Object.entries(clientes).sort((a, b) => b[1].totalDevido - a[1].totalDevido);

    let resposta = '\ud83d\udcca *Relat\u00f3rio de D\u00edvidas*\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n';
    let totalGeral = 0;

    for (const [nome, dados] of ordenados) {
      resposta += `\n\ud83d\udc64 *${nome}*\n`;
      for (const item of dados.itens) {
        const emoji = item.produto === 'bolo' ? '\ud83c\udf82' : '\ud83c\udf6b';
        const nomeProduto = item.produto === 'bolo' ? 'Bolo' : 'Trufa';
        resposta += `   ${emoji} ${nomeProduto}: ${item.quantidade} unid. = R$ ${item.total.toFixed(2)}\n`;
      }
      resposta += `   \ud83d\udcb0 *Total: R$ ${dados.totalDevido.toFixed(2)}*\n`;
      totalGeral += dados.totalDevido;
    }

    resposta += `\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\ud83d\udcb5 *TOTAL A RECEBER: R$ ${totalGeral.toFixed(2)}*`;
    return resposta;
  } catch (err) {
    console.error('Erro relatorio:', err.message);
    return '\u274c Erro ao gerar relat\u00f3rio.';
  }
}

function parsearLinha(linha) {
  const limpa = linha
    .replace(/,/g, ' ')
    .replace(/\b(mais|e|de)\b/gi, ' ')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const palavrasOrig = limpa.split(' ').filter(Boolean);
  const palavrasNorm = palavrasOrig.map(norm);
  const n = palavrasNorm.length;

  let inicioItens = -1;
  for (let i = 0; i < n; i++) {
    const p1 = toProduto(palavrasNorm[i]);
    if (p1) { inicioItens = i; break; }
    const qtd = toNumero(palavrasNorm[i]);
    if (qtd !== null && i + 1 < n) {
      const ok2 = i + 2 < n && toProduto(palavrasNorm[i+1] + ' ' + palavrasNorm[i+2]);
      const ok1 = toProduto(palavrasNorm[i+1]);
      if (ok2 || ok1) { inicioItens = i; break; }
    }
  }

  if (inicioItens < 1) return null;

  const nomeRaw = palavrasOrig.slice(0, inicioItens).join(' ').trim();
  if (!nomeRaw) return null;

  const itens = [];
  let i = inicioItens;
  while (i < n) {
    const qtd = toNumero(palavrasNorm[i]);
    if (qtd !== null && i + 1 < n) {
      if (i + 2 < n) {
        const p2 = toProduto(palavrasNorm[i+1] + ' ' + palavrasNorm[i+2]);
        if (p2) { itens.push({ quantidade: qtd, produto: p2 }); i += 3; continue; }
      }
      const p1 = toProduto(palavrasNorm[i+1]);
      if (p1) { itens.push({ quantidade: qtd, produto: p1 }); i += 2; continue; }
    }
    if (i + 1 < n) {
      const p2 = toProduto(palavrasNorm[i] + ' ' + palavrasNorm[i+1]);
      if (p2) { itens.push({ quantidade: 1, produto: p2 }); i += 2; continue; }
    }
    const p1 = toProduto(palavrasNorm[i]);
    if (p1) { itens.push({ quantidade: 1, produto: p1 }); i += 1; continue; }
    i++;
  }

  if (!itens.length) return null;
  return { nome: capitalizarNome(nomeRaw), itens };
}

function parsearPagamento(linha) {
  const t = norm(linha);
  if (!/\b(pagou|pix|transferiu|depositou|mandou|enviou)\b/.test(t)) return null;
  const matchNome = linha.match(/^(.+?)\s+(?:pagou|pix|transferiu|depositou|mandou|enviou)/i);
  if (!matchNome) return null;
  const nome = matchNome[1].trim();
  const resto = linha.slice(matchNome[0].length).trim();
  const palavras = norm(resto).replace(/\bde\b/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < palavras.length; i++) {
    const qtd = toNumero(palavras[i]);
    if (qtd === null) continue;
    if (i + 2 < palavras.length) {
      const p2 = toProduto(palavras[i+1] + ' ' + palavras[i+2]);
      if (p2) return { tipo: 'produto', nome, qtd, produto: p2 };
    }
    if (i + 1 < palavras.length) {
      const p1 = toProduto(palavras[i+1]);
      if (p1) return { tipo: 'produto', nome, qtd, produto: p1 };
    }
  }
  for (let i = 0; i < palavras.length; i++) {
    if (i + 1 < palavras.length) {
      const p2 = toProduto(palavras[i] + ' ' + palavras[i+1]);
      if (p2) return { tipo: 'produto', nome, qtd: 1, produto: p2 };
    }
    const p1 = toProduto(palavras[i]);
    if (p1) return { tipo: 'produto', nome, qtd: 1, produto: p1 };
  }
  const valor = extrairValor(resto);
  if (valor && valor > 0) return { tipo: 'valor', nome, valor };
  return null;
}

function isRelatorio(texto) {
  const t = norm(texto);
  return t.includes('relatorio') || t.includes('saldo') || t.includes('relatorio geral');
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
              respostas.push(result.msg);
              continue;
            }
            const parsed = parsearLinha(linha);
            if (!parsed) continue;
            const linhasResposta = [];
            for (const item of parsed.itens) {
              const resultado = await registrarOuAcumular(parsed.nome, item.produto, item.quantidade);
              if (resultado) {
                linhasResposta.push(
                  `${item.produto === 'bolo' ? '\ud83c\udf82 Bolo' : '\ud83c\udf6b Trufa'}: +${item.quantidade} | Total: ${resultado.qtdAcumulada} unid. = R$ ${resultado.totalAcumulado.toFixed(2)}`
                );
              }
            }
            if (linhasResposta.length) respostas.push(`*${parsed.nome}*\n` + linhasResposta.join('\n'));
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
