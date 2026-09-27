-- 010 · Autenticação
--
-- Duas identidades, de formatos diferentes:
--
--   usuario   → é de um tenant. E-mail e senha. Sessão curta.
--   produtor  → é global, com vários vínculos. Telefone e código, sessão longa.
--               Senha seria atrito na ponta de que a adoção inteira depende, e
--               o canal já existe: é o mesmo vínculo por código do WhatsApp.
--
-- O login acontece ANTES de existir tenant no contexto. Por isso nenhuma tabela
-- daqui tem política por tenant — o acesso é por função `security definer`, e o
-- papel de aplicação não recebe permissão direta em nenhuma delas.

alter table usuario add column senha_hash text;

comment on column usuario.senha_hash is
  'scrypt$N$r$p$salt$hash. Nulo enquanto o usuário não definiu senha — e nesse '
  'estado o login falha igual a senha errada, para não revelar quem existe.';

-- ---------------------------------------------------------------------------
-- O acesso do produtor. O telefone é a identidade porque é por ele que o
-- convite chega e por ele que o campo manda foto e áudio.
-- ---------------------------------------------------------------------------
create table produtor_acesso (
  produtor_id  uuid primary key references produtor(id) on delete cascade,
  telefone     text not null unique check (telefone ~ '^[0-9]{10,15}$'),
  ativado_em   timestamptz,
  criado_em    timestamptz not null default now()
);

comment on table produtor_acesso is
  'Telefone só com dígitos, incluindo DDI. ativado_em marca a primeira entrada — '
  'é a métrica de H2, que mede convite virando acesso.';

create table codigo_acesso (
  id          uuid primary key default gen_random_uuid(),
  telefone    text not null,
  codigo_hash text not null,
  expira_em   timestamptz not null,
  usado_em    timestamptz,
  tentativas  smallint not null default 0,
  criado_em   timestamptz not null default now()
);
create index on codigo_acesso (telefone, criado_em desc);

comment on table codigo_acesso is
  'O código nunca é guardado em claro. Guardar seria o mesmo que guardar senha '
  'em claro, com o agravante de ele chegar por um canal que não controlamos.';

create table tentativa_login (
  chave         text primary key,
  falhas        smallint not null default 0,
  bloqueado_ate timestamptz
);

comment on table tentativa_login is
  'Freio de força bruta, por e-mail ou telefone. Sem isto, senha de seis '
  'caracteres e código de seis dígitos caem em minutos.';

-- ---------------------------------------------------------------------------
-- Nada aqui é acessível direto pela aplicação.
-- ---------------------------------------------------------------------------
revoke all on produtor_acesso, codigo_acesso, tentativa_login from public;

-- ---------------------------------------------------------------------------
-- Freio compartilhado pelos dois fluxos de login.
-- ---------------------------------------------------------------------------
create or replace function app.login_bloqueado(p_chave text) returns boolean
  language sql security definer set search_path = public, app
  as $$ select exists (select 1 from tentativa_login
                        where chave = p_chave and bloqueado_ate > now()) $$;

create or replace function app.login_falhou(p_chave text) returns void
  language plpgsql security definer set search_path = public, app
  as $$
declare v_falhas smallint;
begin
  insert into tentativa_login (chave, falhas) values (p_chave, 1)
    on conflict (chave) do update set falhas = tentativa_login.falhas + 1
    returning falhas into v_falhas;
  -- Cresce o castigo: a quinta falha bloqueia por 15 min, a décima por uma hora.
  if v_falhas >= 10 then
    update tentativa_login set bloqueado_ate = now() + interval '1 hour' where chave = p_chave;
  elsif v_falhas >= 5 then
    update tentativa_login set bloqueado_ate = now() + interval '15 minutes' where chave = p_chave;
  end if;
end $$;

create or replace function app.login_ok(p_chave text) returns void
  language sql security definer set search_path = public, app
  as $$ delete from tentativa_login where chave = p_chave $$;

-- ---------------------------------------------------------------------------
-- Credencial do usuário. Devolve o hash para o Node conferir — a comparação
-- acontece fora do banco, onde está a biblioteca de derivação.
-- ---------------------------------------------------------------------------
create or replace function app.credencial_usuario(p_email text)
  returns table (id uuid, tenant_id uuid, nome text, papel text, senha_hash text)
  language sql security definer set search_path = public, app
  as $$
    select u.id, u.tenant_id, u.nome, u.papel, u.senha_hash
      from usuario u
      join tenant t on t.id = u.tenant_id
     where lower(u.email) = lower(p_email) and u.ativo and t.ativo
  $$;

create or replace function app.definir_senha(p_usuario uuid, p_hash text) returns void
  language sql security definer set search_path = public, app
  as $$ update usuario set senha_hash = p_hash where id = p_usuario $$;

-- ---------------------------------------------------------------------------
-- Código do produtor.
-- ---------------------------------------------------------------------------
create or replace function app.criar_codigo(p_telefone text, p_hash text, p_minutos int default 10)
  returns uuid
  language plpgsql security definer set search_path = public, app
  as $$
declare v_id uuid;
begin
  -- Um código vivo por telefone: pedir outro invalida o anterior.
  update codigo_acesso set usado_em = now()
    where telefone = p_telefone and usado_em is null;
  insert into codigo_acesso (telefone, codigo_hash, expira_em)
    values (p_telefone, p_hash, now() + make_interval(mins => p_minutos))
    returning id into v_id;
  return v_id;
end $$;

/**
 * Confere o código e, dando certo, devolve o produtor. O hash é calculado no
 * Node e chega pronto; aqui só se compara e se marca como usado.
 */
create or replace function app.consumir_codigo(p_telefone text, p_hash text)
  returns uuid
  language plpgsql security definer set search_path = public, app
  as $$
declare
  v_cod codigo_acesso%rowtype;
  v_produtor uuid;
begin
  select * into v_cod from codigo_acesso
    where telefone = p_telefone and usado_em is null and expira_em > now()
    order by criado_em desc limit 1;

  if not found then return null; end if;

  update codigo_acesso set tentativas = tentativas + 1 where id = v_cod.id;
  if v_cod.tentativas >= 4 then
    update codigo_acesso set usado_em = now() where id = v_cod.id;
    return null;
  end if;
  if v_cod.codigo_hash <> p_hash then return null; end if;

  update codigo_acesso set usado_em = now() where id = v_cod.id;

  select a.produtor_id into v_produtor from produtor_acesso a where a.telefone = p_telefone;
  if v_produtor is null then return null; end if;

  update produtor_acesso set ativado_em = coalesce(ativado_em, now())
    where produtor_id = v_produtor;
  return v_produtor;
end $$;

create or replace function app.convidar_produtor(p_produtor uuid, p_telefone text)
  returns void
  language plpgsql security definer set search_path = public, app
  as $$
begin
  if not exists (select 1 from produtor_vinculo v
                  where v.produtor_id = p_produtor and v.tenant_id = app.tenant_atual()) then
    raise exception 'produtor não tem vínculo com este tenant';
  end if;
  insert into produtor_acesso (produtor_id, telefone) values (p_produtor, p_telefone)
    on conflict (produtor_id) do update set telefone = excluded.telefone;
end $$;

comment on function app.convidar_produtor(uuid, text) is
  'O convite sai de quem tem vínculo — na prática, no momento do contrato. É o '
  'gancho que a H2 mede.';

grant execute on function
  app.login_bloqueado(text), app.login_falhou(text), app.login_ok(text),
  app.credencial_usuario(text), app.definir_senha(uuid, text),
  app.criar_codigo(text, text, int), app.consumir_codigo(text, text),
  app.convidar_produtor(uuid, text)
  to public;
