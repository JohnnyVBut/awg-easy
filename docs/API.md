# AWG-Easy 2.0 — API Reference

> Base URL: `http://<host>:51821/api`
> Auth: session cookie (POST `/api/session` → cookie) или header `Authorization: <password>`
> Content-Type: `application/json`

---

## Authentication

### `GET /api/session`
Статус сессии.
```json
{ "requiresPassword": true, "authenticated": false }
```

### `POST /api/session`
Логин.
```json
// Request
{ "password": "secret", "remember": true }
// Response
{ "success": true }
```

### `DELETE /api/session`
Логаут.
```json
{ "success": true }
```

---

## UI Config (без auth)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/release` | Версия релиза |
| GET | `/api/lang` | Язык интерфейса |
| GET | `/api/remember-me` | Включён ли "Remember me" |
| GET | `/api/ui-traffic-stats` | Включена ли статистика трафика |
| GET | `/api/ui-chart-type` | Тип графика трафика |
| GET | `/api/wg-enable-one-time-links` | Включены ли one-time ссылки |
| GET | `/api/ui-sort-clients` | Включена ли сортировка клиентов |
| GET | `/api/wg-enable-expire-time` | Включено ли время истечения |
| GET | `/api/ui-avatar-settings` | Настройки аватаров (DiceBear / Gravatar) |

### `GET /cnf/:link`
Скачать конфиг по одноразовой ссылке (не требует auth).
Возвращает `.conf` файл.

---

## Settings

### `GET /api/settings`
Глобальные настройки.
```json
{
  "dns": "1.1.1.1,8.8.8.8",
  "defaultPersistentKeepalive": 25,
  "defaultClientAllowedIPs": "0.0.0.0/0"
}
```

### `PUT /api/settings`
Обновить настройки.
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
Создать шаблон.
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
Получить шаблон по ID.

### `PUT /api/templates/:id`
Обновить шаблон. Body — те же поля что при создании.

### `DELETE /api/templates/:id`
Удалить шаблон.
```json
{ "success": true }
```

### `POST /api/templates/:id/set-default`
Сделать шаблон дефолтным.
```json
{ "template": { ... } }
```

### `POST /api/templates/:id/apply`
Получить параметры шаблона с новыми рандомными H1-H4 (для применения к интерфейсу).
```json
{ "settings": { "jc": 6, "jmin": 10, ..., "h1": "новый диапазон", ... } }
```

### `POST /api/templates/generate`
Генерировать AWG2 параметры (порт AmneziaWG-Architect).
```json
// Request
{
  "profile": "random",        // random|quic_initial|quic_0rtt|tls_client_hello|dtls|http3|sip|wireguard_noise
  "intensity": "medium",      // low|medium|high
  "host": "yandex.ru",        // опционально, для SNI
  "iterCount": 0,             // счётчик неудачных попыток
  "jc": 6,                    // базовое Jc
  "saveName": "My Profile"    // если задан — сразу сохраняет как шаблон
}
// Response (без saveName)
{ "params": { "jc": 6, ..., "i1": "...", "profile": "quic_initial" }, "profiles": [...] }
// Response (с saveName)
{ "params": {...}, "profiles": [...], "template": { "id": "uuid", ... } }
```

---

## Tunnel Interfaces

### `GET /api/tunnel-interfaces`
```json
{ "interfaces": [{ "id": "wg10", "name": "...", "address": "10.8.0.1/24", "enabled": true, ... }] }
```

### `POST /api/tunnel-interfaces`
Создать интерфейс.
```json
// Request
{
  "name": "Moscow VPN",
  "protocol": "amneziawg-2.0",   // или "wireguard-1.0"
  "address": "10.8.0.1/24",
  "listenPort": 51830,
  "disableRoutes": false,          // true для S2S interconnect интерфейсов
  "settings": {                    // обязательно для amneziawg-2.0
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
Получить интерфейс.

### `PATCH /api/tunnel-interfaces/:id`
Обновить интерфейс (hot-reload через syncconf, без даунтайма).
```json
// Request — любые поля из POST
{ "name": "New Name", "listenPort": 51831 }
// Response
{ "interface": { ... } }
```

### `DELETE /api/tunnel-interfaces/:id`
Удалить интерфейс (stop + удалить файлы).
```json
{ "success": true }
```

### `POST /api/tunnel-interfaces/:id/start`
Запустить интерфейс. Применяет статические маршруты после старта.
```json
{ "interface": { "id": "wg10", "enabled": true, ... } }
```

### `POST /api/tunnel-interfaces/:id/stop`
Остановить интерфейс.
```json
{ "interface": { "id": "wg10", "enabled": false, ... } }
```

### `POST /api/tunnel-interfaces/:id/restart`
Перезапустить интерфейс. Применяет статические маршруты после рестарта.
```json
{ "interface": { ... } }
```

### `GET /api/tunnel-interfaces/:id/export-params`
Экспортировать параметры своего интерфейса для передачи удалённой стороне (S2S workflow).
```json
{
  "name": "Moscow wg10",
  "publicKey": "base64...",
  "endpoint": "1.2.3.4:51830",
  "address": "10.100.0.1/24",
  "protocol": "amneziawg-2.0",
  "presharedKey": "base64..."   // только если уже есть interconnect peer с PSK
}
```

### `GET /api/tunnel-interfaces/:id/export-obfuscation`
Экспортировать AWG2 параметры обфускации интерфейса (для сохранения как шаблон).
Ошибка 400 если интерфейс не AWG2.

### `GET /api/tunnel-interfaces/:id/backup`
Скачать бэкап интерфейса + всех пиров как JSON (attachment).

### `PUT /api/tunnel-interfaces/:id/restore`
Восстановить пиры из JSON бэкапа (удаляет существующих, добавляет из файла).
```json
// Request
{ "file": { "peers": [...] } }
// Response
{ "interface": { ... } }
```

---

## Peers

### `GET /api/tunnel-interfaces/:id/peers`
Получить список пиров интерфейса (включает live transfer stats).
```json
{ "peers": [{ "id": "uuid", "name": "...", "peerType": "client", "enabled": true, ... }] }
```

### `POST /api/tunnel-interfaces/:id/peers`
Создать пир.
```json
// Request (client, auto-generate)
{
  "name": "My Phone",
  "autoAllocateIP": true,           // авто-назначить IP из подсети интерфейса
  "generateKeys": true,             // сгенерировать ключевую пару на сервере
  "clientAllowedIPs": "0.0.0.0/0", // маршруты на клиенте
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
Создать interconnect пир из JSON экспортированного удалённой стороной.
Поддерживает два формата входных данных:
- **Interface-params** (от `export-params`): `{ name, publicKey, endpoint, address, [presharedKey], protocol }`
- **Peer-params**: `{ name, publicKey, endpoint, allowedIPs }`

PSK: если пришёл в файле — использует его; иначе генерирует новый.
```json
// Response
{ "peer": { "id": "uuid", "peerType": "interconnect", ... } }
```

### `GET /api/tunnel-interfaces/:id/peers/:peerId`
Получить пир.

### `PATCH /api/tunnel-interfaces/:id/peers/:peerId`
Обновить пир. Body — любые поля пира.

### `DELETE /api/tunnel-interfaces/:id/peers/:peerId`
Удалить пир.
```json
{ "success": true }
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/enable`
Включить пир.
```json
{ "peer": { "enabled": true, ... } }
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/disable`
Выключить пир.

### `GET /api/tunnel-interfaces/:id/peers/:peerId/config`
Скачать `.conf` файл клиентского конфига (attachment).

### `GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg`
QR-код с конфигом в формате SVG (для мобильного AmneziaWG).

### `GET /api/tunnel-interfaces/:id/peers/:peerId/export-json`
Экспортировать параметры interconnect пира для передачи удалённой стороне.
Только для `peerType === 'interconnect'`. Ошибка 400 иначе.
```json
{
  "name": "...", "publicKey": "...", "presharedKey": "...",
  "endpoint": "...", "allowedIPs": "10.100.0.1/32",
  "persistentKeepalive": 25, "clientAllowedIPs": "0.0.0.0/0"
}
```

### `POST /api/tunnel-interfaces/:id/peers/:peerId/generateOneTimeLink`
Сгенерировать одноразовую ссылку на конфиг.
```json
{ "peer": { "oneTimeLink": "hex...", ... } }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/name`
Переименовать пир.
```json
// Request
{ "name": "New Name" }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/address`
Изменить AllowedIPs пира.
```json
// Request
{ "address": "10.8.0.10/32" }
```

### `PUT /api/tunnel-interfaces/:id/peers/:peerId/expireDate`
Установить дату истечения пира.
```json
// Request
{ "expireDate": "2026-12-31T00:00:00Z" }
```

---

## Gateways

### Модель Gateway
```json
{
  "id": "uuid",
  "name": "KZ GW",
  "interface": "wg10",
  "gatewayIP": "10.100.1.1",
  "monitorAddress": "8.8.8.8",      // IP для ICMP-пинга; '' = gatewayIP
  "monitor": true,
  "monitorInterval": 5,             // секунды между ICMP-пробами
  "windowSeconds": null,            // null = глобальный дефолт из Settings
  "latencyThreshold": 500,
  "monitorHttp": {
    "enabled": false,
    "url": "https://example.com",   // URL для HTTP-пробы
    "expectedStatus": 200,          // ожидаемый HTTP-код ответа
    "interval": 60,                 // секунды между HTTP-пробами
    "timeout": 5                    // таймаут curl в секундах
  },
  "monitorRule": "icmp_only",       // "icmp_only"|"http_only"|"all"|"any"
  "description": ""
}
```

**monitorRule** определяет как ICMP и HTTP статусы объединяются в итоговый статус gateway:
- `icmp_only` — только ICMP (умолчание, обратная совместимость)
- `http_only` — только HTTP
- `all` — оба должны быть reachable (AND)
- `any` — достаточно одного (OR)

### Статус мониторинга (добавляется к модели в ответах)
```json
{
  "status": "healthy",             // "healthy"|"degraded"|"down"|"unknown"
  "latency": 12,                   // ICMP RTT мс (avg по window)
  "packetLoss": 0,                 // ICMP потери %
  "lastCheck": "2026-03-15T...",
  "httpStatus": "healthy",         // null если HTTP не включён
  "httpLatency": 45,               // HTTP время ответа мс; null если не включён
  "httpLastCheck": "2026-03-15T..."
}
```

### `GET /api/gateways`
```json
{ "gateways": [{ /* модель + статус мониторинга */ }] }
```

### `POST /api/gateways`
Создать gateway.
```json
// Request — поля monitorHttp и monitorRule опциональны
{
  "name": "KZ Gateway",
  "interface": "wg10",
  "gatewayIP": "10.100.1.1",
  "monitorAddress": "8.8.8.8",
  "monitorInterval": 5,
  "monitorHttp": { "enabled": true, "url": "https://check.example.com", "expectedStatus": 200, "interval": 60, "timeout": 5 },
  "monitorRule": "all"
}
// Response
{ "gateway": { ... } }
```

### `GET /api/gateways/:id`
Получить gateway со статусом мониторинга.

### `PATCH /api/gateways/:id`
Обновить gateway.

### `DELETE /api/gateways/:id`
Удалить gateway.

---

## Gateway Groups

### `GET /api/gateway-groups`
```json
{ "groups": [{ "id": "uuid", "name": "...", "gateways": [...], "trigger": "packetloss" }] }
```

### `POST /api/gateway-groups`
Создать группу.
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
Получить группу.

### `PATCH /api/gateway-groups/:id`
Обновить группу.

### `DELETE /api/gateway-groups/:id`
Удалить группу.

---

## Routing

### `GET /api/routing/tables`
Список routing-таблиц из ядра (`ip rule show`).
```json
{ "tables": [{ "id": 254, "name": "main" }, { "id": 100, "name": "vpn_kz" }] }
```

### `GET /api/routing/table?table=main`
Маршруты из ядра Linux для указанной таблицы.
```json
{ "routes": [{ "dst": "10.8.0.0/24", "dev": "wg10", "prefsrc": "...", "flags": [] }] }
```

### `GET /api/routing/test?ip=8.8.8.8`
Тест маршрута: `ip route get <ip>`.
```json
{ "result": "8.8.8.8 via 10.100.1.1 dev wg10 src 10.100.0.1" }
```

### `GET /api/routing/routes`
Список managed статических маршрутов (из JSON-файла).
```json
{ "routes": [{ "id": "uuid", "destination": "10.0.0.0/8", "via": "10.100.1.1", "dev": "wg10", "table": "main", "enabled": true }] }
```

### `POST /api/routing/routes`
Создать статический маршрут.
```json
// Request
{
  "destination": "10.0.0.0/8",
  "via": "10.100.1.1",           // gateway IP (опционально)
  "dev": "wg10",                  // интерфейс (опционально)
  "table": "main",                // routing table, default "main"
  "metric": 100                   // опционально
}
// Response
{ "route": { "id": "uuid", "enabled": true, ... } }
```

### `PATCH /api/routing/routes/:id`
Включить/выключить маршрут.
```json
// Request
{ "enabled": true }
// Response
{ "route": { ... } }
```

### `DELETE /api/routing/routes/:id`
Удалить маршрут (из ядра и JSON).
```json
{ "success": true }
```

---

## NAT

### `GET /api/nat/interfaces`
Список сетевых интерфейсов хоста для выбора outbound-интерфейса.
```json
{ "interfaces": [{ "name": "eth0" }, { "name": "wg10" }] }
```

### `GET /api/nat/rules`
Список NAT правил.
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
Создать NAT правило.
```json
// Request
{
  "name": "VPN clients NAT",
  "source": "any",              // any | подсеть 10.8.0.0/24 | IP 10.8.0.5
  "outInterface": "eth0",
  "type": "MASQUERADE",        // MASQUERADE | SNAT
  "toSource": null,            // для SNAT: "1.2.3.4"
  "comment": ""
}
// Response
{ "rule": { "id": "uuid", ... } }
```

### `PATCH /api/nat/rules/:id`
Обновить правило или переключить enabled.
```json
// Toggle
{ "enabled": false }
// Full update — те же поля что при создании
```

### `DELETE /api/nat/rules/:id`
Удалить правило (из iptables и JSON).

---

## Firewall Aliases

Четыре типа:
- **host** — список IP-адресов
- **network** — список CIDR-префиксов
- **ipset** — kernel ipset (большой набор, наполняется через upload или generate)
- **group** — объединяет несколько host/network алиасов; `getMatchSpec` возвращает merged deduplicated entries

### `GET /api/aliases`
```json
{
  "aliases": [{
    "id": "uuid", "name": "ru", "type": "ipset",
    "ipsetName": "ru", "entryCount": 8123,
    "generatorOpts": { "country": "RU", "asn": null, "asnList": null },
    "lastUpdated": "2026-03-15T10:00:00Z",
    "memberIds": []
  }, {
    "id": "uuid2", "name": "all_vpn", "type": "group",
    "entries": [], "memberIds": ["uuid-a", "uuid-b"],
    "entryCount": 42, "lastUpdated": "2026-03-15T10:00:00Z"
  }]
}
```

### `POST /api/aliases`
Создать алиас.
```json
// host/network type
{ "name": "my_hosts", "type": "host", "entries": ["1.2.3.4", "5.6.7.8"], "description": "" }
{ "name": "my_nets",  "type": "network", "entries": ["10.0.0.0/8", "192.168.0.0/16"] }

// ipset type (пустой при создании, наполняется через upload или generate)
{ "name": "ru", "type": "ipset", "description": "RU prefixes" }

// group type (ссылается на существующие host/network алиасы)
{ "name": "all_vpn", "type": "group", "memberIds": ["uuid-a", "uuid-b"] }

// Response
{ "alias": { "id": "uuid", ... } }
```

### `PATCH /api/aliases/:id`
Обновить алиас (name, description, entries для host/network, memberIds для group).

### `DELETE /api/aliases/:id`
Удалить алиас. Для ipset — уничтожает kernel set.
Если алиас используется как member в группе — возвращает HTTP 409 с именем группы.

### `POST /api/aliases/:id/upload`
Загрузить префиксы из текстового файла в ipset (один CIDR на строку).
```json
// Request
{ "text": "10.0.0.0/8\n192.168.0.0/16\n..." }
// Response
{ "alias": { "entryCount": 42, ... } }
```

### `POST /api/aliases/:id/generate`
Запустить фоновую генерацию ipset через RIPEstat API (PrefixFetcher).
```json
// Request — один из вариантов:
{ "country": "RU" }
{ "asn": "AS15169" }
{ "asnList": "12345,20485" }

// Response
{ "jobId": "uuid" }
```

### `GET /api/aliases/:id/generate/:jobId`
Статус фоновой генерации.
```json
// В процессе
{ "status": "running" }
// Завершено
{ "status": "done", "entryCount": 8123 }
// Ошибка
{ "status": "error", "error": "No prefixes returned" }
```

---

## Firewall Rules

Правила файрволла — единая сущность для фильтрации (ACCEPT/DROP/REJECT) и PBR (ACCEPT + gateway).
Правила применяются в порядке `order` (top-to-bottom) через кастомные iptables-цепочки:
- `FIREWALL_FORWARD` (filter table) — для ACCEPT/DROP/REJECT
- `FIREWALL_MANGLE` (mangle table) — для маркировки PBR (если задан gateway)

### `GET /api/firewall/interfaces`
Список сетевых интерфейсов хоста (для поля `interface` при создании правила).
```json
{ "interfaces": ["eth0", "wg10", "wg11", "lo"] }
```

### `GET /api/firewall/rules`
```json
{
  "rules": [{
    "id": "uuid", "name": "Block RU", "enabled": true, "order": 1,
    "interface": "any",            // "any" | "wg10" | "eth0" — ingress -i флаг
    "protocol": "any",             // "any" | "tcp" | "udp" | "tcp/udp" | "icmp"
    "source": {
      "type": "any",               // "any" | "cidr" | "alias"
      "aliasId": null, "value": null, "invert": false, "port": null
    },
    "destination": {
      "type": "alias", "aliasId": "uuid", "value": null, "invert": true, "port": null
    },
    "action": "drop",              // "accept" | "drop" | "reject"
    "gatewayId": null,             // только если action=accept
    "gatewayGroupId": null,
    "fwmark": null,                // авто-назначается при наличии gateway
    "log": false, "comment": "",
    "createdAt": "ISO string"
  }]
}
```

### `POST /api/firewall/rules`
Создать правило. Правило добавляется последним (order = max + 1).
```json
// Request
{
  "name": "Non-RU → KZ",            // опционально
  "interface": "any",               // опционально, default "any"
  "protocol": "any",                // опционально, default "any"
  "source": {
    "type": "any"
  },
  "destination": {
    "type": "alias",
    "aliasId": "uuid-of-ru-alias",
    "invert": true,                 // NOT — трафик НЕ в этот набор
    "port": "443"                   // опционально
  },
  "action": "accept",               // "accept" | "drop" | "reject"
  "gatewayId": "uuid-of-kz-gw",    // опционально, только для action=accept
  "gatewayGroupId": null,
  "log": false,
  "comment": ""
}
// Response
{ "rule": { "id": "uuid", ... } }
```

**Endpoint types:**
| type | Поля | Описание |
|------|------|----------|
| `any` | — | Без ограничений |
| `cidr` | `value: "10.0.0.0/8"` | Конкретный CIDR |
| `alias` | `aliasId: "uuid"` | Ссылка на алиас (host/network/ipset/group) |

`invert: true` добавляет `!` перед матчем (NOT).

Итоговые kernel-команды (пример ACCEPT + gateway PBR):
```bash
iptables-nft -t mangle -A FIREWALL_MANGLE -m set ! --match-set ru dst -j MARK --set-mark 1000
ip route add default via <gw.gatewayIP> dev <gw.interface> table 1000
ip rule add fwmark 1000 lookup 1000 priority 1010
iptables-nft -t filter -A FIREWALL_FORWARD -m set ! --match-set ru dst -j ACCEPT
```

### `PATCH /api/firewall/rules/:id`
Toggle или обновление правила:
```json
// Toggle
{ "enabled": false }
// Обновление — любые поля модели
{ "name": "New Name", "action": "drop", "gatewayId": null }
```

### `DELETE /api/firewall/rules/:id`
Удалить правило (перестраивает цепочки, убирает ip rule + ip route из ядра).

### `POST /api/firewall/rules/:id/move`
Переместить правило вверх или вниз (меняет порядок применения):
```json
{ "direction": "up" }   // или "down"
```

---

## System

### `GET /api/system/interfaces`
Список сетевых интерфейсов хоста (для выбора при создании Gateway).
```json
{ "interfaces": [{ "name": "eth0", "type": "ether", "operstate": "UP" }] }
```

---

## Admin Tunnel (WireGuard wg0)

Legacy API для admin-туннеля (страница Administration).

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/wireguard/client` | Список клиентов wg0 |
| POST | `/api/wireguard/client` | Создать клиента `{ name, expiredDate? }` |
| DELETE | `/api/wireguard/client/:id` | Удалить клиента |
| POST | `/api/wireguard/client/:id/enable` | Включить клиента |
| POST | `/api/wireguard/client/:id/disable` | Выключить клиента |
| PUT | `/api/wireguard/client/:id/name` | Переименовать `{ name }` |
| PUT | `/api/wireguard/client/:id/address` | Изменить адрес `{ address }` |
| PUT | `/api/wireguard/client/:id/expireDate` | Дата истечения `{ expireDate }` |
| POST | `/api/wireguard/client/:id/generateOneTimeLink` | Одноразовая ссылка |
| GET | `/api/wireguard/client/:id/qrcode.svg` | QR-код |
| GET | `/api/wireguard/client/:id/configuration` | Скачать `.conf` |
| GET | `/api/wireguard/backup` | Бэкап wg0 конфига |
| PUT | `/api/wireguard/restore` | Восстановить из бэкапа `{ file }` |

---

## Prometheus Metrics

### `GET /metrics`
Метрики в формате Prometheus text. Требует Basic Auth если `PROMETHEUS_METRICS_PASSWORD` задан.

### `GET /metrics/json`
Те же метрики в JSON формате.

---

## Коды ошибок

| Код | Описание |
|-----|----------|
| 400 | Bad Request — неверные параметры |
| 401 | Не авторизован |
| 404 | Ресурс не найден |
| 500 | Внутренняя ошибка сервера |

```json
{ "statusCode": 404, "message": "Interface not found" }
```
