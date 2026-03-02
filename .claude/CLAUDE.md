# AWG-Easy 2.0 — Claude Memory

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

## Архитектура проекта

### Стек
- **Backend**: Node.js, h3 (HTTP framework), bcryptjs, QRCode, express-session
- **Frontend**: Vue 2 (CDN, не webpack), Tailwind CSS (CDN), VueI18n, ApexCharts
- **WireGuard**: `awg-quick` (AWG2) / `wg-quick` (WG1), `--network host`

### Хранилище данных (`/etc/wireguard/data/`)
```
/etc/wireguard/data/
  settings.json          ← глобальные настройки + AWG2 templates
  admin.json             ← Admin Instance (ключи + peers) [не реализовано]
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
| `src/lib/WireGuard.js` | Старый wg0 (вкладка Clients, не трогать) |
| `src/www/js/api.js` | Все клиентские API методы |
| `src/www/js/app.js` | Vue app: data + methods |
| `src/www/index.html` | Весь UI (один файл, Vue template) |

### Критические технические решения
- PostUp/PostDown использует `iptables-nft` (не `iptables`) — Ubuntu 22.04 nftables
- При "already exists" на restart → down→up цикл
- H1-H4 = диапазоны `start-end`, рандомизируются при каждом `applyTemplate()`
- Приватный ключ хранится на сервере (нужен для QR/download клиентов)
- Маска пира всегда `/32`
- Интерфейсы нумеруются с wg10 (wg10, wg11, ...), порты с 51830

## Статус UI вкладок

| Вкладка | Ключ `activeTab` | Цвет | Статус |
|---------|-----------------|------|--------|
| Clients | `'clients'` | blue | ✅ старая архитектура |
| WAN Tunnels | `'wanTunnels'` | blue | ✅ deprecated |
| Tunnel Interfaces | `'tunnelInterfaces'` | green | ✅ частично |
| Settings | `'settings'` | purple | ✅ готово |
| Admin | `'admin'` | — | ❌ не реализовано |

## Что сделано (хронология коммитов)

| Коммит | Что |
|--------|-----|
| `de31c42` | fix: iptables-nft + FORWARD ACCEPT в PostUp/PostDown |
| `8892179` | fix: регенерация конфига + down→up при "already exists" |
| `359984e` | fix: H1-H4 как non-overlapping ranges |
| `63a7a18` | refactor: убран remoteAddress, Address вычисляется из AllowedIPs |
| `b4fc216` | docs: REQUIREMENTS.md |
| `e029c52` | docs: добавлены разделы Peers и Settings в REQUIREMENTS |
| `c83b983` | **feat: Settings.js + Settings/Templates API** |
| `7482fc2` | **feat(ui): вкладка Settings (Global Settings + AWG2 Templates)** |
| `b872903` | docs: обновлён статус в REQUIREMENTS.md |

## Следующий шаг по REQUIREMENTS.md

**Admin Instance** (backend + UI):
1. `src/lib/AdminInstance.js` — env vars → ключи → поднять при старте
2. API: `GET /api/admin`, `GET/POST/DELETE /api/admin/peers`, config + QR
3. UI: вкладка **Admin** (read-only статус интерфейса, список пиров)

После — **Instances Tab** (edit modal, Disable Routes, Load from template) и **Peers Tab** (отдельная вкладка, online/offline, traffic).

Полный список задач → `REQUIREMENTS.md` раздел "🚧 Не реализовано".
