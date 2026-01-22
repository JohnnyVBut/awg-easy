#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  AWG-Easy 2.0 - Quick Start${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if image exists
if ! docker image inspect awg2-easy:latest >/dev/null 2>&1; then
    echo -e "${YELLOW}Docker image not found. Building...${NC}"
    ./build.sh
    echo ""
fi

# Get server IP
echo -e "${BLUE}Detecting server IP...${NC}"
SERVER_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || echo "")

if [ -z "$SERVER_IP" ]; then
    echo -e "${YELLOW}Could not detect server IP automatically.${NC}"
    read -p "Enter your server IP or domain: " SERVER_IP
fi

echo -e "${GREEN}Server IP: ${SERVER_IP}${NC}"
echo ""

# Generate password hash
echo -e "${BLUE}Setting up Web UI password...${NC}"
read -sp "Enter Web UI password: " WEB_PASSWORD
echo ""

# Generate bcrypt hash
echo -e "${BLUE}Generating bcrypt hash...${NC}"
WGPW_OUTPUT=$(docker run --rm awg2-easy:latest wgpw "$WEB_PASSWORD")

# Extract hash from output: PASSWORD_HASH='$2y$...'
PASSWORD_HASH=$(echo "$WGPW_OUTPUT" | grep -oP "PASSWORD_HASH='\K[^']+")

if [ -z "$PASSWORD_HASH" ]; then
    echo -e "${RED}Failed to generate password hash!${NC}"
    echo "Output was: $WGPW_OUTPUT"
    exit 1
fi

echo -e "${GREEN}Password hash generated.${NC}"
echo ""

# Create data directory
mkdir -p ./data

# Stop and remove existing container
if docker ps -a --format '{{.Names}}' | grep -q '^awg-easy$'; then
    echo -e "${YELLOW}Stopping existing container...${NC}"
    docker stop awg-easy >/dev/null 2>&1 || true
    docker rm awg-easy >/dev/null 2>&1 || true
fi

# Run container
echo -e "${BLUE}Starting AWG-Easy 2.0 container...${NC}"
echo ""

docker run -d \
  --name awg-easy \
  --restart unless-stopped \
  \
  -e WG_HOST="$SERVER_IP" \
  -e PASSWORD_HASH=''"$PASSWORD_HASH"'' \
  -e PORT=51821 \
  -e WG_PORT=51820 \
  -e WG_DEFAULT_DNS=1.1.1.1,8.8.8.8 \
  \
  -e JC=6 \
  -e JMIN=10 \
  -e JMAX=50 \
  -e S1=64 \
  -e S2=67 \
  -e S3=17 \
  -e S4=4 \
  -e H1=221138202-537563446 \
  -e H2=1824677785-1918284606 \
  -e H3=2058490965-2098228430 \
  -e H4=2114920036-2134209753 \
  -e I1='<b 0x084481800001000300000000077469636b65747306776964676574096b696e6f706f69736b0272750000010001c00c0005000100000039001806776964676574077469636b6574730679616e646578c025c0390005000100000039002b1765787465726e616c2d7469636b6574732d776964676574066166697368610679616e646578036e657400c05d000100010000001c000457fafe25>' \
  -e I2= \
  -e I3= \
  -e I4= \
  -e I5= \
  -e ITIME=0 \
  \
  -v "$(pwd)/data:/etc/wireguard" \
  -v "$(pwd)/data:/etc/amnezia/amneziawg" \
  \
  -p 51820:51820/udp \
  -p 51821:51821/tcp \
  \
  --cap-add=NET_ADMIN \
  --cap-add=SYS_MODULE \
  \
  --sysctl="net.ipv4.ip_forward=1" \
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
  \
  --device=/dev/net/tun:/dev/net/tun \
  \
  awg2-easy:latest

echo ""
echo -e "${GREEN}✓ AWG-Easy 2.0 is running!${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}Access Information:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo -e "  ${GREEN}Web UI:${NC}      http://${SERVER_IP}:51821"
echo -e "  ${GREEN}VPN Port:${NC}    ${SERVER_IP}:51820/udp"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}AmneziaWG 2.0 Parameters:${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Jc:   6     (Junk packet count)"
echo "  Jmin: 10    (Min junk size)"
echo "  Jmax: 50    (Max junk size)"
echo "  S1:   64    (Init packet junk)"
echo "  S2:   67    (Response packet junk)"
echo "  S3:   17    (Cookie reply junk)"
echo "  S4:   4     (Transport data junk)"
echo "  H1-H4:      (Random ranges from real config)"
echo "  I1:         DNS packet (tickets.widget.kinopoisk.ru)"
echo "  I2-I5:      (Empty)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Useful commands:"
echo "  docker logs -f awg-easy      # View logs"
echo "  docker stop awg-easy         # Stop container"
echo "  docker start awg-easy        # Start container"
echo "  docker restart awg-easy      # Restart container"
echo ""
