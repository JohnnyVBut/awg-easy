# 🔧 Решение проблемы "Connected но трафик не идет"

## 🔍 Симптомы

- ✅ Клиент подключается (status: Connected)
- ✅ Handshake успешен
- ❌ Трафик не ходит (нет интернета)
- ❌ Ping не работает

## 🐛 Возможные причины

### 1. IP Forwarding отключен
### 2. Неправильный сетевой интерфейс (WG_DEVICE)
### 3. Проблемы с iptables/nftables
### 4. DNS не работает
### 5. Firewall блокирует

---

## ✅ Диагностика

### Шаг 1: Проверить что контейнер запущен

```bash
docker ps | grep awg-easy
```

Должно показать работающий контейнер.

### Шаг 2: Проверить WireGuard интерфейс

```bash
docker exec awg-easy wg show
```

Должно показать:
```
interface: wg0
  public key: ...
  private key: (hidden)
  listening port: 51820

peer: <client-public-key>
  preshared key: (hidden)
  endpoint: <client-ip>:port
  allowed ips: 10.8.0.2/32
  latest handshake: 10 seconds ago   # <-- ВАЖНО!
  transfer: 1.23 KiB received, 2.34 KiB sent
```

**Проверить:**
- `latest handshake` - должен быть недавним (< 2 минут)
- `transfer` - должны быть цифры (если трафик идет)

### Шаг 3: Проверить IP forwarding

```bash
docker exec awg-easy sysctl net.ipv4.ip_forward
```

Должно быть:
```
net.ipv4.ip_forward = 1
```

Если `= 0`, то это проблема!

### Шаг 4: Проверить какой сетевой интерфейс

```bash
docker exec awg-easy ip route | grep default
```

Вывод (пример):
```
default via 172.17.0.1 dev eth0
```

Интерфейс обычно `eth0`, но может быть другой!

### Шаг 5: Проверить iptables правила

```bash
docker exec awg-easy iptables -t nat -L POSTROUTING -v -n
```

Должно быть правило MASQUERADE:
```
Chain POSTROUTING (policy ACCEPT)
target     prot opt source               destination
MASQUERADE  all  --  10.8.0.0/24         0.0.0.0/0
```

### Шаг 6: Проверить FORWARD правила

```bash
docker exec awg-easy iptables -L FORWARD -v -n
```

Должно быть:
```
Chain FORWARD (policy ACCEPT)
ACCEPT     all  --  wg0    *       0.0.0.0/0            0.0.0.0/0
ACCEPT     all  --  *      wg0     0.0.0.0/0            0.0.0.0/0
```

---

## 🔧 Исправления

### Исправление 1: IP Forwarding

Если `net.ipv4.ip_forward = 0`:

```bash
# Остановить контейнер
docker stop awg-easy
docker rm awg-easy

# Запустить с правильными sysctl
docker run -d \
  --sysctl="net.ipv4.ip_forward=1" \
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" \
  ... (остальные параметры)
```

Или в `docker-compose.yml`:
```yaml
sysctls:
  - net.ipv4.ip_forward=1
  - net.ipv4.conf.all.src_valid_mark=1
```

### Исправление 2: Неправильный WG_DEVICE

Если интерфейс не `eth0`, а например `ens3`:

```bash
# Узнать правильный интерфейс
docker exec awg-easy ip route | grep default
# Вывод: default via 172.17.0.1 dev ens3

# Пересоздать с правильным WG_DEVICE
docker stop awg-easy
docker rm awg-easy

# Добавить в запуск:
-e WG_DEVICE=ens3 \
```

### Исправление 3: Ручное добавление iptables правил

Если правила не создались автоматически:

```bash
# Войти в контейнер
docker exec -it awg-easy sh

# Добавить правила вручную
iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
iptables -A FORWARD -i wg0 -j ACCEPT
iptables -A FORWARD -o wg0 -j ACCEPT

# Проверить
iptables -t nat -L POSTROUTING -v -n
iptables -L FORWARD -v -n

# Выйти
exit
```

### Исправление 4: Использовать nftables вместо iptables

Если iptables не работает (современные системы используют nftables):

```bash
docker exec -it awg-easy sh

# Проверить что используется
iptables --version
# Если пишет "nf_tables", значит это nftables backend

# Применить правила через nft
nft add table ip nat
nft add chain ip nat POSTROUTING { type nat hook postrouting priority 100 \; }
nft add rule ip nat POSTROUTING ip saddr 10.8.0.0/24 oifname "eth0" masquerade

nft add table ip filter
nft add chain ip filter FORWARD { type filter hook forward priority 0 \; policy accept \; }
nft add rule ip filter FORWARD iifname "wg0" accept
nft add rule ip filter FORWARD oifname "wg0" accept
```

### Исправление 5: Полный рестарт WireGuard

```bash
docker exec awg-easy wg-quick down wg0
docker exec awg-easy wg-quick up wg0
```

---

## 🎯 Быстрое решение (скрипт)

Создайте файл `fix-routing.sh`:

```bash
#!/bin/bash

echo "=== Checking AWG-Easy routing ==="

# Получить интерфейс
INTERFACE=$(docker exec awg-easy ip route | grep default | awk '{print $5}')
echo "Network interface: $INTERFACE"

# Проверить IP forwarding
FORWARD=$(docker exec awg-easy sysctl -n net.ipv4.ip_forward)
echo "IP forwarding: $FORWARD"

if [ "$FORWARD" != "1" ]; then
    echo "ERROR: IP forwarding is disabled!"
    echo "Recreate container with: --sysctl=net.ipv4.ip_forward=1"
    exit 1
fi

# Проверить iptables
echo ""
echo "=== Checking iptables rules ==="
docker exec awg-easy iptables -t nat -L POSTROUTING -v -n | grep MASQUERADE

if [ $? -ne 0 ]; then
    echo "WARNING: MASQUERADE rule not found!"
    echo "Adding manually..."
    docker exec awg-easy iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o $INTERFACE -j MASQUERADE
    docker exec awg-easy iptables -A FORWARD -i wg0 -j ACCEPT
    docker exec awg-easy iptables -A FORWARD -o wg0 -j ACCEPT
    echo "Rules added!"
fi

echo ""
echo "=== Final check ==="
docker exec awg-easy iptables -t nat -L POSTROUTING -v -n
docker exec awg-easy iptables -L FORWARD -v -n | grep wg0

echo ""
echo "Done! Try reconnecting your client."
```

Запуск:
```bash
chmod +x fix-routing.sh
./fix-routing.sh
```

---

## 🧪 Тест с клиента

После исправления, с клиента проверить:

### 1. Ping VPN сервера
```bash
ping 10.8.0.1
```

Должно работать.

### 2. Ping внешнего IP
```bash
ping 8.8.8.8
```

Если работает - NAT настроен правильно.

### 3. Ping DNS имени
```bash
ping google.com
```

Если работает - DNS работает.

### 4. Проверка IP
```bash
curl ifconfig.me
```

Должен показать IP сервера VPN, не ваш реальный IP.

---

## 📝 Постоянное решение

### Вариант 1: Обновить run.sh

Добавить явное определение WG_DEVICE:

```bash
# Определить интерфейс автоматически
WG_DEVICE=$(ip route | grep default | awk '{print $5}')

docker run -d \
  -e WG_DEVICE="$WG_DEVICE" \
  ... (остальное)
```

### Вариант 2: Обновить docker-compose.yml

```yaml
environment:
  - WG_DEVICE=eth0  # или ваш интерфейс
```

### Вариант 3: Использовать PostUp скрипт

```yaml
environment:
  - WG_POST_UP=iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
```

---

## 🔍 Логи для отладки

```bash
# Общие логи
docker logs awg-easy

# WireGuard статус
docker exec awg-easy wg show

# Проверка DNS
docker exec awg-easy cat /etc/wireguard/wg0.conf | grep DNS

# Проверка маршрутов
docker exec awg-easy ip route
```

---

## ❓ Частые проблемы

### "RTNETLINK answers: Operation not permitted"

**Причина:** Недостаточно прав у контейнера

**Решение:** Добавить capabilities:
```bash
--cap-add=NET_ADMIN \
--cap-add=SYS_MODULE
```

### "Cannot find device wg0"

**Причина:** Ядро не поддерживает WireGuard

**Решение:** Обновить ядро хоста до 5.6+

### "iptables: No chain/target/match by that name"

**Причина:** Конфликт iptables/nftables

**Решение:** Использовать iptables-legacy:
```bash
docker exec awg-easy update-alternatives --set iptables /sbin/iptables-legacy
docker restart awg-easy
```

---

## ✅ Checklist

- [ ] IP forwarding = 1
- [ ] Правильный WG_DEVICE (обычно eth0)
- [ ] MASQUERADE правило есть
- [ ] FORWARD правила есть
- [ ] Handshake успешен
- [ ] Ping 10.8.0.1 работает
- [ ] Ping 8.8.8.8 работает
- [ ] DNS работает

Если все ✅ - трафик должен идти!
