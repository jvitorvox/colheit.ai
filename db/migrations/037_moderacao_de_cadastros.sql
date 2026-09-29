-- 037 · Moderação de cadastros
--
-- O autoatendimento deixou um limite conhecido: quem confirma primeiro fica com
-- o CNPJ, e desfazer isso era ligação para o suporte sem ferramenta nenhuma.
-- Esta migração dá a ferramenta — e, com ela, o superadmin que eu vinha
-- adiando de propósito desde a 034.
--
-- A decisão tomada foi a de MENOR alcance possível, e ela é o assunto inteiro
-- deste arquivo:
--
--   · a moderação é fila DEPOIS, não portão antes. Confirmou o e-mail, a
--     empresa existe e a pessoa entra na hora. Ninguém espera uma pessoa para
--     começar a usar; o abuso, que é raro, se conserta depois.
--
--   · o login de plataforma NÃO é chave mestra. Ele vê cadastro: nome, CNPJ,
--     quem pediu, quando, quantos usuários. Não vê pedido, produtor, visita,
--     caderno nem receita de ninguém.
--
-- E a fronteira do segundo ponto não é a RLS: é o TIPO DE RETORNO das funções
-- lá embaixo. A sessão de plataforma não põe tenant no contexto, então nenhuma
-- política de negócio casa e aquelas tabelas já respondem vazio; o que ela
-- enxerga é exatamente o que `app.moderacao_empresas`, `app.moderacao_pendentes`
-- e `app.moderar_empresa` devolvem, e nada mais. Para auditar o alcance dessa
-- conta basta ler três assinaturas.

-- ---------------------------------------------------------------------------
-- A identidade da plataforma. Tabela separada de `usuario`, e não um campo
-- nela: um bit de "vê tudo" convivendo com as contas dos clientes fica a um
-- engano de distância de virar escalação de privilégio.
-- ---------------------------------------------------------------------------
create table plataforma_usuario (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null,
  email      text not null unique,
  senha_hash text,
  ativo      boolean not null default true,
  criado_em  timestamptz not null default now()
);

comment on table plataforma_usuario is
  'Quem modera cadastro. Não tem tenant, não participa de nenhuma política de '
  'negócio, e só nasce por `npm run admin -- plataforma`.';

revoke all on plataforma_usuario from public;

-- O eixo novo do contexto. São quatro agora, e continuam sem conviver: empresa
-- (tenant + usuario), portal (produtor) e plataforma.
create or replace function app.plataforma_atual() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.plataforma_id', true), '')::uuid $$;

create or replace function app.e_plataforma() returns boolean
  language sql stable
  -- `security definer` por necessidade, como app.e_gestor(): lê uma tabela que
  -- a aplicação não alcança.
  security definer set search_path = public, app
  as $$ select exists (select 1 from plataforma_usuario
                        where id = app.plataforma_atual() and ativo) $$;

create or replace function app.credencial_plataforma(p_email text)
  returns table (id uuid, nome text, senha_hash text)
  language sql security definer set search_path = public, app
  as $$
    select p.id, p.nome, p.senha_hash
      from plataforma_usuario p
     where lower(p.email) = lower(p_email) and p.ativo
  $$;

create or replace function app.plataforma_eu()
  returns table (id uuid, nome text, email text)
  language sql security definer set search_path = public, app
  as $$
    select p.id, p.nome, p.email from plataforma_usuario p
     where p.id = app.plataforma_atual() and p.ativo
  $$;

-- ---------------------------------------------------------------------------
-- O bilhete de senha passa a servir às duas identidades.
--
-- Uma peça só, e não uma segunda cópia do mesmo mecanismo: quem modera também
-- nasce sem senha, também escolhe a dela, e ninguém além dela a conhece.
-- ---------------------------------------------------------------------------
alter table recuperacao_senha alter column usuario_id drop not null;
alter table recuperacao_senha add column plataforma_id uuid
  references plataforma_usuario(id) on delete cascade;
alter table recuperacao_senha add constraint recuperacao_tem_um_dono
  check ((usuario_id is not null) <> (plataforma_id is not null));

create or replace function app.consumir_recuperacao(p_hash text, p_senha_hash text)
  returns uuid
  language plpgsql security definer set search_path = public, app
  as $$
declare
  v_id uuid;
  v_plataforma uuid;
begin
  select r.usuario_id, r.plataforma_id into v_id, v_plataforma
    from recuperacao_senha r
    left join usuario u on u.id = r.usuario_id
    left join tenant t on t.id = u.tenant_id
    left join plataforma_usuario p on p.id = r.plataforma_id
   where r.token_hash = p_hash and r.usado_em is null and r.expira_em > now()
     and (r.usuario_id is null or (u.ativo and t.ativo))
     and (r.plataforma_id is null or p.ativo);
  if v_id is null and v_plataforma is null then return null; end if;

  if v_id is not null then
    update usuario set senha_hash = p_senha_hash where id = v_id;
    delete from tentativa_login
      where chave = (select lower(email) from usuario where id = v_id);
    update recuperacao_senha set usado_em = now()
      where usuario_id = v_id and usado_em is null;
  else
    update plataforma_usuario set senha_hash = p_senha_hash where id = v_plataforma;
    delete from tentativa_login
      where chave = (select lower(email) from plataforma_usuario where id = v_plataforma);
    update recuperacao_senha set usado_em = now()
      where plataforma_id = v_plataforma and usado_em is null;
  end if;

  return coalesce(v_id, v_plataforma);
end $$;

-- ---------------------------------------------------------------------------
-- Soltar o CNPJ.
--
-- `documento` era único e ponto. Com moderação isso não basta: recusar um
-- cadastro tem de devolver o CNPJ a quem é dono dele, e apagar a empresa
-- apagaria junto o registro do que aconteceu — logo a linha que alguém vai
-- querer olhar quando a ligação chegar.
--
-- A unicidade passa a valer só entre as reivindicações VIVAS. A linha recusada
-- fica onde está, com o CNPJ verdadeiro e a data em que foi solto.
-- ---------------------------------------------------------------------------
alter table tenant
  add column liberado_em  timestamptz,
  add column revisado_em  timestamptz,
  add column revisado_por uuid references plataforma_usuario(id),
  add column revisao_nota text;

alter table tenant drop constraint tenant_documento_key;
create unique index tenant_documento_vivo on tenant (documento) where liberado_em is null;

comment on column tenant.liberado_em is
  'Quando o CNPJ foi devolvido. A linha continua aqui: é o registro de que '
  'aquele cadastro existiu e foi recusado.';

-- O autoatendimento tem de enxergar a mesma regra: CNPJ solto está livre.
create or replace function app.abrir_cadastro(
  p_nome text, p_documento text, p_tipo text,
  p_gestor text, p_email text, p_hash text, p_horas int default 48)
  returns table (situacao text)
  language plpgsql security definer set search_path = public, app
  as $$
begin
  if exists (select 1 from cadastro_tentativa t
              where t.email = lower(p_email)
                and t.ultimo_em > now() - interval '1 minute') then
    return;
  end if;
  insert into cadastro_tentativa (email) values (lower(p_email))
    on conflict (email) do update set ultimo_em = now();

  if exists (select 1 from usuario u where lower(u.email) = lower(p_email)) then
    return query select 'email_existe'::text;
    return;
  end if;

  if exists (select 1 from tenant t
              where t.documento = p_documento and t.liberado_em is null) then
    return query select 'empresa_existe'::text;
    return;
  end if;

  update cadastro_pendente set usado_em = now()
    where lower(gestor_email) = lower(p_email) and usado_em is null;

  insert into cadastro_pendente
    (nome, documento, tipo, gestor_nome, gestor_email, token_hash, expira_em)
  values
    (p_nome, p_documento, p_tipo, p_gestor, lower(p_email), p_hash,
     now() + make_interval(hours => p_horas));

  return query select 'nova'::text;
end $$;

create or replace function app.confirmar_cadastro(p_hash text, p_senha_hash text)
  returns table (tenant_id uuid, empresa text, gestor text)
  language plpgsql security definer set search_path = public, app
  as $$
declare
  v_p cadastro_pendente%rowtype;
  v_t uuid;
  v_u uuid;
begin
  select * into v_p from cadastro_pendente
   where token_hash = p_hash and usado_em is null and expira_em > now();
  if not found then return; end if;

  if exists (select 1 from tenant t
              where t.documento = v_p.documento and t.liberado_em is null) then
    raise exception 'essa empresa já tem conta no colheit.ai';
  end if;
  if exists (select 1 from usuario u where lower(u.email) = v_p.gestor_email) then
    raise exception 'esse e-mail já tem conta no colheit.ai';
  end if;

  insert into tenant (nome, documento, tipo, origem)
    values (v_p.nome, v_p.documento, v_p.tipo, 'autoatendimento')
    returning id into v_t;

  insert into usuario (tenant_id, nome, email, papel)
    values (v_t, v_p.gestor_nome, v_p.gestor_email, 'gestor')
    returning id into v_u;

  insert into recuperacao_senha (usuario_id, token_hash, origem, expira_em)
    values (v_u, p_senha_hash, 'cadastro', now() + interval '24 hours');

  update cadastro_pendente set usado_em = now() where id = v_p.id;

  return query select v_t, v_p.nome, v_p.gestor_nome;
end $$;

-- ---------------------------------------------------------------------------
-- A fila. Três funções, e o alcance inteiro da conta de plataforma está aqui.
--
-- Repare no que NÃO está no retorno: receita, volume, pedido, produtor, visita,
-- caderno. Quem modera cadastro precisa saber que a empresa existe, de quem ela
-- diz ser e quem pediu — nada do que ela faz lá dentro.
-- ---------------------------------------------------------------------------
create or replace function app.moderacao_empresas()
  returns table (
    id uuid, nome text, documento text, tipo text, criado_em timestamptz,
    ativo boolean, liberado_em timestamptz, revisado_em timestamptz,
    revisao_nota text, revisado_por text,
    gestor text, gestor_email text, usuarios int)
  language plpgsql security definer set search_path = public, app
  as $$
begin
  if not app.e_plataforma() then raise exception 'esta área é da plataforma'; end if;

  return query
    select t.id, t.nome, t.documento, t.tipo, t.criado_em,
           t.ativo, t.liberado_em, t.revisado_em, t.revisao_nota,
           (select p.nome from plataforma_usuario p where p.id = t.revisado_por),
           -- O gestor mais antigo é quem pediu o cadastro. Só ele: a lista de
           -- consultores de cada cliente não é assunto de quem modera CNPJ.
           (select u.nome from usuario u where u.tenant_id = t.id
             order by u.criado_em limit 1),
           (select u.email from usuario u where u.tenant_id = t.id
             order by u.criado_em limit 1),
           (select count(*)::int from usuario u where u.tenant_id = t.id and u.ativo)
      from tenant t
     where t.origem = 'autoatendimento'
     -- Quem ainda não foi olhado primeiro: é uma fila, e fila que não põe o
     -- pendente no topo vira uma lista que ninguém termina de ler.
     order by (t.revisado_em is not null), t.criado_em desc;
end $$;

create or replace function app.moderacao_pendentes()
  returns table (
    id uuid, nome text, documento text, tipo text,
    gestor_nome text, gestor_email text, criado_em timestamptz, expira_em timestamptz)
  language plpgsql security definer set search_path = public, app
  as $$
begin
  if not app.e_plataforma() then raise exception 'esta área é da plataforma'; end if;

  return query
    select c.id, c.nome, c.documento, c.tipo,
           c.gestor_nome, c.gestor_email, c.criado_em, c.expira_em
      from cadastro_pendente c
     where c.usado_em is null and c.expira_em > now()
     order by c.criado_em desc;
end $$;

-- Aprovar tira da fila. Recusar desliga a empresa E devolve o CNPJ — as duas
-- coisas juntas, porque uma sem a outra não resolve nada: desligar sem soltar
-- deixa o dono de verdade sem conseguir se cadastrar, e soltar sem desligar
-- deixa o impostor usando o sistema.
--
-- Reabrir existe porque moderação erra, e o erro aqui desliga o sistema de uma
-- empresa inteira.
create or replace function app.moderar_empresa(p_tenant uuid, p_acao text, p_nota text)
  returns void
  language plpgsql security definer set search_path = public, app
  as $$
declare v_quem uuid := app.plataforma_atual();
begin
  if not app.e_plataforma() then raise exception 'esta área é da plataforma'; end if;
  if not exists (select 1 from tenant t
                  where t.id = p_tenant and t.origem = 'autoatendimento') then
    raise exception 'essa empresa não nasceu pela tela, e não é desta fila';
  end if;

  if p_acao = 'aprovar' then
    -- Não mexe em liberado_em de propósito: aprovar é dizer "olhei, está de
    -- pé". Desfazer uma recusa é `reabrir`, que confere se o CNPJ ainda está
    -- livre antes de reivindicá-lo de novo.
    update tenant set revisado_em = now(), revisado_por = v_quem, revisao_nota = p_nota
     where id = p_tenant and liberado_em is null;
    if not found then
      raise exception 'essa empresa está com o CNPJ solto; para aprovar, reabra antes';
    end if;

  elsif p_acao = 'recusar' then
    if coalesce(btrim(p_nota), '') = '' then
      raise exception 'recusar exige um motivo — é o que quem atender a ligação vai ler';
    end if;
    update tenant set ativo = false, liberado_em = now(),
                      revisado_em = now(), revisado_por = v_quem, revisao_nota = p_nota
     where id = p_tenant;

  elsif p_acao = 'reabrir' then
    -- Entre a recusa e o arrependimento o dono de verdade pode ter se
    -- cadastrado. Aí não há o que reabrir: o CNPJ é dele agora.
    if exists (select 1 from tenant t
                join tenant alvo on alvo.id = p_tenant
               where t.documento = alvo.documento and t.liberado_em is null
                 and t.id <> p_tenant) then
      raise exception 'esse CNPJ já foi para outra empresa; não dá para reabrir esta';
    end if;
    update tenant set ativo = true, liberado_em = null,
                      revisado_em = null, revisado_por = null, revisao_nota = null
     where id = p_tenant;

  else
    raise exception 'ação desconhecida';
  end if;
end $$;

grant execute on function
  app.plataforma_atual(), app.e_plataforma(), app.credencial_plataforma(text),
  app.plataforma_eu(),
  app.moderacao_empresas(), app.moderacao_pendentes(),
  app.moderar_empresa(uuid, text, text)
  to public;
