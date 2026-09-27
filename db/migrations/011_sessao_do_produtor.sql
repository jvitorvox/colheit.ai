-- 011 · A sessão do produtor
--
-- O produtor não tem tenant: ele é global e tem vários vínculos. A porta única
-- é exatamente isso — um acesso, e ele vê o que é dele em todas as revendas.
--
-- Então ele precisa de um segundo eixo de contexto, ao lado do tenant. As
-- políticas abaixo são PERMISSIVAS e se somam às que já existem: quando há
-- tenant no contexto, app.produtor_atual() é nulo e estas não casam; quando há
-- produtor, app.tenant_atual() é nulo e as outras não casam. Nunca os dois.

create or replace function app.produtor_atual() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.produtor_id', true), '')::uuid $$;

comment on function app.produtor_atual() is
  'O produtor da sessão do portal. Nulo em toda sessão de tenant — e é por isso '
  'que os dois eixos não se misturam.';

-- Ele mesmo, e os documentos dele.
create policy produtor_ele_mesmo on produtor
  using (id = app.produtor_atual());

create policy documento_dele on produtor_documento
  using (produtor_id = app.produtor_atual());

-- Com quem ele compra. É a porta única: todas as revendas, num acesso só.
create policy vinculo_dele on produtor_vinculo
  using (produtor_id = app.produtor_atual());

-- A terra dele e os talhões dela.
create policy propriedade_dele on propriedade
  using (exists (select 1 from produtor_propriedade pp
                  where pp.propriedade_id = propriedade.id
                    and pp.produtor_id = app.produtor_atual()));

create policy relacao_dele on produtor_propriedade
  using (produtor_id = app.produtor_atual());

create policy talhao_dele on talhao
  using (exists (select 1 from produtor_propriedade pp
                  where pp.propriedade_id = talhao.propriedade_id
                    and pp.produtor_id = app.produtor_atual()));

-- Nenhuma destas tem `with check`: a sessão do produtor é de LEITURA no núcleo
-- de cadastro. O que ele manda do campo entra por outro caminho, e passa pela
-- validação do consultor antes de virar dado — a regra do módulo de captura.
