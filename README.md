# colheit.ai

CRM de campo e portal do produtor para a cadeia de insumos agrícolas — indústria,
distribuidor/revenda, consultor técnico e agricultor.

O desenho do produto (problema, personas, concorrentes, arquitetura e o que ainda
está em aberto) vive fora do código, no documento de desenho.

## Subir

```bash
cp .env.example .env      # ajuste as senhas
docker compose up -d --build
docker compose exec api npm --prefix api run migrar
```

API em `http://localhost:7011` — `/saude` responde `{"ok":true}`.

## Testar o isolamento

```bash
docker compose exec api npm --prefix api run teste
```

## A regra que sustenta tudo

Isolamento **no banco**, não na aplicação. Dois papéis de PostgreSQL:

| Papel | Quem é | Row-level security |
|---|---|---|
| `colheitai_owner` | migração, job, carga | passa por cima |
| `colheitai_app` | requisição HTTP | **obedece sempre** |

A aplicação obedece porque **não é dona de nenhuma tabela** — no PostgreSQL o dono
ignora RLS por padrão. Sem essa separação, RLS é decoração.

O tenant entra no contexto por transação (`app.tenant_id`), e as rotas não precisam
saber que existe multi-tenancy. Um `WHERE` esquecido não vaza dado de outra empresa.

### Toda tabela de negócio nova

```sql
create table minha_tabela (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(id) on delete cascade,
  ...
);
create index on minha_tabela (tenant_id);
select app.aplicar_isolamento('minha_tabela');   -- não esquecer
```

E o teste de isolamento roda no CI a cada migração nova — não é conferência manual.

## Estrutura

```
db/init/          papéis de banco, uma vez na criação do volume
db/migrations/    versionadas, aplicadas em ordem, uma vez cada
api/src/          db.js (dois pools), migrar.js, server.js
test/             isolamento entre tenants
```

## Identidade do produtor

Chave sintética, documentos como tabela, **identidade global e relação por tenant**.

CPF não é chave primária porque o mesmo produtor opera sob CPF, CNPJ e inscrição
estadual — com CPF como chave ele viraria N registros e a porta única quebraria no
caso que ela existe para resolver. Somam-se: o consultor cadastra em campo sem o
documento em mãos, e CPF como chave se espalharia por toda FK, log e URL.

| Tabela | Escopo | O que guarda |
|---|---|---|
| `produtor` | global | identidade — é o mesmo João para todas as revendas |
| `produtor_documento` | global | CPF, CNPJ, IE. PK em (tipo, valor): um documento, um dono |
| `produtor_vinculo` | **por tenant** | a relação comercial. Tudo comercial pendura aqui |

`produtor` é a exceção à regra do tenant_id, e a política é o preço: enxerga quem
tem vínculo, não quem tem a coluna.

```sql
-- porta única: mesmo CPF por outra revenda devolve o MESMO produtor
select app.vincular_produtor("João", '[{"tipo":"cpf","valor":"12345678901"}]');
```

A revenda que chega depois só ganha um vínculo — nunca descobre que o registro já
existia. Cadastro sem documento é aceito (é o caso do campo), o que produz duplicata
temporária: `app.fundir_produtor()` resolve, e **ninguém é apagado** — o perdedor
aponta para o vencedor e o histórico continua alcançável.

## Duas dimensões de isolamento

| | Pergunta | Onde |
|---|---|---|
| tenant | de qual empresa é o dado | `app.tenant_id` |
| carteira | qual consultor pode atuar sobre aquele produtor | `app.usuario_id` |

Gestor enxerga a empresa inteira; consultor, só a carteira. Sem usuário no contexto
é job e integração — rodam no tenant, sem pessoa por trás. Quem cadastra em campo
entra na própria carteira no mesmo ato, senão perderia de vista o que acabou de criar.

## Terra

`propriedade` não tem coluna de dono. Tem `produtor_propriedade` com papel
(proprietário, arrendatário, comodatário) e período — porque arrendamento é a regra,
e o dono da terra também é cliente. O CAR é chave natural do **imóvel**, nunca do
produtor, e é opcional: é autodeclarado e uma fazenda pode abranger mais de um.

## Módulo cadastro

Primeiro módulo com camada de API. A estrutura é a regra da seção 13 do desenho —
`rota -> service -> repository`, **o SQL vive só no repository**, e nenhum módulo
importa o repository de outro.

```
POST   /cadastro/produtores                      cadastra ou reconhece (porta única)
GET    /cadastro/produtores                      a carteira que o contexto permite ver
POST   /cadastro/produtores/:id/documentos       acrescenta CPF, CNPJ ou IE
POST   /cadastro/produtores/fundir               resolve duplicata, sem apagar ninguém
POST   /cadastro/propriedades                    cria a terra junto com quem a opera
POST   /cadastro/propriedades/:id/operadores     arrendatário entra como segundo papel
PATCH  /cadastro/operadores/:id/encerrar         fecha o período, mantém o histórico
POST   /cadastro/propriedades/:id/talhoes        talhão
POST   /cadastro/carteira                        autoriza consultor sobre um produtor
```

**Documento é validado com dígito verificador**, não só formato: erro de digitação é
de onde vem a maior parte das duplicatas, e o banco só garante que são dígitos.
Inscrição estadual fica no formato — a regra varia por estado.

## Autenticação

Duas identidades, de formatos diferentes — e é a cadeia que pede isso.

| | Como entra | Sessão | Vê |
|---|---|---|---|
| `usuario` (gestor, consultor) | e-mail e senha | 12 h | o tenant dele |
| `produtor` | telefone e código de 6 dígitos | 30 dias | o que é dele, em **todas** as revendas |

Senha no produtor seria atrito na ponta de que a adoção inteira depende, e o canal
já existe: o código é o mesmo vínculo por código do WhatsApp, e o convite sai de
quem tem vínculo — no contrato. É o gancho que a H2 mede.

```
POST /auth/login                    e-mail e senha
POST /auth/produtor/codigo          pede o código (responde igual para telefone conhecido ou não)
POST /auth/produtor/entrar          telefone + código
GET  /auth/eu                       quem sou eu, nos dois casos
POST /auth/convites                 convida produtor (exige vínculo)
POST /auth/usuarios/:id/senha       só gestor, e só da própria empresa
```

### O que o módulo protege

- **Resposta uniforme.** E-mail inexistente, usuário sem senha e senha errada dão a
  mesma resposta — distinguir entregaria quais e-mails existem na plataforma.
- **Tempo uniforme.** Conta sem senha gasta o mesmo trabalho de scrypt de uma
  conferência real; sem isso o relógio entregaria o que a mensagem esconde.
- **Freio de força bruta** por e-mail ou telefone: cinco falhas bloqueiam 15 minutos,
  dez bloqueiam uma hora. A falha é **gravada fora da exceção** — lançar de dentro da
  transação provocaria rollback e o contador zeraria sozinho.
- **Código de uso único**, com validade de 10 minutos, guardado só como hash, e pedir
  um novo invalida o anterior.
- **HS256 fixado na verificação.** Aceitar o algoritmo que vem no próprio token é como
  se abre a porta para `alg: none`.

### Os dois eixos de contexto

`comContexto()` põe `app.tenant_id` + `app.usuario_id` **ou** `app.produtor_id` — nunca
os dois. As políticas do produtor (migração 011) são permissivas e se somam às de
tenant: quando um eixo está preenchido, o outro é nulo e as políticas dele não casam.

A sessão do portal é de **leitura** no núcleo de cadastro, e não entra em `/cadastro`.

## Módulo pedidos — as dez etapas

O coração do produto. A referência é acompanhar uma entrega de e-commerce: hoje o
pedido some depois do "fechado" e o agricultor só descobre o andamento se perguntar.

| | | avisa | | | | avisa |
|---|---|---|---|---|---|---|
| 1 | Negociação | | | 6 | Transporte | ✓ |
| 2 | Pedido | ✓ | | 7 | Entrega | ✓ |
| 3 | Crédito | ✓ | | 8 | Plantio | |
| 4 | Faturamento | ✓ | | 9 | Acompanhamento | ✓ |
| 5 | Expedição | | | 10 | Resultado | |

```
GET   /pedidos                      a empresa vê a carteira; o produtor vê os dele
GET   /pedidos/etapas               as dez, com quem faz e quem avisa
GET   /pedidos/:id                  com itens, nota e histórico completo
POST  /pedidos                      nasce na etapa 1, com o território carimbado
POST  /pedidos/:id/avancar          uma etapa, nunca pulando
POST  /pedidos/:id/retroceder       exige motivo, fica marcado no histórico
POST  /pedidos/:id/cancelar         exige motivo
PATCH /pedidos/:id/credito          pendente · aprovado · recusado
POST  /pedidos/:id/nota             a nota, que é o motor da captura
POST  /pedidos/:id/nota/pago        registra o pagamento
GET   /pedidos/avisos               fila de notificação; quem entrega é outro módulo
```

### Três regras que não são burocracia

**A etapa 4 exige a nota.** Marcar faturado sem o documento deixaria o dado entrar
pela metade — e a nota *é* o sell-out. A regra deixou de ser combinada e virou
estrutural.

**Avança uma de cada vez.** Pular seria cômodo e destrói a promessa: a régua do
agricultor é ver o pedido andar, e pedido que salta de 2 para 7 não conta história.

**Retroceder exige motivo e fica marcado.** A realidade volta — carga recusada na
porteira, entrega que não foi. Apagar o passo em falso seria perder o que a operação
precisa aprender.

### O carimbo do território

`pedido.franqueado_id` e `pedido.municipio` são gravados na criação, a partir do
município da terra, e **nunca recalculados**. Redesenhar um território depois
reescreveria o passado e vazaria histórico de um franqueado para outro.

É por esse carimbo que o franqueado enxerga a venda que a distribuidora fez com
produto dele — visibilidade descendente, **e só de leitura**: quem opera a venda é
quem a altera.

## Módulo push

É o push do PWA que cumpre o "chega sem abrir o app" — custo zero por mensagem,
sem intermediário e sem template. O WhatsApp continua sem disparar nada: ele só
recebe o que vem do campo e responde quando perguntam.

```
GET    /push/chave-publica    a chave VAPID, sem sessão (o navegador precisa antes)
POST   /push/assinaturas      registra o navegador
DELETE /push/assinaturas      remove pelo endpoint
GET    /push/assinaturas      as minhas
```

O envio não é rota. `npm run despachar` drena a fila com o papel **dono**, porque
ela atravessa tenants — é da plataforma, não de uma empresa. Mesmo motivo pelo qual
migração e job usam o dono.

### O que o despachante decide

| Desfecho | O que faz |
|---|---|
| entregou em ao menos um navegador | marca enviada — quem tem celular e desktop não precisa dos dois de pé |
| `404` ou `410` | apaga a assinatura: é o serviço dizendo que aquele navegador não existe mais |
| falha passageira | adia; na terceira tentativa descarta com motivo |
| produtor sem assinatura | descarta na hora — "a carga saiu" não vale três dias depois, e a informação continua no histórico do pedido |

`assinatura_push.agente` guarda o user agent de propósito: é assim que a ressalva do
iPhone — onde o push exige adicionar o portal à tela de início — vira número em vez
de suposição.

### O contrato do cliente

O PWA ainda não existe. Quando existir, o service worker precisa de:

```js
const { chavePublica } = await (await fetch('/push/chave-publica')).json();
const sub = await registro.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: chavePublica,
});
await fetch('/push/assinaturas', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ ...sub.toJSON(), agente: navigator.userAgent }),
});
```

A carga que chega no `push` é `{ titulo, texto, pedidoId, etapa }`.

## O que ainda não está aqui




Funil, visita, catálogo e o caderno de campo. O PWA — a API do push está pronta, a tela não. E a captura pelo WhatsApp, que é quem entrega o código de acesso do produtor. `002_exemplo_isolamento.sql` fica:
testa `app.aplicar_isolamento` de forma independente do domínio.
