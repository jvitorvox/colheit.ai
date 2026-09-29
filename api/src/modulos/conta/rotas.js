import { Router } from 'express';
import { rota } from '../../http/erros.js';
import * as servico from './service.js';

export const rotasConta = Router();

// Mesma chave do código do produtor e do bilhete de senha: em produção nada
// disso volta pela resposta, e quem entrega é o correio.
const EXPOR_CODIGO = process.env.AUTH_EXPOR_CODIGO === '1';

/**
 * Pedir cadastro. Rota pública — é a única da API que qualquer um alcança sem
 * ter conta, e por isso ela não cria nada: só põe um pedido à espera do e-mail.
 *
 * 202 e a mesma frase nos três desfechos. Quem diz o que aconteceu é a
 * mensagem, que só chega a quem controla o endereço digitado.
 */
rotasConta.post('/cadastro', rota(async (req, res) => {
  const r = await servico.pedirCadastro(req.body ?? {});
  if (r.semCorreio) {
    return res.status(202).json({
      enviado: 'esta instalação não abre conta pela tela; fale com quem cuida do colheit.ai',
      autoatendimento: false,
    });
  }
  res.status(202).json({
    enviado: 'se estiver tudo certo, o e-mail de confirmação chega em instantes',
    autoatendimento: true,
    ...(EXPOR_CODIGO && r.token ? { token: r.token } : {}),
  });
}));

rotasConta.post('/confirmar', rota(async (req, res) => {
  res.status(201).json(await servico.confirmarCadastro(req.body ?? {}));
}));
