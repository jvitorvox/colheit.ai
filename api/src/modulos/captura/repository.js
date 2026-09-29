// SQL do módulo captura.
//
// Como no push, há duas famílias: o que roda dentro de uma requisição com
// contexto, e o que o gateway faz com o papel dono — ele atende vários tenants
// e não tem sessão de ninguém.

/* ------------------------------------------------------------------ canal */

export async function registrarCanal(cx, numero) {
  const { rows } = await cx.query(`
    insert into canal_whatsapp (tenant_id, numero) values (app.tenant_atual(), $1)
    on conflict (tenant_id) do update set numero = excluded.numero, ativo = true
    returning tenant_id, numero, ativo`, [numero]);
  return rows[0];
}

export async function meuCanal(cx) {
  const { rows } = await cx.query(
    'select tenant_id, numero, ativo, conectado_em from canal_whatsapp');
  return rows[0] ?? null;
}

/* ------------------------------------------------------- gateway (dono) */

export async function tenantDoNumero(dono, numero) {
  const { rows } = await dono.query(
    'select tenant_id from canal_whatsapp where numero = $1 and ativo', [numero]);
  return rows[0]?.tenant_id ?? null;
}

/**
 * Quem é este telefone. O produtor é global — o mesmo número fala com qualquer
 * canal; o usuário é do tenant que recebeu.
 */
export async function identificar(dono, telefone, tenantId) {
  const p = await dono.query(
    'select produtor_id from produtor_acesso where telefone = $1', [telefone]);
  if (p.rows[0]) return { produtorId: p.rows[0].produtor_id, usuarioId: null };

  const u = await dono.query(
    'select id from usuario where telefone = $1 and tenant_id = $2 and ativo',
    [telefone, tenantId]);
  if (u.rows[0]) return { produtorId: null, usuarioId: u.rows[0].id };

  return { produtorId: null, usuarioId: null };
}

export async function gravarEntrada(dono, m) {
  const { rows } = await dono.query(`
    insert into mensagem_whatsapp (tenant_id, telefone, direcao, tipo, texto,
                                   midia_id, produtor_id, usuario_id, duracao_seg)
    values ($1,$2,'entrada',$3,$4,$5,$6,$7,$8)
    returning id, criado_em`,
    [m.tenantId, m.telefone, m.tipo, m.texto, m.midiaId, m.produtorId, m.usuarioId,
      m.duracaoSeg ?? null]);
  return rows[0];
}

export async function gravarSaida(dono, m) {
  const { rows } = await dono.query(`
    insert into mensagem_whatsapp (tenant_id, telefone, direcao, tipo, texto, responde_a)
    values ($1,$2,'saida','texto',$3,$4)
    returning id`, [m.tenantId, m.telefone, m.texto, m.respondeA]);
  return rows[0].id;
}

export async function ultimaEntradaDe(dono, tenantId, telefone, janelaHoras) {
  const { rows } = await dono.query(`
    select id from mensagem_whatsapp
     where tenant_id = $1 and telefone = $2 and direcao = 'entrada'
       and criado_em > now() - make_interval(hours => $3)
     order by criado_em desc limit 1`, [tenantId, telefone, janelaHoras]);
  return rows[0]?.id ?? null;
}

export async function saidasPendentes(dono, limite) {
  const { rows } = await dono.query(`
    select m.id, m.tenant_id, c.numero as de, m.telefone as para, m.texto
      from mensagem_whatsapp m
      join canal_whatsapp c on c.tenant_id = m.tenant_id
     where m.direcao = 'saida' and m.enviada_em is null
     order by m.criado_em limit $1`, [limite]);
  return rows;
}

export const marcarEnviada = (dono, id) =>
  dono.query('update mensagem_whatsapp set enviada_em = now() where id = $1', [id]);

export async function criarRelato(dono, r) {
  const { rows } = await dono.query(`
    insert into relato (mensagem_id, tenant_id, produtor_id, tipo, transcricao,
                        extraido, situacao)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [r.mensagemId, r.tenantId, r.produtorId, r.tipo, r.transcricao,
      r.extraido ? JSON.stringify(r.extraido) : null, r.situacao]);
  return rows[0].id;
}

/* ------------------------------------------------ fila do consultor (ctx) */

export async function relatos(cx, situacao) {
  const { rows } = await cx.query(`
    select r.id, r.tipo, r.situacao, r.transcricao, r.extraido, r.criado_em,
           r.observacao, p.nome as produtor, m.tipo as origem, m.telefone, m.midia_id
      from relato r
      join produtor p on p.id = r.produtor_id
      join mensagem_whatsapp m on m.id = r.mensagem_id
     where ($1::text is null or r.situacao = $1)
     order by r.criado_em desc`, [situacao ?? null]);
  return rows;
}

/**
 * O relato, com a duração do áudio que o originou.
 *
 * Ela vem da mensagem, e não do relato, porque é fato do áudio: foi medida no
 * aparelho de quem gravou, no instante em que gravou. Quem valida o relato
 * depois, na mesa, não tem como saber quanto tempo o consultor levou — e
 * gravar o tempo DELE como se fosse o do consultor seria inventar a medição
 * que a H1 decide.
 */
export async function buscarRelato(cx, id) {
  const { rows } = await cx.query(`
    select r.*, m.duracao_seg
      from relato r join mensagem_whatsapp m on m.id = r.mensagem_id
     where r.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function decidirRelato(cx, id, situacao, observacao, talhaoId) {
  const { rowCount } = await cx.query(`
    update relato
       set situacao = $2, observacao = $3, talhao_id = coalesce($4, talhao_id),
           validado_por = app.usuario_atual(), validado_em = now()
     where id = $1 and situacao in ('pendente', 'aguardando_extracao')`,
    [id, situacao, observacao ?? null, talhaoId ?? null]);
  return rowCount;
}

export async function aguardandoExtracao(dono, limite) {
  const { rows } = await dono.query(`
    select r.id, r.tenant_id, m.tipo, m.texto, m.midia_id
      from relato r join mensagem_whatsapp m on m.id = r.mensagem_id
     where r.situacao = 'aguardando_extracao'
     order by r.criado_em limit $1`, [limite]);
  return rows;
}

export const aplicarExtracao = (dono, id, transcricao, extraido, tipo) =>
  dono.query(`update relato
                 set transcricao = $2, extraido = $3, tipo = coalesce($4, tipo),
                     situacao = 'pendente'
               where id = $1`,
  [id, transcricao, extraido ? JSON.stringify(extraido) : null, tipo ?? null]);

/** Todos os canais ativos — o gateway atende vários tenants, então usa o dono. */
export async function canaisAtivos(dono) {
  const { rows } = await dono.query(
    'select tenant_id, numero from canal_whatsapp where ativo order by criado_em');
  return rows;
}

export const marcarConectado = (dono, numero) =>
  dono.query('update canal_whatsapp set conectado_em = now() where numero = $1', [numero]);
