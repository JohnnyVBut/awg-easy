# Node 22 LTS (x86_64). On armv6/armv7 older Node versions may be needed.
FROM docker.io/library/node:22-alpine AS build_node_modules

# Copy Web UI
COPY src /app
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev && \
    mv node_modules /node_modules

# Pre-fetch Alpine packages here (node:22-alpine has newer apk/TLS stack).
# Final stage installs them offline — zero network needed there.
# -R = recursive, pulls all transitive dependencies.
RUN printf '%s\n' \
        'https://mirror.yandex.ru/mirrors/alpine/latest-stable/main' \
        'https://mirror.yandex.ru/mirrors/alpine/latest-stable/community' \
        > /etc/apk/repositories && \
    mkdir /apk-cache && \
    apk fetch --no-cache -R -o /apk-cache \
        dumb-init iptables iproute2 libstdc++ libgcc

# Copy build result to a new image.
# This saves a lot of disk space.
# Kernel mode: amneziawg.ko must be loaded on the Docker host.
# Install on Ubuntu/Debian host: sudo add-apt-repository ppa:amnezia/ppa && sudo apt-get install amneziawg
# The container uses awg-quick / awg tools from the base image to configure interfaces.
# No userspace amneziawg-go is needed — the kernel module handles everything.
FROM amneziavpn/amneziawg-go:latest
HEALTHCHECK CMD /usr/bin/timeout 5s /bin/sh -c "/usr/bin/wg show | /bin/grep -q interface || exit 1" --interval=1m --timeout=5s --retries=3
COPY --from=build_node_modules /app /app

# Move node_modules one directory up, so during development
# we don't have to mount it in a volume.
# This results in much faster reloading!
#
# Also, some node_modules might be native, and
# the architecture & OS of your development machine might differ
# than what runs inside of docker.
COPY --from=build_node_modules /node_modules /node_modules

# Copy the needed wg-password scripts
COPY --from=build_node_modules /app/wgpw.sh /bin/wgpw
RUN chmod +x /bin/wgpw

# Install packages offline from files pre-fetched in stage 1.
# --no-network: prevents apk from fetching APKINDEX (even for local installs apk tries
#   to refresh the index from /etc/apk/repositories — this hangs on RU servers).
# --allow-untrusted: local .apk files have no repo signature (fetched over HTTPS in stage 1).
COPY --from=build_node_modules /apk-cache /apk-cache
RUN apk add --no-cache --no-network --allow-untrusted /apk-cache/*.apk && rm -rf /apk-cache

# Copy Node 22 binary from build stage (apk would install Alpine's older version)
COPY --from=build_node_modules /usr/local/bin/node /usr/local/bin/node

# Set Environment
ENV DEBUG=Server,WireGuard

# Run Web UI
WORKDIR /app
CMD ["/usr/bin/dumb-init", "node", "server.js"]
