# OpenClaw on Podman with Docker Sandbox Backend

## Overview

This guide runs the OpenClaw gateway in a Podman container and uses the **Docker
sandbox backend** for agent tool execution. The gateway creates and manages sandbox
containers through the Podman socket, using Podman's Docker API compatibility.

The key insight: Podman implements the Docker API, so the gateway's existing Docker
sandbox code works with Podman — the gateway creates sandbox containers via the
socket, bind-mounts the workspace into them, and executes tool calls via
`docker exec`. No SSH, no file syncing, no separate sandbox lifecycle to manage.

Tested on: Debian Trixie (13) on Raspberry Pi 5 (arm64), Podman 5.4.2, April 2026.

## Architecture

```
openclaw user (rootless Podman)
                              Podman socket
┌──────────────────┐         (/var/run/docker.sock)        ┌──────────────────────┐
│  Gateway Container│─── docker create/exec ──────────────▶│  Sandbox Container   │
│  (openclaw:local) │         via socket                   │  (bookworm-slim)     │
│  port 18789/18790 │                                      │  python3, git, etc   │
└──────────────────┘                                       └──────────────────────┘
         │                                                          │
         └──── bind mount ──── workspace dir ──── bind mount ───────┘
              /home/node/.openclaw/workspace    /workspace
              (gateway view)                    (sandbox view)
              same files on host disk
```

- Gateway and sandbox share the workspace via bind mount (no sync/seed/copy)
- Gateway creates sandbox containers on demand via `podman-remote` (symlinked as `docker`)
- Both containers run under the same rootless Podman user with `--userns=keep-id`
- No Docker daemon, no Docker socket — pure Podman

## Key problems solved

### 1. Containerized gateway path alignment (Docker and Podman)

The existing Docker sandbox backend assumes the gateway runs directly on the host.
When the gateway creates a sandbox container via the socket, it passes its own
internal paths as bind-mount sources:

```
docker create -v /home/node/.openclaw/workspace:/workspace ...
```

The Docker/Podman daemon resolves that path on the **host** filesystem. But
`/home/node/.openclaw/workspace` only exists inside the gateway container — the
real host path is `/home/openclaw/.openclaw/workspace` (or wherever the config
directory lives on the host).

This guide adds `hostPathPrefix` and `gatewayPathPrefix` config options that tell
the gateway to translate its internal paths to host paths before passing them to
`docker create`. This fix is runtime-agnostic — it works for Docker-in-Docker
deployments too, not just Podman. Any setup where the gateway runs in a container
with socket passthrough benefits from this.

### 2. Rootless Podman UID mapping (Podman-specific)

Rootless Podman maps UIDs through user namespaces. Each container gets its own
mapping from `/etc/subuid`. Without explicit configuration, UID 1000 inside one
container may map to a different host UID than UID 1000 inside another container.
When two containers share a bind-mounted workspace, this causes permission errors.

The fix is `--userns=keep-id` on both the gateway and sandbox containers, which
maps the host user's UID directly into each container. This requires `podman-remote`
as the container CLI inside the gateway image — the Docker CLI does not support the
`--userns` flag. `podman-remote` is installed in the gateway image and symlinked as
`docker` so the gateway's existing `spawn("docker", ...)` code works unchanged.

## Prerequisites

- **Podman** (rootless mode, 5.x+ recommended)
- **2 GB+ RAM** (image builds will OOM with less — exit code 137)
- **git**

## Step 1: Clone the repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
git checkout podman_sandbox
```

## Step 2: Build the gateway image

Build with `podman-remote` as the container CLI:

```bash
podman build \
  --build-arg OPENCLAW_INSTALL_DOCKER_CLI=podman-remote \
  -t openclaw:local -f Dockerfile .
```

This installs `podman-remote` from the Debian Trixie repository inside the gateway
image and symlinks it as `/usr/local/bin/docker`.

### Alternative: Docker CLI

If you prefer to use the Docker CLI (works for most operations but lacks
`--userns=keep-id` support):

```bash
podman build \
  --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 \
  -t openclaw:local -f Dockerfile .
```

Note: without `--userns=keep-id` on sandbox containers, you'll need to configure
`sandbox.docker.user: "0:0"` which runs the sandbox process as root inside the
container (still rootless on the host via Podman's user namespace).

## Step 3: Build the sandbox image

```bash
podman build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .
```

This creates a minimal Debian image with bash, git, python3, curl, jq, and ripgrep.

## Step 4: Create the system user (if not already done)

```bash
sudo useradd -r -m -s /bin/bash openclaw
sudo loginctl enable-linger openclaw
```

If you see warnings about missing subuid/subgid ranges:

```bash
sudo sh -c 'echo "openclaw:100000:65536" >> /etc/subuid'
sudo sh -c 'echo "openclaw:100000:65536" >> /etc/subgid'
```

## Step 5: Load images into the openclaw user's Podman store

```bash
# Gateway image
podman save -o /tmp/openclaw-image.tar openclaw:local
chmod 644 /tmp/openclaw-image.tar
cd /tmp && sudo -u openclaw podman load -i /tmp/openclaw-image.tar
rm -f /tmp/openclaw-image.tar

# Sandbox image
podman save -o /tmp/sandbox.tar openclaw-sandbox:bookworm-slim
chmod 644 /tmp/sandbox.tar
cd /tmp && sudo -u openclaw podman load -i /tmp/sandbox.tar
rm -f /tmp/sandbox.tar
```

## Step 6: Enable the Podman socket

```bash
sudo -u openclaw XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) \
  systemctl --user enable --now podman.socket
```

Verify:

```bash
sudo -u openclaw ls -la /run/user/$(id -u openclaw)/podman/podman.sock
```

## Step 7: Create config directory and minimal config

```bash
sudo -u openclaw mkdir -p /home/openclaw/.openclaw/workspace
sudo -u openclaw bash -c 'cat > /home/openclaw/.openclaw/openclaw.json << '"'"'EOF'"'"'
{
  "gateway": {
    "mode": "local"
  }
}
EOF'
```

## Step 8: Run onboarding

```bash
cd /tmp && sudo -u openclaw podman run --rm -it \
  --init --userns=keep-id \
  --user "$(id -u openclaw):$(id -g openclaw)" \
  -e HOME=/home/node -e TERM=xterm-256color -e BROWSER=echo \
  -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
  -e OPENCLAW_NO_RESPAWN=1 \
  -v /home/openclaw/.openclaw:/home/node/.openclaw:rw \
  -v /home/openclaw/.openclaw/workspace:/home/node/.openclaw/workspace:rw \
  openclaw:local \
  node dist/index.js onboard
```

## Step 9: Configure the Docker sandbox backend

Edit the config:

```bash
sudo -u openclaw vi /home/openclaw/.openclaw/openclaw.json
```

Add or replace the `sandbox` block inside `agents.defaults`:

```json
"agents": {
  "defaults": {
    "sandbox": {
      "mode": "all",
      "backend": "docker",
      "scope": "agent",
      "workspaceAccess": "rw",
      "docker": {
        "hostPathPrefix": "/home/openclaw/.openclaw",
        "gatewayPathPrefix": "/home/node/.openclaw",
        "createArgs": ["--userns=keep-id"],
        "network": "none"
      }
    }
  }
}
```

### Config explained

| Setting | Value | Purpose |
|---------|-------|---------|
| `backend` | `"docker"` | Use Docker/Podman socket, not SSH |
| `hostPathPrefix` | `"/home/openclaw/.openclaw"` | Host-side path prefix for bind mounts. The gateway sees `~/.openclaw` at `/home/node/.openclaw` inside its container, but Podman resolves bind-mount sources on the host. This translates `/home/node/.openclaw/...` to `/home/openclaw/.openclaw/...` when creating sandbox containers. |
| `gatewayPathPrefix` | `"/home/node/.openclaw"` | The gateway-internal path that corresponds to `hostPathPrefix`. Optional — defaults to the gateway's `STATE_DIR`. |
| `createArgs` | `["--userns=keep-id"]` | Passed to `docker create` (actually `podman-remote`). Maps the host user's UID into the sandbox container so both containers see the same file ownership. |
| `network` | `"none"` | Sandbox gets no network by default. Set to `"bridge"` if agents need internet access. |

### Why hostPathPrefix is needed

The gateway runs inside a container where config is mounted at `/home/node/.openclaw`.
When it creates a sandbox container, it passes this path as a bind-mount source:

```
docker create -v /home/node/.openclaw/workspace:/workspace ...
```

But Podman (on the host) resolves that path on the host filesystem, where it doesn't
exist — the real host path is `/home/openclaw/.openclaw/workspace`. The
`hostPathPrefix` config tells the gateway to rewrite the source path before passing
it to `docker create`.

This is not a Podman-specific problem — it affects any containerized gateway using
Docker socket passthrough, including Docker itself.

### Why createArgs is needed

Rootless Podman maps UIDs through user namespaces. The gateway container uses
`--userns=keep-id` (set in the launch command) so the host user's UID (1001) maps
to the same UID inside the container. Without `--userns=keep-id` on the sandbox
container, its UID mapping would differ, and the shared workspace bind mount would
have permission mismatches.

`createArgs: ["--userns=keep-id"]` passes this flag when the gateway creates sandbox
containers. This requires `podman-remote` as the CLI — the Docker CLI does not
support `--userns`.

## Step 10: Launch the gateway

```bash
cd /tmp && sudo -u openclaw podman run -d --replace \
  --name openclaw \
  --init \
  --userns=keep-id \
  --user "$(id -u openclaw):$(id -g openclaw)" \
  -e HOME=/home/node -e TERM=xterm-256color \
  -e NPM_CONFIG_CACHE=/home/node/.openclaw/.npm \
  -e OPENCLAW_NO_RESPAWN=1 \
  -e XDG_CONFIG_HOME=/home/node/.openclaw/.config \
  -e CONTAINER_HOST=unix:///var/run/docker.sock \
  -v /home/openclaw/.openclaw:/home/node/.openclaw:rw \
  -v /home/openclaw/.openclaw/workspace:/home/node/.openclaw/workspace:rw \
  -v /run/user/$(id -u openclaw)/podman/podman.sock:/var/run/docker.sock:rw \
  -p 127.0.0.1:18789:18789 \
  -p 127.0.0.1:18790:18790 \
  openclaw:local \
  node dist/index.js gateway --bind lan --port 18789
```

### Environment variables explained

| Variable | Purpose |
|----------|---------|
| `XDG_CONFIG_HOME=/home/node/.openclaw/.config` | Redirects `podman-remote`'s config directory into the writable mount. The gateway image's `/home/node` is owned by uid 1000 (the `node` user from the base image), but the container runs as uid 1001 via `--userns=keep-id`. `podman-remote` needs a writable config dir. |
| `CONTAINER_HOST=unix:///var/run/docker.sock` | Tells `podman-remote` where to find the Podman socket. Unlike the Docker CLI, `podman-remote` doesn't default to `/var/run/docker.sock`. |

### Socket mount

The Podman socket (`/run/user/<UID>/podman/podman.sock`) is mounted at
`/var/run/docker.sock` inside the gateway container. This is the standard Docker
socket path — if you later switch to Docker, no config changes needed.

## Step 11: Verify

```bash
# Gateway running
cd /tmp && sudo -u openclaw podman ps

# podman-remote works inside gateway
cd /tmp && sudo -u openclaw podman exec openclaw docker version

# Sandbox container created (after first message)
cd /tmp && sudo -u openclaw podman ps --format "table {{.Names}} {{.Status}} {{.Image}}"

# Workspace accessible from sandbox
cd /tmp && sudo -u openclaw podman exec openclaw-sbx-agent-main-* ls -la /workspace/

# File write from sandbox
cd /tmp && sudo -u openclaw podman exec openclaw-sbx-agent-main-* \
  touch /workspace/test && echo "write OK" && \
  sudo -u openclaw podman exec openclaw-sbx-agent-main-* rm /workspace/test

# Gateway can read sandbox-created files (same bind mount)
cd /tmp && sudo -u openclaw podman exec openclaw ls -la /home/node/.openclaw/workspace/
```

## Management

### Logs

```bash
cd /tmp && sudo -u openclaw podman logs -f openclaw
```

### Stop / Start

```bash
cd /tmp && sudo -u openclaw podman stop openclaw
cd /tmp && sudo -u openclaw podman start openclaw
```

### Restart (recreates gateway container)

```bash
cd /tmp && sudo -u openclaw podman stop openclaw
cd /tmp && sudo -u openclaw podman rm openclaw
# Re-run the launch command from Step 10
```

### Rebuild gateway image

```bash
cd ~/src/openclaw
podman build \
  --build-arg OPENCLAW_INSTALL_DOCKER_CLI=podman-remote \
  -t openclaw:local -f Dockerfile .

podman save -o /tmp/openclaw-image.tar openclaw:local
chmod 644 /tmp/openclaw-image.tar
cd /tmp && sudo -u openclaw podman load -i /tmp/openclaw-image.tar
rm -f /tmp/openclaw-image.tar

# Relaunch gateway
cd /tmp && sudo -u openclaw podman stop openclaw
cd /tmp && sudo -u openclaw podman rm openclaw
# Re-run the launch command from Step 10
```

### Rebuild sandbox image

```bash
cd ~/src/openclaw
podman build -t openclaw-sandbox:bookworm-slim -f Dockerfile.sandbox .

podman save -o /tmp/sandbox.tar openclaw-sandbox:bookworm-slim
chmod 644 /tmp/sandbox.tar
cd /tmp && sudo -u openclaw podman load -i /tmp/sandbox.tar
rm -f /tmp/sandbox.tar

# Remove old sandbox container (gateway recreates on next message)
cd /tmp && sudo -u openclaw podman rm -f openclaw-sbx-agent-main-*
cd /tmp && sudo -u openclaw podman restart openclaw
```

## How it works

### Bind mount (no sync)

The gateway and sandbox share the workspace via a bind mount. When the gateway
creates a sandbox container, it passes:

```
docker create -v /home/openclaw/.openclaw/workspace:/workspace ...
```

(The `hostPathPrefix` translation rewrites the gateway-internal path to the host path.)

Both containers see the same files. When the agent writes a file via a tool call,
it writes through `docker exec` into the sandbox, which writes to the bind mount,
which is immediately visible to the gateway. No tar, no seed, no cache.

### Container lifecycle

The gateway creates sandbox containers on demand via the Podman socket. The container
runs `sleep infinity` and the gateway executes commands into it via `docker exec`.
Containers are reused across messages for the same agent scope. If the sandbox config
changes (image, mounts, etc.), the gateway detects the hash mismatch and recreates
the container.

### UID alignment

Both the gateway and sandbox containers use `--userns=keep-id`, which maps the host
user's UID (1001, openclaw) to the same UID inside each container. Since both see
UID 1001, and the workspace bind mount preserves host ownership, files are readable
and writable from both sides.

### Path translation

The `hostPathPrefix` / `gatewayPathPrefix` config enables path translation for
bind-mount sources. When the gateway constructs `-v source:target` arguments for
`docker create`, it replaces the gateway-internal prefix with the host prefix:

```
/home/node/.openclaw/workspace  →  /home/openclaw/.openclaw/workspace
```

This is implemented in `src/agents/sandbox/host-path-translate.ts` and applied in
`workspace-mounts.ts` and `docker.ts`. The translation only affects bind-mount
source paths passed to `docker create` — the gateway's own file access uses its
internal paths unchanged.

## Comparison with Docker sandbox

| Aspect | Docker | Podman (this guide) |
|--------|--------|---------------------|
| Container runtime | Docker daemon | Rootless Podman |
| Socket | `/var/run/docker.sock` | `/run/user/<UID>/podman/podman.sock` (mounted at same path) |
| CLI in gateway image | `docker-ce-cli` | `podman-remote` (symlinked as `docker`) |
| UID handling | Runs as configured user | `--userns=keep-id` maps host UID into container |
| Path translation | Not needed if host paths match | `hostPathPrefix` / `gatewayPathPrefix` required |
| Compose overlay | `docker-compose.sandbox.yml` (generated) | Same, plus `docker-compose.podman.yml` for `userns_mode` |
| Setup script | `scripts/docker/setup.sh` | Same script (auto-detects Podman) |
| Sandbox image | `Dockerfile.sandbox` | Same image |
| Sandbox lifecycle | Automatic | Automatic (same code path) |
| File sharing | Bind mount | Bind mount (same) |

## Code changes from upstream

The following changes enable Podman socket support in the Docker sandbox backend.
All core code changes are runtime-agnostic and benefit Docker deployments too.

### Runtime-agnostic (benefits Docker and Podman)

- **`src/config/types.sandbox.ts`** — Added `hostPathPrefix`, `gatewayPathPrefix`,
  and `createArgs` to `SandboxDockerSettings`. These solve the path alignment problem
  for any containerized gateway using socket passthrough.
- **`src/config/zod-schema.agent-runtime.ts`** — Zod validation for the new fields.
- **`src/agents/sandbox/config.ts`** — Config resolution for the new fields.
- **`src/agents/sandbox/host-path-translate.ts`** — New utility: translates
  gateway-internal paths to host paths for bind-mount sources.
- **`src/agents/sandbox/workspace-mounts.ts`** — `appendWorkspaceMountArgs` accepts
  optional `translateHostPath` function.
- **`src/agents/sandbox/docker.ts`** — Wires path translation into container creation;
  supports `createArgs` for extra `docker create` flags.

### Podman-specific (minimal)

- **`docker-compose.podman.yml`** — Static compose overlay adding `userns_mode: keep-id`.
- **`Dockerfile`** — Added `podman-remote` as a value for `OPENCLAW_INSTALL_DOCKER_CLI`
  build arg. Installs from Debian Trixie repo, symlinked as `docker`.
- **`scripts/docker/setup.sh`** — Auto-detects Podman, includes compose overlay, sets
  `hostPathPrefix`/`gatewayPathPrefix`/`createArgs` in config when Podman is detected.
