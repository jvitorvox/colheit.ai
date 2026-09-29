import { lerToken } from '../modulos/auth/token.js';
import { SemContexto, ErroDeUso } from './erros.js';

/**
 * Descobre quem está falando e deixa em req.ctx.
 *
 * É a única porta por onde o contexto entra. Sessão de empresa traz
 * { tenant, usuario, papel }; sessão do portal traz { produtor }. Nunca as duas.
 */
export function identificar(req, _res, next) {
  const cabecalho = req.get('authorization') ?? '';
  const [esquema, bruto] = cabecalho.split(' ');
  if (!bruto || esquema.toLowerCase() !== 'bearer') return next(new SemContexto());

  const ctx = lerToken(bruto);
  if (!ctx) return next(new SemContexto());

  req.ctx = ctx;
  next();
}

/** Fecha a rota para a sessão do portal — o que é de empresa é de empresa. */
export function soEmpresa(req, _res, next) {
  if (!req.ctx?.tenant) return next(new ErroDeUso('esta rota é da área da empresa'));
  next();
}

/** Fecha a rota para quem não é o produtor. */
export function soProdutor(req, _res, next) {
  if (!req.ctx?.produtor) return next(new ErroDeUso('esta rota é do portal do produtor'));
  next();
}

/**
 * Fecha a rota para quem não é da plataforma.
 *
 * É o espelho de `soEmpresa`, e vale nos dois sentidos: nenhuma sessão de
 * empresa ou de portal entra aqui, e a de plataforma não entra em lugar nenhum
 * que peça tenant.
 */
export function soPlataforma(req, _res, next) {
  if (!req.ctx?.plataforma) return next(new ErroDeUso('esta rota é da plataforma'));
  next();
}
