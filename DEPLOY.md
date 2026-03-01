# AWG-Easy 2.0 — Deploy from Scratch

Full server setup guide: Ubuntu 22.04 + AmneziaWG kernel module + Docker.

---

## Requirements

| | |
|---|---|
| OS | Ubuntu 22.04 LTS |
| Kernel | 6.8+ (HWE) |
| RAM | 512 MB minimum |
| Access | Root or sudo |
| Network | Public IP, UDP ports open |

---

## Step 1 — Install HWE kernel (kernel 6.8+)

The AmneziaWG DKMS module requires kernel ≥ 6.1 (`timer_delete` was added then).
Ubuntu 22.04 ships with kernel 5.15 by default — upgrade to HWE:

```bash
sudo apt update && sudo apt install -y linux-generic-hwe-22.04
sudo reboot
```

After reboot, verify:

```bash
uname -r
# expected: 6.8.x-xx-generic
```

---

## Step 2 — Install AmneziaWG kernel module

```bash
sudo add-apt-repository ppa:amnezia/ppa
sudo apt install -y amneziawg
```

Load the module now and add to autoload on every boot:

```bash
sudo modprobe amneziawg
echo "amneziawg" | sudo tee /etc/modules-load.d/amneziawg.conf
```

Verify:

```bash
lsmod | grep amneziawg
# expected: amneziawg   131072  0
```

---

## Step 3 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker          # activate group without logout
```

---

## Step 4 — Clone repository and checkout branch

```bash
git clone https://github.com/JohnnyVBut/awg-easy.git
cd awg-easy
git checkout feature/kernel-module
```

---

## Step 5 — Install persistent sysctl settings

Applies on every host reboot (ip forwarding, BBR, buffers, etc.):

```bash
sudo cp sysctl.d/99-awg.conf /etc/sysctl.d/99-awg.conf
sudo sysctl --system
```

---

## Step 6 — Build Docker image

```bash
docker build -t awg2-easy:latest .
```

---

## Step 7 — Start container

```bash
./run.sh
```

The script will:
1. Apply kernel parameters on the host (`ip_forward`, BBR, buffers)
2. Ask for Web UI password and generate bcrypt hash
3. Detect public server IP (or ask to enter manually)
4. Start the container with `--network host`

---

## Step 8 — Verify

```bash
# Container is running
docker ps

# Logs (should show wg0 started)
docker logs awg-easy

# WireGuard interfaces on host
ip -d link show type amneziawg

# Listening UDP ports (wg0 = 51820, wg10 = 51830, etc.)
ss -unlp | grep -E '518[23][0-9]'

# NAT rules (appear after first tunnel interface Start)
iptables -t nat -L POSTROUTING -n -v
```

Web UI: `http://<server-ip>:51821`

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 51821 | TCP | Web UI |
| 51820 | UDP | WireGuard (wg0, classic clients) |
| 51830 | UDP | Tunnel Interface wg10 |
| 51831 | UDP | Tunnel Interface wg11 |
| 51832+ | UDP | Each new Tunnel Interface gets the next free port |

With `--network host` all ports are immediately accessible — no container restart needed when new interfaces are created.

---

## Creating a Tunnel Interface (AmneziaWG 2.0)

1. Open Web UI → **Tunnel Interfaces** tab
2. Click **Create Interface**
   - Name: anything (e.g. `Mobile`)
   - Protocol: `AmneziaWG 2.0`
   - Address: VPN subnet for this interface (e.g. `10.10.0.1/24`)
   - AWG parameters are pre-filled with secure defaults
3. Click **Start** on the created interface
4. Click **Manage Peers** → **Add Peer**
   - Mode: **Generate Keys** (server generates all keys, QR shown automatically)
   - Type: **Client** (mobile/dynamic IP)
   - Name: e.g. `iPhone`
   - Allowed IPs: VPN IP for this client (e.g. `10.10.0.2/32`)
5. Scan QR with AmneziaWG mobile app

---

## Updating

```bash
cd awg-easy
git pull origin feature/kernel-module
docker build -t awg2-easy:latest .
docker stop awg-easy && docker rm awg-easy
./run.sh
```

> After update, existing tunnel interfaces with `enabled: true` are auto-started by the container on boot.
> If PostUp/PostDown rules changed — do **Stop → Start** on each interface in the UI to re-apply iptables rules.

---

## Troubleshooting

### Module not loaded after reboot
```bash
sudo modprobe amneziawg
# If that fails:
sudo dkms status            # check build status
uname -r                    # verify kernel version is 6.x
```

### Container starts but wg0 not coming up
```bash
docker logs awg-easy        # look for wg-quick errors
ls /etc/wireguard/          # check wg0.conf exists
```

### Client connects but no internet
```bash
# Check NAT rule is present:
iptables -t nat -L POSTROUTING -n -v | grep MASQUERADE

# If missing — Stop and Start the interface in the UI to re-apply PostUp
# Check ip_forward:
sysctl net.ipv4.ip_forward  # must be 1
```

### Client connects but DNS doesn't work
The generated client config includes `DNS = 1.1.1.1, 8.8.8.8`.
If you regenerated config after the fix — re-download/re-scan QR for existing peers.

### Port not reachable from outside
```bash
# Verify interface is running:
ip -d link show wg10

# Verify port is listening:
ss -unlp | grep 51830

# Check firewall:
ufw status
iptables -L INPUT -n | grep 5183
```
