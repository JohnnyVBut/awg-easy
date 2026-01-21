#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Building AWG-Easy 2.0 Docker Image${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Переход в директорию проекта
cd "$(dirname "$0")"

# Сборка образа
echo -e "${GREEN}Building Docker image...${NC}"
docker build -t awg2-easy:latest .

echo ""
echo -e "${GREEN}✓ Build complete!${NC}"
echo ""
echo "Image tag: awg-easy:latest"
echo ""
echo "Next steps:"
echo "  1. Edit docker-compose.yml with your settings"
echo "  2. Run: docker-compose up -d"
echo "  or"
echo "  Run: ./run.sh"
