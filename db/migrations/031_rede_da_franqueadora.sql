-- 031 · A rede da franqueadora
--
-- `franqueadora` existia só como valor do enum de tipo desde a 012. A
-- visibilidade dela nunca foi construída — e ela é o topo da cadeia: vê todos
-- os franqueados dela e tudo que desce deles.
--
-- A regra que o desenho fixa, e que esta migração precisa garantir:
--
--   uma franqueadora NÃO pode saber das transações de outra.
--
-- Por isso cada política daqui pendura no pedido, que já carrega o carimbo do
-- franqueado. O alcance dela é "pedido cujo franqueado é meu" — nunca "tudo que
-- aconteceu no município", que pegaria a venda da concorrente no mesmo lugar.

create table rede (
  franqueado_id   uuid primary key references tenant(id) on delete cascade,
  franqueadora_id uuid not null references tenant(id) on delete cascade,
  desde           date not null default current_date
);

comment on table rede is
  'Chave primária no FRANQUEADO: a exclusividade da franquia é a própria '
  'restrição de unicidade. Um franqueado servindo duas franqueadoras é estado '
  'que o banco não permite existir — como território com dois donos na 012.';

create index on rede (franqueadora_id);

-- Leitura aberta, como `territorio`, e pelo mesmo motivo: a forma da rede não é
-- segredo — uma loja franqueada exibe a marca na fachada. O que é confidencial
-- são as TRANSAÇÕES, e essas seguem fechadas pelas políticas abaixo.
grant select on rede to public;

create or replace function app.franqueado_e_meu(p_franqueado uuid) returns boolean
  language sql
  stable
  as $$
    select exists (select 1 from rede
                    where franqueado_id = p_franqueado
                      and franqueadora_id = app.tenant_atual())
  $$;

-- ---------------------------------------------------------------------------
-- A cadeia, descendo. Tudo de leitura: ela não opera venda nenhuma, do mesmo
-- jeito que o franqueado não opera a venda da distribuidora.
-- ---------------------------------------------------------------------------

create policy pedido_da_franqueadora on pedido
  using (app.franqueado_e_meu(franqueado_id))
  with check (false);

create policy produtor_pela_rede on produtor
  using (exists (select 1 from pedido pd
                  where pd.produtor_id = produtor.id
                    and app.franqueado_e_meu(pd.franqueado_id)))
  with check (false);

create policy propriedade_pela_rede on propriedade
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = propriedade.id
                    and app.franqueado_e_meu(pd.franqueado_id)))
  with check (false);

create policy talhao_pela_rede on talhao
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = talhao.propriedade_id
                    and app.franqueado_e_meu(pd.franqueado_id)))
  with check (false);

create policy relacao_pela_rede on produtor_propriedade
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = produtor_propriedade.propriedade_id
                    and pd.produtor_id = produtor_propriedade.produtor_id
                    and app.franqueado_e_meu(pd.franqueado_id)))
  with check (false);

-- Ela precisa do NOME do franqueado para o painel dela dizer algo além de uuid.
-- Só o dela, e só ler.
create policy tenant_da_minha_rede on tenant
  using (app.franqueado_e_meu(id))
  with check (false);

-- `pedido_item`, `nota` e `pedido_etapa` já seguem `app.pedido_visivel`, e
-- `plantio`/`colheita` já seguem `app.talhao_visivel`: as duas passam a valer
-- para ela sem uma linha a mais, porque foram escritas em cima do que o
-- chamador enxerga, e não de um tenant fixo.
