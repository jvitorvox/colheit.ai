FROM node:22-alpine AS dependencias
# O Baileys puxa parte da criptografia de sinal direto de um repositório git,
# então git é necessário para INSTALAR — não para rodar. Fica só nesta etapa.
RUN apk add --no-cache git
WORKDIR /app/gateway
COPY package.json ./
RUN npm install --omit=dev

FROM node:22-alpine
WORKDIR /app/gateway
COPY --from=dependencias /app/gateway/node_modules ./node_modules
COPY package.json ./
COPY src ./src
CMD ["node", "src/index.js"]
