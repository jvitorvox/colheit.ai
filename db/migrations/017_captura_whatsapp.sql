-- 017 · Captura pelo WhatsApp
--
-- O hábito já existe: produtor e RTV trocam foto de talhão e áudio sobre a
-- lavoura hoje, e isso morre numa conversa pessoal. O módulo não cria
-- comportamento novo — dá destino ao que já acontece.
--
-- Duas regras moram no schema, não na disciplina de quem escreve o gateway:
--   · um número por tenant — se um cair, o canal para de um cliente, não da
--     plataforma;
--   · resposta só existe atrelada a uma mensagem de ENTRADA. O WhatsApp nunca
--     dispara; ele responde. Sem a âncora, a linha não nasce.

alter table usuario add column telefone text check (telefone ~ '^[0-9]{10,15}$');
comment on column usuario.telefone is
  'Por onde o consultor manda a visita por áudio. Mesmo formato do produtor: '
  'só dígitos, com DDI.';

create unique index on usuario (telefone) where telefone is not null;

create table canal_whatsapp (
  tenant_id    uuid primary key references tenant(id) on delete cascade,
  numero       text not null unique check (numero ~ '^[0-9]{10,15}$'),
  ativo        boolean not null default true,
  conectado_em timestamptz,
  criado_em    timestamptz not null default now()
);

comment on table canal_whatsapp is
  'Chave primária no tenant: um número por empresa, como no RDO do Construtivo. '
  'É o que limita o estrago de um bloqueio a um cliente só.';

-- ---------------------------------------------------------------------------
create table mensagem_whatsapp (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id) on delete cascade,
  telefone    text not null,
  direcao     text not null check (direcao in ('entrada', 'saida')),
  tipo        text not null check (tipo in ('texto', 'audio', 'imagem')),
  texto       text,
  midia_ref   text,
  produtor_id uuid references produtor(id) on delete set null,
  usuario_id  uuid references usuario(id) on delete set null,
  responde_a  uuid references mensagem_whatsapp(id) on delete set null,
  recebida_em timestamptz not null default now(),
  enviada_em  timestamptz,
  criado_em   timestamptz not null default now(),
  -- Saída é sempre resposta a uma entrada. É aqui que "nunca dispara" deixa de
  -- ser combinado e passa a ser impossível.
  check (direcao = 'entrada' or responde_a is not null)
);

create index on mensagem_whatsapp (tenant_id, telefone, criado_em desc);
create index on mensagem_whatsapp (criado_em) where direcao = 'saida' and enviada_em is null;

comment on column mensagem_whatsapp.midia_ref is
  'Referência do áudio ou da foto no armazenamento. O binário não entra no '
  'banco; aqui fica só o ponteiro.';

-- ---------------------------------------------------------------------------
-- O relato estruturado. Nasce pendente: quem fecha é o consultor, como o
-- engenheiro fecha o RDO no Construtivo.
-- ---------------------------------------------------------------------------
create table relato (
  id           uuid primary key default gen_random_uuid(),
  mensagem_id  uuid not null unique references mensagem_whatsapp(id) on delete cascade,
  tenant_id    uuid not null references tenant(id) on delete cascade,
  produtor_id  uuid not null references produtor(id) on delete cascade,
  talhao_id    uuid references talhao(id) on delete set null,
  tipo         text not null default 'lavoura'
                 check (tipo in ('lavoura', 'visita', 'lote')),
  transcricao  text,
  extraido     jsonb,
  situacao     text not null default 'aguardando_extracao'
                 check (situacao in ('aguardando_extracao', 'pendente', 'validado', 'descartado')),
  validado_por uuid references usuario(id) on delete set null,
  validado_em  timestamptz,
  observacao   text,
  criado_em    timestamptz not null default now()
);

create index on relato (tenant_id, situacao, criado_em desc);
create index on relato (produtor_id);

comment on column relato.situacao is
  'aguardando_extracao é o estado honesto enquanto o provedor de IA não está '
  'ligado: a mensagem chegou e está guardada, mas ninguém leu ainda.';
comment on column relato.extraido is
  'O que a IA entendeu, em jsonb. Fica ao lado da transcrição, nunca no lugar '
  'dela — quem valida precisa poder comparar com o que foi dito.';

-- ---------------------------------------------------------------------------
select app.aplicar_isolamento('canal_whatsapp');
select app.aplicar_isolamento('mensagem_whatsapp');
select app.aplicar_isolamento('relato');

-- O produtor enxerga o que ele mesmo mandou, e o que viraram — mas não valida.
create policy mensagem_dele on mensagem_whatsapp
  using (produtor_id = app.produtor_atual()) with check (false);

create policy relato_dele on relato
  using (produtor_id = app.produtor_atual()) with check (false);
