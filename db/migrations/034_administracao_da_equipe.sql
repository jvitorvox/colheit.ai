-- 034 · A equipe se administra pela tela
--
-- Até aqui usuário se criava com `insert` direto no banco. Todo seed e todo
-- teste desta base fez isso, e passou despercebido porque o caminho do dado
-- sempre existiu — mas ninguém sobe um cliente sem um DBA ao lado.
--
-- E "só gestor" vivia só no JavaScript (`definirSenha` checava `ctx.papel`).
-- Regra de autorização que mora só na rota é regra que a próxima rota esquece.

create or replace function app.e_gestor() returns boolean
  language sql
  stable
  -- SECURITY DEFINER é obrigatório aqui, não conveniência: esta função é usada
  -- na política de `usuario` e lê `usuario`. Sem ela bypassar a política, a
  -- política chamaria a si mesma e o Postgres recusaria por recursão.
  security definer
  set search_path = public, app
  as $$
    select exists (select 1 from usuario
                    where id = app.usuario_atual() and papel = 'gestor' and ativo)
  $$;

comment on function app.e_gestor() is
  'Responde sobre a sessão atual, nunca sobre um terceiro — não há parâmetro. '
  'É o que permite ser security definer sem abrir nada.';

grant execute on function app.e_gestor() to public;

-- Ler continua sendo de todo mundo do tenant; escrever passa a ser do gestor.
alter policy tenant_isolamento on usuario
  with check (tenant_id = app.tenant_atual() and app.e_gestor());

comment on policy tenant_isolamento on usuario is
  'O consultor lê a equipe — precisa, para saber a quem endereçar. Criar, '
  'desativar e mudar papel é do gestor, e quem recusa é o banco.';

-- ---------------------------------------------------------------------------
-- A carteira também: tirar produtor de consultor é ato de gestor.
--
-- `app.autorizar_consultor` já existia e é `security definer`, então a política
-- não a alcança — a checagem vai dentro dela.
-- ---------------------------------------------------------------------------
create or replace function app.autorizar_consultor(p_usuario uuid, p_vinculo uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
  as $$
begin
  if not app.e_gestor() then
    raise exception 'só gestor mexe na carteira';
  end if;
  if not exists (select 1 from usuario u join produtor_vinculo v on v.id = p_vinculo
                  where u.id = p_usuario and u.tenant_id = v.tenant_id
                    and v.tenant_id = app.tenant_atual()) then
    raise exception 'usuário e produtor não são da mesma empresa';
  end if;
  insert into consultor_carteira (usuario_id, vinculo_id)
    values (p_usuario, p_vinculo) on conflict do nothing;
end $$;

create or replace function app.desautorizar_consultor(p_usuario uuid, p_vinculo uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
  as $$
begin
  if not app.e_gestor() then
    raise exception 'só gestor mexe na carteira';
  end if;
  delete from consultor_carteira c
   using produtor_vinculo v
   where c.vinculo_id = v.id and c.usuario_id = p_usuario
     and c.vinculo_id = p_vinculo and v.tenant_id = app.tenant_atual();
end $$;

grant execute on function app.desautorizar_consultor(uuid, uuid) to public;

comment on function app.desautorizar_consultor(uuid, uuid) is
  'Tirar da carteira não apaga visita nem pedido: o histórico do que aquele '
  'consultor fez continua onde está. O que muda é quem enxerga a partir de agora.';
