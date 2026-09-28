-- 026 · A foto do talhão
--
-- O consultor fotografa o que está vendo. É a única coisa do registro de visita
-- que o texto não substitui: "estande irregular na bordadura" e a foto da
-- bordadura irregular não são o mesmo dado, e é a foto que o agrônomo da
-- revenda consegue julgar sem ter ido.
--
-- Uma visita tem mais de uma foto — a bordadura, o meio do talhão, a praga de
-- perto —, então é tabela de ligação e não coluna.

create table visita_midia (
  visita_id uuid not null references visita(id) on delete cascade,
  midia_id  uuid not null references midia(id)  on delete cascade,
  ordem     smallint not null default 0,
  primary key (visita_id, midia_id)
);

comment on table visita_midia is
  'A chave primária é o par: reenviar a mesma visita com a mesma foto não '
  'duplica o vínculo, do mesmo jeito que visita.cliente_id não duplica a visita.';

create index on visita_midia (midia_id);

-- Ler a foto segue a visita, como o item segue o pedido. E a subconsulta passa
-- pela política de `visita`: o produtor enxerga as fotos das visitas à lavoura
-- dele, a empresa as do tenant dela, e ninguém mais.
create or replace function app.visita_visivel(p_visita uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from visita where id = p_visita) $$;

create or replace function app.visita_minha(p_visita uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from visita
                        where id = p_visita and tenant_id = app.tenant_atual()) $$;

alter table visita_midia enable row level security;

-- Escrever é só de quem é dono da visita. O produtor vê a foto da lavoura dele
-- e não pendura foto nenhuma — o registro de campo é de quem foi ao campo.
create policy foto_pela_visita on visita_midia
  using (app.visita_visivel(visita_id))
  with check (app.visita_minha(visita_id));
