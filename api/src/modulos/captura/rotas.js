import { Router } from 'express';
import { rota, SemContexto } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasCaptura = Router();

/**
 * O gateway não é uma pessoa: não tem tenant nem sessão, e atende vários
 * canais. Ele se identifica por segredo compartilhado — é a mesma ideia do
 * `identificar`, com uma porta só para ele.
 *
 * Se o segredo não estiver configurado, a porta fica fechada. Sem isso, um
 * ambiente mal configurado aceitaria mensagem de qualquer um.
 */
function soGateway(req, _res, next) {
  const esperado = process.env.GATEWAY_SEGREDO;
  if (!esperado || esperado.length < 16) return next(new SemContexto());
  if (req.get('x-gateway-segredo') !== esperado) return next(new SemContexto());
  next();
}

rotasCaptura.post('/mensagens', soGateway, rota(async (req, res) => {
  res.status(201).json(await servico.receber(req.body ?? {}));
}));

rotasCaptura.get('/canais', soGateway, rota(async (_req, res) => {
  res.json(await servico.canaisAtivos());
}));

rotasCaptura.post('/canais/:numero/conectado', soGateway, rota(async (req, res) => {
  await servico.marcarConectado(req.params.numero);
  res.json({ ok: true });
}));

rotasCaptura.get('/saidas', soGateway, rota(async (_req, res) => {
  res.json(await servico.saidasPendentes());
}));

rotasCaptura.post('/saidas/:id/enviada', soGateway, rota(async (req, res) => {
  await servico.marcarEnviada(req.params.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ área da empresa */

rotasCaptura.use(identificar);

rotasCaptura.get('/relatos', rota(async (req, res) => {
  res.json(await servico.relatos(req.ctx, { situacao: req.query.situacao }));
}));

rotasCaptura.post('/relatos/:id/validar', soEmpresa, rota(async (req, res) => {
  res.json(await servico.decidir(req.ctx, req.params.id, 'validar', req.body ?? {}));
}));

rotasCaptura.post('/relatos/:id/descartar', soEmpresa, rota(async (req, res) => {
  res.json(await servico.decidir(req.ctx, req.params.id, 'descartar', req.body ?? {}));
}));

rotasCaptura.get('/canal', soEmpresa, rota(async (req, res) => {
  res.json(await servico.meuCanal(req.ctx));
}));

rotasCaptura.post('/canal', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.registrarCanal(req.ctx, req.body ?? {}));
}));
