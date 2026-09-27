import { Router } from 'express';
import { rota } from '../../http/erros.js';
import { identificar } from '../../http/identificar.js';
import * as servico from './service.js';

export const rotasMidia = Router();
rotasMidia.use(identificar);

rotasMidia.get('/', rota(async (req, res) => {
  res.json(await servico.listar(req.ctx));
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
