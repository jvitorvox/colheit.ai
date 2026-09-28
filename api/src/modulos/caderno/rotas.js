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

// O fechamento da safra. Serve às duas sessões, como o resto do caderno: a
// política decide se é a terra de um produtor ou a carteira da revenda.
rotasCaderno.get('/resultado', rota(async (req, res) => {
  res.json(await servico.resultadoDaSafra(req.ctx, req.query.safra, req.query.produtorId));
}));

// Leitura comercial, e por isso só empresa — como o share por marca. Fora do
// /caderno/resultado de propósito: aquele o portal também lê.
rotasCaderno.get('/resultado-por-origem', soEmpresa, rota(async (req, res) => {
  res.json(await servico.resultadoPorOrigem(req.ctx, req.query.safra));
}));

// A safra por franqueado. Só empresa, como as outras leituras de rede — e
// vazia para quem enxerga um franqueado só, que é quase todo mundo.
rotasCaderno.get('/resultado-por-franqueado', soEmpresa, rota(async (req, res) => {
  res.json(await servico.safraPorFranqueado(req.ctx, req.query.safra));
}));

// A safra por município. Sem nome de franqueado — é o município da terra, que
// está na propriedade que o próprio tenant cadastrou.
rotasCaderno.get('/resultado-por-municipio', soEmpresa, rota(async (req, res) => {
  res.json(await servico.safraPorMunicipio(req.ctx, req.query.safra));
}));
