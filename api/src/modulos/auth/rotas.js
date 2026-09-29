import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasAuth = Router();

// Expor o código na resposta é só para desenvolvimento e teste. Em produção
// quem entrega é o módulo do WhatsApp — ou o correio, no caso da recuperação —
// e a API nunca devolve nem o código nem o bilhete de senha.
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

/**
 * Esqueci minha senha.
 *
 * 202 e a mesma frase para e-mail que existe, e-mail que não existe e pedido
 * repetido: o formulário público de recuperação é o jeito mais fácil de
 * transformar um sistema numa lista de quem tem conta nele.
 *
 * Sem correio configurado a frase muda, e tem de mudar: dizer "o e-mail chega
 * em instantes" numa instalação que não manda e-mail é mandar a pessoa esperar
 * por algo que não vem. O que ela precisa ouvir é por onde ir.
 */
rotasAuth.post('/esqueci', rota(async (req, res) => {
  const r = await servico.pedirRecuperacao(req.body ?? {});
  if (r.semCorreio) {
    return res.status(202).json({
      enviado: 'esta instalação não manda e-mail; peça ao gestor da sua empresa '
        + 'para abrir um acesso novo para você',
      autoatendimento: false,
    });
  }
  res.status(202).json({
    enviado: 'se o e-mail estiver cadastrado, o link chega em instantes',
    autoatendimento: true,
    ...(EXPOR_CODIGO && r.token ? { token: r.token } : {}),
  });
}));

rotasAuth.post('/redefinir', rota(async (req, res) => {
  res.json(await servico.redefinirSenha(req.body ?? {}));
}));

/* ------------------------------------------------------------ com contexto */

rotasAuth.get('/eu', identificar, rota(async (req, res) => {
  res.json(await servico.quemSouEu(req.ctx));
}));

rotasAuth.post('/convites', identificar, soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.convidarProdutor(req.ctx, req.body ?? {}));
}));

// O gestor abre acesso; ele não define senha. O token volta uma vez só, e a
// tela dele mostra o link para o gestor entregar — depois disso não há de onde
// lê-lo de novo, porque o banco guarda o hash.
rotasAuth.post('/usuarios/:id/acesso', identificar, soEmpresa, rota(async (req, res) => {
  res.status(201).json(await servico.abrirAcesso(req.ctx, req.params.id));
}));
