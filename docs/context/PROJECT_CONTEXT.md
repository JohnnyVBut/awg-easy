# 🚀 AWG-Easy: Контекст разработки (30 января 2026)

## 📌 Проект

**AWG-Easy** - веб-интерфейс для управления WireGuard и AmneziaWG VPN туннелями  
**Репозиторий:** https://github.com/JohnnyVBut/awg-easy  
**Текущая ветка:** `feature/wan-tunnels`  
**Технологии:** Node.js, Express, Vue.js, Docker, WireGuard, AmneziaWG

---

## 📊 Текущее состояние проекта

### ✅ Что работает (в development ветке):

1. **VPN Users** - управление клиентами WireGuard/AmneziaWG
2. **WAN Tunnels** - Site-to-Site VPN туннели (текущая реализация)
   - Модель: 1 туннель = 1 интерфейс + 1 peer (1:1)
   - Недавно добавлены поля Tunnel Address для PBR
   - Генерация конфигов для обеих сторон

### 🚧 В разработке (feature/wan-tunnels):

**Новая архитектура туннелей:**
- Модель: 1 интерфейс → много peers (1:N) - hub-and-spoke
- Разделение Interface и Peer как отдельные сущности
- Как в pfSense/OPNsense

---

## 🎯 Цель текущей разработки

### Проблема старой модели:

```
WAN Tunnel = Interface + Peer (слитно)
├─ wg10 → Office-A (1:1)
├─ wg11 → Office-B (1:1)
└─ wg12 → Office-C (1:1)

Проблемы:
❌ Нельзя добавить второй peer к одному интерфейсу
❌ Hub-and-spoke требует много интерфейсов
❌ Смешивает локальную и удалённую конфигурацию
```

### Решение - новая модель:

```
Interface wg10 (Main VPN Hub)
  ├─ Peer "Office-A"
  ├─ Peer "Office-B"
  └─ Peer "Office-C"

Преимущества:
✅ Один интерфейс для всех подключений
✅ Логическое разделение Interface и Peer
✅ Гибкость - можно добавлять/удалять peers
✅ Соответствует WireGuard концепции
✅ Как в pfSense/OPNsense
```

---

## 📁 Созданные файлы новой архитектуры

### Backend (Node.js):

**src/lib/TunnelInterface.js** (10 KB)
- Класс управления интерфейсом (wg10, wg11, etc.)
- Один интерфейс → много peers
- Генерация WireGuard конфига из интерфейса + peers
- Методы: start(), stop(), restart(), reload(), addPeer(), removePeer()

**src/lib/Peer.js** (11 KB)
- Класс представления удалённого подключения
- Данные: name, publicKey, endpoint, allowedIPs, remoteAddress
- Валидация данных
- Генерация remote config для скачивания (опциональная функция)

**src/lib/InterfaceManager.js** (8.7 KB)
- Singleton менеджер всех интерфейсов
- Управление созданием/удалением интерфейсов
- Auto-assign портов и имён интерфейсов (wg10, wg11...)
- Управление peers через интерфейсы

**src/routes/tunnel-interfaces.js** (11 KB)
- Express REST API routes
- Endpoints для интерфейсов и peers
- Полный CRUD для обеих сущностей

---

## 🗂️ Файловая структура данных

```
/etc/wireguard/
├── data/                          ← Новая структура
│   ├── interfaces/
│   │   ├── wg10.json             ← Данные интерфейса
│   │   └── wg11.json
│   └── peers/
│       ├── wg10/
│       │   ├── uuid-1.json       ← Данные peer
│       │   ├── uuid-2.json
│       │   └── uuid-3.json
│       └── wg11/
│           └── uuid-4.json
│
├── wg10.conf                     ← Генерируется автоматически
└── wg11.conf
```

---

## 🔌 API Endpoints (новая архитектура)

### Interfaces:
```
GET    /api/tunnel-interfaces              # Список интерфейсов
POST   /api/tunnel-interfaces              # Создать интерфейс
GET    /api/tunnel-interfaces/:id          # Инфо об интерфейсе
PATCH  /api/tunnel-interfaces/:id          # Обновить интерфейс
DELETE /api/tunnel-interfaces/:id          # Удалить интерфейс
POST   /api/tunnel-interfaces/:id/start    # Запустить
POST   /api/tunnel-interfaces/:id/stop     # Остановить
POST   /api/tunnel-interfaces/:id/restart  # Перезапустить
```

### Peers:
```
GET    /api/tunnel-interfaces/:id/peers                # Список peers
POST   /api/tunnel-interfaces/:id/peers                # Добавить peer
GET    /api/tunnel-interfaces/:id/peers/:peerId        # Инфо о peer
PATCH  /api/tunnel-interfaces/:id/peers/:peerId        # Обновить peer
DELETE /api/tunnel-interfaces/:id/peers/:peerId        # Удалить peer
GET    /api/tunnel-interfaces/:id/peers/:peerId/config # Скачать конфиг
```

---

## 📝 Пример использования API

### Создать интерфейс:
```json
POST /api/tunnel-interfaces
{
  "name": "Main VPN Hub",
  "protocol": "wireguard-1.0",
  "address": "10.100.0.1/24",
  "listenPort": 51830
}

Response: { "interface": { "id": "wg10", ... } }
```

### Добавить peer:
```json
POST /api/tunnel-interfaces/wg10/peers
{
  "name": "Office-A",
  "publicKey": "aBcD1234...",
  "endpoint": "office-a.com:51820",
  "allowedIPs": "192.168.1.0/24",
  "remoteAddress": "10.100.0.2/24",
  "persistentKeepalive": 25
}

Response: { "peer": { "id": "uuid-1234", ... } }
```

---

## 🔧 Технические детали

### Зависимости:
- **uuid** - для генерации peer IDs (нужно добавить в package.json)
- **debug** - для логирования
- **express** - REST API

### Структура данных Peer:

```javascript
{
  id: "uuid",                      // Уникальный ID
  name: "Office-A",                // Friendly name
  interfaceId: "wg10",             // К какому интерфейсу
  publicKey: "...",                // Public key удалённой стороны
  presharedKey: "",                // PSK (опционально)
  endpoint: "office-a.com:51820",  // Endpoint удалённой стороны
  allowedIPs: "192.168.1.0/24",    // Какие сети маршрутизировать
  remoteAddress: "10.100.0.2/24",  // Туннельный IP удалённой стороны
  persistentKeepalive: 25,         // Keepalive
  enabled: true,                   // Включен ли
  createdAt: "2026-01-30..."       // Дата создания
}
```

### Hot Reload:
Используется `wg syncconf` для применения изменений без остановки туннеля:
```bash
wg syncconf wg10 <(wg-quick strip wg10)
```

---

## ❓ Открытые вопросы для обсуждения

### 1. Download Config функция
**Вопрос:** Нужна ли функция скачивания конфига для удалённой стороны?

**За:**
- Удобно для настройки remote без AWG-Easy
- Шаблон для других систем (Mikrotik, pfSense)

**Против:**
- Опциональная функция, не обязательная для работы
- Может запутать пользователей

**Текущий статус:** Реализована, но опциональна

---

### 2. Import Config функция
**Вопрос:** Добавить ли возможность импорта конфига при создании Peer?

**Workflow:**
```
1. Remote сторона создаёт конфиг
2. Hub импортирует .conf файл
3. Парсинг → автозаполнение полей
4. Create Peer
```

**Статус:** Не реализована, обсуждается

---

### 3. UI дизайн
**Вопрос:** Как должен выглядеть UI для новой модели?

**Варианты:**

**Вариант A - Две вкладки:**
```
┌─────────────────────────────────┐
│ [Interfaces] [Peers]            │
├─────────────────────────────────┤
│ Interfaces:                     │
│ ├─ wg10 (Main Hub) [3 peers]   │
│ └─ wg11 (AWS DC)   [1 peer]    │
└─────────────────────────────────┘
```

**Вариант B - Вложенный список:**
```
┌─────────────────────────────────┐
│ Tunnel Interfaces               │
├─────────────────────────────────┤
│ ▶ wg10 - Main Hub               │
│   Port: 51830 | Peers: 3        │
│ ▼ wg11 - AWS DC                 │
│   Port: 51831 | Peers: 1        │
│   ├─ Peer "Office-A"            │
│   │  [Edit] [Delete] [Config]   │
│   └─ [Add Peer]                 │
└─────────────────────────────────┘
```

**Статус:** Не реализован, требует обсуждения

---

## 🚀 Следующие шаги

### Приоритет 1: Интеграция Backend

**Задачи:**
1. Скопировать файлы в проект:
   - TunnelInterface.js → src/lib/
   - Peer.js → src/lib/
   - InterfaceManager.js → src/lib/
   - tunnel-interfaces.js → src/routes/

2. Добавить в package.json:
   ```json
   "dependencies": {
     "uuid": "^9.0.0"
   }
   ```

3. Интегрировать routes в Server.js:
   ```javascript
   const tunnelInterfacesRoutes = require('../routes/tunnel-interfaces');
   app.use('/api/tunnel-interfaces', tunnelInterfacesRoutes);
   ```

4. Тестировать API через curl/Postman

---

### Приоритет 2: Frontend UI

**Задачи:**
1. Определить UI дизайн (Вариант A или B)
2. Создать Vue компоненты:
   - InterfacesList.vue
   - InterfaceForm.vue
   - PeersList.vue
   - PeerForm.vue
3. Добавить вкладку "Tunnel Interfaces" в index.html
4. Интегрировать с API

---

### Приоритет 3: Тестирование

**Задачи:**
1. Unit тесты для классов
2. Integration тесты API
3. E2E тесты UI
4. Тестирование на реальных туннелях

---

## 📚 История разработки (краткая)

### Фаза 1: Исправление WAN Tunnels (29 января)
- Добавлены поля Tunnel Address (localTunnelAddress, remoteTunnelAddress)
- Исправлена генерация remote конфигов
- Исправлена передача данных в API (payload fix)
- Автогенерация ключей для remote стороны

**Файлы:** index.html, app.js, WanTunnel.js, TunnelManager.js

### Фаза 2: Анализ требований (30 января)
- Обсуждение логичности текущей модели
- Предложение разделить Interface и Peer
- Анализ валидности требований
- Оценка подводных камней

### Фаза 3: Новая архитектура (30 января - сейчас)
- Создание Backend классов
- Создание API endpoints
- Подготовка к Frontend разработке

**Ветка:** feature/wan-tunnels

---

## 🔑 Ключевые принципы

### Backend:
- **Singleton** для InterfaceManager
- **Композиция** - Interface содержит Peers
- **Separation of Concerns** - Interface vs Peer
- **Hot Reload** - изменения без перезапуска
- **Валидация** - проверка данных перед сохранением
- **Auto-generation** - ключи, порты, имена интерфейсов

### Frontend (планируется):
- **Vue.js** компоненты
- **Формы** для создания/редактирования
- **Списки** с возможностью expand/collapse
- **Валидация** на клиенте
- **Feedback** - loading states, error messages

---

## 💡 Важные замечания

### О Download Config:
- Это **опциональная helper функция**
- НЕ обязательна для работы Peer
- Полезна для настройки remote без AWG-Easy
- Можно создать Peer вручную указав только 5 параметров:
  1. Endpoint
  2. Public Key
  3. PSK (опционально)
  4. Remote Address
  5. AllowedIPs

### О WireGuard:
- Один интерфейс может иметь **неограниченное** количество peers
- Это стандартная hub-and-spoke модель
- AllowedIPs определяет куда маршрутизировать трафик
- Endpoint опционален (для incoming-only connections)

### О миграции:
- Старые WAN Tunnels пока оставляем
- Миграция отложена до завершения новой архитектуры
- Можно реализовать позже через migration script

---

## 🎯 Текущий фокус

**СЕЙЧАС НУЖНО:**

1. **Решить по UI дизайну** - какой вариант использовать?
2. **Интегрировать Backend** - скопировать файлы, добавить routes
3. **Протестировать API** - через curl/Postman
4. **Создать Frontend** - Vue компоненты для управления

**ПОТОМ:**
- Миграция старых WAN Tunnels
- Удаление deprecated кода
- Документация
- Release

---

## 📞 Контакты и ресурсы

- **GitHub:** https://github.com/JohnnyVBut/awg-easy
- **Ветка:** feature/wan-tunnels
- **Документация WireGuard:** https://www.wireguard.com/
- **AmneziaWG:** https://github.com/amnezia-vpn/amneziawg

---

**Дата создания контекста:** 30 января 2026  
**Последнее обновление:** 30 января 2026 10:30 UTC  
**Статус:** Backend готов, ждёт интеграции и Frontend разработки
