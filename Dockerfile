FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm ci

# Copy source
COPY server/ ./server/
COPY lib/db.ts ./lib/db.ts
COPY tsconfig.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 1234

CMD ["npx", "tsx", "server/ws-server.ts"]
