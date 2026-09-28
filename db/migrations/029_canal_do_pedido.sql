-- 029 · O canal fica carimbado no pedido
--
-- `canal` já era escolhido na criação do pedido, mas só para achar o preço — e
-- então se perdia. Quem vende sabe de cabeça se foi direto ou pela
-- distribuidora; o FRANQUEADO não sabe de jeito nenhum.
--
-- Ele enxerga a venda que desceu do território dele e não a operou. Quanto do
-- território dele passou por terceiro é exatamente a pergunta que ele não
-- consegue responder por fora do sistema — e a resposta estava sendo jogada
-- fora a cada pedido.
--
-- Mesmo tratamento de `franqueado_id` e `municipio`: carimbo da criação, nunca
-- recalculado. Mudar a tabela de preço depois não pode reescrever por onde a
-- venda passou.

alter table pedido add column canal text not null default 'direto'
  check (canal in ('direto', 'distribuidor'));

comment on column pedido.canal is
  'Por onde a venda passou, carimbado na criação. Os pedidos anteriores a esta '
  'migração ficam como `direto`: é o padrão que a criação já usava quando o '
  'campo não vinha, então o default não inventa história nova.';

create index on pedido (safra, canal);
