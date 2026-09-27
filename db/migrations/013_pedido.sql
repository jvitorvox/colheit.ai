-- 013 · O pedido e as dez etapas
--
-- O coração do produto. A referência é acompanhar uma entrega de e-commerce:
-- hoje o pedido some depois do "fechado", e o agricultor só descobre o
-- andamento se perguntar — muitas vezes já tendo pagado.
--
-- Nenhuma das dez etapas espera integração com ERP. Expedição é nativa, o
-- status de crédito a revenda lança, e a nota entra porque é por ela que o
-- produtor vê o que deve e paga.

create table etapa_pedido (
  numero   smallint primary key check (numero between 1 and 10),
  nome     text not null,
  quem     text not null,
  notifica boolean not null,
  faixa    text not null check (faixa in ('comercial', 'retaguarda', 'campo'))
);

comment on column etapa_pedido.notifica is
  'Se a mudança merece aviso ativo ao produtor. O aviso sai por push do PWA — '
  'o WhatsApp nunca dispara, só responde quando ele pergunta.';

insert into etapa_pedido (numero, nome, quem, notifica, faixa) values
  ( 1, 'Negociação',     'RTV',             false, 'comercial'),
  ( 2, 'Pedido',         'RTV na fazenda',  true,  'comercial'),
  ( 3, 'Crédito',        'Revenda',         true,  'retaguarda'),
  ( 4, 'Faturamento',    'Retaguarda',      true,  'retaguarda'),
  ( 5, 'Expedição',      'Logística',       false, 'retaguarda'),
  ( 6, 'Transporte',     'Logística',       true,  'retaguarda'),
  ( 7, 'Entrega',        'Transportadora',  true,  'retaguarda'),
  ( 8, 'Plantio',        'RTV e produtor',  false, 'campo'),
  ( 9, 'Acompanhamento', 'RTV',             true,  'campo'),
  (10, 'Resultado',      'RTV e produtor',  false, 'campo');

grant select on etapa_pedido to public;

-- ---------------------------------------------------------------------------
create table pedido (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenant(id) on delete cascade,
  produtor_id    uuid not null references produtor(id) on delete cascade,
  propriedade_id uuid references propriedade(id) on delete set null,
  numero         text not null,
  safra          text not null,
  etapa          smallint not null default 1 references etapa_pedido(numero),
  situacao       text not null default 'andamento'
                   check (situacao in ('andamento', 'concluido', 'cancelado')),
  credito        text not null default 'pendente'
                   check (credito in ('pendente', 'aprovado', 'recusado')),
  franqueado_id  uuid references tenant(id) on delete set null,
  municipio      text,
  uf             char(2),
  criado_em      timestamptz not null default now(),
  unique (tenant_id, numero)
);

comment on column pedido.franqueado_id is
  'CARIMBO da atribuição, gravado na criação a partir do município da terra. '
  'Nunca recalculado: redesenhar território depois reescreveria o passado.';
comment on column pedido.municipio is
  'Copiado junto com o carimbo. Guardar o município da época é o que permite '
  'auditar a atribuição mesmo que a propriedade mude de cadastro depois.';

create index on pedido (produtor_id);
create index on pedido (tenant_id, situacao);
create index on pedido (franqueado_id) where franqueado_id is not null;

create table pedido_item (
  id          uuid primary key default gen_random_uuid(),
  pedido_id   uuid not null references pedido(id) on delete cascade,
  cultivar    text not null,
  quantidade  numeric(12,2) not null check (quantidade > 0),
  unidade     text not null default 'sc',
  preco_unit  numeric(12,4) check (preco_unit >= 0)
);
create index on pedido_item (pedido_id);

comment on table pedido_item is
  'Sem FK para catálogo ainda: o módulo de catálogo entra depois e acrescenta '
  'a coluna. Cultivar em texto agora é honesto; inventar catálogo agora, não.';

-- O histórico é append-only: é ele que prova quando o agricultor foi avisado.
create table pedido_etapa (
  id            uuid primary key default gen_random_uuid(),
  pedido_id     uuid not null references pedido(id) on delete cascade,
  etapa         smallint not null references etapa_pedido(numero),
  em            timestamptz not null default now(),
  por_usuario   uuid references usuario(id) on delete set null,
  observacao    text,
  retrocesso    boolean not null default false
);
create index on pedido_etapa (pedido_id, em desc);

-- ---------------------------------------------------------------------------
-- A nota. Não é um detalhe do pedido: é o motor da captura.
-- ---------------------------------------------------------------------------
create table nota (
  id           uuid primary key default gen_random_uuid(),
  pedido_id    uuid not null unique references pedido(id) on delete cascade,
  numero       text not null,
  chave        text unique check (chave is null or chave ~ '^[0-9]{44}$'),
  valor        numeric(14,2) not null check (valor > 0),
  emitida_em   date not null,
  vencimento   date,
  linha_digitavel text,
  pago_em      date,
  origem       text not null default 'lancamento'
                 check (origem in ('lancamento', 'xml', 'danfe')),
  criado_em    timestamptz not null default now()
);

comment on table nota is
  'A revenda lança porque é assim que ela recebe — e o sell-out entra junto, '
  'sem ninguém precisar pedir. Emitir nota continua fora do escopo: aqui só se '
  'LÊ e se EXIBE, inclusive o boleto, que o produtor paga no banco dele.';
comment on column nota.chave is
  'Chave de 44 dígitos da NF-e, quando a nota entra por XML ou DANFE escaneado. '
  'Unique: a mesma nota não entra duas vezes por caminhos diferentes.';

-- ---------------------------------------------------------------------------
-- Aviso enfileirado. Quem entrega é o módulo de notificação; aqui só se
-- registra a intenção — e o registro é o que torna a promessa auditável.
-- ---------------------------------------------------------------------------
create table notificacao (
  id          uuid primary key default gen_random_uuid(),
  produtor_id uuid not null references produtor(id) on delete cascade,
  pedido_id   uuid references pedido(id) on delete cascade,
  etapa       smallint references etapa_pedido(numero),
  texto       text not null,
  criada_em   timestamptz not null default now(),
  enviada_em  timestamptz
);
create index on notificacao (produtor_id, criada_em desc);
create index on notificacao (enviada_em) where enviada_em is null;

-- ---------------------------------------------------------------------------
-- Isolamento: os dois eixos, como em todo o resto.
-- ---------------------------------------------------------------------------
select app.aplicar_isolamento('pedido');

-- As duas políticas abaixo são de LEITURA. O `with check (false)` é o que
-- garante isso: sem ele o PostgreSQL usaria o `using` como condição de
-- escrita, e a sessão do portal passaria a poder CRIAR pedido para si mesma.
create policy pedido_do_produtor on pedido
  using (produtor_id = app.produtor_atual())
  with check (false);

-- O franqueado enxerga o que desce dele, mesmo tendo sido vendido pelo canal.
-- É a visibilidade descendente: ele vê o que originou, nunca o lado — e só vê.
create policy pedido_do_franqueado on pedido
  using (franqueado_id = app.tenant_atual())
  with check (false);

-- Ler o filho segue o pai. Escrever no filho, não: só quem é dono do pedido
-- escreve nele. O franqueado enxerga a venda do canal e não pode alterá-la.
create or replace function app.pedido_visivel(p_pedido uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from pedido where id = p_pedido) $$;

create or replace function app.pedido_meu(p_pedido uuid) returns boolean
  language sql stable
  as $$ select exists (select 1 from pedido
                        where id = p_pedido and tenant_id = app.tenant_atual()) $$;

alter table pedido_item enable row level security;
create policy item_pelo_pedido on pedido_item
  using (app.pedido_visivel(pedido_id)) with check (app.pedido_meu(pedido_id));

alter table pedido_etapa enable row level security;
create policy etapa_pelo_pedido on pedido_etapa
  using (app.pedido_visivel(pedido_id)) with check (app.pedido_meu(pedido_id));

alter table nota enable row level security;
create policy nota_pelo_pedido on nota
  using (app.pedido_visivel(pedido_id)) with check (app.pedido_meu(pedido_id));

alter table notificacao enable row level security;
create policy notificacao_dele on notificacao
  using (produtor_id = app.produtor_atual()
         or exists (select 1 from produtor_vinculo v
                     where v.produtor_id = notificacao.produtor_id
                       and v.tenant_id = app.tenant_atual()))
  with check (exists (select 1 from produtor_vinculo v
                       where v.produtor_id = notificacao.produtor_id
                         and v.tenant_id = app.tenant_atual()));
