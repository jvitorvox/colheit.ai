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
 * Entrega, e não deixa a falha virar erro de quem pediu.
 *
 * Servidor de e-mail cai, recusa, demora. Nada disso é culpa de quem preencheu
 * o formulário, e nada disso ele consegue resolver — devolver "erro interno"
 * para alguém que pediu a própria senha de volta só troca uma espera por um
 * susto. A falha vai inteira para o log, que é onde quem opera vai procurar.
 *
 * O que NÃO se faz aqui é engolir em silêncio: `console.error` com o endereço e
 * o motivo, uma linha por falha.
 */
async function entregar(msg, registro = console) {
  if (!enviarAtual) return false;
  try {
    await enviarAtual(msg);
    return true;
  } catch (erro) {
    registro.error?.(
      `correio FALHOU ao mandar "${msg.assunto}" para ${msg.para}: ${erro.message}`);
    return false;
  }
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

  return entregar({ para: email, assunto: 'Redefinir sua senha do colheit.ai', texto });
}

/**
 * O e-mail do autoatendimento de cadastro.
 *
 * Três textos para uma resposta só: a tela responde igual sempre, e é aqui que
 * a verdade aparece — para quem controla o endereço, e só para ele. Nenhum dos
 * dois avisos leva link nem nomeia ninguém: saber que a empresa já é cliente já
 * é o suficiente para pedir acesso a quem administra, e um nome a mais seria
 * um nome entregue a quem digitou um CNPJ.
 */
export async function enviarCadastro({ situacao, nome, empresa, email, url, horas }) {
  if (!enviarAtual) return false;
  const primeiro = String(nome ?? '').trim().split(/\s+/)[0] || 'Olá';

  const textos = {
    nova: [
      `${primeiro}, falta um clique para a conta de ${empresa} existir.`,
      '',
      'Confirme por aqui e escolha sua senha:',
      url,
      '',
      `O link vale ${horas} horas e serve uma vez só.`,
      '',
      'Se não foi você que pediu, ignore: enquanto ninguém abrir este link, '
      + 'nada foi criado.',
    ],
    empresa_existe: [
      `${primeiro}, esse CNPJ já tem conta no colheit.ai.`,
      '',
      'Peça acesso a quem administra a conta da sua empresa — é quem cria '
      + 'usuário por lá. Nada foi criado por este pedido.',
    ],
    email_existe: [
      `${primeiro}, esse e-mail já tem conta no colheit.ai.`,
      '',
      'Entre normalmente. Se não lembrar a senha, use "Esqueci minha senha" na '
      + 'tela de entrada. Nada foi criado por este pedido.',
    ],
  };

  return entregar({
    para: email,
    assunto: situacao === 'nova' ? 'Confirme a conta do colheit.ai' : 'Sobre seu cadastro no colheit.ai',
    texto: textos[situacao].join('\n'),
  });
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

  // SMTP_HOST=registro imprime a mensagem no log em vez de mandar.
  //
  // ⚠️ DESENVOLVIMENTO. O link de confirmação e o de senha valem uma senha
  // enquanto vivem, e aqui eles aparecem em texto puro no log do contêiner —
  // que costuma ser coletado, guardado e lido por gente que não é a dona da
  // conta. Existe porque sem ele ninguém consegue nem ver o autoatendimento
  // funcionando antes de ter um servidor de e-mail.
  if (host === 'registro') {
    registro.warn?.(
      'correio em modo REGISTRO: as mensagens vão para o log, em texto puro. '
      + 'Não use em produção — o link de confirmação vale uma senha.');
    usarCorreio(({ para, assunto, texto }) => {
      registro.log?.(`\n--- e-mail para ${para} · ${assunto} ---\n${texto}\n---`);
    });
    return { ligado: true, host: 'registro (log)', de };
  }

  const { transporte, porta } = construirTransporte(nodemailer);

  usarCorreio(({ para, assunto, texto }) =>
    transporte.sendMail({ from: de, to: para, subject: assunto, text: texto }));

  return { ligado: true, host, porta, de };
}

/**
 * O transporte, com os tempos-limite que o padrão não põe.
 *
 * Sem eles a espera padrão é de minutos, e ela acontece DENTRO da requisição:
 * `/auth/esqueci` e `/conta/cadastro` aguardam o envio, então um servidor de
 * e-mail pendurado pendura junto quem está na tela — e, com conexões presas,
 * derruba a API inteira antes de derrubar só o e-mail.
 *
 * Dez segundos é generoso para um servidor são e curto para um doente.
 */
function construirTransporte(nodemailer) {
  const porta = Number(process.env.SMTP_PORTA ?? 587);
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: porta,
    // 465 é TLS desde o primeiro byte; 587 abre em claro e sobe com STARTTLS.
    // `requireTLS` é o que impede a sessão de seguir em claro se o servidor não
    // oferecer STARTTLS — sem ele, senha de SMTP passaria pela rede legível.
    secure: porta === 465,
    requireTLS: porta !== 465,
    auth: process.env.SMTP_USUARIO
      ? { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_SENHA }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return { transporte, porta };
}

/**
 * Prova o SMTP contra o servidor de verdade, e diz em voz alta o que achou.
 *
 * São duas etapas separadas de propósito, porque elas falham por motivos
 * diferentes e a diferença é o diagnóstico inteiro:
 *
 *   verificar  → abre a conexão, sobe o TLS e autentica. Se isto falha, o
 *                problema é host, porta, TLS ou credencial — e nenhuma
 *                mensagem foi mandada para ninguém.
 *   enviar     → o servidor aceitou a mensagem. Se isto falha depois de o
 *                verificar passar, o problema é remetente, destinatário ou
 *                política de envio, não credencial.
 *
 * A senha não aparece na saída, nem quando dá errado.
 */
export async function testar(para, { registro = console } = {}) {
  const host = process.env.SMTP_HOST;
  if (!host) return { ok: false, etapa: 'configuração', erro: 'SMTP_HOST ausente' };
  if (host === 'registro') {
    return {
      ok: false,
      etapa: 'configuração',
      erro: 'SMTP_HOST=registro é o modo de log; não prova nada sobre servidor de verdade',
    };
  }
  const de = process.env.SMTP_DE;
  if (!de) return { ok: false, etapa: 'configuração', erro: 'SMTP_DE ausente' };

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    return { ok: false, etapa: 'configuração', erro: 'nodemailer não está instalado' };
  }

  const { transporte, porta } = construirTransporte(nodemailer);
  const config = {
    host,
    porta,
    tls: porta === 465 ? 'direto (465)' : 'STARTTLS exigido',
    usuario: process.env.SMTP_USUARIO || '(sem autenticação)',
    de,
  };

  try {
    await transporte.verify();
  } catch (erro) {
    return { ok: false, etapa: 'conexão', config, erro: erro.message };
  }

  try {
    const r = await transporte.sendMail({
      from: de,
      to: para,
      subject: 'colheit.ai · teste de correio',
      text: [
        'Se esta mensagem chegou, o SMTP do colheit.ai está de pé.',
        '',
        `Servidor: ${host}:${porta}`,
        `Remetente: ${de}`,
        `Enviada em ${new Date().toISOString()}`,
        '',
        'Nenhuma conta foi criada nem alterada por este teste.',
      ].join('\n'),
    });
    registro.log?.(`aceita pelo servidor: ${r.response ?? ''}`.trim());
    return { ok: true, config, id: r.messageId, aceitos: r.accepted, recusados: r.rejected };
  } catch (erro) {
    return { ok: false, etapa: 'envio', config, erro: erro.message };
  } finally {
    transporte.close();
  }
}

/** O endereço público, para montar o link. Só quem tem APP_URL manda e-mail. */
export const enderecoPublico = () => String(process.env.APP_URL ?? '').replace(/\/+$/, '');
