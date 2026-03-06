FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY relay-server.js .
EXPOSE 8765
CMD ["node", "relay-server.js"]
