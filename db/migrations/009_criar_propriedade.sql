-- 009 · Criar propriedade sem cair no próprio isolamento
--
-- Achado ao construir o módulo cadastro. A política de `propriedade` só tem
-- `using`, e nesse caso o PostgreSQL usa a mesma expressão como `with check`
-- no INSERT. Mas a visibilidade da propriedade vem de `produtor_propriedade`,
-- que ainda não existe no instante do insert — a linha nasce invisível para
-- quem a está criando, e o insert é recusado.
--
-- A saída não é afrouxar a política: é reconhecer que **propriedade sem
-- operador não significa nada**. As duas linhas nascem juntas, numa função
-- `security definer` que faz as duas de uma vez.

create or replace function app.criar_propriedade(
  p_nome        text,
  p_produtor    uuid,
  p_papel       text default 'proprietario',
  p_municipio   text default null,
  p_uf          char(2) default null,
  p_car         text default null,
  p_area_ha     numeric default null,
  p_inicio      date default null
) returns uuid
  language plpgsql
  security definer
  set search_path = public, app
  as $$
declare
  v_tenant uuid := app.tenant_atual();
  v_id     uuid;
begin
  if v_tenant is null then
    raise exception 'sem tenant no contexto';
  end if;

  -- O produtor precisa ser do tenant que está criando. Sem esta checagem a
  -- função seria uma porta lateral para pendurar terra em produtor alheio.
  if not exists (select 1 from produtor_vinculo v
                  where v.produtor_id = p_produtor and v.tenant_id = v_tenant) then
    raise exception 'produtor não tem vínculo com este tenant';
  end if;

  insert into propriedade (nome, municipio, uf, car, area_ha)
    values (p_nome, p_municipio, p_uf, p_car, p_area_ha)
    returning id into v_id;

  insert into produtor_propriedade (produtor_id, propriedade_id, papel, inicio)
    values (p_produtor, v_id, p_papel, coalesce(p_inicio, current_date));

  return v_id;
end $$;

comment on function app.criar_propriedade(text, uuid, text, text, char, text, numeric, date) is
  'Cria a propriedade e a relação com quem a opera na mesma transação. '
  'Propriedade sem operador não existe no modelo — quem opera é o que a torna visível.';

grant execute on function app.criar_propriedade(text, uuid, text, text, char, text, numeric, date) to public;
