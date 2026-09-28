import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasPainel = Router();
rotasPainel.use(identificar);

/**
 * O painel de abertura da área da empresa.
 *
 * `soEmpresa` e nada mais: quem enxerga a empresa inteira e quem enxerga só a
 * própria carteira recebem a mesma resposta, com números diferentes, porque a
 * política decide. Um `if` de papel aqui seria uma segunda regra de
 * visibilidade para manter em dia com a primeira.
 */
rotasPainel.get('/', soEmpresa, rota(async (req, res) => {
  res.json(await servico.montar(req.ctx, { safra: req.query.safra }));
}));
