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
//   docker compose exec -w /app/api api npm run admin -- senha ana@3t.com
//   docker compose exec -w /app/api api npm run admin -- plataforma "Joao" joao@colheit.ai
//   docker compose exec -w /app/api api npm run admin -- empresas
import { dono } from './db.js';
import { gerarToken, hashToken } from './modulos/auth/senha.js';

const TIPOS = ['franqueadora', 'franqueado', 'industria', 'distribuidor', 'revenda'];

/**
 * Cria a empresa e o primeiro gestor dela, numa transação só.
 *
 * Empresa sem gestor é empresa que ninguém consegue abrir, e gestor sem empresa
 * não existe: ou os dois nascem, ou nenhum nasce.
 *
 * O gestor nasce SEM senha, como qualquer usuário criado pela tela. O que sai
 * daqui é um link de uma viagem só, e quem escolhe a senha é ele — nem esta
 * linha de comando, nem quem a rodou, chega a conhecer a senha de ninguém.
 */
async function empresa([nome, documento, tipo, gestor, email]) {
  if (!nome || !documento || !tipo || !gestor || !email) {
    throw new Error('uso: empresa <nome> <documento> <tipo> <gestor> <e-mail>');
  }
  if (!TIPOS.includes(tipo)) throw new Error(`tipo deve ser um de: ${TIPOS.join(', ')}`);

  const cx = await dono.connect();
  try {
    await cx.query('begin');
    const { rows: [t] } = await cx.query(
      'insert into tenant (nome, documento, tipo) values ($1,$2,$3) returning id',
      [nome, String(documento).replace(/\D/g, ''), tipo]);
    const { rows: [u] } = await cx.query(`
      insert into usuario (tenant_id, nome, email, papel)
      values ($1,$2,$3,'gestor') returning id`,
    [t.id, gestor, String(email).trim().toLowerCase()]);
    const link = await abrirBilhete(cx, u.id);
    await cx.query('commit');

    console.log(`empresa  ${t.id}  ${nome} (${tipo})`);
    console.log(`gestor   ${u.id}  ${email}`);
    console.log(`\nEntregue este link — ele vale 24 h e serve uma vez:\n${link}`);
  } catch (erro) {
    await cx.query('rollback');
    throw erro;
  } finally {
    cx.release();
  }
}

/**
 * Prova o SMTP contra o servidor de verdade.
 *
 * Existe porque a entrega por e-mail era a única peça desta base que nunca
 * tinha encostado num servidor real: o fluxo do bilhete está testado ponta a
 * ponta com um entregador falso, e entregador falso não descobre certificado
 * vencido, porta bloqueada, remetente recusado nem senha de aplicativo errada.
 *
 * Manda UMA mensagem, para um endereço que você escreve na mão. Não cria conta,
 * não mexe em conta nenhuma, e não é o caminho de recuperação de senha — é só
 * o cano.
 */
async function correio([para]) {
  if (!para) throw new Error('uso: correio <e-mail de destino>');
  const { testar } = await import('./modulos/auth/correio.js');
  const r = await testar(para);

  if (r.config) {
    console.log(`servidor   ${r.config.host}:${r.config.porta}  (${r.config.tls})`);
    console.log(`usuário    ${r.config.usuario}`);
    console.log(`remetente  ${r.config.de}`);
    console.log('');
  }

  if (!r.ok) {
    // A etapa é o diagnóstico: conexão aponta para host/porta/TLS/credencial,
    // envio aponta para remetente, destinatário ou política do provedor.
    throw new Error(`falhou na ${r.etapa}: ${r.erro}`);
  }

  console.log(`conexão    ok — abriu, subiu o TLS e autenticou`);
  console.log(`envio      aceito pelo servidor (${r.id})`);
  if (r.recusados?.length) console.log(`recusados  ${r.recusados.join(', ')}`);
  console.log(`\nMandada para ${para}. Confira a caixa — e o spam, que é onde`);
  console.log('mensagem de domínio novo costuma cair.');
}

/**
 * A conta que modera cadastro.
 *
 * Nasce só por aqui, e não por tela nenhuma: é a única conta da plataforma que
 * fica acima de todos os clientes, e criar mais uma dessas é ato de quem tem a
 * máquina, não de quem tem uma sessão aberta.
 *
 * Ela vê cadastro — nome, CNPJ, quem pediu, quando — e não vê pedido, produtor,
 * visita nem caderno de ninguém. Isso não é promessa desta função: a sessão de
 * plataforma não põe tenant no contexto, e sem tenant nenhuma política casa.
 */
async function plataforma([nome, email]) {
  if (!nome || !email) throw new Error('uso: plataforma <nome> <e-mail>');
  const chave = String(email).trim().toLowerCase();

  const cx = await dono.connect();
  try {
    await cx.query('begin');
    const { rows: [p] } = await cx.query(
      'insert into plataforma_usuario (nome, email) values ($1,$2) returning id',
      [nome, chave]);
    const link = await abrirBilhete(cx, p.id, 'plataforma_id', '/plataforma');
    await cx.query('commit');

    console.log(`plataforma  ${p.id}  ${chave}`);
    console.log(`\nEntregue este link — ele vale 24 h e serve uma vez:\n${link}`);
  } catch (erro) {
    await cx.query('rollback');
    if (erro.code === '23505') throw new Error(`já existe conta de plataforma com ${chave}`);
    throw erro;
  } finally {
    cx.release();
  }
}

/**
 * O fundo da escada da recuperação de senha.
 *
 * Um consultor que esquece a senha pede ao gestor. O gestor que esquece pede a
 * outro gestor. O único gestor de uma empresa que esquece a senha não tem a
 * quem pedir — e sem este comando a saída voltaria a ser um `update` no psql,
 * que é exatamente o que as telas de administração vieram encerrar.
 *
 * Roda com o papel dono e alcança qualquer conta da plataforma, de propósito:
 * é a chave mestra, e o lugar dela é a máquina do servidor, não uma tela.
 */
async function senha([email]) {
  if (!email) throw new Error('uso: senha <e-mail>');
  const chave = String(email).trim().toLowerCase();
  const { rows } = await dono.query(`
    select u.id, u.nome, u.ativo, t.nome as empresa, t.ativo as empresa_ativa
      from usuario u join tenant t on t.id = u.tenant_id
     where lower(u.email) = $1`, [chave]);
  if (rows.length === 0) throw new Error(`nenhuma conta com o e-mail ${chave}`);

  const [u] = rows;
  // Reativar por tabela seria decisão de outra pessoa tomada às escondidas: o
  // link não vale para conta desligada, e o comando diz o que fazer antes.
  if (!u.ativo) throw new Error(`${u.nome} está inativo — reative pela tela Equipe antes`);
  if (!u.empresa_ativa) throw new Error(`a empresa ${u.empresa} está inativa`);

  console.log(`${u.nome} · ${u.empresa}`);
  console.log(`\nEntregue este link — ele vale 24 h e serve uma vez:\n${await abrirBilhete(dono, u.id)}`);
}

/**
 * O mesmo fundo de escada, para quem modera.
 *
 * Aqui não existe "outro gestor" a quem pedir: a conta de plataforma não tem
 * empresa, e a tela dela não abre acesso para ninguém. Quem esquece essa senha
 * depende da máquina, e é assim que tem de ser.
 */
async function senhaPlataforma([email]) {
  if (!email) throw new Error('uso: senha-plataforma <e-mail>');
  const chave = String(email).trim().toLowerCase();
  const { rows } = await dono.query(
    'select id, nome, ativo from plataforma_usuario where lower(email) = $1', [chave]);
  if (rows.length === 0) throw new Error(`nenhuma conta de plataforma com o e-mail ${chave}`);

  const [p] = rows;
  if (!p.ativo) throw new Error(`${p.nome} está inativo`);

  console.log(`${p.nome} · plataforma`);
  console.log('\nEntregue este link — ele vale 24 h e serve uma vez:\n'
    + `${await abrirBilhete(dono, p.id, 'plataforma_id', '/plataforma')}`);
}

/**
 * O bilhete de senha, do jeito que a API o guarda: só o hash fica.
 *
 * Sem APP_URL o comando imprime o caminho em vez de um endereço inventado —
 * link com o servidor errado é link que não abre, e pior, um que alguém tenta.
 */
async function abrirBilhete(cx, id, coluna = 'usuario_id', casca = '/empresa') {
  const token = gerarToken();
  await cx.query(`
    update recuperacao_senha set usado_em = now()
     where ${coluna} = $1 and usado_em is null`, [id]);
  await cx.query(`
    insert into recuperacao_senha (${coluna}, token_hash, origem, expira_em)
    values ($1, $2, 'admin', now() + interval '24 hours')`,
  [id, hashToken(token)]);

  // A casca muda com a identidade: o gestor escolhe a senha em /empresa, quem
  // modera escolhe em /plataforma. Mandar um para a porta do outro daria um
  // link que funciona e uma tela de entrada onde ele não consegue entrar.
  const base = String(process.env.APP_URL ?? '').replace(/\/+$/, '');
  return base
    ? `${base}${casca}#senha=${token}`
    : `${casca}#senha=${token}\n(cole depois do endereço da instalação; defina APP_URL para sair pronto)`;
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
    select t.id, t.nome, t.tipo, t.documento, t.origem,
           (select count(*)::int from usuario u where u.tenant_id = t.id and u.ativo) as usuarios,
           (select count(*)::int from territorio te where te.franqueado_id = t.id) as municipios
      from tenant t order by t.tipo, t.nome`);
  if (rows.length === 0) return console.log('(nenhuma empresa ainda)');
  for (const r of rows) {
    console.log(`${r.id}  ${r.tipo.padEnd(13)} ${r.nome}`
      + `  ·  ${r.usuarios} usuário(s)`
      + (r.municipios ? `  ·  ${r.municipios} município(s)` : '')
      // Quem nasceu pela tela vem marcado: é o primeiro dado que alguém vai
      // querer olhar quando ligarem dizendo "esse CNPJ não é dessa gente".
      + (r.origem === 'autoatendimento' ? '  ·  pela tela' : ''));
  }
}

async function exigirTipo(id, tipo) {
  const { rows } = await dono.query('select tipo from tenant where id = $1', [id]);
  if (rows.length === 0) throw new Error(`empresa ${id} não existe`);
  if (rows[0].tipo !== tipo) {
    throw new Error(`${id} é ${rows[0].tipo}, e aqui precisa ser ${tipo}`);
  }
}

const COMANDOS = {
  empresa, territorio, rede, senha, plataforma, correio, empresas,
  'senha-plataforma': senhaPlataforma,
};

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

export { empresa, territorio, rede, senha, plataforma, senhaPlataforma, correio, empresas };
