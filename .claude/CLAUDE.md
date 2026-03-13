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
git pull origin feature/kernel-module
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

### FIX-11: ip -j (JSON флаг) зависает на некоторых ядрах Linux — НИКОГДА не использовать
**Файл:** `src/lib/RouteManager.js` — все методы работающие с `ip` командами
**Причина:** Флаг `-j` (JSON output) у `iproute2` использует другой путь через netlink API,
который на ряде конфигураций ядра Linux зависает **навсегда** (ни ответа, ни ошибки).
Подтверждено в production на Москве: `ip -j route show table main` висел бесконечно.
Контейнер с `--network host` делает polling каждую секунду → за несколько минут
накапливались десятки зависших процессов → `RouteManager.init()` не завершался →
все API-запросы к routing висели → UI показывал вечный Loading...

**Правило:** `ip -j` **ЗАПРЕЩЕНО** во всём проекте. Использовать только текстовый вывод + парсинг.

```javascript
// ПРАВИЛЬНО — текстовый вывод + _parseTextRoutes():
const out = await Util.exec('ip route show table main', { log: true, timeout: 5000 });
return RouteManager._parseTextRoutes(out || '');

// ПРАВИЛЬНО — ip rule show (текст) для обнаружения routing tables:
const out = await Util.exec('ip rule show', { log: false, timeout: 5000 });
// парсить строки вида "100: from all fwmark 0x1 lookup 100"

// ПРАВИЛЬНО — ip route get (текст):
const out = await Util.exec(`ip route get ${ip}`, { timeout: 5000 });
// парсить строку вида "10.8.0.5 dev wg0 src 10.8.0.1 uid 0"

// НЕПРАВИЛЬНО — НИКОГДА:
// ip -j route show table main  ← зависает
// ip -j route get 8.8.8.8      ← зависает
// ip -j rule show               ← зависает
// ip -j addr show               ← потенциально зависает
```

**Симптомы зависания `ip -j`:**
- docker logs показывает много повторяющихся `$ ip -j route show ...` без ответа
- UI показывает вечный "Loading..." при переходе на страницу Routing
- Через ~1 минуту (N×timeout) всё начинает работать — это таймауты Util.exec срабатывают

### FIX-12: HTTP method в fetch() — ВСЕГДА uppercase (Node.js 22 llhttp)
**Файл:** `src/www/js/api.js` → метод `call()` → `method: method.toUpperCase()`
**Причина:** Node.js 22 использует llhttp HTTP parser, который **строго требует** uppercase.
Fetch Standard нормализует GET/HEAD/POST/DELETE/OPTIONS/PUT, но **НЕ нормализует PATCH**.
`fetch(..., { method: 'patch' })` отправляет `patch` lowercase → llhttp отвергает с 400 + TCP RST
**до** попадания в h3/application код. Симптомы: `ERR_CONNECTION_RESET` + "в логах ничего нет".

```javascript
// ПРАВИЛЬНО: в call() — один раз покрывает все вызовы:
async call({ method, path, body }) {
  const res = await fetch(`./api${path}`, {
    method: method.toUpperCase(), // Node.js 22 llhttp: HTTP method must be uppercase
    ...
  });
}
// НЕПРАВИЛЬНО: method: 'patch', method: 'put', method: 'delete' (lowercase)
// Fetch Standard не нормализует PATCH — Node.js 22 отвергает на уровне HTTP парсера
```

### FIX-13: Порядок инициализации — InterfaceManager ПЕРВЫМ, затем RouteManager + NatManager
**Файл:** `src/lib/Server.js` → constructor (~строки 93-104)
**Причина (двойной баг):**

**Баг A** — lazy init: без eager init маршруты и NAT-правила восстанавливаются только при первом
открытии страницы Routing/NAT. При рестарте контейнера они отсутствуют в ядре.

**Баг B** — неправильный порядок: если RouteManager инициализируется ДО InterfaceManager,
картина такова:
1. RouteManager.init() добавляет `ip route add 10.x.x.x via ... dev wg10` — успешно
2. InterfaceManager.init() (lazy, при первом API-запросе) запускает интерфейсы
3. FIX-2: wg10 "already exists" → `awg-quick down wg10` → kernel удаляет ВСЕ маршруты на wg10
4. `awg-quick up wg10` — интерфейс пересоздан, но без кастомных маршрутов
5. Результат: маршруты в JSON есть, в ядре нет. Toggle → 500 (ip route del не находит маршрут)

**Правильный порядок:** InterfaceManager → (RouteManager + NatManager параллельно).
После start/restart интерфейса из UI: вызывать `rm.reapplyForDevice(id)`.

```javascript
// ПРАВИЛЬНО — в конструкторе Server:
InterfaceManager.getInstance()
  .then(() => Promise.all([
    RouteManager.getInstance().catch(err => debug(`RouteManager init error: ${err.message}`)),
    NatManager.getInstance().catch(err => debug(`NatManager init error: ${err.message}`)),
  ]))
  .catch(err => debug(`InterfaceManager init error: ${err.message}`));

// ПРАВИЛЬНО — в start и restart handlers:
const rm = await RouteManager.getInstance();
await rm.reapplyForDevice(id).catch(err => debug(`reapplyForDevice(${id}) failed: ${err.message}`));

// НЕПРАВИЛЬНО:
// RouteManager.getInstance();  // до InterfaceManager → маршруты стираются при down→up
// Не вызывать reapplyForDevice после start/restart → маршруты пропадают при ручном рестарте
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
GET /api/tunnel-interfaces/:id/export-params  ← { name, publicKey, endpoint, address, protocol, [presharedKey] }

GET/POST /api/tunnel-interfaces/:id/peers
POST /api/tunnel-interfaces/:id/peers/import-json  ← создать Interconnect peer из JSON
GET/PATCH/DELETE /api/tunnel-interfaces/:id/peers/:peerId
GET /api/tunnel-interfaces/:id/peers/:peerId/config
GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
POST /api/tunnel-interfaces/:id/peers/:peerId/enable
POST /api/tunnel-interfaces/:id/peers/:peerId/disable
GET /api/tunnel-interfaces/:id/export-obfuscation         ← AWG2 params JSON

GET    /api/nat/interfaces        ← список сетевых интерфейсов хоста (ip -o link show)
GET    /api/nat/rules             ← список NAT правил
POST   /api/nat/rules             ← создать правило { name, source, outInterface, type, toSource, comment }
PATCH  /api/nat/rules/:id         ← обновить правило | toggle: { enabled: bool }
DELETE /api/nat/rules/:id         ← удалить правило
```

---

## UI Навигация — Sidebar + Per-Page Routing

**Архитектура:** Боковое меню (sidebar) + `activePage` переключает контент `<main>`.
Старые горизонтальные табы (`activeTab`) удалены. WAN Tunnels удалены полностью.

| Страница | Ключ `activePage` | Статус |
|----------|------------------|--------|
| Interfaces | `'interfaces'` | ✅ динамические вкладки, per-interface view (info + peers) |
| Gateways | `'gateways'` | ⏳ placeholder ("Coming soon") |
| Routing | `'routing'` | ✅ Status (kernel routes + route test) + Static routes CRUD + OSPF placeholder |
| NAT | `'nat'` | ✅ Outbound NAT CRUD + toggle + Port Forwarding placeholder |
| Firewall | `'firewall'` | ⏳ placeholder ("Coming soon") |
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
| `337869e` | feature/kernel-module | feat(ui): dashboard view — все пиры всех интерфейсов на одном экране |
| `943a046` | feature/kernel-module | feat(ui): Edit Interface modal (имя, адрес, порт, AWG2 профиль) |
| `075ebc8` | feature/kernel-module | fix(ui): загрузка templates после логина (AWG2 дропдаун без визита Settings) |
| `138e33d` | feature/kernel-module | feat: Routing page — Status + Static Routes + OSPF placeholder (RouteManager, API, UI) |
| `152f010` | feature/kernel-module | fix: routing table discovery via kernel (ip rule show) instead of container rt_tables |
| `2f025c3` | feature/kernel-module | fix: add iproute2 explicitly to Dockerfile |
| `36b3191` | feature/kernel-module | fix(ui): show kernelRoutesError + loading indicator |
| `ef5d5cc` | feature/kernel-module | fix(ui): parallel loading + kernelRoutesLoading state |
| `b3c7153` | feature/kernel-module | fix: remove ALL ip -j usage — text parsing instead (hangs on some kernels) |
| `dfc34c8` | feature/kernel-module | fix: toJSON() missing settings + api.js json error + Server.js try-catch |
| `1579be6` | feature/kernel-module | fix: uppercase HTTP methods in api.js (Node.js 22 llhttp rejects lowercase) |
| `d75d7d5` | feature/kernel-module | feat(ui): toast notification system — replace all alert() with toasts |
| (pending) | feature/kernel-module | feat: NAT page — Outbound Source NAT CRUD (NatManager, API, UI) |

---

## Checkpoint (текущее состояние)

**Активная ветка:** `feature/kernel-module`
**Последний коммит:** `d75d7d5` + NAT feature (не закоммичено)

---

### ✅ Что работает — Backend

| Фича | Статус | Примечание |
|------|--------|------------|
| NAT только для client-iface (disableRoutes) | ✅ TESTED | interconnect — без MASQUERADE |
| H1-H4 non-overlapping zones | ✅ TESTED | 4 зоны по 1073741823 uint32 |
| Peer model: peerType, clientAllowedIPs, enabled, PSK | ✅ | |
| addPeer: autoAllocateIP, generateKeys | ✅ | |
| getStatus: transferRx/Tx, latestHandshake, runtimeEndpoint | ✅ | polling через setInterval |
| Export/Import interconnect peer JSON workflow | ✅ TESTED | PSK координация работает |
| AWG kernel deadlock fix: syncconf + restart | ✅ TESTED | awg set peer → убран для AWG2 |
| Util.exec timeout 30s / getStatus 5s | ✅ | SIGKILL при превышении |
| PATCH /api/tunnel-interfaces/:id | ✅ | hot-reload через syncconf, без даунтайма |
| RouteManager: getKernelRoutes (text parse) | ✅ TESTED | ip route show (без -j), работает на всех ядрах |
| RouteManager: getRoutingTables (ip rule show) | ✅ TESTED | обнаруживает хостовые таблицы (table 100 vpn_kz) |
| RouteManager: testRoute (text parse) | ✅ | ip route get, без -j |
| RouteManager: addRoute/deleteRoute/toggleRoute | ✅ | персистентность в routes.json |
| Routing API: GET /api/routing/table | ✅ | kernel routes по таблице |
| Routing API: GET /api/routing/tables | ✅ | список таблиц |
| Routing API: GET /api/routing/test | ✅ | route get |
| Routing API: GET/POST/PATCH/DELETE /api/routing/routes | ✅ | static routes CRUD |
| NatManager: addRule/updateRule/deleteRule/toggleRule | ✅ | персистентность в nat-rules.json |
| NatManager: getNetworkInterfaces | ✅ | ip -o link show (без -j, text parse) |
| NatManager: eager init в Server constructor | ✅ | правила применяются при старте контейнера |
| NAT API: GET /api/nat/interfaces | ✅ | список интерфейсов хоста |
| NAT API: GET/POST/PATCH/DELETE /api/nat/rules | ✅ | CRUD правил, toggle через PATCH {enabled} |

### ✅ Что работает — Frontend

| Страница/Компонент | Статус | Детали |
|-------------------|--------|--------|
| Sidebar (6 пунктов) | ✅ | Interfaces, Gateways, Routing, Firewall, Settings, Administration |
| Interfaces: вкладка "All" (дашборд) | ✅ | все пиры всех интерфейсов, дефолтный вид |
| Interfaces: dynamic tabs | ✅ | по одной вкладке на интерфейс |
| Interfaces: per-interface view | ✅ | Info card + Peers list |
| Interface card: "Edit" кнопка | ✅ | модал: имя, адрес, порт, AWG2 профиль |
| Interface card: "Export My Params" | ✅ | скачивает JSON для другой стороны |
| Dashboard peer cards | ✅ | серый бейдж interfaceName, все действия работают |
| Peers: create modal (Client/Interconnect toggle) | ✅ | peerType выбирается до создания |
| Peers: "Import JSON" кнопка | ✅ | interconnect workflow |
| Peer cards: S2S badge | ✅ | синий тег для peerType=interconnect |
| Peer cards: runtimeEndpoint | ✅ | IP:port из wg dump (обновляется ~1s) |
| Peer cards: online/offline dot | ✅ | красный мигающий = online |
| Peer cards: RX/TX stats | ✅ | текущий и накопленный трафик |
| Peer cards: enable/disable toggle | ✅ | |
| Peer cards: QR/download (только client) | ✅ | downloadableConfig = !!privateKey |
| Settings: Global Settings + AWG2 Templates | ✅ | |
| AWG2 дропдаун доступен сразу после логина | ✅ | fix: loadSettings() в login() |
| Administration: Admin Tunnel (старый Clients) | ✅ | |
| Routing: Status tab (kernel routes + route test) | ✅ TESTED | работает на Москве и КЗ |
| Routing: Static tab (CRUD + toggle) | ✅ | персистентность в routes.json |
| Routing: OSPF tab | ⏳ | placeholder "Coming soon" |
| Routing: таблица 100 в дропдауне | ✅ TESTED | обнаруживается через ip rule show |
| Toast-уведомления (правый верхний угол) | ✅ | зелёный (success) / красный (error), 7с, стекируются, dismiss × |
| NAT: Outbound NAT tab (CRUD таблица правил + toggle) | ✅ | |
| NAT: Add Rule modal (any/subnet/IP source, MASQUERADE/SNAT) | ✅ | |
| NAT: Edit Rule modal | ✅ | |
| NAT: Port Forwarding tab | ⏳ | placeholder "Coming soon" |
| Gateways / Firewall | ⏳ | placeholder "Coming soon" |

### ❌ Что не реализовано

1. **Admin Instance backend** — `src/lib/AdminInstance.js` (управление wg0/admin-туннелем через новую архитектуру)
2. **Gateways** — backend + UI
3. **Firewall** — backend + UI
4. **Port Forwarding (DNAT)** — backend + UI (страница NAT, вкладка Port Forwarding)

---

## S2S Interconnect Workflow (реализован, протестирован)

Сценарий: два сервера (A и B), нужно создать S2S туннель.

```
Сервер A:                          Сервер B:
1. Создать интерфейс wg10           1. Создать интерфейс wg10
   (адрес 10.100.0.1/24)               (адрес 10.100.1.1/24)
2. Export My Params →               2. Import JSON (файл от A)
   скачать wg10-params.json            → создаётся Interconnect peer
   { publicKey, endpoint,              → PSK генерируется автоматически
     address, protocol }
                                    3. Export My Params →
                                       скачать wg10-params.json
                                       { publicKey, endpoint,
                                         address, protocol,
                                         presharedKey }  ← PSK включён!
4. Import JSON (файл от B)
   → создаётся Interconnect peer
   → PSK берётся из файла (sync!)
```

**Ключевые детали реализации:**
- `export-params`: возвращает publicKey + endpoint (WG_HOST:port) + address + protocol
  + presharedKey если уже есть interconnect peer с PSK
- `import-json`: принимает оба формата — interface-params (address → /32) и peer-params (allowedIPs напрямую)
- AllowedIPs для interconnect пира = `<remote_ip>/32` (не подсеть — крипто-роутинг только до пира)
- PSK: сторона B генерирует при первом импорте, потом включает в свой export → A получает при импорте

---

## Следующие задачи (по приоритету)

### 1. Admin Instance (приоритет: средний)
**Что нужно:**
- `src/lib/AdminInstance.js` — загрузка из ENV vars (WG_DEFAULT_ADDRESS, WG_DEFAULT_DNS, etc.)
- Страница Administration: показать статус admin-туннеля, список клиентов (из WireGuard.js)
- **Файлы:** новый `src/lib/AdminInstance.js`, `src/www/index.html` (страница Administration), `src/lib/Server.js` (API)

### 2. Gateways/Routing/Firewall (приоритет: низкий)
- Заглушки "Coming soon" заменить на реальный UI
- Backend: `ip route add/del`, `iptables-nft` правила через API

Полный список → `REQUIREMENTS.md` раздел "🚧 Не реализовано".

---

## Детали реализации — Dashboard + Edit Interface

### Dashboard (вкладка "All")

**Данные:**
- `allPeers: []` — реактивный массив, каждый peer имеет `peer.interfaceId` + `peer.interfaceName`
- `_peerIfaceId(peer)` — возвращает `peer.interfaceId || activeInterfaceId` — правильный iface для API-вызовов
- `_refreshPeersOrAll()` — после действий над пиром вызывает нужный refresh (per-iface или all)

**Polling:**
```javascript
setInterval(() => {
  if (activePage === 'interfaces') {
    if (activeInterfaceId) refreshPeers();
    else refreshAllPeers(); // dashboard mode
  }
}, 1000);
```

**Watcher `activeInterfaceId`:** при переключении на null → немедленно вызывает `refreshAllPeers()`.

**Startup:** `loadTunnelInterfaces().then(() => refreshAllPeers())` — дашборд заполняется сразу.

### Edit Interface Modal

**Данные:** `showInterfaceEdit: false`, `interfaceEdit: { id, name, address, listenPort, disableRoutes, protocol, selectedTemplateId, settings: { jc, jmin, jmax, s1-s4, h1-h4, i1-i5 } }`

**Методы:**
- `openInterfaceEdit(iface)` — заполняет interfaceEdit из iface.data + открывает модал
- `onEditInterfaceTemplateSelect(templateId)` — заполняет interfaceEdit.settings из шаблона
- `saveInterfaceEdit()` — валидация → `api.updateTunnelInterface()` → `_applyInterfaceUpdate()` (Vue splice)

**Кнопка:** фиолетовая outline "Edit" в ряду кнопок interface info card.

**Backend flow:** `PATCH /api/tunnel-interfaces/:id` → `Object.assign(data, updates)` → `save()` → `regenerateConfig()` → `reload()` (syncconf, без даунтайма).

### Fix: AWG2 дропдаун после логина

**Проблема:** `loadSettings()` в mounted() получал 401, если приложение требует пароль. После логина вызывался только `loadTunnelInterfaces()`, шаблоны не загружались.

**Фикс:** добавлен `this.loadSettings()` рядом с `this.loadTunnelInterfaces()` в `login()` handler.
