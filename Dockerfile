FROM node:20-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies for tsx)
RUN npm ci

# Copy source
COPY server/ ./server/
COPY lib/ ./lib/
COPY tsconfig.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data

CMD ["npx", "tsx", "server/ws-server.ts"]
