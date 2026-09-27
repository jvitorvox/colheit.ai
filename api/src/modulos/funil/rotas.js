import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

// O funil inteiro é camada comercial. A sessão do portal não entra aqui, e a
// tabela nem tem política de produtor — a regra rígida do desenho, duas vezes.
export const rotasFunil = Router();
rotasFunil.use(identificar, soEmpresa);

rotasFunil.get('/', rota(async (req, res) => {
  res.json(await servico.listar(req.ctx, req.query));
}));

rotasFunil.get('/resumo', rota(async (req, res) => {
  res.json(await servico.resumo(req.ctx, req.query.safra));
}));

rotasFunil.get('/penetracao', rota(async (req, res) => {
  res.json(await servico.penetracao(req.ctx, req.query));
}));

rotasFunil.get('/:id', rota(async (req, res) => {
  res.json(await servico.buscar(req.ctx, req.params.id));
}));

rotasFunil.post('/', rota(async (req, res) => {
  res.status(201).json(await servico.abrir(req.ctx, req.body ?? {}));
}));

rotasFunil.post('/:id/mover', rota(async (req, res) => {
  res.json(await servico.mover(req.ctx, req.params.id, req.body ?? {}));
}));

rotasFunil.patch('/:id/potencial', rota(async (req, res) => {
  res.json(await servico.definirPotencial(req.ctx, req.params.id, req.body ?? {}));
}));
