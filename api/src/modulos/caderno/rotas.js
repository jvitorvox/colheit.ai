import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

// Camada técnica: o desenho diz que ela é compartilhada com o agricultor.
// Ler é das duas sessões; escrever é de quem fecha o registro — o consultor.
export const rotasCaderno = Router();
rotasCaderno.use(identificar);

rotasCaderno.get('/plantios', rota(async (req, res) => {
  res.json(await servico.listarPlantios(req.ctx, req.query));
}));

rotasCaderno.get('/desempenho', rota(async (req, res) => {
  res.json(await servico.desempenho(req.ctx, req.query.safra));
}));

rotasCaderno.get('/share', soEmpresa, rota(async (req, res) => {
  res.json(await servico.sharePorMarca(req.ctx, req.query.safra));
}));

rotasCaderno.get('/plantios/:id', rota(async (req, res) => {
  res.json(await servico.buscarPlantio(req.ctx, req.params.id));
}));

rotasCaderno.post('/plantios', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.registrarPlantio(req.ctx, req.body ?? {}));
}));

rotasCaderno.post('/plantios/:id/colheita', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.registrarColheita(req.ctx, req.params.id, req.body ?? {}));
}));
