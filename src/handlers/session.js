// ─── MÓDULO DE ESTADO DE SESSÃO ──────────────────────────────────────────────
// Responsabilidade: estado em memória por JID.
// ─────────────────────────────────────────────────────────────────────────────

// Confirmação pendente de "zerar cliente" por JID
const ZERAR_PENDENTE = {};
const ZERAR_TTL_MS   = 60_000;

// Ordens válidas para o comando "relatorio"
const ORDENS_RELATORIO = new Set(['nome', 'data', 'valor']);

// ── Estado de confirmação de compra incompleta ────────────────────────────────
// Estrutura por JID:
// {
//   etapa: 'produto' | 'quantidade',
//   nome: 'Carla',
//   produto: null | 'trufa',
//   transcricaoOriginal: 'momon',
//   expira: timestamp
// }
const CONFIRMACAO_PENDENTE = {};
const CONFIRMACAO_TTL_MS   = 120_000; // 2 minutos

function limparConfirmacao(jid) {
  delete CONFIRMACAO_PENDENTE[jid];
}

function criarConfirmacaoProduto(jid, nome, transcricaoOriginal) {
  CONFIRMACAO_PENDENTE[jid] = {
    etapa: 'produto',
    nome,
    produto: null,
    transcricaoOriginal,
    expira: Date.now() + CONFIRMACAO_TTL_MS,
  };
  setTimeout(() => {
    if (CONFIRMACAO_PENDENTE[jid]) delete CONFIRMACAO_PENDENTE[jid];
  }, CONFIRMACAO_TTL_MS + 1000);
}

function criarConfirmacaoQuantidade(jid, nome, produto) {
  CONFIRMACAO_PENDENTE[jid] = {
    etapa: 'quantidade',
    nome,
    produto,
    transcricaoOriginal: null,
    expira: Date.now() + CONFIRMACAO_TTL_MS,
  };
  setTimeout(() => {
    if (CONFIRMACAO_PENDENTE[jid]) delete CONFIRMACAO_PENDENTE[jid];
  }, CONFIRMACAO_TTL_MS + 1000);
}

module.exports = {
  ZERAR_PENDENTE, ZERAR_TTL_MS, ORDENS_RELATORIO,
  CONFIRMACAO_PENDENTE, CONFIRMACAO_TTL_MS,
  limparConfirmacao, criarConfirmacaoProduto, criarConfirmacaoQuantidade,
};
