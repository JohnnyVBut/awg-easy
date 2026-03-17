# AWG-Easy 3.0 — Migration Plan: Node.js → Go/Fiber

## Цель

Переписать AWG-Easy с Node.js/h3 на Go/Fiber.
Финальная цель (Фаза 2, отдельный этап): минимальный ISO-образ системы
с встроенным веб-приложением, загружаемый напрямую без Docker.

---

## Стек

| Компонент | Текущий (Node.js) | Новый (Go) |
|-----------|-------------------|------------|
| HTTP фреймворк | h3 | Fiber v2 |
| Хранилище | JSON файлы | **SQLite** (modernc.org/sqlite, pure Go) |
| Frontend | Vue 2 + CDN | Vue 2 + локальные файлы (Фаза 2: embed.FS) |
| Процесс | Docker + node | Docker + статический Go бинарник |
| Конфиг | ENV vars | ENV vars + /etc/wireguard/data/settings.json |

### Почему SQLite (modernc.org/sqlite)
- **Один файл** `/data/wireguard.db` = один `cp` для бэкапа
- **Pure Go** — CGO_ENABLED=0 сохраняется, статический бинарник
- **ACID транзакции** — безопасный конкурентный доступ без ручных мьютексов
- **WAL mode** — concurrent reads + serialized writes
- Стандартный формат: любой SQLite клиент читает данные напрямую

### Почему Fiber
- Express/h3-подобный API → минимальный cognitive overhead при миграции
- Богатая экосистема middleware (sessions, CORS, rate limit, static files)
- CGO_ENABLED=0 → полностью статический бинарник без libc зависимостей
- Подходит для Фазы 2 (ISO): один файл = всё приложение

### Главный gotcha Fiber: fasthttp memory model
Fiber использует fasthttp, который реиспользует request/context объекты.
`c.Body()` — ссылка на буфер, невалидна после выхода из хендлера.
**Правило:** если тело нужно за пределами хендлера — копировать:
```go
bodyCopy := make([]byte, len(c.Body()))
copy(bodyCopy, c.Body())
```

---

## Фазы

### Фаза 1 — Переписать приложение (текущая ветка: feature/go-rewrite)
Docker остаётся для разработки и тестирования.
Результат: Go бинарник, функционально идентичный Node.js версии.

### Фаза 2 — ISO/appliance (отдельная ветка, после Фазы 1)
- Alpine Linux кастомизация
- OpenRC сервис вместо Docker
- Persistent storage (USB/раздел монтируется в /data)
- Frontend CDN → embed.FS (все JS/CSS внутри бинарника, offline)
- First-boot wizard

---

## Структура проекта

```
awg-easy/
  cmd/
    awg-easy/
      main.go            ← точка входа, инициализация Fiber, флаги CLI
  internal/
    api/                 ← HTTP handlers (бывший Server.js)
      interfaces.go      ← /api/tunnel-interfaces/*
      peers.go           ← /api/tunnel-interfaces/:id/peers/*
      settings.go        ← /api/settings, /api/templates
      routing.go         ← /api/routing/*
      nat.go             ← /api/nat/*
      firewall.go        ← /api/firewall/*
      gateways.go        ← /api/gateways/*, /api/gateway-groups/*
      aliases.go         ← /api/aliases/*
      auth.go            ← login/logout/session
    tunnel/              ← TunnelInterface + InterfaceManager
    peer/                ← Peer model, config gen, QR
    settings/            ← Settings singleton
    routing/             ← RouteManager
    nat/                 ← NatManager
    firewall/            ← FirewallManager + simulateTrace
    gateway/             ← GatewayManager + GatewayMonitor
    ipset/               ← IpsetManager
    awgparams/           ← AwgParamGenerator
    util/                ← Util.Exec (timeout + SIGKILL)
  www/                   ← Frontend (static, embed.FS в Фазе 2)
    index.html
    js/
      vendor/            ← Vue 2, VueI18n, ApexCharts (локально в Фазе 2)
      app.js
      api.js
    css/
      app.css
  Dockerfile.go          ← Multi-stage Go build
  build-go.sh            ← Сборка образа
  docker-compose.go.yml  ← Запуск контейнера
  go.mod
  go.sum
  PLAN.md                ← этот файл
```

---

## Порядок миграции модулей

Принцип: **от простого к сложному**, каждый модуль — отдельный коммит после апрувала.

| # | Модуль | Go файл | Источник | Оценка | Статус |
|---|--------|---------|----------|--------|--------|
| 1 | CLI entry point + Fiber skeleton | `cmd/awg-easy/main.go` | — | 1 день | ✅ |
| 2 | SQLite db layer + Settings/Templates | `internal/db/db.go`, `internal/settings/settings.go` | `Settings.js` | 2 дня | ✅ |
| 3 | HTTP handlers: settings + templates | `internal/api/settings.go` | `Server.js` | 1 день | ✅ |
| 4 | AwgParamGenerator | `internal/awgparams/generator.go` | `AwgParamGenerator.js` | 1 день | ✅ |
| 5 | IpsetManager | `internal/ipset/manager.go` | `IpsetManager.js` | 2 дня | ✅ |
| 6 | AliasManager | `internal/aliases/manager.go` | `AliasManager.js` | 3 дня | ✅ |
| 7 | RouteManager | `internal/routing/manager.go` | `RouteManager.js` | 1 нед | ✅ |
| 8 | NatManager | `internal/nat/manager.go` | `NatManager.js` | 1 нед | ✅ |
| 9 | GatewayMonitor | `internal/gateway/monitor.go` | `GatewayMonitor.js` | 1 нед | ✅ |
| 10 | GatewayManager | `internal/gateway/manager.go` | `GatewayManager.js` | 3 дня | ✅ |
| 11 | FirewallManager | `internal/firewall/manager.go` | `FirewallManager.js` | 2-3 нед | ✅ |
| 12 | Peer | `internal/peer/peer.go` | `Peer.js` | 1 нед | ✅ |
| 13 | TunnelInterface | `internal/tunnel/interface.go` | `TunnelInterface.js` | 2 нед | ✅ |
| 14 | InterfaceManager | `internal/tunnel/manager.go` | `InterfaceManager.js` | 3 дня | ✅ |
| 15 | ~~WireGuard (admin tunnel)~~ | ~~`internal/tunnel/wireguard.go`~~ | ~~`WireGuard.js`~~ | — | ❌ SKIP |
| 16 | HTTP handlers | `internal/api/*.go` | `Server.js` | 2 нед | ✅ |
| 17 | Тестирование | — | — | 3-4 нед | ✅ |

**Итого: ~12-16 недель** (с AI-ассистентом)

### Почему модуль 15 пропущен
`WireGuard.js` управлял wg0 — единственным интерфейсом старой архитектуры.
В Go-переписке этот функционал полностью покрывается `TunnelInterface` + `InterfaceManager`.
"Admin tunnel" = обычный wg10 созданный пользователем через UI.
Обратная совместимость с feature/kernel-module не нужна — Go-реврайт использует SQLite.

---

## Критические фиксы — перенести точно

Все FIX-1..FIX-15 из CLAUDE.md должны быть реализованы в Go.
Особо важные:

| Fix | Суть | Go реализация |
|-----|------|---------------|
| FIX-1 | iptables-nft + `-A FORWARD` (не `-I`) | `generateConfig()` в tunnel package |
| FIX-2 | regenerateConfig() перед start() + down→up | `Start()` метод TunnelInterface |
| FIX-3 | stop() игнорирует "not a WireGuard interface" | `Stop()` проверяет err string |
| FIX-8 | AWG2 RemovePeer → Restart() | mutex + горутина |
| FIX-9 | AWG2 SetPeer → Reload() (syncconf) | mutex + горутина |
| FIX-10 | Exec timeout 30s, getStatus 5s | `context.WithTimeout` |
| FIX-11 | НИКОГДА `ip -j` | текстовый парсинг во всех командах |
| FIX-13 | InterfaceManager → RouteManager.RestoreAll() → NatManager | порядок в main.go |
| FIX-14 | NAT idempotent через `-C` check | `_applyRule()` в nat package |
| FIX-15b | Gateway fallback blackhole/default | GatewayMonitor событие → FirewallManager |

---

## Go-специфичные решения

### Concurrency (замена JS mutex)
```go
// Замена _reloadMutex в TunnelInterface:
type TunnelInterface struct {
    mu   sync.Mutex  // сериализует reload/restart
    data InterfaceData
}

func (t *TunnelInterface) KernelSetPeer(peer *Peer) error {
    t.mu.Lock()
    defer t.mu.Unlock()
    return t.reload()
}
```

### Util.Exec с timeout (FIX-10)
```go
func Exec(cmd string, timeout time.Duration) (string, error) {
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()
    c := exec.CommandContext(ctx, "bash", "-c", cmd)
    c.WaitDelay = timeout  // SIGKILL если не остановился
    out, err := c.CombinedOutput()
    return string(out), err
}
```

### GatewayMonitor (замена EventEmitter)
```go
type StatusChangeFunc func(gatewayID string, up bool)

type GatewayMonitor struct {
    mu       sync.RWMutex
    handlers []StatusChangeFunc
}

func (m *GatewayMonitor) OnStatusChange(h StatusChangeFunc) {
    m.mu.Lock()
    m.handlers = append(m.handlers, h)
    m.mu.Unlock()
}
```

### Сессии в Fiber
```go
store := session.New(session.Config{
    Expiration: 24 * time.Hour,
    KeyLookup:  "cookie:session_id",
})
// middleware:
sess, err := store.Get(c)
if sess.Get("authenticated") != true {
    return c.Status(401).JSON(fiber.Map{"error": "Unauthorized"})
}
```

### JSON persistence (без изменений структуры)
Данные хранятся в тех же JSON файлах — совместимость с feature/kernel-module.
Go struct теги должны совпадать с JS именами полей:
```go
type InterfaceData struct {
    ID       string `json:"id"`
    Name     string `json:"name"`
    Address  string `json:"address"`
    // ...
}
```

---

## Известные ограничения / TODO

### KNOWN-2: Пароль — дефолтный admin + принудительная смена

**Текущее поведение:** пароль задаётся только через `PASSWORD_HASH` ENV (bcrypt-хэш).
Если ENV не задан — сервер работает в open mode (без пароля).

**Желаемое поведение:**
- Первый старт без ENV → пароль по умолчанию `admin` (хэш зашит в коде)
- GET `/api/session` возвращает `"mustChangePassword": true` пока используется дефолтный пароль
- Frontend показывает обязательный модал смены пароля
- PATCH `/api/settings` `{ "password": "newpass" }` → bcrypt → сохраняется в `settings.json`
- `PASSWORD_HASH` ENV сохраняется как опция для миграции с Node.js-деплоев

**Что менять:** `internal/settings/settings.go` (добавить PasswordHash + IsDefaultPassword),
`internal/api/auth.go` (InitAuth читает из settings, GET /api/session добавляет mustChangePassword),
`internal/api/settings.go` (PATCH принимает password → hash → save).

### KNOWN-1: I1-I5 не генерируются при ручном создании шаблона

**Эндпоинт:** `POST /api/templates` (ручной CRUD)
**Поведение:** I1-I5 принимаются как есть из тела запроса (обычно пустые строки).
**Контраст:** `POST /api/templates/generate` (с `saveName`) корректно сохраняет I1-I5,
  сгенерированные через `awgparams.Generate()`.

**Почему оставили:** ручное создание шаблона без генератора — редкий случай.
  Пользователь всегда может воспользоваться `/generate` с `saveName`.

**Возможный фикс (не приоритет):**
  В `POST /api/templates` handler: если I1-I5 пустые и profile/intensity заданы →
  вызвать `awgparams.Generate()` и заполнить I1-I5 из результата.

---

## Правила работы в этой ветке

1. **Никакого кода без обсуждения и явного апрувала** — анализ → обсуждение → апрув → код
2. Читать файл ЦЕЛИКОМ перед Edit (CLAUDE.md правило №1)
3. После каждого коммита — **сразу пушить** (`git push origin feature/go-rewrite`)
4. После каждого коммита — обновлять worklog
5. Каждый модуль — отдельный коммит с подробным сообщением
6. Все критические FIX из CLAUDE.md воспроизводить точно
7. Документировать Go-специфичные решения в этом файле (раздел выше)

---

## Деплой (Фаза 1)

```bash
git pull origin feature/go-rewrite
./build-go.sh
docker compose -f docker-compose.go.yml down && docker compose -f docker-compose.go.yml up -d
```

---

## Checkpoint

**Последнее обновление:** 2026-03-17
**Текущий статус:** модули 1–17 готовы ✅ — Go/Fiber бэкенд полностью портирован и протестирован
**Следующий шаг:** KNOWN-2 (пароль по умолчанию + смена через UI) или начало Фазы 2 (ISO)
