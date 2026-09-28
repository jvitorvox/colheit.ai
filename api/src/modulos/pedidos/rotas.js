import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasPedidos = Router();
rotasPedidos.use(identificar);

// Leitura serve às duas sessões: a empresa vê a carteira dela, o produtor vê
// os pedidos dele em todas as revendas. Quem separa é a política, não a rota.
rotasPedidos.get('/etapas', rota(async (req, res) => {
  res.json(await servico.listarEtapas(req.ctx));
}));

rotasPedidos.get('/', rota(async (req, res) => {
  res.json(await servico.listar(req.ctx, {
    produtorId: req.query.produtorId, situacao: req.query.situacao,
  }));
}));

rotasPedidos.get('/avisos', rota(async (req, res) => {
  res.json(await servico.avisos(req.ctx, { pendentes: req.query.pendentes === '1' }));
}));

// Antes de `/:id`, senão "gargalo" seria lido como um identificador.
rotasPedidos.get('/gargalo', soEmpresa, rota(async (req, res) => {
  res.json(await servico.gargalo(req.ctx));
}));

rotasPedidos.get('/:id', rota(async (req, res) => {
  res.json(await servico.buscar(req.ctx, req.params.id));
}));

// Escrita é só da área da empresa. O portal do produtor é de leitura.
rotasPedidos.post('/', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.criar(req.ctx, req.body ?? {}));
}));

rotasPedidos.post('/:id/avancar', soEmpresa, rota(async (req, res) => {
  res.json(await servico.avancar(req.ctx, req.params.id, req.body ?? {}));
}));

rotasPedidos.post('/:id/retroceder', soEmpresa, rota(async (req, res) => {
  res.json(await servico.retroceder(req.ctx, req.params.id, req.body ?? {}));
}));

rotasPedidos.post('/:id/cancelar', soEmpresa, rota(async (req, res) => {
  res.json(await servico.cancelar(req.ctx, req.params.id, req.body ?? {}));
}));

rotasPedidos.patch('/:id/credito', soEmpresa, rota(async (req, res) => {
  res.json(await servico.definirCredito(req.ctx, req.params.id, req.body ?? {}));
}));

rotasPedidos.post('/:id/nota', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.lancarNota(req.ctx, req.params.id, req.body ?? {}));
}));

rotasPedidos.post('/:id/nota/pago', soEmpresa, rota(async (req, res) => {
  res.json(await servico.marcarPago(req.ctx, req.params.id, req.body ?? {}));
}));
