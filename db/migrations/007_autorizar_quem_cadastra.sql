-- 007 · Quem cadastra em campo já sai autorizado
--
-- Sem isto o consultor cria o produtor e some com ele: o vínculo existe, mas
-- a carteira não, e a política de 006 o esconde do próprio autor.

create or replace function app.vincular_produtor(
  p_nome        text,
  p_documentos  jsonb default '[]'::jsonb,
  p_origem      text  default 'consultor'
) returns uuid
  language plpgsql
  security definer
  set search_path = public, app
  as $$
declare
  v_tenant   uuid := app.tenant_atual();
  v_usuario  uuid := app.usuario_atual();
  v_produtor uuid;
  v_vinculo  uuid;
  v_doc      jsonb;
begin
  if v_tenant is null then
    raise exception 'sem tenant no contexto';
  end if;

  for v_doc in select * from jsonb_array_elements(p_documentos) loop
    select coalesce(p.fundido_em, p.id) into v_produtor
      from produtor_documento d
      join produtor p on p.id = d.produtor_id
     where d.tipo = v_doc->>'tipo' and d.valor = v_doc->>'valor'
     limit 1;
    exit when v_produtor is not null;
  end loop;

  if v_produtor is null then
    insert into produtor (nome, origem) values (p_nome, p_origem)
      returning id into v_produtor;
  end if;

  insert into produtor_documento (produtor_id, tipo, valor)
    select v_produtor, d->>'tipo', d->>'valor'
      from jsonb_array_elements(p_documentos) d
    on conflict (tipo, valor) do nothing;

  insert into produtor_vinculo (tenant_id, produtor_id)
    values (v_tenant, v_produtor)
    on conflict (tenant_id, produtor_id) do update set tenant_id = excluded.tenant_id
    returning id into v_vinculo;

  -- Consultor que cadastra entra na própria carteira. Gestor não precisa.
  if v_usuario is not null
     and exists (select 1 from usuario where id = v_usuario and papel = 'consultor') then
    insert into consultor_carteira (usuario_id, vinculo_id)
      values (v_usuario, v_vinculo)
      on conflict do nothing;
  end if;

  return v_produtor;
end $$;

-- Concede e revoga carteira. É o "autoriza a atuação" do CRM.
create or replace function app.autorizar_consultor(p_usuario uuid, p_vinculo uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
  as $$
begin
  if not exists (select 1 from usuario u join produtor_vinculo v on v.id = p_vinculo
                  where u.id = p_usuario and u.tenant_id = v.tenant_id
                    and v.tenant_id = app.tenant_atual()) then
    raise exception 'usuário e produtor não são da mesma empresa';
  end if;
  insert into consultor_carteira (usuario_id, vinculo_id)
    values (p_usuario, p_vinculo) on conflict do nothing;
end $$;

grant execute on function app.autorizar_consultor(uuid, uuid) to public;
