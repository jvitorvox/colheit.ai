-- 035 · Recuperação de senha
--
-- Quem esquece a senha hoje depende de outra pessoa: o consultor pede ao
-- gestor, e o gestor — se for o único — depende de alguém abrir o psql. Era o
-- último buraco do mesmo tipo que a aba Equipe fechou.
--
-- O produtor não entra aqui: ele nunca teve senha. Telefone e código pelo
-- WhatsApp já são o caminho de volta dele, e é por isso que aquela porta se
-- recupera sozinha desde o começo.
--
-- UMA peça, TRÊS portas. O que muda entre elas é quem prova a identidade:
--
--   esqueci  → a caixa de e-mail prova. O e-mail é a chave de acesso, então
--              controlar a caixa é exatamente a prova que se precisa.
--   gestor   → o gestor prova, entregando o link em mãos (ou pelo WhatsApp).
--              É a porta que funciona sem infraestrutura nenhuma.
--   admin    → a linha de comando, com o papel dono. O fundo da escada, para o
--              gestor que esqueceu e não tem outro gestor.
--
-- Nenhuma delas faz alguém além do dono da conta conhecer a senha: o que
-- circula é um bilhete de uma viagem só, que serve para ESCOLHER uma senha e
-- morre no uso.

create table recuperacao_senha (
  id          uuid primary key default gen_random_uuid(),
  usuario_id  uuid not null references usuario(id) on delete cascade,
  token_hash  text not null,
  origem      text not null check (origem in ('esqueci', 'gestor', 'admin')),
  expira_em   timestamptz not null,
  usado_em    timestamptz,
  criado_em   timestamptz not null default now()
);
create index on recuperacao_senha (usuario_id, criado_em desc);
create index on recuperacao_senha (token_hash);

comment on table recuperacao_senha is
  'O token nunca é guardado em claro — ele vale uma senha enquanto vive, e '
  'viaja por canal que não controlamos. Guardar o hash é a mesma decisão de '
  'codigo_acesso, pelo mesmo motivo.';

comment on column recuperacao_senha.origem is
  'Por qual das três portas o bilhete saiu. Serve para auditoria: um pedido '
  'de esqueci que ninguém fez é sinal de que alguém sabe o e-mail.';

-- Tabela de autenticação, como as do 010: a aplicação não toca nela direto.
revoke all on recuperacao_senha from public;

-- ---------------------------------------------------------------------------
-- Porta 1 — esqueci minha senha.
--
-- Acontece ANTES de existir contexto, e por isso é `security definer` como o
-- resto do 010. Devolve nome e e-mail para o correio ter a quem endereçar;
-- quando o e-mail não existe, devolve nada — e a rota responde igual dos dois
-- jeitos, senão o formulário viraria uma lista de quem tem conta.
-- ---------------------------------------------------------------------------
create or replace function app.abrir_recuperacao(
  p_email text, p_hash text, p_minutos int default 30)
  returns table (usuario_id uuid, nome text, email text)
  language plpgsql security definer set search_path = public, app
  as $$
declare v_u record;
begin
  select u.id, u.nome, u.email into v_u
    from usuario u join tenant t on t.id = u.tenant_id
   where lower(u.email) = lower(p_email) and u.ativo and t.ativo;
  if not found then return; end if;

  -- Freio de caixa de entrada. NÃO usa o freio de login: se um pedido de
  -- recuperação contasse como falha, qualquer um trancaria a conta alheia
  -- só apertando o botão — a recuperação viraria a negação do serviço.
  if exists (select 1 from recuperacao_senha r
              where r.usuario_id = v_u.id and r.criado_em > now() - interval '1 minute') then
    return;
  end if;

  -- Um bilhete vivo por pessoa: pedir outro mata o anterior, como em
  -- app.criar_codigo. Dois links válidos na caixa é um a mais do que se precisa.
  update recuperacao_senha set usado_em = now()
    where recuperacao_senha.usuario_id = v_u.id and usado_em is null;

  insert into recuperacao_senha (usuario_id, token_hash, origem, expira_em)
    values (v_u.id, p_hash, 'esqueci', now() + make_interval(mins => p_minutos));

  return query select v_u.id, v_u.nome, v_u.email;
end $$;

-- ---------------------------------------------------------------------------
-- Porta 2 — o gestor abre para alguém da equipe.
--
-- Substitui o gestor digitar uma senha e falar ela pelo WhatsApp. A regra de
-- quem pode é a mesma de app.autorizar_consultor, e mora aqui dentro: a função
-- é `security definer` e a política de `usuario` não a alcança.
--
-- O prazo é longo de propósito. Este bilhete é entregue fora do sistema, para
-- alguém que talvez esteja em lavoura sem sinal; trinta minutos seria um link
-- que morre antes de ser aberto. Ele continua sendo de uma viagem só, e
-- continua morrendo assim que outro é aberto.
-- ---------------------------------------------------------------------------
create or replace function app.abrir_recuperacao_pelo_gestor(
  p_usuario uuid, p_hash text, p_horas int default 24)
  returns void
  language plpgsql security definer set search_path = public, app
  as $$
begin
  if not app.e_gestor() then
    raise exception 'só gestor abre acesso para alguém da equipe';
  end if;
  if not exists (select 1 from usuario u
                  where u.id = p_usuario and u.tenant_id = app.tenant_atual() and u.ativo) then
    raise exception 'usuário não é desta empresa, ou está inativo';
  end if;

  update recuperacao_senha set usado_em = now()
    where usuario_id = p_usuario and usado_em is null;
  insert into recuperacao_senha (usuario_id, token_hash, origem, expira_em)
    values (p_usuario, p_hash, 'gestor', now() + make_interval(hours => p_horas));
end $$;

-- ---------------------------------------------------------------------------
-- O resgate, comum às três portas.
--
-- Trocar a senha destranca o login: quem esqueceu a senha errou cinco vezes
-- antes de lembrar que existe "esqueci", e sem esta linha ele acabaria de
-- escolher uma senha nova para continuar bloqueado por quinze minutos.
-- ---------------------------------------------------------------------------
create or replace function app.consumir_recuperacao(p_hash text, p_senha_hash text)
  returns uuid
  language plpgsql security definer set search_path = public, app
  as $$
declare v_id uuid;
begin
  select r.usuario_id into v_id
    from recuperacao_senha r
    join usuario u on u.id = r.usuario_id
    join tenant t on t.id = u.tenant_id
   where r.token_hash = p_hash and r.usado_em is null and r.expira_em > now()
     and u.ativo and t.ativo;
  if v_id is null then return null; end if;

  update usuario set senha_hash = p_senha_hash where id = v_id;
  -- Todos, não só o usado: se havia outro bilhete solto, ele deixa de valer no
  -- instante em que a senha muda.
  update recuperacao_senha set usado_em = now()
    where usuario_id = v_id and usado_em is null;
  delete from tentativa_login
    where chave = (select lower(email) from usuario where id = v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- app.definir_senha sai do alcance da aplicação.
--
-- Ela punha a senha de outra pessoa nas mãos do gestor, e senha que duas
-- pessoas conhecem não é senha: quem reaproveita a mesma em outro sistema
-- passa a ter esse sistema conhecido também. O dono continua podendo chamá-la,
-- porque é dele que a linha de comando precisa.
-- ---------------------------------------------------------------------------
revoke execute on function app.definir_senha(uuid, text) from public;

grant execute on function
  app.abrir_recuperacao(text, text, int),
  app.abrir_recuperacao_pelo_gestor(uuid, text, int),
  app.consumir_recuperacao(text, text)
  to public;
