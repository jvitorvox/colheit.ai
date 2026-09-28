-- 030 · O franqueado alcança de quem é a terra
--
-- Ele já enxerga, pelos pedidos que carimbam o território dele: o produtor
-- (`produtor_pelo_pedido`), a propriedade (`propriedade_pelo_pedido`) e o
-- talhão (`talhao_pelo_pedido`). Faltava a linha que liga o produtor à
-- propriedade — e sem ela o painel dele mostrava "Melhor: Gleba 1" e
-- "Pior: Gleba 1", que é o nome de talhão mais comum do país.
--
-- Não abre nada novo: o próprio pedido que ele lê já traz `produtor_id` e
-- `propriedade_id` na mesma linha, então a ligação sempre esteve ao alcance
-- dele. A política só evita que o sistema o obrigue a deduzir o que já sabe.

create policy relacao_pelo_pedido on produtor_propriedade
  using (exists (select 1 from pedido pd
                  where pd.propriedade_id = produtor_propriedade.propriedade_id
                    and pd.produtor_id = produtor_propriedade.produtor_id
                    and pd.franqueado_id = app.tenant_atual()))
  with check (false);

comment on policy relacao_pelo_pedido on produtor_propriedade is
  'Visibilidade descendente, e só de leitura — como todas as do franqueado. O '
  'par (produtor, propriedade) precisa bater com o do pedido: ele alcança o '
  'vínculo que ELE originou, não o histórico de posse daquela terra.';
