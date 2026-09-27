import { SemContexto } from './erros.js';

/**
 * Descobre quem está falando e deixa em req.ctx = { tenant, usuario }.
 *
 * ⚠️ PROVISÓRIO: hoje lê de cabeçalhos, sem autenticação nenhuma. Isto existe
 * para o módulo cadastro poder ser construído e testado antes do módulo de
 * autenticação — e é a ÚNICA porta por onde o contexto entra, de propósito:
 * quando o login existir, só este arquivo muda.
 *
 * Nunca subir para produção assim. O CI não valida isso; a revisão precisa.
 */
export function identificar(req, _res, next) {
  const tenant = req.get('x-tenant-id') || null;
  const usuario = req.get('x-usuario-id') || null;
  if (!tenant) return next(new SemContexto());
  req.ctx = { tenant, usuario };
  next();
}
