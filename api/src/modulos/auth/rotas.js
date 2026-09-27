import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasAuth = Router();

// Expor o código na resposta é só para desenvolvimento e teste. Em produção
// quem entrega é o módulo do WhatsApp, e a API nunca devolve o código.
const EXPOR_CODIGO = process.env.AUTH_EXPOR_CODIGO === '1';

/* ------------------------------------------------------------ sem contexto */

rotasAuth.post('/login', rota(async (req, res) => {
  res.json(await servico.entrarComoUsuario(req.body ?? {}));
}));

rotasAuth.post('/produtor/codigo', rota(async (req, res) => {
  const r = await servico.pedirCodigo(req.body ?? {});
  // Sempre 202 e sempre a mesma frase: telefone conhecido ou não.
  res.status(202).json({
    enviado: 'se o telefone estiver cadastrado, o código chega em instantes',
    ...(EXPOR_CODIGO ? { codigo: r.codigo } : {}),
  });
}));

rotasAuth.post('/produtor/entrar', rota(async (req, res) => {
  res.json(await servico.entrarComoProdutor(req.body ?? {}));
}));

/* ------------------------------------------------------------ com contexto */

rotasAuth.get('/eu', identificar, rota(async (req, res) => {
  res.json(await servico.quemSouEu(req.ctx));
}));

rotasAuth.post('/convites', identificar, soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.convidarProdutor(req.ctx, req.body ?? {}));
}));

rotasAuth.post('/usuarios/:id/senha', identificar, soEmpresa, rota(async (req, res) => {
  res.json(await servico.definirSenha(req.ctx, req.params.id, req.body ?? {}));
}));
