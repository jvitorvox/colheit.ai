import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasVisitas = Router();
rotasVisitas.use(identificar);

// O produtor pode ver quem esteve na lavoura dele e quando — é dele a terra.
// A fila e a medição são da empresa.
rotasVisitas.get('/', rota(async (req, res) => {
  res.json(await servico.listar(req.ctx, {
    produtorId: req.query.produtorId, desde: req.query.desde,
  }));
}));

rotasVisitas.get('/fila', soEmpresa, rota(async (req, res) => {
  res.json(await servico.fila(req.ctx));
}));

rotasVisitas.get('/h1', soEmpresa, rota(async (req, res) => {
  res.json(await servico.medicaoH1(req.ctx, req.query.dias));
}));

rotasVisitas.get('/:id', rota(async (req, res) => {
  res.json(await servico.buscar(req.ctx, req.params.id));
}));

rotasVisitas.post('/', soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.registrar(req.ctx, req.body ?? {}));
}));
