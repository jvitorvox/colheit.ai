-- 036 · Autoatendimento de cadastro
--
-- O último ato que ainda exigia alguém na máquina do servidor. A 034 tirou
-- usuário e carteira do psql, a 035 tirou a senha, e sobrava a empresa: para
-- um cliente novo existir, alguém tinha de rodar `npm run admin`.
--
-- NADA nasce no envio do formulário. Um pedido de cadastro fica pendente, e a
-- empresa só existe quando alguém abre o link que chegou por e-mail. A razão é
-- concreta: `tenant.documento` é único, então criar no envio deixaria qualquer
-- um plantar o CNPJ de uma empresa de verdade e trancar a porta dela para
-- sempre — sem precisar receber e-mail nenhum, sem precisar de nada além de um
-- POST.
--
-- Uma resposta só, três desfechos. O formulário responde exatamente igual
-- sempre; quem conta o que aconteceu é o e-mail, que só chega a quem controla
-- o endereço digitado:
--
--   nova            → o link de confirmação
--   empresa_existe  → "essa empresa já usa o colheit.ai; peça acesso a quem administra"
--   email_existe    → "você já tem conta; entre, ou use 'esqueci minha senha'"
--
-- Dizer isso na tela entregaria, a quem for tentando um CNPJ de cada vez, a
-- lista de quem é cliente da plataforma.

-- De onde veio a empresa. Não muda comportamento nenhum — é o que a pessoa que
-- atender a ligação de "esse CNPJ não é dessa gente" vai querer olhar primeiro.
alter table tenant add column origem text not null default 'admin'
  check (origem in ('admin', 'autoatendimento'));

-- O bilhete de senha que sai do cadastro tem origem própria, para a auditoria
-- não confundir "nasceu agora" com "recuperou a senha".
alter table recuperacao_senha drop constraint recuperacao_senha_origem_check;
alter table recuperacao_senha add constraint recuperacao_senha_origem_check
  check (origem in ('esqueci', 'gestor', 'admin', 'cadastro'));

create table cadastro_pendente (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  documento     text not null check (documento ~ '^[0-9]{14}$'),
  -- Só quem opera a própria carteira se cadastra sozinho. Franqueadora,
  -- franqueado e indústria existem dentro de uma rede que alguém precisa ligar
  -- com `admin -- rede` ou `admin -- territorio` de qualquer jeito: são
  -- conversa, não formulário.
  tipo          text not null check (tipo in ('distribuidor', 'revenda')),
  gestor_nome   text not null,
  gestor_email  text not null,
  token_hash    text not null,
  expira_em     timestamptz not null,
  usado_em      timestamptz,
  criado_em     timestamptz not null default now()
);
create index on cadastro_pendente (gestor_email, criado_em desc);
create index on cadastro_pendente (token_hash);

comment on table cadastro_pendente is
  'Pedido de cadastro à espera do e-mail. Enquanto está aqui não existe empresa, '
  'não existe usuário e o CNPJ continua livre para quem for dono dele.';

revoke all on cadastro_pendente from public;

-- O freio de caixa de entrada, e ele precisa ser uma tabela à parte.
--
-- Contar pendências não serviria: dos três desfechos, só um cria pendência, e
-- os outros dois mandam e-mail do mesmo jeito. Quem escolhe o endereço é quem
-- preenche o formulário — então um freio que só conta pendência deixa qualquer
-- um despejar avisos de "essa empresa já tem conta" na caixa de outra pessoa,
-- sem limite. O que se mede aqui é o PEDIDO, tenha ele dado no que der.
create table cadastro_tentativa (
  email     text primary key,
  ultimo_em timestamptz not null default now()
);

revoke all on cadastro_tentativa from public;

-- ---------------------------------------------------------------------------
-- Abrir o pedido.
--
-- Acontece antes de existir contexto — antes de existir empresa —, então é
-- `security definer` como todo o 010. Devolve o desfecho para o correio
-- escolher o texto; a rota responde igual nos três.
-- ---------------------------------------------------------------------------
create or replace function app.abrir_cadastro(
  p_nome text, p_documento text, p_tipo text,
  p_gestor text, p_email text, p_hash text, p_horas int default 48)
  returns table (situacao text)
  language plpgsql security definer set search_path = public, app
  as $$
begin
  -- Um pedido por minuto por endereço, contado ANTES de saber o desfecho: os
  -- três mandam e-mail, e quem escolhe o endereço é quem preenche o formulário.
  -- Sem devolver nada, a tela responde a mesma frase e nenhuma mensagem sai.
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

  if exists (select 1 from tenant t where t.documento = p_documento) then
    return query select 'empresa_existe'::text;
    return;
  end if;

  -- Um pedido vivo por endereço, como todo bilhete desta base.
  update cadastro_pendente set usado_em = now()
    where lower(gestor_email) = lower(p_email) and usado_em is null;

  insert into cadastro_pendente
    (nome, documento, tipo, gestor_nome, gestor_email, token_hash, expira_em)
  values
    (p_nome, p_documento, p_tipo, p_gestor, lower(p_email), p_hash,
     now() + make_interval(hours => p_horas));

  return query select 'nova'::text;
end $$;

-- ---------------------------------------------------------------------------
-- Confirmar: a empresa, o primeiro gestor e o bilhete de senha, numa transação.
--
-- Empresa sem gestor é empresa que ninguém abre, e gestor sem senha por abrir é
-- gestor que não entra. Ou os três nascem, ou nenhum nasce — a mesma regra do
-- `npm run admin -- empresa`, que este caminho substitui.
--
-- As duas conferências são refeitas aqui, e não só na abertura: entre o pedido
-- e o clique podem passar 48 horas, e nesse intervalo o CNPJ pode ter sido
-- confirmado por outra pessoa.
-- ---------------------------------------------------------------------------
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

  if exists (select 1 from tenant t where t.documento = v_p.documento) then
    raise exception 'essa empresa já tem conta no colheit.ai';
  end if;
  if exists (select 1 from usuario u where lower(u.email) = v_p.gestor_email) then
    raise exception 'esse e-mail já tem conta no colheit.ai';
  end if;

  insert into tenant (nome, documento, tipo, origem)
    values (v_p.nome, v_p.documento, v_p.tipo, 'autoatendimento')
    returning id into v_t;

  -- Sem senha, como todo usuário desta base. O bilhete abaixo é que deixa a
  -- pessoa escolher a dela — nem este código nem ninguém chega a saber qual é.
  insert into usuario (tenant_id, nome, email, papel)
    values (v_t, v_p.gestor_nome, v_p.gestor_email, 'gestor')
    returning id into v_u;

  insert into recuperacao_senha (usuario_id, token_hash, origem, expira_em)
    values (v_u, p_senha_hash, 'cadastro', now() + interval '24 hours');

  update cadastro_pendente set usado_em = now() where id = v_p.id;

  return query select v_t, v_p.nome, v_p.gestor_nome;
end $$;

grant execute on function
  app.abrir_cadastro(text, text, text, text, text, text, int),
  app.confirmar_cadastro(text, text)
  to public;
