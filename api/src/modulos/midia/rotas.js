import express, { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar, soEmpresa } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasMidia = Router();
rotasMidia.use(identificar);

rotasMidia.get('/', rota(async (req, res) => {
  res.json(await servico.listar(req.ctx));
}));

/**
 * Sobe uma foto do campo. Corpo cru, como a porta do gateway: é um arquivo só,
 * o tipo vem no cabeçalho, e não há campo a acompanhar.
 *
 * Só empresa. A foto do talhão é registro de quem foi ao campo; o portal do
 * produtor é de leitura, e abrir escrita de arquivo nele seria outra porta com
 * outro conjunto de riscos sem nada que peça por ela.
 */
rotasMidia.post('/', soEmpresa,
  express.raw({ type: '*/*', limit: '12mb' }),
  rota(async (req, res) => {
    res.status(201).json(await servico.guardarDaSessao(req.ctx, {
      mime: req.get('content-type'),
      bytes: req.body,
    }));
  }));

/**
 * Entrega o arquivo. Nunca há URL pública: a política decide antes de o byte
 * sair, e a resposta é privada de propósito — cache compartilhado guardando
 * áudio de produtor seria o mesmo vazamento por outro caminho.
 */
rotasMidia.get('/:id', rota(async (req, res) => {
  const m = await servico.baixar(req.ctx, req.params.id);
  res.set({
    'content-type': m.mime,
    'content-length': String(m.bytes.length),
    'cache-control': 'private, max-age=300',
    'content-disposition': `inline; filename="${m.id}"`,
  });
  res.end(m.bytes);
}));
