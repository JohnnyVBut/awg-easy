# AWG-Easy 2.0 — Claude Memory

## ⚠️ ПРАВИЛО №1: ПЕРЕД РЕДАКТИРОВАНИЕМ ЛЮБОГО ФАЙЛА

**ВСЕГДА читать файл целиком через Read tool, ТОЛЬКО ПОТОМ делать точечное изменение через Edit.**
Никогда не писать код "из головы" или "по памяти" — только читать → редактировать.
Это предотвращает случайное уничтожение уже исправленных багов.

## ⚠️ ПРАВИЛО №2: TAILWIND CSS — ТОЛЬКО СУЩЕСТВУЮЩИЕ КЛАССЫ

`src/www/css/app.css` — прекомпилированный статический файл. Новые Tailwind-классы **не работают**.
Перед использованием любого класса проверить: `grep "класс" src/www/css/app.css`
Если класса нет — использовать `style="..."` (inline CSS).
Зафиксировано отсутствующие: `px-6`, `py-10`, `py-8`, `min-h-full`, `items-start`, **`p-6`**, **`border-t`**, **`border-neutral-*`**, **`space-y-2`**, **`space-y-4`**, **`space-y-6`**, **`hover:bg-*`** → нужен inline style.

**Замены для `p-6` (= 24px):**
- `p-6 pb-4` → `style="padding:24px 24px 16px;"` (header)
- `p-6 pt-4` → `style="padding:16px 24px 24px;"` (body/footer)
- `border-t dark:border-neutral-600` → `class="dark:border-neutral-600"` + `style="border-top-width:1px;"` (border-t отсутствует, цвет по умолчанию #e5e7eb, dark: класс переопределяет)
- `space-y-4` → `style="display:flex; flex-direction:column; gap:16px;"`
- `space-y-2` → `style="display:flex; flex-direction:column; gap:8px;"`

### Правильный паттерн для модалок — padding на оверлее:
```html
<!-- ПРАВИЛЬНО: padding на overlay + margin:0 auto на панели -->
<div v-if="showModal"
  class="fixed inset-0 bg-black bg-opacity-50 z-50 overflow-y-auto"
  style="padding:40px 24px;"
  @click.self="showModal = false">
  <div class="bg-white dark:bg-neutral-700 rounded-lg"
    style="max-width:520px; margin:0 auto;">
    <!-- контент -->
  </div>
</div>

<!-- НЕПРАВИЛЬНО — НЕ РАБОТАЕТ: -->
<!-- 1. flex wrapper + w-full → нет боковых отступов -->
<!-- 2. width:calc(100% - 48px) + margin:auto на панели → ненадёжно в fixed+overflow-y:auto контексте -->
```
`padding:40px 24px` на оверлее = гарантированно 24px слева/справа, 40px сверху/снизу.
`margin:0 auto` на панели = центрирование внутри контентной зоны оверлея.

---

## Правила работы

- Активная ветка: **`feature/kernel-module`** | Репо: `git@github.com:JohnnyVBut/awg-easy.git`
- Коммитить и пушить только в `feature/kernel-module`, не в worktree-ветки
- После каждого пуша напоминать команды деплоя на сервере
- Каждый коммит — подробное сообщение (что, почему, какие файлы)
- После завершения задачи обновлять `REQUIREMENTS.md` (статус) и этот файл

## Деплой на сервере

```bash
git pull origin feature/native-approach
./build.sh
docker compose down && docker compose up -d
```

---

## 🚨 КРИТИЧЕСКИЕ ФИКСЫ — ПРОВЕРЯТЬ ПЕРЕД КАЖДЫМ РЕДАКТИРОВАНИЕМ

Это фиксы которые были добавлены после обнаружения реальных багов.
При редактировании соответствующих файлов — **убедиться что эти строки на месте**.

### FIX-1: iptables-nft + FORWARD в обоих направлениях + NAT только если disableRoutes=false
**Файл:** `src/lib/TunnelInterface.js` → метод `generateWgConfig()`
**Причина:** Ubuntu 22.04 использует nftables. FORWARD нужен -i И -o. NAT только для клиентских интерфейсов.

```javascript
// ПРАВИЛЬНО (disableRoutes=false — клиентский интерфейс):
config += `PostUp = iptables-nft -I FORWARD -i ${this.id} -j ACCEPT; iptables-nft -I FORWARD -o ${this.id} -j ACCEPT; iptables-nft -t nat -A POSTROUTING -s ${subnet} -j MASQUERADE\n`;
config += `PostDown = iptables-nft -D FORWARD -i ${this.id} -j ACCEPT 2>/dev/null || true; iptables-nft -D FORWARD -o ${this.id} -j ACCEPT 2>/dev/null || true; iptables-nft -t nat -D POSTROUTING -s ${subnet} -j MASQUERADE 2>/dev/null || true\n`;

// ПРАВИЛЬНО (disableRoutes=true — interconnect интерфейс, без NAT):
config += `PostUp = iptables-nft -I FORWARD -i ${this.id} -j ACCEPT; iptables-nft -I FORWARD -o ${this.id} -j ACCEPT\n`;
config += `PostDown = iptables-nft -D FORWARD -i ${this.id} -j ACCEPT 2>/dev/null || true; iptables-nft -D FORWARD -o ${this.id} -j ACCEPT 2>/dev/null || true\n`;

// НЕПРАВИЛЬНО: iptables (без -nft), только -i без -o, или MASQUERADE при disableRoutes=true
```

### FIX-2: Конфиг регенерируется перед каждым start() + down→up при "already exists"
**Файл:** `src/lib/TunnelInterface.js` → метод `start()` (~строки 336-358)
**Причина:** `--network host` → интерфейс переживает docker restart → "already exists".

```javascript
// ПРАВИЛЬНО:
async start() {
  await this.regenerateConfig(); // ← ВСЕГДА перед подъёмом
  try {
    await Util.exec(`${this._quickBin} up ${this.id}`);
  } catch (err) {
    if (err.message && err.message.includes('already exists')) {
      await Util.exec(`${this._quickBin} down ${this.id}`);
      await Util.exec(`${this._quickBin} up ${this.id}`);
    } else {
      throw err;
    }
  }
  this.data.enabled = true;
  await this.save();
}
// НЕПРАВИЛЬНО: сразу throw err при "already exists", или без regenerateConfig()
```

### FIX-3: stop() игнорирует "not a WireGuard/AmneziaWG interface"
**Файл:** `src/lib/TunnelInterface.js` → метод `stop()` (~строки 363-378)
**Причина:** Интерфейс уже был остановлен — это нормально, не должно крашить.

```javascript
// ПРАВИЛЬНО:
async stop() {
  try {
    await Util.exec(`${this._quickBin} down ${this.id}`);
  } catch (err) {
    if (!err.message.includes('is not a WireGuard interface') &&
        !err.message.includes('is not an AmneziaWG interface')) {
      throw err;
    }
    // молча игнорируем — уже остановлен
  }
  this.data.enabled = false;
  await this.save();
}
```

### FIX-4: Non-overlapping H1-H4 (4 зоны uint32, не случайные числа)
**Файл:** `src/lib/Settings.js` → функция `generateRandomHRanges()` (~строки 19-34)
**Причина:** H1-H4 не должны пересекаться. Uint32 делится на 4 равные зоны.

```javascript
// ПРАВИЛЬНО:
function generateRandomHRanges() {
  const RANGE_SIZE = 50_000_000;
  const ZONE_SIZE = Math.floor((0xFFFFFFFF - 5) / 4);
  const randRange = (zone) => {
    const zoneStart = 5 + zone * ZONE_SIZE;
    const zoneEnd = zoneStart + ZONE_SIZE - 1;
    const start = zoneStart + Math.floor(Math.random() * (zoneEnd - zoneStart - RANGE_SIZE));
    return `${start}-${start + RANGE_SIZE}`;
  };
  return { h1: randRange(0), h2: randRange(1), h3: randRange(2), h4: randRange(3) };
}
// НЕПРАВИЛЬНО: Math.random() * 0xFFFFFFFF без зон — могут пересечься
```

### FIX-5: Vue 2 — обновление массива только через splice
**Файл:** `src/www/js/app.js` → метод `_applyInterfaceUpdate()`
**Причина:** `array[idx] = newItem` не триггерит реактивность Vue 2.

```javascript
// ПРАВИЛЬНО:
_applyInterfaceUpdate(updatedIface) {
  const idx = this.tunnelInterfaces.findIndex(i => i.id === updatedIface.id);
  if (idx !== -1) {
    this.tunnelInterfaces.splice(idx, 1, updatedIface); // ← только splice!
  } else {
    this.tunnelInterfaces.push(updatedIface);
  }
},
// НЕПРАВИЛЬНО: this.tunnelInterfaces[idx] = updatedIface
```

### FIX-6: Address пира вычисляется из AllowedIPs + маска интерфейса
**Файл:** `src/lib/Peer.js` → метод `_generateCompleteConfig()` (~строки 173-177)
**Причина:** Поле `remoteAddress` удалено. Address = IP из AllowedIPs + маска iface.

```javascript
// ПРАВИЛЬНО:
if (this.allowedIPs && interfaceData.address) {
  const peerIp = this.allowedIPs.split('/')[0];
  const ifaceMask = interfaceData.address.split('/')[1] || '24';
  config += `Address = ${peerIp}/${ifaceMask}\n`;
}
// НЕПРАВИЛЬНО: this.remoteAddress (поле не существует)
```

### FIX-7: _quickBin / _syncBin выбирается по протоколу
**Файл:** `src/lib/TunnelInterface.js` → геттеры `_quickBin` и `_syncBin`
**Причина:** amneziawg-2.0 требует `awg-quick`/`awg`, wireguard-1.0 требует `wg-quick`/`wg`.

```javascript
get _quickBin() { return this.data.protocol === 'amneziawg-2.0' ? 'awg-quick' : 'wg-quick'; }
get _syncBin()  { return this.data.protocol === 'amneziawg-2.0' ? 'awg' : 'wg'; }
// НЕПРАВИЛЬНО: захардкодить только wg-quick или только awg-quick
```

### FIX-8: _kernelRemovePeer — AWG2 использует restart(), WG1 — wg set peer remove
**Файл:** `src/lib/TunnelInterface.js` → метод `_kernelRemovePeer()`
**Причина:** `awg set peer remove` дедлочится в AWG kernel module. Безопасное решение — restart().
Сериализован через `_reloadMutex`.

```javascript
// ПРАВИЛЬНО:
async _kernelRemovePeer(peerId, _publicKey) {
  if (!this.data.enabled) return;
  this._reloadMutex = this._reloadMutex
    .then(async () => {
      try {
        await this.restart();
        debug(`Interface ${this.id} restarted to remove peer ${peerId}`);
      } catch (err) {
        debug(`_kernelRemovePeer restart failed for ${peerId}: ${err.message}`);
      }
    })
    .catch(() => {});
  return this._reloadMutex;
}
// НЕПРАВИЛЬНО: awg set peer remove (дедлок), или без _reloadMutex
```

### FIX-9: _kernelSetPeer — AWG2 использует syncconf (reload), WG1 — wg set peer
**Файл:** `src/lib/TunnelInterface.js` → метод `_kernelSetPeer()`
**Причина:** `awg set peer <key> <params>` нестабилен в AWG kernel module — занимает
10-15+ секунд даже при добавлении первого пира на чистый интерфейс. После завершения
оставляет ядро в плохом состоянии → getStatus() дедлочится. Подтверждено в production.
Для AWG2: используем reload() (awg syncconf) — конфиг на диске уже обновлён раньше.
Сериализован через `_reloadMutex` (через reload()).

```javascript
// ПРАВИЛЬНО:
async _kernelSetPeer(peer) {
  if (!this.data.enabled) return;
  if (this.data.protocol === 'amneziawg-2.0') {
    return this.reload(); // awg syncconf — атомарно, без awg set peer
  }
  // WireGuard 1.0: wg set надёжен
  this._reloadMutex = this._reloadMutex
    .then(async () => { /* wg set peer ... */ })
    .catch(() => {});
  return this._reloadMutex;
}
// НЕПРАВИЛЬНО: awg set peer add для AWG2 (медленно, оставляет ядро в плохом состоянии)
```

**Важно для обоих методов (_kernelRemovePeer и _kernelSetPeer):**
Оба идут через `_reloadMutex` — гарантирует что `restart()` и `reload()` никогда
не выполняются одновременно. Конкурентный awg syncconf + awg-quick up = deadlock.

### FIX-10: Util.exec — timeout по умолчанию 30s
**Файл:** `src/lib/Util.js` → метод `exec()`
**Причина:** Без timeout зависший `awg`/`wg` процесс живёт вечно. При polling каждую
секунду накапливаются сотни зависших дочерних процессов → исчерпание ресурсов → container freeze.

```javascript
// ПРАВИЛЬНО:
static async exec(cmd, { log = true, timeout = 30000 } = {}) {
  // ...
  const child = childProcess.exec(cmd, { shell: 'bash', timeout, killSignal: 'SIGKILL' }, callback);
}
// getStatus() вызывает с timeout: 5000 — быстро убивает зависший awg show dump
// НЕПРАВИЛЬНО: без timeout (childProcess.exec висит вечно)
```

---

## Архитектура проекта

### Стек
- **Backend**: Node.js, h3 (HTTP framework), bcryptjs, QRCode, express-session
- **Frontend**: Vue 2 (CDN, не webpack), Tailwind CSS (CDN), VueI18n, ApexCharts
- **WireGuard**: `awg-quick` (AWG2) / `wg-quick` (WG1), `--network host`

### Хранилище данных (`/etc/wireguard/data/`)
```
/etc/wireguard/data/
  settings.json          ← глобальные настройки + AWG2 templates
  interfaces/
    wg10.json            ← data-plane interface
    wg11.json
  peers/
    wg10/
      {uuid}.json        ← peer данные
```

### Ключевые файлы backend

| Файл | Роль |
|------|------|
| `src/lib/Server.js` | HTTP сервер (h3), все API маршруты |
| `src/lib/Settings.js` | Singleton: global settings + AWG2 templates |
| `src/lib/InterfaceManager.js` | Singleton: управление всеми data-plane интерфейсами |
| `src/lib/TunnelInterface.js` | Один WG/AWG интерфейс (start/stop/config/peers) |
| `src/lib/Peer.js` | Модель пира, генерация клиентского конфига и QR |
| `src/lib/WireGuard.js` | Старый wg0 (вкладка Clients, **не трогать**) |
| `src/www/js/api.js` | Все клиентские API методы |
| `src/www/js/app.js` | Vue app: data + methods |
| `src/www/index.html` | Весь UI (один файл, Vue template) |

### Дополнительные технические решения
- Маска пира всегда `/32` (AllowedIPs = "10.x.x.x/32")
- Интерфейсы нумеруются с wg10 (wg10, wg11, ...), порты с 51830
- H1-H4 хранятся как строки `"start-end"` — диапазоны одинаковые на обеих сторонах туннеля. Рандомизация внутри диапазона — задача AWG протокола, приложение её не выполняет
- Приватный ключ хранится на сервере (нужен для QR/download клиентов)

---

## API маршруты (новая архитектура)

```
GET/PUT  /api/settings
GET/POST /api/templates
GET/PUT/DELETE /api/templates/:id
POST /api/templates/:id/set-default
POST /api/templates/:id/apply          ← возвращает AWG2 params с fresh H1-H4

GET/POST /api/tunnel-interfaces
GET/PATCH/DELETE /api/tunnel-interfaces/:id
POST /api/tunnel-interfaces/:id/start  ← возвращает { interface: iface.toJSON() }
POST /api/tunnel-interfaces/:id/stop   ← возвращает { interface: iface.toJSON() }
POST /api/tunnel-interfaces/:id/restart ← возвращает { interface: iface.toJSON() }

GET/POST /api/tunnel-interfaces/:id/peers
POST /api/tunnel-interfaces/:id/peers/import-json  ← создать Interconnect peer из JSON
GET/PATCH/DELETE /api/tunnel-interfaces/:id/peers/:peerId
GET /api/tunnel-interfaces/:id/peers/:peerId/config
GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
POST /api/tunnel-interfaces/:id/peers/:peerId/enable
POST /api/tunnel-interfaces/:id/peers/:peerId/disable
GET /api/tunnel-interfaces/:id/peers/:peerId/export-json  ← JSON для передачи удалённой стороне
GET /api/tunnel-interfaces/:id/export-obfuscation         ← AWG2 params JSON
```

---

## UI Навигация — Sidebar + Per-Page Routing

**Архитектура:** Боковое меню (sidebar) + `activePage` переключает контент `<main>`.
Старые горизонтальные табы (`activeTab`) удалены. WAN Tunnels удалены полностью.

| Страница | Ключ `activePage` | Статус |
|----------|------------------|--------|
| Interfaces | `'interfaces'` | ✅ динамические вкладки, per-interface view (info + peers) |
| Gateways | `'gateways'` | ⏳ placeholder ("Coming soon") |
| Routing | `'routing'` | ⏳ placeholder ("Coming soon") |
| Firewall / NAT | `'firewall'` | ⏳ placeholder ("Coming soon") |
| Settings | `'settings'` | ✅ Global Settings + AWG2 Templates |
| Administration | `'administration'` | ✅ Admin Tunnel (бывший Clients tab) |

---

## Что сделано (хронология коммитов)

| Коммит | Ветка | Что |
|--------|-------|-----|
| `de31c42` | feature/kernel-module | fix: iptables-nft + FORWARD ACCEPT в PostUp/PostDown |
| `8892179` | feature/kernel-module | fix: регенерация конфига + down→up при "already exists" |
| `359984e` | feature/kernel-module | fix: H1-H4 как non-overlapping ranges |
| `63a7a18` | feature/kernel-module | refactor: убран remoteAddress, Address вычисляется из AllowedIPs |
| `c83b983` | feature/kernel-module | feat: Settings.js + Settings/Templates API |
| `7482fc2` | feature/kernel-module | feat(ui): вкладка Settings (Global Settings + AWG2 Templates) |
| `aa4feda` | feature/kernel-module | fix(ui): reactive status update after start/stop/restart |
| `f8ca1ab` | feature/kernel-module | feat(ui): S2S badge + runtimeEndpoint в карточке пира |
| `a3d0aa5` | feature/kernel-module | fix: interconnect peer allowedIPs = host /32, не подсеть |
| `028a7c5` | feature/kernel-module | fix: mutex для _kernelSetPeer + exec timeout |
| `b3c53be` | feature/kernel-module | fix: AWG2 _kernelSetPeer → awg syncconf вместо awg set peer |

---

## Checkpoint (текущее состояние)

**Активная ветка:** `feature/kernel-module`

**Что работает (backend):**
- NAT только для client-интерфейсов (disableRoutes=false), interconnect — без NAT ✅ TESTED
- H1-H4 не рандомизируются при apply template, копируются как есть ✅ TESTED
- Peer model: peerType, clientAllowedIPs, enabled, PSK автогенерация ✅
- addPeer: autoAllocateIP, generateKeys ✅
- getStatus: transferRx/Tx, latestHandshake ✅
- Export/Import interconnect peer params (JSON workflow) ✅ TESTED
- AWG kernel deadlock: _kernelSetPeer → syncconf, _kernelRemovePeer → restart ✅ TESTED
- Util.exec timeout 30s (5s для getStatus) ✅

**Что работает (frontend):**
- Sidebar навигация (6 пунктов)
- Interfaces page: dynamic tabs + per-interface view (info card + peers list)
- Interface card: "Export My Params" кнопка
- Peers: peerType toggle (Client/Interconnect) при создании
- Peers: Import JSON кнопка (interconnect workflow)
- Peer cards: S2S badge, runtimeEndpoint, online/offline, RX/TX, enable/disable
- Settings page: Global Settings + AWG2 Templates
- Administration page: Admin Tunnel (бывший Clients)
- Placeholder pages: Gateways, Routing, Firewall/NAT

**Что не реализовано:**
- Admin Instance backend (AdminInstance.js)
- Interfaces edit modal (name/address/protocol/settings/template dropdown)
- Gateways/Routing/Firewall backend

## Следующие задачи (по приоритету)

1. **Interfaces edit modal** — имя, адрес, протокол, дропдаун шаблона AWG2
2. **Admin Instance** — `src/lib/AdminInstance.js`, страница Administration
3. **Gateways/Routing/Firewall** — backend + UI

Полный список → `REQUIREMENTS.md` раздел "🚧 Не реализовано".
