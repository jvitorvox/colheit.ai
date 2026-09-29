import jwt from 'jsonwebtoken';

// Duas durações, por motivos diferentes:
//
//   usuario  → 12 h. Ele opera dados de outras pessoas; sessão curta é barata
//              para ele, que trabalha sentado e com senha à mão.
//   produtor → 30 dias. Ele é a ponta de que a adoção depende, e pedir login
//              de novo a cada semana é o tipo de atrito que esvazia o portal.
//   plataforma → 4 h. Ela desliga o sistema de uma empresa inteira com um
//              clique; é a sessão que menos pode ficar esquecida aberta.
const HORAS_USUARIO = '12h';
const DIAS_PRODUTOR = '30d';
const HORAS_PLATAFORMA = '4h';

function segredo() {
  const s = process.env.JWT_SEGREDO;
  if (!s || s.length < 32) {
    throw new Error('JWT_SEGREDO ausente ou curto demais (mínimo 32 caracteres)');
  }
  return s;
}

const COMUM = { algorithm: 'HS256', issuer: 'colheitai' };

export function tokenDeUsuario({ id, tenantId, papel }) {
  return jwt.sign({ tipo: 'usuario', tenant: tenantId, papel }, segredo(),
    { ...COMUM, subject: id, expiresIn: HORAS_USUARIO });
}

export function tokenDeProdutor({ id }) {
  return jwt.sign({ tipo: 'produtor' }, segredo(),
    { ...COMUM, subject: id, expiresIn: DIAS_PRODUTOR });
}

export function tokenDePlataforma({ id }) {
  return jwt.sign({ tipo: 'plataforma' }, segredo(),
    { ...COMUM, subject: id, expiresIn: HORAS_PLATAFORMA });
}

/**
 * Verifica e devolve o contexto da requisição.
 *
 * O algoritmo é fixado em HS256 de propósito: aceitar o que vem no cabeçalho
 * do próprio token é como se abre a porta para `alg: none` e para confusão de
 * algoritmo. Nula é a resposta para qualquer token que não sirva — a rota não
 * precisa saber se expirou, se a assinatura não bate ou se o formato é outro.
 */
export function lerToken(bruto) {
  try {
    const p = jwt.verify(bruto, segredo(), { algorithms: ['HS256'], issuer: 'colheitai' });
    if (p.tipo === 'usuario' && p.tenant) {
      return { tenant: p.tenant, usuario: p.sub, papel: p.papel };
    }
    if (p.tipo === 'produtor') {
      return { produtor: p.sub };
    }
    // Sem tenant, e é o ponto: `soEmpresa` recusa esta sessão, e nas rotas que
    // não passam por ele o contexto vai vazio para o banco — onde nenhuma
    // política casa. O moderador não deixa de ver dado de negócio porque
    // alguém lembrou de conferir; ele não vê porque não há por onde.
    if (p.tipo === 'plataforma') {
      return { plataforma: p.sub };
    }
    return null;
  } catch {
    return null;
  }
}
