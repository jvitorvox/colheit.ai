// Erros que a API sabe traduzir. Tudo que não for um destes vira 500 e vai
// para o log — erro desconhecido nunca vaza mensagem de banco para o cliente.

export class ErroDeUso extends Error {
  constructor(mensagem, campo) {
    super(mensagem);
    this.status = 400;
    this.campo = campo;
  }
}

export class NaoEncontrado extends Error {
  constructor(oQue) {
    super(`${oQue} não encontrado`);
    this.status = 404;
  }
}

export class SemContexto extends Error {
  constructor() {
    super('requisição sem tenant identificado');
    this.status = 401;
  }
}

/**
 * Traduz o que o banco recusou. A política de RLS é a última linha de defesa,
 * e quando ela barra algo o cliente não precisa saber que existe RLS — do
 * ponto de vista dele, aquilo simplesmente não existe ou não é dele.
 */
export function traduzirErroDeBanco(erro) {
  if (erro.code === '23505') return new ErroDeUso('já existe um registro com esse valor');
  if (erro.code === '23503') return new ErroDeUso('referência aponta para algo que não existe');
  if (erro.code === '23514') return new ErroDeUso('valor fora do que a regra aceita');
  if (erro.code === '42501') return new NaoEncontrado('registro');
  // Exceções levantadas com raise exception nas funções de app.*
  if (erro.code === 'P0001') return new ErroDeUso(erro.message);
  return erro;
}

export function tratarErro(erro, req, res, _next) {
  const e = traduzirErroDeBanco(erro);
  const status = e.status ?? 500;
  if (status >= 500) {
    console.error(`[500] ${req.method} ${req.originalUrl}`, erro);
    return res.status(500).json({ erro: 'erro interno' });
  }
  res.status(status).json(e.campo ? { erro: e.message, campo: e.campo } : { erro: e.message });
}

/** Express 4 não captura rejeição de promessa; este embrulho captura. */
export const rota = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
