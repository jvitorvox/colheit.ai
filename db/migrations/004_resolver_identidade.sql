-- 004 · Resolver identidade e fundir duplicatas
--
-- Estas funções são `security definer`: rodam com os poderes do dono e
-- portanto enxergam além do tenant. É proposital e é o único jeito de a
-- Revenda B reconhecer um produtor que já existe sob a Revenda A — sem
-- nunca revelar que ele existia.

-- ---------------------------------------------------------------------------
-- Cadastra ou reconhece. Devolve o id do produtor, já com vínculo criado
-- para o tenant do contexto.
--
-- Documentos em jsonb: '[{"tipo":"cpf","valor":"12345678901"}]' — ou '[]',
-- porque o consultor cadastra em campo sem documento em mãos.
-- ---------------------------------------------------------------------------
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
  v_tenant    uuid := app.tenant_atual();
  v_produtor  uuid;
  v_doc       jsonb;
begin
  if v_tenant is null then
    raise exception 'sem tenant no contexto';
  end if;

  -- Já conhecemos algum destes documentos? Segue o ponteiro de fusão.
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

  -- Documentos novos passam a apontar para ele. Conflito é silencioso:
  -- o documento já pertence a alguém, e quem manda é o dono existente.
  insert into produtor_documento (produtor_id, tipo, valor)
    select v_produtor, d->>'tipo', d->>'valor'
      from jsonb_array_elements(p_documentos) d
    on conflict (tipo, valor) do nothing;

  insert into produtor_vinculo (tenant_id, produtor_id)
    values (v_tenant, v_produtor)
    on conflict (tenant_id, produtor_id) do nothing;

  return v_produtor;
end $$;

comment on function app.vincular_produtor(text, jsonb, text) is
  'Porta única: mesmo CPF entrando por outra revenda devolve o MESMO produtor. '
  'A revenda que chega depois só ganha um vínculo — nunca descobre que o '
  'registro já existia, nem enxerga nada da outra.';

-- ---------------------------------------------------------------------------
-- Fusão. Ninguém é apagado: o perdedor aponta para o vencedor e o histórico
-- continua alcançável pelo ponteiro.
-- ---------------------------------------------------------------------------
create or replace function app.fundir_produtor(p_perdedor uuid, p_vencedor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, app
  as $$
begin
  if p_perdedor = p_vencedor then
    raise exception 'perdedor e vencedor são o mesmo produtor';
  end if;
  if exists (select 1 from produtor where id = p_perdedor and fundido_em is not null) then
    raise exception 'produtor % já foi fundido', p_perdedor;
  end if;

  update produtor_documento set produtor_id = p_vencedor
    where produtor_id = p_perdedor
      and not exists (select 1 from produtor_documento d2
                       where d2.produtor_id = p_vencedor
                         and d2.tipo = produtor_documento.tipo
                         and d2.valor = produtor_documento.valor);

  -- Vínculo que colidiria (as duas pontas na mesma revenda) é descartado:
  -- o do vencedor já cobre aquela relação.
  update produtor_vinculo set produtor_id = p_vencedor
    where produtor_id = p_perdedor
      and not exists (select 1 from produtor_vinculo v2
                       where v2.produtor_id = p_vencedor
                         and v2.tenant_id = produtor_vinculo.tenant_id);
  delete from produtor_vinculo where produtor_id = p_perdedor;

  update produtor set fundido_em = p_vencedor where id = p_perdedor;
end $$;

comment on function app.fundir_produtor(uuid, uuid) is
  'Regra combinada: vence quem tem documento; empatando, o mais antigo. '
  'A escolha de quem vence é de quem chama — aqui só executa.';

grant execute on function app.vincular_produtor(text, jsonb, text) to public;
grant execute on function app.fundir_produtor(uuid, uuid) to public;
