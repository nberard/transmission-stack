FROM node:22-alpine
LABEL maintainer="Nicolas Berard <berard.nicolas@gmail.com>"

# ffmpeg: in-browser playback of any video (on-the-fly conversion, embedded subtitles)
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    USERS_DIR=/users
EXPOSE 8080
CMD ["node", "server.js"]
