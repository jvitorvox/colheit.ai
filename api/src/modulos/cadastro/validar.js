import { ErroDeUso } from '../../http/erros.js';

// Validação de documento é o antídoto mais barato para duplicata de produtor.
// O banco só garante que são dígitos; o dígito verificador pega o erro de
// digitação, que é de onde vem a maior parte dos cadastros repetidos.

export const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

export function cpfValido(cpf) {
  const d = soDigitos(cpf);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;           // 00000000000 e afins
  for (let casa = 9; casa < 11; casa++) {
    let soma = 0;
    for (let i = 0; i < casa; i++) soma += Number(d[i]) * (casa + 1 - i);
    let dv = (soma * 10) % 11;
    if (dv === 10) dv = 0;
    if (dv !== Number(d[casa])) return false;
  }
  return true;
}

export function cnpjValido(cnpj) {
  const d = soDigitos(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const conferir = (pesos) => {
    const soma = pesos.reduce((s, p, i) => s + Number(d[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  if (conferir([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) !== Number(d[12])) return false;
  return conferir([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[13]);
}

const TIPOS = ['cpf', 'cnpj', 'ie'];

/**
 * Normaliza a lista de documentos e recusa o que não fecha.
 *
 * A inscrição estadual não tem dígito verificador único no país — cada estado
 * tem a sua regra — então aqui ela só é checada no formato. Vale registrar
 * como limite conhecido em vez de fingir que valida.
 */
export function normalizarDocumentos(lista) {
  if (lista === undefined || lista === null) return [];
  if (!Array.isArray(lista)) throw new ErroDeUso('documentos deve ser uma lista', 'documentos');

  return lista.map((doc, i) => {
    const onde = `documentos[${i}]`;
    if (!doc || typeof doc !== 'object') throw new ErroDeUso('documento inválido', onde);

    const tipo = String(doc.tipo ?? '').toLowerCase();
    if (!TIPOS.includes(tipo)) {
      throw new ErroDeUso(`tipo deve ser um de: ${TIPOS.join(', ')}`, `${onde}.tipo`);
    }

    const valor = soDigitos(doc.valor);
    if (!valor) throw new ErroDeUso('valor é obrigatório', `${onde}.valor`);
    if (tipo === 'cpf' && !cpfValido(valor)) throw new ErroDeUso('CPF inválido', `${onde}.valor`);
    if (tipo === 'cnpj' && !cnpjValido(valor)) throw new ErroDeUso('CNPJ inválido', `${onde}.valor`);
    if (tipo === 'ie' && (valor.length < 8 || valor.length > 14)) {
      throw new ErroDeUso('inscrição estadual fora do tamanho esperado', `${onde}.valor`);
    }

    return { tipo, valor };
  });
}

export function textoObrigatorio(valor, campo, max = 200) {
  const t = String(valor ?? '').trim();
  if (!t) throw new ErroDeUso(`${campo} é obrigatório`, campo);
  if (t.length > max) throw new ErroDeUso(`${campo} passa de ${max} caracteres`, campo);
  return t;
}

export function umDe(valor, opcoes, campo, padrao) {
  if (valor === undefined || valor === null || valor === '') {
    if (padrao !== undefined) return padrao;
    throw new ErroDeUso(`${campo} é obrigatório`, campo);
  }
  const v = String(valor).toLowerCase();
  if (!opcoes.includes(v)) throw new ErroDeUso(`${campo} deve ser um de: ${opcoes.join(', ')}`, campo);
  return v;
}

export function uuidValido(valor, campo) {
  const v = String(valor ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new ErroDeUso(`${campo} não é um identificador válido`, campo);
  }
  return v;
}

export function areaValida(valor, campo) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) throw new ErroDeUso(`${campo} deve ser maior que zero`, campo);
  return n;
}
