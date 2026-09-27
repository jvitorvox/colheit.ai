import webpush from 'web-push';

// A criptografia do Web Push é RFC 8291 — aes128gcm com troca de chave por
// ECDH, mais um JWT assinado em P-256 para o VAPID. Não se escreve isso à mão
// pelo mesmo motivo do JWT: é onde os erros silenciosos moram.

let configurado = false;

export function chavePublica() {
  return process.env.VAPID_PUBLICA ?? null;
}

function configurar() {
  if (configurado) return;
  const publica = process.env.VAPID_PUBLICA;
  const privada = process.env.VAPID_PRIVADA;
  const contato = process.env.VAPID_CONTATO ?? 'mailto:suporte@colheit.ai';
  if (!publica || !privada) throw new Error('VAPID_PUBLICA e VAPID_PRIVADA são obrigatórias');
  webpush.setVapidDetails(contato, publica, privada);
  configurado = true;
}

/**
 * Entrega uma mensagem a um navegador.
 *
 * Devolve o desfecho em vez de lançar, porque o despachante precisa distinguir
 * três coisas: entregou, a assinatura morreu (navegador desinstalado, permissão
 * revogada) e deu problema passageiro. Só a do meio justifica apagar o registro.
 */
export async function enviarWebPush(assinatura, carga) {
  configurar();
  try {
    await webpush.sendNotification(
      {
        endpoint: assinatura.endpoint,
        keys: { p256dh: assinatura.p256dh, auth: assinatura.auth },
      },
      JSON.stringify(carga),
      { TTL: 60 * 60 * 12 },
    );
    return { ok: true };
  } catch (erro) {
    const status = erro.statusCode ?? 0;
    // 404 e 410 são a forma do serviço de push dizer que aquele navegador
    // não existe mais. Insistir é gastar à toa e sujar a base.
    if (status === 404 || status === 410) return { ok: false, morta: true, motivo: `http ${status}` };
    return { ok: false, morta: false, motivo: erro.message ?? `http ${status}` };
  }
}
