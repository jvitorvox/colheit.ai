import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasPush = Router();

// A chave pública é pública por definição: o navegador precisa dela antes de
// existir sessão, para montar a assinatura.
rotasPush.get('/chave-publica', rota(async (_req, res) => {
  res.json(servico.chave());
}));

// As duas sessões assinam — o produtor recebe o andamento do pedido, e o
// usuário da empresa vai receber a fila dele quando esse módulo existir.
rotasPush.use(identificar);

rotasPush.post('/assinaturas', rota(async (req, res) => {
  res.status(201).json(await servico.assinar(req.ctx, req.body ?? {}));
}));

rotasPush.delete('/assinaturas', rota(async (req, res) => {
  res.json(await servico.desassinar(req.ctx, req.body ?? {}));
}));

rotasPush.get('/assinaturas', rota(async (req, res) => {
  res.json(await servico.minhasAssinaturas(req.ctx));
}));
