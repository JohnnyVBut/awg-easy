# AWG-Easy 2.0 — API Reference

> Base URL: `http://<host>:51821/api`
> Auth: session cookie (POST `/api/session` → cookie) or header `Authorization: <password>`
> Content-Type: `application/json`

---

## Authentication

### `GET /api/session`
Session status.
```json
{ "requiresPassword": true, "authenticated": false }
```

### `POST /api/session`
Login.
```json
// Request
{ "password": "secret", "remember": true }
// Response
{ "success": true }
```

### `DELETE /api/session`
Logout.
```json
{ "success": true }
```

---

## UI Config (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/release` | Release version |
| GET | `/api/lang` | UI language |
| GET | `/api/remember-me` | Whether "Remember me" is enabled |
| GET | `/api/ui-traffic-stats` | Whether traffic statistics are enabled |
| GET | `/api/ui-chart-type` | Traffic chart type |
| GET | `/api/wg-enable-one-time-links` | Whether one-time links are enabled |
| GET | `/api/ui-sort-clients` | Whether client sorting is enabled |
| GET | `/api/wg-enable-expire-time` | Whether expiry time is enabled |
| GET | `/api/ui-avatar-settings` | Avatar settings (DiceBear / Gravatar) |

### `GET /cnf/:link`
Download config via one-time link (no auth required).
Returns a `.conf` file.

---

## Settings

### `GET /api/settings`
Global settings.
```json
{
  "dns": "1.1.1.1,8.8.8.8",
  "defaultPersistentKeepalive": 25,
  "defaultClientAllowedIPs": "0.0.0.0/0"
}
```

### `PUT /api/settings`
Update settings.
```json
// Request
{ "dns": "8.8.8.8", "defaultPersistentKeepalive": 25, "defaultClientAllowedIPs": "0.0.0.0/0" }
```

---

## AWG2 Templates

### `GET /api/templates`
```json
{ "templates": [{ "id": "uuid", "name": "...", "isDefault": false, "jc": 6, ... }] }
```

### `POST /api/templates`
Create a template.
```json
// Request
{
  "name": "My Profile",
  "isDefault": false,
  "jc": 6, "jmin": 10, "jmax": 50,
  "s1": 64, "s2": 67, "s3": 17, "s4": 4,
  "h1": "221138202-537563446", "h2": "...", "h3": "...", "h4": "...",
  "i1": "...", "i2": "", "i3": "", "i4": "", "i5": ""
}
// Response
{ "template": { "id": "uuid", ... } }
```

### `GET /api/templates/:id`
Get a template by ID.

### `PUT /api/templates/:id`
Update a template. Body — same fields as creation.

### `DELETE /api/templates/:id`
Delete a template.
```json
{ "success": true }
```

### `POST /api/templates/:id/set-default`
Set template as default.
```json
{ "template": { ... } }
```

### `POST /api/templates/:id/apply`
Get template parameters with new random H1-H4 (for applying to an interface).
```json
{ "settings": { "jc": 6, "jmin": 10, ..., "h1": "new range", ... } }
```

### `POST /api/templates/generate`
Generate AWG2 parameters (port of AmneziaWG-Architect).
```json
// Request
{
  "profile": "random",        // random|quic_initial|quic_0rtt|tls_client_hello|dtls|http3|sip|wireguard_noise
  "intensity": "medium",      // low|medium|high
  "host": "example.com",      // optional, for SNI
  "iterCount": 0,             // retry counter
  "jc": 6,                    // base Jc value
  "saveName": "My Profile"    // if provided — saves as a template immediately
}
// Response (without saveName)
{ "params": { "jc": 6, ..., "i1": "...", "profile": "quic_initial" }, "profiles": [...] }
// Response (with saveName)
{ "params": {...}, "profiles": [...], "template": { "id": "uuid", ... } }
```

---

## Tunnel Interfaces

### `GET /api/tunnel-interfaces`
```json
{ "interfaces": [{ "id": "wg10", "name": "...", "address": "10.8.0.1/24", "enabled": true, ... }] }
```

### `POST /api/tunnel-interfaces`
Create an interface.
```json
// Request
{
  "name": "Moscow VPN",
  "protocol": "amneziawg-2.0",   // or "wireguard-1.0"
  "address": "10.8.0.1/24",
  "listenPort": 51830,
  "disableRoutes": false,          // true for S2S interconnect interfaces
  "settings": {                    // required for amneziawg-2.0
    "jc": 6, "jmin": 10, "jmax": 50,
    "s1": 64, "s2": 67, "s3": 17, "s4": 4,
    "h1": "...", "h2": "...", "h3": "...", "h4": "...",
    "i1": "...", "i2": "", "i3": "", "i4": "", "i5": ""
  }
}
// Response
{ "interface": { "id": "wg10", ... } }
```

### `GET /api/tunnel-interfaces/:id`
Get an interface.

### `PATCH /api/tunnel-interfaces/:id`
Update an interface (hot-reload via syncconf, no downtime).
```json
// Request — any fields from POST
{ "name": "New Name", "listenPort": 51831 }
// Response
{ "interface": { ... } }
```

### `DELETE /api/tunnel-interfaces/:id`
Delete an interface (stop + remove files).
```json
{ "success": true }
```

### `POST /api/tunnel-interfaces/:id/start`
Start an interface. Applies static routes after startup.
```json
{ "interface": { "id": "wg10", "enabled": true, ... } }
```

### `POST /api/tunnel-interfaces/:id/stop`
Stop an interface.
```json
{ "interface": { "id": "wg10", "enabled": false, ... } }
```

### `POST /api/tunnel-interfaces/:id/restart`
Restart an interface. Applies static routes after restart.
```json
{ "interface": { ... } }
```

### `GET /api/tunnel-interfaces/:id/export-params`
Export this interface's parameters to share with the remote side (S2S workflow).
```json
{
  "name": "Moscow wg10",
  "publicKey": "base64...",
  "endpoint": "1.2.3.4:51830",
  "address": "10.100.0.1/24",
  "protocol": "amneziawg-2.0",
  "presharedKey": "base64..."   // only if an interconnect peer with PSK already exists
}
```

### `GET /api/tunnel-interfaces/:id/export-obfuscation`
Export AWG2 obfuscation parameters of the interface (for saving as a template).
Returns 400 if the interface is not AWG2.

### `GET /api/tunnel-interfaces/:id/backup`
Download a backup of the interface and all its peers as JSON (attachment).

### `PUT /api/tunnel-interfaces/:id/restore`
Restore peers from a JSON backup (removes existing peers, adds from file).
```json
// Request
{ "file": { "peers": [...] } }
// Response
{ "interface": { ... } }
```

---

## Peers

### `GET /api/tunnel-interfaces/:id/peers`
Get the list of peers for an interface (includes live transfer stats).
```json
{ "peers": [{ "id": "uuid", "name": "...", "peerType": "client", "enabled": true, ... }] }
```

### `POST /api/tunnel-interfaces/:id/peers`
Create a peer.
```json
// Request (client, auto-generate)
{
  "name": "My Phone",
  "autoAllocateIP": true,           // auto-assign IP from interface subnet
  "generateKeys": true,             // generate key pair on the server
  "clientAllowedIPs": "0.0.0.0/0", // routes on the client side
  "persistentKeepalive": 25,
  "peerType": "client"
}

// Request (client, manual keys)
{
  "name": "Office PC",
  "publicKey": "base64...",
  "allowedIPs": "10.8.0.5/32",
  "peerType": "client"
}

// Request (interconnect)
{
  "name": "KZ Server",
  "publicKey": "base64...",
  "allowedIPs": "10.100.1.1/32",
  "endpoint": "kz.example.com:51830",
  "peerType": "interconnect"
}

// Response
{ "peer": { "id": "uuid", "name": "...", "publicKey": "...", ... } }
```

### `POST /api/tunnel-interfaces/:id/peers/import-json`
Create an interconnect peer from JSON exported by the remote side.
Supports two input formats:
- **Interface-params** (from `export-params`): `{ name, publicKey, endpoint, address, [presharedKey], protocol }`
- **Peer-params**: `{ name, publicKey, endpoint, allowedIPs }`

PSK: if included in the file — uses it; otherwise generates a new one.
```json
// Response
{ "peer": { "id": "uuid", "peerType": "interconnect", ... } }
```

### `GET /api/tunnel-interfaces/:id/peers/:peerId`
Get a peer.

### `PATCH /api/tunnel-interfaces/:id/peers/:peerId`
Update a peer. Body — any peer fields.

### `DELETE /api/tunnel-interfaces/:id/peers/:peerId`
Delete a peer.
```json
{ "success": true }
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/enable`
Enable a peer.
```json
{ "peer": { "enabled": true, ... } }
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/disable`
Disable a peer.

### `GET /api/tunnel-interfaces/:id/peers/:peerId/config`
Download the client `.conf` file (attachment).

### `GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg`
QR code with the config in SVG format (for mobile AmneziaWG).

### `GET /api/tunnel-interfaces/:id/peers/:peerId/export-json`
Export interconnect peer parameters to share with the remote side.
Only for `peerType === 'interconnect'`. Returns 400 otherwise.
```json
{
  "name": "...", "publicKey": "...", "presharedKey": "...",
  "endpoint": "...", "allowedIPs": "10.100.0.1/32",
  "persistentKeepalive": 25, "clientAllowedIPs": "0.0.0.0/0"
}
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/generateOneTimeLink`
Generate a one-time download link for the config.
```json
{ "peer": { "oneTimeLink": "hex...", ... } }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/name`
Rename a peer.
```json
// Request
{ "name": "New Name" }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/address`
Change peer AllowedIPs.
```json
// Request
{ "address": "10.8.0.10/32" }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/expireDate`
Set peer expiry date.
```json
// Request
{ "expireDate": "2026-12-31T00:00:00Z" }
```

---

## Gateways

### `GET /api/gateways`
```json
{
  "gateways": [{
    "id": "uuid", "name": "KZ GW", "interface": "wg10",
    "gatewayIP": "10.100.1.1", "monitorAddress": "8.8.8.8",
    "status": "online", "latency": 12.5, "packetLoss": 0
  }]
}
```

### `POST /api/gateways`
Create a gateway.
```json
// Request
{
  "name": "KZ Gateway",
  "interface": "wg10",
  "gatewayIP": "10.100.1.1",
  "monitorAddress": "8.8.8.8",   // optional, for ping monitoring
  "interval": 5                   // seconds between pings, default 5
}
// Response
{ "gateway": { ... } }
```

### `GET /api/gateways/:id`
Get a gateway with monitoring status.

### `PATCH /api/gateways/:id`
Update a gateway.

### `DELETE /api/gateways/:id`
Delete a gateway.

---

## Gateway Groups

### `GET /api/gateway-groups`
```json
{ "groups": [{ "id": "uuid", "name": "...", "gateways": [...], "trigger": "packetloss" }] }
```

### `POST /api/gateway-groups`
Create a group.
```json
// Request
{
  "name": "Failover Group",
  "trigger": "packetloss",         // packetloss|latency|packetloss_latency
  "description": "...",
  "gateways": [
    { "gatewayId": "uuid", "tier": 1 },   // tier 1 = primary
    { "gatewayId": "uuid", "tier": 2 }    // tier 2 = backup
  ]
}
```

### `GET /api/gateway-groups/:id`
Get a group.

### `PATCH /api/gateway-groups/:id`
Update a group.

### `DELETE /api/gateway-groups/:id`
Delete a group.

---

## Routing

### `GET /api/routing/tables`
List routing tables from the kernel (`ip rule show`).
```json
{ "tables": [{ "id": 254, "name": "main" }, { "id": 100, "name": "vpn_kz" }] }
```

### `GET /api/routing/table?table=main`
Routes from the Linux kernel for the specified table.
```json
{ "routes": [{ "dst": "10.8.0.0/24", "dev": "wg10", "prefsrc": "...", "flags": [] }] }
```

### `GET /api/routing/test?ip=8.8.8.8`
Route test: `ip route get <ip>`.
```json
{ "result": "8.8.8.8 via 10.100.1.1 dev wg10 src 10.100.0.1" }
```

### `GET /api/routing/routes`
List managed static routes (from JSON file).
```json
{ "routes": [{ "id": "uuid", "destination": "10.0.0.0/8", "via": "10.100.1.1", "dev": "wg10", "table": "main", "enabled": true }] }
```

### `POST /api/routing/routes`
Create a static route.
```json
// Request
{
  "destination": "10.0.0.0/8",
  "via": "10.100.1.1",           // gateway IP (optional)
  "dev": "wg10",                  // interface (optional)
  "table": "main",                // routing table, default "main"
  "metric": 100                   // optional
}
// Response
{ "route": { "id": "uuid", "enabled": true, ... } }
```

### `PATCH /api/routing/routes/:id`
Enable or disable a route.
```json
// Request
{ "enabled": true }
// Response
{ "route": { ... } }
```

### `DELETE /api/routing/routes/:id`
Delete a route (from kernel and JSON).
```json
{ "success": true }
```

---

## NAT

### `GET /api/nat/interfaces`
List host network interfaces for outbound interface selection.
```json
{ "interfaces": [{ "name": "eth0" }, { "name": "wg10" }] }
```

### `GET /api/nat/rules`
List NAT rules.
```json
{
  "rules": [{
    "id": "uuid", "name": "VPN clients", "source": "any",
    "outInterface": "eth0", "type": "MASQUERADE",
    "toSource": null, "enabled": true, "comment": ""
  }]
}
```

### `POST /api/nat/rules`
Create a NAT rule.
```json
// Request
{
  "name": "VPN clients NAT",
  "source": "any",              // any | subnet 10.8.0.0/24 | IP 10.8.0.5
  "outInterface": "eth0",
  "type": "MASQUERADE",        // MASQUERADE | SNAT
  "toSource": null,            // for SNAT: "1.2.3.4"
  "comment": ""
}
// Response
{ "rule": { "id": "uuid", ... } }
```

### `PATCH /api/nat/rules/:id`
Update a rule or toggle enabled.
```json
// Toggle
{ "enabled": false }
// Full update — same fields as creation
```

### `DELETE /api/nat/rules/:id`
Delete a rule (from iptables and JSON).

---

## Firewall Aliases

### `GET /api/aliases`
```json
{
  "aliases": [{
    "id": "uuid", "name": "ru", "type": "ipset",
    "ipsetName": "ru", "entryCount": 8123,
    "generatorOpts": { "country": "RU", "asn": null, "asnList": null },
    "lastUpdated": "2026-03-15T10:00:00Z"
  }]
}
```

### `POST /api/aliases`
Create an alias.
```json
// host/network type
{ "name": "my_hosts", "type": "host", "entries": ["1.2.3.4", "5.6.7.8"], "description": "" }
{ "name": "my_nets",  "type": "network", "entries": ["10.0.0.0/8", "192.168.0.0/16"] }

// ipset type (empty on creation, populated via upload or generate)
{ "name": "ru", "type": "ipset", "description": "RU prefixes" }

// Response
{ "alias": { "id": "uuid", ... } }
```

### `PATCH /api/aliases/:id`
Update an alias (name, description, entries).

### `DELETE /api/aliases/:id`
Delete an alias. For ipset — destroys the kernel set.

### `POST /api/aliases/:id/upload`
Upload prefixes from a text file into an ipset (one CIDR per line).
```json
// Request
{ "text": "10.0.0.0/8\n192.168.0.0/16\n..." }
// Response
{ "alias": { "entryCount": 42, ... } }
```

### `POST /api/aliases/:id/generate`
Start background ipset generation via RIPEstat API (PrefixFetcher).
```json
// Request — one of:
{ "country": "RU" }
{ "asn": "AS15169" }
{ "asnList": "12345,20485" }

// Response
{ "jobId": "uuid" }
```

### `GET /api/aliases/:id/generate/:jobId`
Status of background generation job.
```json
// In progress
{ "status": "running" }
// Completed
{ "status": "done", "entryCount": 8123 }
// Error
{ "status": "error", "error": "No prefixes returned" }
```

---

## Firewall Rules

Firewall rules are a unified entity for filtering (ACCEPT/DROP/REJECT) and PBR (ACCEPT + gateway).
Rules are evaluated in `order` sequence (top-to-bottom) via custom iptables chains:
- `FIREWALL_FORWARD` (filter table) — for ACCEPT/DROP/REJECT
- `FIREWALL_MANGLE` (mangle table) — for PBR packet marking (when gateway is set)

### `GET /api/firewall/interfaces`
List host network interfaces (for the `interface` field when creating a rule).
```json
{ "interfaces": ["eth0", "wg10", "wg11", "lo"] }
```

### `GET /api/firewall/rules`
```json
{
  "rules": [{
    "id": "uuid", "name": "Block RU", "enabled": true, "order": 1,
    "interface": "any",            // "any" | "wg10" | "eth0" — ingress -i flag
    "protocol": "any",             // "any" | "tcp" | "udp" | "tcp/udp" | "icmp"
    "source": {
      "type": "any",               // "any" | "cidr" | "alias"
      "aliasId": null, "value": null, "invert": false, "port": null
    },
    "destination": {
      "type": "alias", "aliasId": "uuid", "value": null, "invert": true, "port": null
    },
    "action": "drop",              // "accept" | "drop" | "reject"
    "gatewayId": null,             // only when action=accept
    "gatewayGroupId": null,
    "fwmark": null,                // auto-assigned when gateway is set
    "log": false, "comment": "",
    "createdAt": "ISO string"
  }]
}
```

### `POST /api/firewall/rules`
Create a rule. The rule is appended last (order = max + 1).
```json
// Request
{
  "name": "Non-RU → KZ",           // optional
  "interface": "any",              // optional, default "any"
  "protocol": "any",               // optional, default "any"
  "source": {
    "type": "any"
  },
  "destination": {
    "type": "alias",
    "aliasId": "uuid-of-ru-alias",
    "invert": true,                // NOT — traffic NOT destined for this set
    "port": "443"                  // optional
  },
  "action": "accept",              // "accept" | "drop" | "reject"
  "gatewayId": "uuid-of-kz-gw",   // optional, only for action=accept
  "gatewayGroupId": null,
  "log": false,
  "comment": ""
}
// Response
{ "rule": { "id": "uuid", ... } }
```

**Endpoint types:**
| type | Fields | Description |
|------|--------|-------------|
| `any` | — | No restriction |
| `cidr` | `value: "10.0.0.0/8"` | Specific CIDR |
| `alias` | `aliasId: "uuid"` | Reference to an alias (host/network/ipset) |

`invert: true` prepends `!` to the match expression (NOT).

Resulting kernel commands (example: ACCEPT + gateway PBR):
```bash
iptables-nft -t mangle -A FIREWALL_MANGLE -m set ! --match-set ru dst -j MARK --set-mark 1000
ip route add default via <gw.gatewayIP> dev <gw.interface> table 1000
ip rule add fwmark 1000 lookup 1000 priority 1010
iptables-nft -t filter -A FIREWALL_FORWARD -m set ! --match-set ru dst -j ACCEPT
```

### `PATCH /api/firewall/rules/:id`
Toggle or update a rule:
```json
// Toggle
{ "enabled": false }
// Update — any model fields
{ "name": "New Name", "action": "drop", "gatewayId": null }
```

### `DELETE /api/firewall/rules/:id`
Delete a rule (rebuilds chains, removes ip rule + ip route from kernel).

### `POST /api/firewall/rules/:id/move`
Move a rule up or down (changes evaluation order):
```json
{ "direction": "up" }   // or "down"
```

---

## System

### `GET /api/system/interfaces`
List host network interfaces (for Gateway creation).
```json
{ "interfaces": [{ "name": "eth0", "type": "ether", "operstate": "UP" }] }
```

---

## Admin Tunnel (WireGuard wg0)

Legacy API for the admin tunnel (Administration page).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/wireguard/client` | List wg0 clients |
| POST | `/api/wireguard/client` | Create client `{ name, expiredDate? }` |
| DELETE | `/api/wireguard/client/:id` | Delete client |
| POST | `/api/wireguard/client/:id/enable` | Enable client |
| POST | `/api/wireguard/client/:id/disable` | Disable client |
| PUT | `/api/wireguard/client/:id/name` | Rename `{ name }` |
| PUT | `/api/wireguard/client/:id/address` | Change address `{ address }` |
| PUT | `/api/wireguard/client/:id/expireDate` | Set expiry date `{ expireDate }` |
| POST | `/api/wireguard/client/:id/generateOneTimeLink` | Generate one-time link |
| GET | `/api/wireguard/client/:id/qrcode.svg` | QR code |
| GET | `/api/wireguard/client/:id/configuration` | Download `.conf` |
| GET | `/api/wireguard/backup` | Backup wg0 config |
| PUT | `/api/wireguard/restore` | Restore from backup `{ file }` |

---

## Prometheus Metrics

### `GET /metrics`
Metrics in Prometheus text format. Requires Basic Auth if `PROMETHEUS_METRICS_PASSWORD` is set.

### `GET /metrics/json`
Same metrics in JSON format.

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request — invalid parameters |
| 401 | Unauthorized |
| 404 | Resource not found |
| 500 | Internal server error |

```json
{ "statusCode": 404, "message": "Interface not found" }
```
