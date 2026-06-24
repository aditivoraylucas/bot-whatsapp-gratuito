// ─── MÓDULO DE PRODUTOS E AJUDA ──────────────────────────────────────────────
// Responsabilidade: comandos de preço, cadastro de produto, listagem e mensagem
// de ajuda. Sem dependência de Sheets nem de estado de sessão.
// ─────────────────────────────────────────────────────────────────────────────
const {
  norm, capitalizarNome,
  toProduto, nomeProdutoExib,
  PRECOS, SINONIMOS_EXTRA, salvarPrecos, salvarSinonimosExtra, todosOsSinonimos,
} = require('../utils');

function mudarPreco(produto, novoPreco) {
  const p = toProduto(produto);
  if (!p) return `❌ Produto *${produto}* não encontrado.`;
  const precoAntigo = PRECOS[p] || 0;
  PRECOS[p] = novoPreco;
  salvarPrecos();
  return `✅ Preço de *${nomeProdutoExib(p)}* atualizado: R$ ${precoAntigo.toFixed(2)} → R$ ${novoPreco.toFixed(2)}\n_Saldos existentes não foram alterados. Vale para novas compras._`;
}

function cadastrarNovoProduto(nomeProduto, preco) {
  const key = norm(nomeProduto).replace(/\s+/g, '_');
  if (PRECOS[key] !== undefined) return `⚠️ Produto *${nomeProduto}* já existe. Para mudar o preço: _preco ${nomeProduto} R$XX_`;
  PRECOS[key] = preco;
  SINONIMOS_EXTRA[key] = [...new Set([norm(nomeProduto), nomeProduto.toLowerCase().trim()])];
  salvarPrecos();
  salvarSinonimosExtra();
  return `✅ Novo produto cadastrado!\n*${capitalizarNome(nomeProduto)}* = R$ ${preco.toFixed(2)}\nUso: _"cliente nome ${norm(nomeProduto)}"_`;
}

function listarProdutos() {
  const todos = todosOsSinonimos();
  let msg = '*Produtos cadastrados*\n───────────────\n';
  for (const [key] of Object.entries(todos)) {
    const preco = PRECOS[key];
    if (preco === undefined) continue;
    msg += `${nomeProdutoExib(key)}: R$ ${preco.toFixed(2)}\n`;
  }
  msg += '───────────────\n_Para mudar o preço: preco [produto] [valor]_';
  return msg;
}

function mensagemAjuda() {
  return [
    '*Bot de Vendas 🥇*','───────────────',
    '*Registrar compra (fiado):*','  `julia 2 trufas`','  `carlos 1 bolo 3 trufas`','',
    '*Venda à vista (pago na hora):*','  `julia 2 trufas pago`','  `carlos 1 bolo pago pix`','  `ana 3 trufas pago dinheiro`','  `ana pegou 2 trufas e pagou pix`','',
    '*Registrar pagamento de dívida:*','  `julia pagou 10`','  `carlos pix 15`','  `ana pagou 2 trufas`','',
    '*Relatórios:*',
    '  `relatorio` — geral (maior devedor primeiro)',
    '  `relatorio nome` — ordenado A–Z',
    '  `relatorio data` — ordenado por compra mais recente',
    '  `relatorio valor` — ordenado por valor (explícito)',
    '  `relatorio detalhado`',
    '  `relatorio quitados`',
    '  `relatorio junho`',
    '  `resumo` — resumo do dia','',
    '*Consultas:*','  `saldo julia`','  `historico carlos`','',
    '*Aliases (apelidos):*',
    '  `alias ray Raylucas` — define "ray" como apelido de "Raylucas"',
    '  `alias ju Julia Souza` — define "ju" como apelido de "Julia Souza"',
    '  `alias ray` — remove o apelido "ray"',
    '  `aliases` — lista todos os apelidos cadastrados',
    '',
    '*Outros:*',
    '  `cancelar julia` — desfaz último lançamento',
    '  `zerar carlos` — zera dívida (pede confirmação)',
    '  `produtos` — lista produtos e preços',
    '  `preco trufa 6` — muda preço',
    '  `novo brigadeiro 3.50` — cadastra produto',
  ].join('\n');
}

module.exports = { mudarPreco, cadastrarNovoProduto, listarProdutos, mensagemAjuda };
