import { comContexto } from '../../contexto.js';
import { ErroDeUso } from '../../http/erros.js';
import * as repo from './repository.js';
import { chavePublica } from './enviador.js';

export function chave() {
  const k = chavePublica();
  if (!k) throw new ErroDeUso('push não configurado neste ambiente');
  return { chavePublica: k };
}

/**
 * Registra o navegador. O corpo vem do PushSubscription do próprio navegador,
 * então a validação aqui é de forma — quem garante que as chaves servem é o
 * serviço de push, no primeiro envio.
 */
export function assinar(ctx, corpo = {}) {
  const endpoint = String(corpo.endpoint ?? '').trim();
  const p256dh = String(corpo.keys?.p256dh ?? corpo.p256dh ?? '').trim();
  const auth = String(corpo.keys?.auth ?? corpo.auth ?? '').trim();

  if (!/^https:\/\//.test(endpoint)) throw new ErroDeUso('endpoint inválido', 'endpoint');
  if (!p256dh || !auth) throw new ErroDeUso('chaves da assinatura ausentes', 'keys');

  const agente = corpo.agente ? String(corpo.agente).slice(0, 300) : null;

  return comContexto(ctx, async (cx) => {
    const id = await repo.assinar(cx, { endpoint, p256dh, auth, agente });
    return { id, assinado: true };
  });
}

export function desassinar(ctx, corpo = {}) {
  const endpoint = String(corpo.endpoint ?? '').trim();
  if (!endpoint) throw new ErroDeUso('endpoint é obrigatório', 'endpoint');
  return comContexto(ctx, async (cx) => {
    const n = await repo.desassinar(cx, endpoint);
    return { removidas: n };
  });
}

export function minhasAssinaturas(ctx) {
  return comContexto(ctx, (cx) => repo.minhasAssinaturas(cx));
}
