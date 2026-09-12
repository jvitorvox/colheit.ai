FROM node:22-alpine

WORKDIR /app/api
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
WORKDIR /app
CMD ["node", "api/src/server.js"]
