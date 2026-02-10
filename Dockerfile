FROM oven/bun:1-alpine

WORKDIR /app

# Copy package files
COPY package.json ./

# Install deps (none currently, but future-proof)
RUN bun install --production 2>/dev/null || true

# Copy source
COPY . .

# Create data directory
RUN mkdir -p data

# Health check port
EXPOSE 3000

# Run the continuous server
CMD ["bun", "run", "src/server.ts"]
