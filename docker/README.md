# Docker profiles

This repository provides two local Docker profiles:

## `core` (default recommended)

Low-footprint stack for daily work:
- `code-intel-mcp` service only

Start:

```bash
docker compose -f docker/docker-compose.yml --profile core up -d
```

Stop:

```bash
docker compose -f docker/docker-compose.yml --profile core down
```

## `search-optional`

Optional profile for local search tooling experiments:
- `search-optional` helper container with `ripgrep`

Start with core + optional:

```bash
docker compose -f docker/docker-compose.yml --profile core --profile search-optional up -d
```

## `zoekt-optional`

Optional profile for large-scale full-text indexing experiments:
- `zoekt-webserver` (serves indexed search on port `6070`)
- `zoekt-index` (one-shot index build against mounted workspace)

Start core + Zoekt webserver:

```bash
pnpm docker:zoekt:up
```

Build/update index on-demand:

```bash
pnpm docker:zoekt:index
```

Stop Zoekt profile:

```bash
pnpm docker:zoekt:down
```

## Resource notes

- `core` is constrained to ~512MB RAM and 0.5 CPU.
- `search-optional` is constrained to ~256MB RAM and 0.25 CPU.
- `zoekt-optional` services are constrained to ~384MB RAM and 0.35 CPU each.
- Keep optional profile off unless needed.
