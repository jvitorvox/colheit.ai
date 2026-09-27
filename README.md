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

### ⚠️ Autenticação ainda não existe

`api/src/http/identificar.js` lê `x-tenant-id` e `x-usuario-id` de cabeçalho, **sem
verificar nada**. Existe para o cadastro poder ser construído antes do módulo de
login, e é a única porta por onde o contexto entra — quando a autenticação chegar,
só aquele arquivo muda. **Não subir assim.**

## O que ainda não está aqui

Pedido e as dez etapas, funil, visita, catálogo — e a autenticação. `002_exemplo_isolamento.sql` fica:
testa `app.aplicar_isolamento` de forma independente do domínio.
