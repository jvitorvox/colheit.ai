-- 028 · Dia Zero: o preparo do produtor
--
-- Entre saber que a carga saiu e ela chegar existe uma janela de dias em que o
-- produtor está mais ligado no aplicativo do que em qualquer outro momento do
-- ano — é quando ele acerta máquina, equipe e regulagem. A estratégia diz que o
-- agricultor é o centro; esta é a hora em que isso deixa de ser frase.
--
-- A lista é DELE. A revenda não lê.
--
-- Não é zelo abstrato: "ainda não tenho gente para descarregar" é problema de
-- quem vai receber, e saber disso mudaria a conversa comercial. Se um dia a
-- revenda precisar enxergar o preparo, que seja decisão tomada e dita a ele —
-- não um efeito colateral de onde a tabela nasceu.

create table preparo_pedido (
  pedido_id uuid not null references pedido(id) on delete cascade,
  item      text not null,
  feito_em  timestamptz,
  primary key (pedido_id, item)
);

comment on column preparo_pedido.item is
  'Código estável do item — `descarga`, `equipe`, `semeadora`. O texto que '
  'aparece na tela mora no service: mudar a redação não pode apagar o que a '
  'pessoa já marcou, e apagaria se a chave fosse a frase.';

create index on preparo_pedido (pedido_id);

create or replace function app.pedido_do_produtor(p_pedido uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from pedido
                        where id = p_pedido and produtor_id = app.produtor_atual()) $$;

alter table preparo_pedido enable row level security;

-- Ler e escrever, só ele. É a única tabela do sistema em que a sessão do portal
-- ESCREVE — em todo o resto ela é de leitura, e aqui é porque o dado é dele:
-- ninguém além dele sabe se a semeadora está revisada.
create policy preparo_dele on preparo_pedido
  using (app.pedido_do_produtor(pedido_id))
  with check (app.pedido_do_produtor(pedido_id));
