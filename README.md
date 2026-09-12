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

## O que ainda não está aqui

As tabelas de domínio — produtor, propriedade, talhão, pedido. Falta decidir a
**chave de identidade do produtor** (CPF/CNPJ, CAR, ou composta), e ela decide se a
porta única funciona: o produtor que compra da Revenda A tem que ser reconhecido
como o mesmo que compra da Revenda B.

`002_exemplo_isolamento.sql` cria uma tabela descartável só para o teste ter o que
provar. Sai quando a primeira tabela de domínio entrar.
