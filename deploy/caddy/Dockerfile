# Custom Caddy build with rate-limit plugin.
# Standard caddy:latest does not include rate limiting — xcaddy adds it.
FROM caddy:builder AS builder

RUN xcaddy build \
    --with github.com/mholt/caddy-ratelimit

FROM caddy:latest
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
