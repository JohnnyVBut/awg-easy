# WireSteer — Caddy Reverse Proxy

Caddy sits in front of WireSteer and provides:
- HTTPS + HTTP/3 (QUIC) on port 443
- Decoy streaming site on `/`
- Hidden admin path (configured via `ADMIN_PATH` env var)
- Rate limiting on login endpoint (5 attempts / IP / minute)
- Security headers (HSTS, no-referrer, X-Frame-Options, …)
- TLS cert for bare public IP via acme.sh shortlived profile

## Quick start

### 1. Issue TLS certificate

```bash
# Port 80 must be reachable from the internet during issuance
chmod +x scripts/acme-install.sh
sudo ./scripts/acme-install.sh <YOUR_PUBLIC_IP> <YOUR_EMAIL>
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env — set ADMIN_PATH to a random string
# Generate one: openssl rand -hex 12
```

### 3. Add decoy video

Download Big Buck Bunny (or any neutral mp4) to:
```
www/video/decoy.mp4
```

### 4. Ensure WireSteer binds to 127.0.0.1 only

Add to your WireSteer docker-compose or startup:
```
--listen 127.0.0.1:51821
```
or block external access via iptables:
```bash
iptables-nft -A INPUT ! -i lo -p tcp --dport 51821 -j DROP
```

### 5. Start Caddy

```bash
docker compose up -d --build
```

### 6. Access admin interface

```
https://<IP>/<ADMIN_PATH>/
```

## Security notes

- `ADMIN_PATH` is security through obscurity — TOTP in WireSteer is the real gate
- `Referrer-Policy: no-referrer` prevents the hidden path from leaking via Referer headers
- Rate limiting blocks brute force on the login endpoint (5 POST /api/session per IP per minute)
- WireSteer port 51821 MUST NOT be reachable from the internet (see step 4)
- TLS cert renews automatically every 3 days via acme.sh cron
- Caddy container runs read-only with minimal capabilities (NET_BIND_SERVICE only)
