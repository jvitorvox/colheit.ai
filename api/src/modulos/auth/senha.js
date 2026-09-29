import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derivar = promisify(scrypt);

// scrypt vem na biblioteca padrão do Node — sem dependência nativa, sem
// compilação, e com custo de memória, que é o que segura ataque por GPU.
const N = 16384, r = 8, p = 1, TAM = 64;

export async function gerarHash(senha) {
  if (typeof senha !== 'string' || senha.length < 8) {
    throw new Error('senha precisa de ao menos 8 caracteres');
  }
  const sal = randomBytes(16);
  const chave = await derivar(senha, sal, TAM, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${chave.toString('base64')}`;
}

/**
 * Confere a senha em tempo constante.
 *
 * Hash nulo — usuário que nunca definiu senha — devolve falso, mas só depois
 * de gastar o mesmo trabalho de uma conferência real. Sem isso, o tempo de
 * resposta entregaria quais e-mails existem.
 */
export async function conferir(senha, hashGuardado) {
  const falso = '$' + 'x'.repeat(86);
  const alvo = hashGuardado ?? `scrypt$${N}$${r}$${p}$${Buffer.alloc(16).toString('base64')}${falso}`;

  const partes = String(alvo).split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, n, rr, pp, salB64, chaveB64] = partes;
  let esperado;
  try {
    esperado = Buffer.from(chaveB64, 'base64');
  } catch {
    return false;
  }
  const chave = await derivar(String(senha ?? ''), Buffer.from(salB64, 'base64'),
    esperado.length || TAM, { N: Number(n), r: Number(rr), p: Number(pp) });

  if (chave.length !== esperado.length) return false;
  const igual = timingSafeEqual(chave, esperado);
  return hashGuardado ? igual : false;
}

/** Código de acesso: seis dígitos, sorteados sem viés de módulo. */
export function gerarCodigo() {
  let n;
  do { n = randomBytes(4).readUInt32BE(0); } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, '0');
}

/**
 * O código é curto e de vida curta, então scrypt aqui só atrasaria o login sem
 * ganho real — o freio de tentativas é o que protege. SHA-256 com pimenta
 * garante que um vazamento da tabela não entregue códigos em claro.
 */
export function hashCodigo(codigo, telefone) {
  return createHash('sha256')
    .update(`${process.env.JWT_SEGREDO ?? ''}|${telefone}|${codigo}`)
    .digest('base64');
}

/**
 * O bilhete de recuperação: 256 bits sorteados.
 *
 * Longo assim porque, enquanto vive, ele vale uma senha — e ninguém o digita,
 * então não há atrito a economizar. Com esta entropia adivinhar está fora de
 * questão, e é por isso que o resgate não precisa de contador de tentativas
 * como o código de seis dígitos precisa.
 */
export const gerarToken = () => randomBytes(32).toString('base64url');

/** Mesma decisão de hashCodigo: curto de vida, e scrypt só atrasaria. */
export function hashToken(token) {
  return createHash('sha256')
    .update(`${process.env.JWT_SEGREDO ?? ''}|recuperacao|${token}`)
    .digest('base64');
}
