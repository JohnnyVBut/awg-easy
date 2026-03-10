# PoC: Split Routing — RU ISP / KZ Tunnel

## Задача

VPN-клиенты подключены к российскому серверу.
- Российские IP → напрямую через российского провайдера
- Нероссийские IP → через S2S туннель в Казахстан

## Топология

```
VPN Client (192.168.72.x)
        |
    wg11 (RU сервер, 192.168.72.1/24)
        |
    [ipset + fwmark + ip rule]
        |
   ┌────┴────────────────────┐
   │                         │
Russian IP              Non-Russian IP
   │                         │
ens3 → ISP RU          wg10 → KZ сервер (10.255.255.1)
(62.113.116.1)               │
                        MASQUERADE → eth0 → Internet
                        (185.98.7.1)
```

## Серверы

| Роль | Интерфейс | IP |
|------|-----------|----|
| RU VPN клиенты | wg11 | 192.168.72.1/24 |
| RU → KZ туннель | wg10 | 10.255.255.2/30 |
| RU ISP | ens3 | gateway 62.113.116.1 |
| KZ туннельный IP | wg10 | 10.255.255.1 |
| KZ ISP | eth0 | gateway 185.98.7.1 |

## Реализация

### Российский сервер

```bash
# 1. Загрузить российские префиксы в ipset
ipset create ru_nets hash:net family inet
(echo "create ru_nets hash:net family inet -exist"; \
 awk '{print "add ru_nets " $1}' /root/scripto/ru_agregate.txt) | ipset restore -!

# 2. Добавить таблицу маршрутизации
echo "100 vpn_kz" >> /etc/iproute2/rt_tables

# 3. Маршрут в таблице 100: всё → KZ
ip route add default via 10.255.255.1 dev wg10 table 100

# 4. Правило: fwmark 1 → таблица 100
ip rule add fwmark 1 lookup 100 priority 100

# 5. Пометить нероссийский трафик от VPN-клиентов
iptables-nft -t mangle -A PREROUTING \
    -s 192.168.72.0/24 \
    -m set ! --match-set ru_nets dst \
    -j MARK --set-mark 1
```

### KZ сервер

```bash
# 1. Маршрут назад к клиентской сети
ip route add 192.168.72.0/24 via 10.255.255.2 dev wg10

# 2. MASQUERADE клиентского трафика
iptables -t nat -A POSTROUTING -s 192.168.72.0/24 -o eth0 -j MASQUERADE
```

## Принцип работы

1. Пакет от клиента (`192.168.72.x`) приходит на wg11
2. PREROUTING mangle: dst в `ru_nets`? → без mark (→ main table → ISP)
3. PREROUTING mangle: dst НЕ в `ru_nets`? → mark=1
4. Routing: mark=1 → lookup table 100 → default via wg10 → KZ
5. KZ сервер: принимает пакет (AllowedIPs=0.0.0.0/0), видит src=192.168.72.x
6. KZ сервер: MASQUERADE → выходит с KZ публичным IP
7. Ответ: KZ → de-NAT → route 192.168.72.0/24 via wg10 → RU → клиент

## Ключевые решения

- **ipset hash:net** вместо 12K маршрутов в routing table — O(1) lookup в ядре
- **fwmark** вместо src-based ip rule — гибче, готово к расширению (несколько источников)
- **NAT на KZ стороне** — KZ видит реальные IP клиентов (192.168.72.x), не туннельный IP
- **AllowedIPs=0.0.0.0/0 + disableRoutes=true** на KZ пире — туннель принимает любой src IP, маршруты не добавляются автоматически

## Диагностика

```bash
# RU: проверить ipset
ipset list ru_nets | wc -l

# RU: проверить правила
ip rule show
ip route show table 100
iptables-nft -t mangle -L PREROUTING -v -n

# RU: проверить куда уйдёт IP
ip route get 8.8.8.8 mark 1      # → wg10 (KZ)
ip route get 77.88.8.8 mark 0    # → ens3 (ISP)

# KZ: проверить
ip route show | grep 192.168.72
iptables -t nat -L POSTROUTING -v -n

# С клиента
traceroute 8.8.8.8     # первый хоп → KZ
traceroute 77.88.8.8   # прямо через RU ISP
curl ident.me          # должен вернуть KZ IP
```

## Следующие шаги (GUI интеграция)

- Страница **Routing** в AWG-Easy: управление `ip rule` / `ip route` через API
- Загрузка и обновление ipset через UI (загрузка файла префиксов)
- Failover: если KZ туннель упал → переключить на ISP или другой туннель
- Персистентность: восстановление правил после перезагрузки сервера
