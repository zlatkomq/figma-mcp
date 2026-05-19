FROM node:22-bookworm-slim

# Postavi radni direktorij
WORKDIR /app

# Kopiraj samo package files za brži build (layer caching)
COPY package*.json ./
RUN npm install --production

# Kopiraj ostatak koda
COPY . .

# Port na kojem tvoj Express (SSE) sluša
EXPOSE 3000

# Pokretanje servera
CMD ["node", "index.js"]
