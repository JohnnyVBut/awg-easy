# AWG-Easy 2.0 — Claude Memory

## ⚠️ ПРАВИЛО №1: ПЕРЕД РЕДАКТИРОВАНИЕМ ЛЮБОГО ФАЙЛА

**ВСЕГДА читать файл целиком через Read tool, ТОЛЬКО ПОТОМ делать точечное изменение через Edit.**
Никогда не писать код "из головы" или "по памяти" — только читать → редактировать.
Это предотвращает случайное уничтожение уже исправленных багов.

## ⚠️ ПРАВИЛО №2: TAILWIND CSS — ТОЛЬКО СУЩЕСТВУЮЩИЕ КЛАССЫ

`src/www/css/app.css` — прекомпилированный статический файл. Новые Tailwind-классы **не работают**.
Перед использованием любого класса проверить: `grep "класс" src/www/css/app.css`
Если класса нет — использовать `style="..."` (inline CSS).
Зафиксировано отсутствующие: `px-6`, `py-10`, `py-8`, `min-h-full`, `items-start` → нужен inline style.
Для модальных wrapper-div использовать: `style="display:flex; min-height:100%; align-items:flex-start; justify-content:center; padding:40px 24px;"`

---

## Правила работы

- Ветка: `feature/kernel-module` | Репо: `git@github.com:JohnnyVBut/awg-easy.git`
- Коммитить и пушить **только в `feature/kernel-module`**, не в worktree-ветки
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

### FIX-1: iptables-nft (не iptables) + FORWARD в обоих направлениях
**Файл:** `src/lib/TunnelInterface.js` → метод `generateWgConfig()` (~строки 268-269)
**Причина:** Ubuntu 22.04 использует nftables. `iptables` не работает. FORWARD нужен -i И -o.

```javascript
// ПРАВИЛЬНО:
config += `PostUp = iptables-nft -I FORWARD -i ${this.id} -j ACCEPT; iptables-nft -I FORWARD -o ${this.id} -j ACCEPT; iptables-nft -t nat -A POSTROUTING -s ${subnet} -j MASQUERADE\n`;
config += `PostDown = iptables-nft -D FORWARD -i ${this.id} -j ACCEPT; iptables-nft -D FORWARD -o ${this.id} -j ACCEPT; iptables-nft -t nat -D POSTROUTING -s ${subnet} -j MASQUERADE\n`;
// НЕПРАВИЛЬНО: iptables (без -nft), или только -i без -o
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
- H1-H4 хранятся как строки `"start-end"` (awg-quick выбирает значение в диапазоне)
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
GET/PATCH/DELETE /api/tunnel-interfaces/:id/peers/:peerId
GET /api/tunnel-interfaces/:id/peers/:peerId/config
GET /api/tunnel-interfaces/:id/peers/:peerId/qrcode.svg
```

---

## Статус UI вкладок

| Вкладка | Ключ `activeTab` | Цвет | Статус |
|---------|-----------------|------|--------|
| Clients | `'clients'` | blue | ✅ старая архитектура |
| WAN Tunnels | `'wanTunnels'` | blue | ✅ deprecated |
| Tunnel Interfaces | `'tunnelInterfaces'` | green | ✅ частично |
| Settings | `'settings'` | purple | ✅ готово |
| Admin | `'admin'` | — | ❌ не реализовано |

---

## Что сделано (хронология коммитов)

| Коммит | Что |
|--------|-----|
| `de31c42` | fix: iptables-nft + FORWARD ACCEPT в PostUp/PostDown |
| `8892179` | fix: регенерация конфига + down→up при "already exists" |
| `359984e` | fix: H1-H4 как non-overlapping ranges |
| `63a7a18` | refactor: убран remoteAddress, Address вычисляется из AllowedIPs |
| `b4fc216` | docs: REQUIREMENTS.md |
| `e029c52` | docs: добавлены разделы Peers и Settings в REQUIREMENTS |
| `c83b983` | feat: Settings.js + Settings/Templates API |
| `7482fc2` | feat(ui): вкладка Settings (Global Settings + AWG2 Templates) |
| `b872903` | docs: обновлён статус в REQUIREMENTS.md |
| `aa4feda` | fix(ui): reactive status update after start/stop/restart |

---

## Checkpoint (текущее состояние)

**Последний коммит:** `aa4feda`
**Ветка:** `feature/kernel-module`
**Что работает:** Settings tab + AWG2 Templates + Tunnel Interfaces (create/start/stop/restart с реактивным UI обновлением)
**Что не реализовано:** Admin tab, Instances edit modal, Peers tab

## Следующие задачи (по приоритету)

### 1. Admin Instance
- `src/lib/AdminInstance.js` — env vars → ключи → поднять при старте
- API: `GET /api/admin`, `GET/POST/DELETE /api/admin/peers`, config + QR
- UI: вкладка **Admin** (read-only статус, список пиров)

### 2. Instances Tab улучшения
- Edit modal (name/address/protocol/settings)
- Disable Routes checkbox
- Load from template dropdown + авто-заполнение AWG2
- Public key display + Copy button

### 3. Peers Tab
- Отдельная вкладка, filter по интерфейсу
- Enable/disable toggle, online/offline (latestHandshake), RX/TX

Полный список → `REQUIREMENTS.md` раздел "🚧 Не реализовано".
