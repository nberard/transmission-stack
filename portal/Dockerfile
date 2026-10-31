FROM node:22-alpine
LABEL maintainer="Nicolas Berard <berard.nicolas@gmail.com>"

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    USERS_DIR=/users
EXPOSE 8080
CMD ["node", "server.js"]
