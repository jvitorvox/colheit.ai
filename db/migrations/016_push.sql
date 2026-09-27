-- 016 · Push
--
-- É o push do PWA que cumpre a promessa de "chega sem abrir o app". Custo zero
-- por mensagem, sem intermediário e sem template — e o WhatsApp continua sem
-- disparar nada, só respondendo quando perguntam.

create table assinatura_push (
  id          uuid primary key default gen_random_uuid(),
  produtor_id uuid references produtor(id) on delete cascade,
  usuario_id  uuid references usuario(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  agente      text,
  criada_em   timestamptz not null default now(),
  ultima_em   timestamptz,
  falhas      smallint not null default 0,
  check (num_nonnulls(produtor_id, usuario_id) = 1)
);

comment on table assinatura_push is
  'Uma assinatura por navegador, não por pessoa: quem usa celular e desktop tem '
  'duas, e as duas devem receber. O endpoint é único porque é ele que o serviço '
  'de push usa como identidade.';

comment on column assinatura_push.agente is
  'Guardado para medir a ressalva do iPhone: lá o push exige que o produtor '
  'adicione o portal à tela de início, e essa fricção precisa aparecer em '
  'número, não em suposição.';

create index on assinatura_push (produtor_id) where produtor_id is not null;
create index on assinatura_push (usuario_id) where usuario_id is not null;

-- ---------------------------------------------------------------------------
-- A fila ganha o que falta para ser drenada com honestidade.
-- ---------------------------------------------------------------------------
alter table notificacao add column tentativas smallint not null default 0;
alter table notificacao add column descartada_em timestamptz;
alter table notificacao add column motivo text;

comment on column notificacao.descartada_em is
  'Aviso que não tinha para quem ir. "A carga saiu" não vale três dias depois, '
  'então em vez de acumular fila eterna, descarta-se com motivo — a informação '
  'não se perde: continua no histórico do pedido.';

create index on notificacao (criada_em)
  where enviada_em is null and descartada_em is null;

-- ---------------------------------------------------------------------------
-- Cada um assina a própria caixa, e só ela.
-- ---------------------------------------------------------------------------
alter table assinatura_push enable row level security;

create policy assinatura_do_produtor on assinatura_push
  using (produtor_id = app.produtor_atual())
  with check (produtor_id = app.produtor_atual());

create policy assinatura_do_usuario on assinatura_push
  using (usuario_id = app.usuario_atual())
  with check (usuario_id = app.usuario_atual());

comment on policy assinatura_do_produtor on assinatura_push is
  'Com `with check` igual ao `using`, de propósito: aqui escrever é o ato '
  'principal, e ninguém assina caixa alheia.';
