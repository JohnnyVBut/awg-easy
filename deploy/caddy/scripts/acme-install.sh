#!/bin/bash
# First-time setup: install acme.sh and issue a short-lived Let's Encrypt
# certificate for a bare public IP address.
#
# Usage:
#   sudo ./acme-install.sh <PUBLIC_IP> <EMAIL>
#
# What it does:
#   1. Installs acme.sh (if not present)
#   2. Issues a shortlived cert (6 days) for the IP via HTTP-01 challenge
#   3. Installs the cert to /etc/ssl/wiresteer/
#   4. Configures auto-renewal via acme.sh cron (every 3 days)
#   5. On renewal, reloads Caddy via `docker exec wiresteer-caddy caddy reload`
#
# Requirements:
#   - Port 80 must be reachable from the internet during issuance
#   - Caddy container name: wiresteer-caddy (see docker-compose.yml)
#   - Docker must be installed and running

set -euo pipefail

IP="${1:?Usage: $0 <PUBLIC_IP> <EMAIL>}"
EMAIL="${2:?Usage: $0 <PUBLIC_IP> <EMAIL>}"

CERT_DIR="/etc/ssl/wiresteer"
ACME_WEBROOT="/srv/acme"
CADDY_CONTAINER="wiresteer-caddy"

echo "==> Creating directories..."
mkdir -p "$CERT_DIR" "$ACME_WEBROOT"
chmod 755 "$ACME_WEBROOT"
chmod 700 "$CERT_DIR"

# Install acme.sh if not already present
if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
    echo "==> Installing acme.sh..."
    curl https://get.acme.sh | sh -s email="$EMAIL"
    # shellcheck disable=SC1090
    source "$HOME/.acme.sh/acme.sh.env"
else
    echo "==> acme.sh already installed, skipping"
    # shellcheck disable=SC1090
    source "$HOME/.acme.sh/acme.sh.env" 2>/dev/null || true
fi

echo "==> Issuing short-lived certificate for $IP..."
~/.acme.sh/acme.sh \
    --issue \
    --server letsencrypt \
    -d "$IP" \
    -w "$ACME_WEBROOT" \
    --certificate-profile shortlived \
    --days 3

echo "==> Installing certificate to $CERT_DIR..."
~/.acme.sh/acme.sh \
    --install-cert -d "$IP" \
    --key-file       "$CERT_DIR/server.key" \
    --fullchain-file "$CERT_DIR/server.crt" \
    --reloadcmd      "docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile"

chmod 600 "$CERT_DIR/server.key"
chmod 644 "$CERT_DIR/server.crt"

echo ""
echo "Done. Certificate installed to $CERT_DIR"
echo "Auto-renewal is configured via acme.sh cron (runs every 3 days)."
echo ""
echo "Verify renewal cron:"
echo "  crontab -l | grep acme"
