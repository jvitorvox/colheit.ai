/**
 * A entrega do bilhete de recuperação por e-mail.
 *
 * NASCE DESLIGADA, e a recuperação não depende dela: sem SMTP configurado as
 * outras duas portas continuam abertas — o gestor abre o acesso de quem está na
 * equipe, e a linha de comando abre o do gestor. O que falta sem correio é
 * apenas o autoatendimento.
 *
 * O envio é injetável pelo mesmo motivo do extrator: o teste põe o dele e
 * nenhuma linha de teste toca uma rede.
 *
 * ⚠️ Esta peça nunca foi exercitada contra um servidor de e-mail de verdade.
 * O fluxo do token está testado ponta a ponta; a entrega, não.
 */

let enviarAtual = null;

/** Liga um entregador. Produção injeta o SMTP; o teste injeta o dele. */
export function usarCorreio(fn) {
  enviarAtual = fn;
}

export function correioLigado() {
  return enviarAtual !== null;
}

/**
 * Manda o bilhete. Devolve false quando não há correio — a ausência é estado
 * previsto, não erro, e quem chama decide o que dizer na tela.
 */
export async function enviarRecuperacao({ nome, email, url, minutos }) {
  if (!enviarAtual) return false;
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';
  const texto = [
    `${primeiro}, alguém pediu para redefinir a senha do colheit.ai desta conta.`,
    '',
    'Para escolher uma senha nova, abra:',
    url,
    '',
    `O link vale ${minutos} minutos e serve uma vez só.`,
    '',
    'Se não foi você, ignore esta mensagem: a senha atual continua valendo, e '
    + 'quem pediu não recebeu nada além desta mesma frase.',
  ].join('\n');

  await enviarAtual({ para: email, assunto: 'Redefinir sua senha do colheit.ai', texto });
  return true;
}

/* --------------------------------------------------------------- a trava */

/**
 * Liga o correio de verdade, se o ambiente estiver configurado.
 *
 * `SMTP_DE` é exigido separado do host porque remetente errado é o jeito mais
 * rápido de a mensagem cair em spam — e uma recuperação que cai em spam é uma
 * recuperação que não existe.
 *
 * `APP_URL` também é obrigatório, e por um motivo de segurança: sem ele a API
 * teria de adivinhar o próprio endereço a partir do cabeçalho `Host`, que quem
 * faz a requisição escolhe. Um pedido com `Host` forjado mandaria para a caixa
 * da vítima um link legítimo apontando para o servidor do atacante.
 *
 * A importação do nodemailer é tardia de propósito: quem roda sem SMTP não
 * precisa nem ter a biblioteca instalada para a API subir.
 */
export async function ligarSeConfigurado({ registro = console } = {}) {
  const host = process.env.SMTP_HOST;
  const de = process.env.SMTP_DE;
  const base = process.env.APP_URL;

  if (!host) return { ligado: false, motivo: 'SMTP_HOST ausente' };
  if (!de || !base) {
    registro.warn?.(
      'correio DESLIGADO: há SMTP_HOST, mas falta SMTP_DE ou APP_URL. '
      + 'A recuperação por e-mail fica fora; o gestor e o `npm run admin` continuam abrindo acesso.');
    return { ligado: false, motivo: 'SMTP_DE ou APP_URL ausente' };
  }

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    registro.warn?.('correio DESLIGADO: nodemailer não está instalado.');
    return { ligado: false, motivo: 'nodemailer ausente' };
  }

  const porta = Number(process.env.SMTP_PORTA ?? 587);
  const transporte = nodemailer.createTransport({
    host,
    port: porta,
    // 465 é TLS desde o primeiro byte; 587 abre em claro e sobe com STARTTLS.
    secure: porta === 465,
    requireTLS: porta !== 465,
    auth: process.env.SMTP_USUARIO
      ? { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_SENHA }
      : undefined,
  });

  usarCorreio(({ para, assunto, texto }) =>
    transporte.sendMail({ from: de, to: para, subject: assunto, text: texto }));

  return { ligado: true, host, de };
}

/** O endereço público, para montar o link. Só quem tem APP_URL manda e-mail. */
export const enderecoPublico = () => String(process.env.APP_URL ?? '').replace(/\/+$/, '');
