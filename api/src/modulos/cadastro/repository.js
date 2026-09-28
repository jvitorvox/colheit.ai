// Todo o SQL do módulo cadastro mora aqui, e só aqui — regra da seção 13.
//
// Nenhuma função abre transação nem conhece pool: todas recebem `cx`, que é a
// conexão já dentro de app.comContexto(). É isso que garante que o tenant e o
// usuário estejam no contexto quando a política de RLS for avaliada.

/* ---------------------------------------------------------------- produtor */

export async function vincularProdutor(cx, { nome, documentos, origem }) {
  const { rows } = await cx.query(
    'select app.vincular_produtor($1, $2::jsonb, $3) as id',
    [nome, JSON.stringify(documentos), origem],
  );
  return rows[0].id;
}

export async function listarProdutores(cx) {
  const { rows } = await cx.query(`
    select p.id, p.nome, p.origem, p.criado_em,
           coalesce(
             (select json_agg(json_build_object('tipo', d.tipo, 'valor', d.valor) order by d.tipo)
                from produtor_documento d where d.produtor_id = p.id),
             '[]'::json) as documentos
      from produtor_vinculo v
      join produtor p on p.id = v.produtor_id
     where p.fundido_em is null
     order by p.nome`);
  return rows;
}

export async function buscarProdutor(cx, id) {
  const { rows } = await cx.query(`
    select p.id, p.nome, p.origem, p.fundido_em, p.criado_em,
           coalesce(
             (select json_agg(json_build_object('tipo', d.tipo, 'valor', d.valor) order by d.tipo)
                from produtor_documento d where d.produtor_id = p.id),
             '[]'::json) as documentos
      from produtor p where p.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function adicionarDocumento(cx, produtorId, { tipo, valor }) {
  await cx.query(
    'insert into produtor_documento (produtor_id, tipo, valor) values ($1, $2, $3)',
    [produtorId, tipo, valor],
  );
}

export async function fundirProdutor(cx, perdedor, vencedor) {
  await cx.query('select app.fundir_produtor($1, $2)', [perdedor, vencedor]);
}

/* ------------------------------------------------------------ propriedade */

export async function criarPropriedade(cx, d) {
  const { rows } = await cx.query(
    'select app.criar_propriedade($1,$2,$3,$4,$5,$6,$7,$8) as id',
    [d.nome, d.produtorId, d.papel, d.municipio, d.uf, d.car, d.areaHa, d.inicio],
  );
  return rows[0].id;
}

export async function listarPropriedades(cx) {
  const { rows } = await cx.query(`
    select pr.id, pr.nome, pr.municipio, pr.uf, pr.car, pr.area_ha,
           coalesce(
             (select json_agg(json_build_object(
                       'produtorId', pp.produtor_id, 'produtor', p.nome,
                       'papel', pp.papel, 'inicio', pp.inicio, 'fim', pp.fim)
                       order by pp.papel)
                from produtor_propriedade pp
                join produtor p on p.id = pp.produtor_id
               where pp.propriedade_id = pr.id and pp.fim is null),
             '[]'::json) as operadores
      from propriedade pr
     order by pr.nome`);
  return rows;
}

export async function ligarOperador(cx, propriedadeId, d) {
  const { rows } = await cx.query(`
    insert into produtor_propriedade (produtor_id, propriedade_id, papel, inicio)
    values ($1, $2, $3, coalesce($4::date, current_date))
    returning id`, [d.produtorId, propriedadeId, d.papel, d.inicio]);
  return rows[0].id;
}

export async function encerrarOperacao(cx, relacaoId, fim) {
  const { rowCount } = await cx.query(
    'update produtor_propriedade set fim = coalesce($2::date, current_date) where id = $1 and fim is null',
    [relacaoId, fim],
  );
  return rowCount;
}

/* ----------------------------------------------------------------- talhão */

export async function criarTalhao(cx, propriedadeId, { nome, areaHa }) {
  const { rows } = await cx.query(
    'insert into talhao (propriedade_id, nome, area_ha) values ($1,$2,$3) returning id',
    [propriedadeId, nome, areaHa],
  );
  return rows[0].id;
}

export async function listarTalhoes(cx, propriedadeId) {
  const { rows } = await cx.query(
    'select id, nome, area_ha from talhao where propriedade_id = $1 order by nome',
    [propriedadeId],
  );
  return rows;
}

export async function propriedadeExiste(cx, id) {
  const { rows } = await cx.query('select 1 from propriedade where id = $1', [id]);
  return rows.length > 0;
}

/* --------------------------------------------------------------- carteira */

export async function autorizarConsultor(cx, usuarioId, vinculoId) {
  await cx.query('select app.autorizar_consultor($1, $2)', [usuarioId, vinculoId]);
}

export async function vinculoDoProdutor(cx, produtorId) {
  const { rows } = await cx.query(
    'select id from produtor_vinculo where produtor_id = $1 and tenant_id = app.tenant_atual()',
    [produtorId],
  );
  return rows[0]?.id ?? null;
}

/**
 * A lavoura como o produtor a vê: a terra dele com os talhões dentro.
 *
 * Uma consulta só, em vez de listar propriedades e depois talhões de cada uma —
 * o portal abre nisto, e é a tela que precisa ser rápida no celular do campo.
 */
export async function minhaLavoura(cx) {
  const { rows } = await cx.query(`
    select pr.id, pr.nome, pr.municipio, pr.uf, pr.area_ha,
           coalesce(
             (select json_agg(json_build_object('id', t.id, 'nome', t.nome, 'areaHa', t.area_ha)
                              order by t.nome)
                from talhao t where t.propriedade_id = pr.id),
             '[]'::json) as talhoes,
           (select pp.papel from produtor_propriedade pp
             where pp.propriedade_id = pr.id and pp.produtor_id = app.produtor_atual()
               and pp.fim is null limit 1) as meu_papel
      from propriedade pr
     order by pr.nome`);
  return rows;
}

/**
 * Procura produtor por pedaço de nome, dentro do que o chamador enxerga.
 *
 * `unaccent` não está instalado, e instalar extensão por causa de uma busca de
 * WhatsApp seria caro demais para o ganho. `lower` + `like` resolve "jose" para
 * "José"? Não — e é por isso que a comparação é feita sobre o nome COM acento
 * de um lado e o termo como foi escrito do outro, aceitando que quem escreve
 * "jose" sem acento não é encontrado. O consultor escreve o nome que ele lê na
 * tela, e ficar adivinhando acento erraria mais do que acerta.
 */
export async function procurarProdutores(cx, termos) {
  const { rows } = await cx.query(`
    select p.id, p.nome
      from produtor p
     where p.fundido_em is null
       and exists (select 1 from unnest($1::text[]) t
                    where lower(p.nome) like '%' || lower(t) || '%')
     order by p.nome
     limit 5`, [termos]);
  return rows;
}

/**
 * Procura talhão citado num texto, dos dois jeitos que a pessoa escreve.
 *
 * `$2` é a mensagem inteira e `$1` são os termos soltos, porque as duas
 * direções acontecem: "e a Gleba 2, quanto rendeu?" traz o nome INTEIRO dentro
 * da frase, e "quanto rendeu o pivô?" traz só um pedaço do nome "Pivô do
 * fundo". Procurar só por termo faria "Gleba 2" casar também com "Gleba 1",
 * porque o número tem um caractere e não entra na lista de termos.
 */
export async function procurarTalhoes(cx, termos, frase) {
  const { rows } = await cx.query(`
    select t.id, t.nome,
           position(lower(t.nome) in lower($2)) > 0 as pelo_nome_inteiro
      from talhao t
     where position(lower(t.nome) in lower($2)) > 0
        or exists (select 1 from unnest($1::text[]) x
                    where lower(t.nome) like '%' || lower(x) || '%')
     order by length(t.nome) desc
     limit 5`, [termos, frase]);
  return rows;
}
