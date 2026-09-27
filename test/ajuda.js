// Apoio comum aos testes de API: sobe o servidor, fala HTTP e cria gente já
// com senha. Depois do módulo auth, nenhum teste fabrica contexto na mão —
// todos entram pela porta, como um cliente de verdade entraria.
import { dono } from '../api/src/db.js';
import { criarApp } from '../api/src/server.js';
import { gerarHash } from '../api/src/modulos/auth/senha.js';

export const SENHA = 'senha-de-teste-123';

export async function subirApi() {
  const servidor = criarApp().listen(0);
  await new Promise((ok) => servidor.once('listening', ok));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const req = (caminho, { metodo = 'GET', corpo, token } = {}) =>
    fetch(base + caminho, {
      method: metodo,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => null) }));

  const fechar = () => new Promise((ok) => servidor.close(ok));
  return { base, req, fechar };
}

export async function criarTenant(nome, documento, tipo = 'revenda') {
  const { rows } = await dono.query(
    'insert into tenant (nome, documento, tipo) values ($1,$2,$3) returning id',
    [nome, documento, tipo]);
  return rows[0].id;
}

/** Cria usuário já com senha — senha entra pelo dono, que é quem faz carga. */
export async function criarUsuario(tenantId, nome, email, papel) {
  const hash = await gerarHash(SENHA);
  const { rows } = await dono.query(
    `insert into usuario (tenant_id, nome, email, papel, senha_hash)
     values ($1,$2,$3,$4,$5) returning id`, [tenantId, nome, email, papel, hash]);
  return rows[0].id;
}

export async function entrar(req, email, senha = SENHA) {
  const r = await req('/auth/login', { metodo: 'POST', corpo: { email, senha } });
  if (r.status !== 200) throw new Error(`login falhou (${r.status}): ${JSON.stringify(r.corpo)}`);
  return r.corpo.token;
}

/**
 * Estado limpo para um arquivo de teste de API.
 *
 * tentativa_login e codigo_acesso não pendem de tenant, então não caem no
 * cascade — e sem limpá-los o freio de força bruta de um arquivo trava o
 * login do arquivo seguinte, que roda no mesmo banco.
 */
export async function limparBase() {
  await dono.query('truncate tenant, produtor, propriedade cascade');
  await dono.query('truncate tentativa_login, codigo_acesso');
}
