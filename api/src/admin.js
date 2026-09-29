// Os atos que não pertencem a tenant nenhum.
//
// Criar uma empresa, desenhar um território, montar uma rede: nenhum deles
// acontece DENTRO de um cliente, e por isso nenhum deles é tela do console. É o
// mesmo caso da migração e do despachante de push — roda com o papel dono, fora
// de qualquer sessão, e não há rota que alcance.
//
// A alternativa seria inventar um superadmin: um papel acima dos tenants, com
// autenticação própria e uma quarta casca para manter. Isso é decisão de
// produto, não consequência técnica — e enquanto ela não for tomada, uma linha
// de comando resolve e não abre superfície nenhuma.
//
//   docker compose exec -w /app/api api npm run admin -- empresa "3 Tentos" \
//     11111111000111 revenda "Ana Paula" ana@3t.com
//   docker compose exec -w /app/api api npm run admin -- territorio Sorriso MT <franqueado>
//   docker compose exec -w /app/api api npm run admin -- rede <franqueado> <franqueadora>
//   docker compose exec -w /app/api api npm run admin -- empresas
import { randomBytes } from 'node:crypto';
import { dono } from './db.js';
import { gerarHash } from './modulos/auth/senha.js';

const TIPOS = ['franqueadora', 'franqueado', 'industria', 'distribuidor', 'revenda'];

/**
 * Cria a empresa e o primeiro gestor dela, numa transação só.
 *
 * Empresa sem gestor é empresa que ninguém consegue abrir, e gestor sem empresa
 * não existe: ou os dois nascem, ou nenhum nasce.
 *
 * A senha é sorteada e impressa UMA vez. Não fica em lugar nenhum a não ser no
 * hash — quem recebe troca no primeiro acesso, e se perder, o gestor define de
 * novo pela tela. Pedir a senha por argumento deixaria ela no histórico do
 * shell.
 */
async function empresa([nome, documento, tipo, gestor, email]) {
  if (!nome || !documento || !tipo || !gestor || !email) {
    throw new Error('uso: empresa <nome> <documento> <tipo> <gestor> <e-mail>');
  }
  if (!TIPOS.includes(tipo)) throw new Error(`tipo deve ser um de: ${TIPOS.join(', ')}`);

  const senha = randomBytes(9).toString('base64url');
  const cx = await dono.connect();
  try {
    await cx.query('begin');
    const { rows: [t] } = await cx.query(
      'insert into tenant (nome, documento, tipo) values ($1,$2,$3) returning id',
      [nome, String(documento).replace(/\D/g, ''), tipo]);
    const { rows: [u] } = await cx.query(`
      insert into usuario (tenant_id, nome, email, papel, senha_hash)
      values ($1,$2,$3,'gestor',$4) returning id`,
    [t.id, gestor, String(email).trim().toLowerCase(), await gerarHash(senha)]);
    await cx.query('commit');

    console.log(`empresa  ${t.id}  ${nome} (${tipo})`);
    console.log(`gestor   ${u.id}  ${email}`);
    console.log(`senha    ${senha}`);
    console.log('\nAnote agora: ela não é guardada em lugar nenhum além do hash.');
  } catch (erro) {
    await cx.query('rollback');
    throw erro;
  } finally {
    cx.release();
  }
}

/** Um município, um franqueado. A exclusividade é a chave primária. */
async function territorio([municipio, uf, franqueadoId]) {
  if (!municipio || !uf || !franqueadoId) {
    throw new Error('uso: territorio <municipio> <uf> <id do franqueado>');
  }
  await exigirTipo(franqueadoId, 'franqueado');
  await dono.query(`
    insert into territorio (municipio, uf, franqueado_id) values ($1,$2,$3)
    on conflict (municipio, uf) do update set franqueado_id = excluded.franqueado_id,
                                              desde = current_date`,
  [municipio, String(uf).toUpperCase(), franqueadoId]);
  console.log(`${municipio}/${String(uf).toUpperCase()} → ${franqueadoId}`);
  // Redesenhar território NÃO reescreve o passado: `pedido.franqueado_id` é
  // carimbo da criação. O que muda vale da próxima venda em diante.
  console.log('Os pedidos já carimbados continuam com o franqueado de antes.');
}

/** Um franqueado, uma franqueadora. Também exclusivo por construção. */
async function rede([franqueadoId, franqueadoraId]) {
  if (!franqueadoId || !franqueadoraId) {
    throw new Error('uso: rede <id do franqueado> <id da franqueadora>');
  }
  await exigirTipo(franqueadoId, 'franqueado');
  await exigirTipo(franqueadoraId, 'franqueadora');
  await dono.query(`
    insert into rede (franqueado_id, franqueadora_id) values ($1,$2)
    on conflict (franqueado_id) do update set franqueadora_id = excluded.franqueadora_id,
                                              desde = current_date`,
  [franqueadoId, franqueadoraId]);
  console.log(`${franqueadoId} → ${franqueadoraId}`);
}

/** O que existe hoje, para achar os identificadores sem abrir o psql. */
async function empresas() {
  const { rows } = await dono.query(`
    select t.id, t.nome, t.tipo, t.documento,
           (select count(*)::int from usuario u where u.tenant_id = t.id and u.ativo) as usuarios,
           (select count(*)::int from territorio te where te.franqueado_id = t.id) as municipios
      from tenant t order by t.tipo, t.nome`);
  if (rows.length === 0) return console.log('(nenhuma empresa ainda)');
  for (const r of rows) {
    console.log(`${r.id}  ${r.tipo.padEnd(13)} ${r.nome}`
      + `  ·  ${r.usuarios} usuário(s)`
      + (r.municipios ? `  ·  ${r.municipios} município(s)` : ''));
  }
}

async function exigirTipo(id, tipo) {
  const { rows } = await dono.query('select tipo from tenant where id = $1', [id]);
  if (rows.length === 0) throw new Error(`empresa ${id} não existe`);
  if (rows[0].tipo !== tipo) {
    throw new Error(`${id} é ${rows[0].tipo}, e aqui precisa ser ${tipo}`);
  }
}

const COMANDOS = { empresa, territorio, rede, empresas };

if (import.meta.url === `file://${process.argv[1]}`) {
  const [comando, ...resto] = process.argv.slice(2);
  const fn = COMANDOS[comando];
  if (!fn) {
    console.error(`comandos: ${Object.keys(COMANDOS).join(', ')}`);
    process.exit(1);
  }
  fn(resto)
    .then(() => dono.end())
    .catch((erro) => { console.error(erro.message); process.exit(1); });
}

export { empresa, territorio, rede, empresas };
