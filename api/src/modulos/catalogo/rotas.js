import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

// O catálogo é da empresa que vende. O produtor não precisa dele: o item do
// pedido guarda o nome do cultivar por escrito.
export const rotasCatalogo = Router();
rotasCatalogo.use(identificar, soEmpresa);

rotasCatalogo.get('/produtos', rota(async (req, res) => {
  res.json(await servico.listarProdutos(req.ctx, req.query));
}));

rotasCatalogo.post('/produtos', rota(async (req, res) => {
  res.status(201).json(await servico.criarProduto(req.ctx, req.body ?? {}));
}));

rotasCatalogo.patch('/produtos/:id/arquivar', rota(async (req, res) => {
  res.json(await servico.arquivarProduto(req.ctx, req.params.id, false));
}));

rotasCatalogo.patch('/produtos/:id/reativar', rota(async (req, res) => {
  res.json(await servico.arquivarProduto(req.ctx, req.params.id, true));
}));

rotasCatalogo.get('/produtos/:id/precos', rota(async (req, res) => {
  res.json(await servico.historicoDePreco(req.ctx, req.params.id));
}));

rotasCatalogo.post('/produtos/:id/precos', rota(async (req, res) => {
  res.status(201).json(await servico.definirPreco(req.ctx, req.params.id, req.body ?? {}));
}));

rotasCatalogo.get('/resumo', rota(async (req, res) => {
  res.json(await servico.resumoDeVenda(req.ctx, req.query.safra));
}));
