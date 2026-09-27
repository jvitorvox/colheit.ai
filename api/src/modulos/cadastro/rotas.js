// A porta HTTP do módulo. Só traduz requisição em chamada de service e
// resposta em JSON — nenhuma regra mora aqui.
import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { soEmpresa, soProdutor } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasCadastro = Router();

/* ----------------------------------------------------------------- portal */

// A lavoura é do produtor, e o portal precisa lê-la. Vem antes do `soEmpresa`
// abaixo, que fecha todo o resto do módulo para a área da empresa.
rotasCadastro.get('/minha-lavoura', soProdutor, rota(async (req, res) => {
  res.json(await servico.minhaLavoura(req.ctx));
}));

rotasCadastro.use(soEmpresa);

/* ---------------------------------------------------------------- produtor */

rotasCadastro.post('/produtores', rota(async (req, res) => {
  res.status(201).json(await servico.criarProdutor(req.ctx, req.body ?? {}));
}));

rotasCadastro.get('/produtores', rota(async (req, res) => {
  res.json(await servico.listarProdutores(req.ctx));
}));

rotasCadastro.get('/produtores/:id', rota(async (req, res) => {
  res.json(await servico.buscarProdutor(req.ctx, req.params.id));
}));

rotasCadastro.post('/produtores/:id/documentos', rota(async (req, res) => {
  res.status(201).json(await servico.adicionarDocumento(req.ctx, req.params.id, req.body ?? {}));
}));

rotasCadastro.post('/produtores/fundir', rota(async (req, res) => {
  res.json(await servico.fundirProdutores(req.ctx, req.body ?? {}));
}));

/* ------------------------------------------------------------ propriedade */

rotasCadastro.post('/propriedades', rota(async (req, res) => {
  res.status(201).json(await servico.criarPropriedade(req.ctx, req.body ?? {}));
}));

rotasCadastro.get('/propriedades', rota(async (req, res) => {
  res.json(await servico.listarPropriedades(req.ctx));
}));

rotasCadastro.post('/propriedades/:id/operadores', rota(async (req, res) => {
  res.status(201).json(await servico.ligarOperador(req.ctx, req.params.id, req.body ?? {}));
}));

rotasCadastro.patch('/operadores/:id/encerrar', rota(async (req, res) => {
  res.json(await servico.encerrarOperacao(req.ctx, req.params.id, req.body ?? {}));
}));

/* ----------------------------------------------------------------- talhão */

rotasCadastro.post('/propriedades/:id/talhoes', rota(async (req, res) => {
  res.status(201).json(await servico.criarTalhao(req.ctx, req.params.id, req.body ?? {}));
}));

rotasCadastro.get('/propriedades/:id/talhoes', rota(async (req, res) => {
  res.json(await servico.listarTalhoes(req.ctx, req.params.id));
}));

/* --------------------------------------------------------------- carteira */

rotasCadastro.post('/carteira', rota(async (req, res) => {
  res.status(201).json(await servico.autorizarConsultor(req.ctx, req.body ?? {}));
}));
