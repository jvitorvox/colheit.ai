-- 015 · O franqueado enxerga quem comprou o produto dele
--
-- Achado ao testar a visibilidade descendente. O pedido já aparecia para o
-- franqueado pelo carimbo de território, mas o `join` com produtor o descartava:
-- ele não tem vínculo COMERCIAL com aquele produtor — quem vendeu foi a
-- distribuidora. Na prática ele via um pedido sem dono.
--
-- A regra que desenhamos diz o contrário: ele enxerga o que desce da venda
-- dele, e o produtor final é justamente o que ele nunca teve. A visibilidade
-- é DERIVADA da transação — não é vínculo comercial concedido, e por isso não
-- lhe dá nada além do que aparece nos pedidos que são dele.

create policy produtor_pelo_pedido on produtor
  using (exists (select 1 from pedido pd
                  where pd.produtor_id = produtor.id
                    and pd.franqueado_id = app.tenant_atual()))
  with check (false);

comment on policy produtor_pelo_pedido on produtor is
  'Visibilidade descendente: o franqueado alcança o produtor pelos pedidos que '
  'carimbam o território dele. Só leitura, e só quem aparece nesses pedidos — '
  'a carteira da distribuidora continua sendo dela.';

-- O município da venda já vai carimbado no próprio pedido, então o franqueado
-- não precisa enxergar a propriedade para saber onde a semente foi parar. É
-- mais uma razão pela qual o carimbo ficou no pedido, e não numa consulta.
