import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soPlataforma } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasPlataforma = Router();

// `soPlataforma` no roteador inteiro, e não rota a rota: uma rota nova aqui
// nasce fechada, em vez de nascer aberta e depender de alguém lembrar.
rotasPlataforma.use(identificar, soPlataforma);

rotasPlataforma.get('/eu', rota(async (req, res) => {
  res.json(await servico.quemSouEu(req.ctx));
}));

rotasPlataforma.get('/moderacao', rota(async (req, res) => {
  res.json(await servico.fila(req.ctx));
}));

rotasPlataforma.post('/moderacao/:id', rota(async (req, res) => {
  res.json(await servico.moderar(req.ctx, req.params.id, req.body ?? {}));
}));
