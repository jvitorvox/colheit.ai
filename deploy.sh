#!/usr/bin/env sh
# Deploy: sobe a stack, aplica as migrações e garante o super admin.
#
#   ./deploy.sh
#
# O super admin vem de PLATAFORMA_ADMIN_EMAIL / PLATAFORMA_ADMIN_SENHA no .env
# (ou no ambiente de quem roda). A senha não mora no repositório.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo 'falta o .env — copie o .env.example e preencha'; exit 1
fi

# `--wait` segura até os healthchecks passarem: o banco já atende quando a
# migração roda.
docker compose up -d --build --wait db armazem
docker compose up -d --build

docker compose exec -T api npm --prefix api run migrar
docker compose exec -T api npm --prefix api run superadmin

echo 'deploy ok'
