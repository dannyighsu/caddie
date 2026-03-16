#!/bin/bash

# Northstar run script
# Usage: ./run.sh [dev|prod]

set -e

MODE="${1:-dev}"

if [ "$MODE" != "dev" ] && [ "$MODE" != "prod" ]; then
  echo "Usage: ./run.sh [dev|prod]"
  echo "  dev  - development mode with .env.local (default)"
  echo "  prod - production mode with .env.production"
  exit 1
fi

echo "Starting Northstar in $MODE mode..."

# Determine env file
if [ "$MODE" = "dev" ]; then
  ENV_FILE=".env.local"
else
  ENV_FILE=".env.production"
fi

# Run database migrations
echo "Running database migrations..."
pnpm run db:migrate || echo "Migrations skipped (no database configured or migration failed)"

# Run the app - Next.js automatically loads .env.local / .env.production
if [ "$MODE" = "dev" ]; then
  pnpm run dev
else
  pnpm run build && pnpm run start
fi
