# OpenClaw on Podman with SSH Sandbox Agents

## Overview

This guide runs the OpenClaw gateway in a Podman container and uses the **SSH sandbox
backend** for agent tool execution. Instead of mounting a Docker/Podman socket into the
gateway container, the gateway SSHes into a separate container running sshd.

This eliminates the need for Docker CLI in the gateway image, path alignment hacks,
and socket exposure — the gateway only needs SSH access to the sandbox.

Both containers run under the `openclaw` system user via rootless Podman, and share
a Podman network for inter-container communication.

Tested on: Debian Trixie (13) on Raspberry Pi 5 (arm64), Podman 5.4.2, March 2026.

## Architecture

```
openclaw user (rootless Podman, network: openclaw-net)
┌──────────────────┐          ┌────────────────────────────┐
│  Gateway Container│───SSH───▶│  Sandbox Container (sshd)  │
│  (openclaw:local) │  port 22 │  - python3, git, tar, etc  │
│  port 18789/18790 │          │  - sandbox user             │
└──────────────────┘          └────────────────────────────┘
```

- No Docker socket mounted
- No Docker CLI in the gateway image
- Gateway uses standard `/home/node` paths (stock image)
- SSH keypair for authentication, known_hosts for host verification
- nftables blocks openclaw user (uid 1001) from local LAN

## Prerequisites

- **Podman** (rootless mode)
- **sudo** access for one-time setup
- **2 GB+ RAM** (image builds will OOM with less — exit code 137)
- **git**

## Step 1: Clone the repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

## Step 2: Patch the setup script

The setup script has a bug where the temp directory permissions prevent the
openclaw user from reading the image tar during `podman load`.

Find this block in `scripts/podman/setup.sh` (around line 272):

```bash
echo "Loading image into $OPENCLAW_USER Podman store..."
run_as_openclaw podman load -i "$IMAGE_TAR"
```

Change to:

```bash
echo "Loading image into $OPENCLAW_USER Podman store..."
chmod 755 "$IMAGE_TAR_DIR"
chmod 644 "$IMAGE_TAR"
run_as_openclaw podman load -i "$IMAGE_TAR"
```

## Step 3: Patch the launch script

The launch script (`scripts/run-openclaw-podman.sh`) needs two changes:

### Add shared network

Find the gateway `podman run` command (around line 219):

```bash
podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  --init \
```

Change to:

```bash
podman run --pull="$PODMAN_PULL" -d --replace \
  --name "$CONTAINER_NAME" \
  --init --network openclaw-net \
```

### Add SSH key mount

In the same `podman run` command, after the workspace volume mount, add:

```bash
  -v "$CONFIG_DIR/sandbox-ssh:/home/node/.openclaw/sandbox-ssh:rw${SELINUX_MOUNT_OPTS}" \
```

So the volume mounts section looks like:

```bash
  -v "$CONFIG_DIR:/home/node/.openclaw:rw${SELINUX_MOUNT_OPTS}" \
  -v "$WORKSPACE_DIR:/home/node/.openclaw/workspace:rw${SELINUX_MOUNT_OPTS}" \
  -v "$CONFIG_DIR/sandbox-ssh:/home/node/.openclaw/sandbox-ssh:rw${SELINUX_MOUNT_OPTS}" \
```

The `:rw` mount allows SSH to auto-update `known_hosts` when sandbox containers
are rebuilt with new host keys.

## Step 4: Run the setup script

On Debian Trixie, `adduser`/`useradd` are in `/usr/sbin` which may not be in PATH:

```bash
PATH="/usr/sbin:$PATH" ./scripts/podman/setup.sh
```

This creates the `openclaw` system user, builds the gateway image, loads it into
the openclaw user's Podman store, installs the launch script, and generates a
gateway token.

If you see a warning about missing subuid/subgid ranges:

```bash
sudo sh -c 'echo "openclaw:100000:65536" >> /etc/subuid'
sudo sh -c 'echo "openclaw:100000:65536" >> /etc/subgid'
```

## Step 5: Copy the patched launch script

The setup script installed the original launch script. Replace it with the patched
version:

```bash
sudo cp scripts/run-openclaw-podman.sh /home/openclaw/run-openclaw-podman.sh
sudo chown 1001:1001 /home/openclaw/run-openclaw-podman.sh
```

## Step 6: Create the Podman network

Both containers need to communicate. Create a shared network:

```bash
sudo -u openclaw podman network create openclaw-net
```

## Step 7: Generate SSH keypair

```bash
cd /tmp
sudo -u openclaw mkdir -p /home/openclaw/.openclaw/sandbox-ssh
sudo -u openclaw ssh-keygen -t ed25519 \
  -f /home/openclaw/.openclaw/sandbox-ssh/id_ed25519 \
  -N "" -C "openclaw-sandbox"
```

## Step 8: Build the SSH sandbox container

### Build and load into openclaw user's store

The Containerfile lives in `sandbox-ssh/` in the repo.

```bash
cd ~/src/openclaw
podman build \
  --build-arg SSH_PUBLIC_KEY="$(sudo cat /home/openclaw/.openclaw/sandbox-ssh/id_ed25519.pub)" \
  -t openclaw-sandbox-ssh:latest -f sandbox-ssh/Containerfile sandbox-ssh/

podman save -o /tmp/sandbox-ssh.tar openclaw-sandbox-ssh:latest
chmod 644 /tmp/sandbox-ssh.tar
cd / && sudo -u openclaw podman load -i /tmp/sandbox-ssh.tar
rm -f /tmp/sandbox-ssh.tar
```

## Step 9: Create the sandbox workspace volume and start the container

Create a host directory for sandbox workspaces so they persist across container
rebuilds:

```bash
sudo -u openclaw mkdir -p /home/openclaw/.openclaw/sandbox-workspaces
```

Start the sandbox container with the workspace volume mounted:

```bash
cd /tmp && sudo -u openclaw podman run -d \
  --name openclaw-sandbox \
  --network openclaw-net \
  --restart unless-stopped \
  -v /home/openclaw/.openclaw/sandbox-workspaces:/home/sandbox/workspaces:rw \
  openclaw-sandbox-ssh:latest
```

This mirrors how the gateway workspace is host-mounted — sandbox workspaces
(including agent memory files, daily logs, and project files created during
sessions) survive container rebuilds. Without this mount, all workspace data
lives in container storage and is lost on `podman rm`.

Note: No `-p` port publishing needed — the gateway reaches the sandbox directly
via the shared `openclaw-net` network using the container name as hostname.

## Step 10: Collect the SSH host key

Get the host key directly from the sandbox container and write it to known_hosts:

```bash
cd /tmp
sudo -u openclaw podman exec openclaw-sandbox \
  cat /etc/ssh/ssh_host_ed25519_key.pub | \
  awk '{print "openclaw-sandbox " $1 " " $2}' | \
  sudo tee /home/openclaw/.openclaw/sandbox-ssh/known_hosts > /dev/null
sudo chown 1001:1001 /home/openclaw/.openclaw/sandbox-ssh/known_hosts
```

### Test SSH connectivity

```bash
cd /tmp
sudo -u openclaw podman exec openclaw-sandbox echo "sandbox container reachable"

# Can't test SSH yet — the gateway container isn't running.
# SSH will be tested after launch in Step 14.
```

## Step 11: Run the onboarding wizard

```bash
./scripts/run-openclaw-podman.sh launch setup
```

This walks you through:
- LLM provider configuration (API keys)
- Messaging channel setup (Telegram, Discord, etc.)
- Optional features (search, hooks, skills)

You can skip optional items and configure them later.

## Step 12: Configure SSH sandbox in openclaw.json

Edit the config file:

```bash
sudo -u openclaw vi /home/openclaw/.openclaw/openclaw.json
```

Add or replace the `sandbox` block inside `agents.defaults`:

```json
"sandbox": {
  "mode": "all",
  "backend": "ssh",
  "scope": "agent",
  "workspaceAccess": "rw",
  "ssh": {
    "target": "sandbox@openclaw-sandbox:22",
    "workspaceRoot": "/home/sandbox/workspaces",
    "strictHostKeyChecking": true,
    "identityFile": "/home/node/.openclaw/sandbox-ssh/id_ed25519",
    "knownHostsFile": "/home/node/.openclaw/sandbox-ssh/known_hosts"
  }
}
```

**Important:** The `identityFile` and `knownHostsFile` paths use `/home/node/`
because they are resolved inside the gateway container where config is mounted
at `/home/node/.openclaw/`.

The `target` uses `openclaw-sandbox:22` — the container name, resolved via
Podman DNS on the shared `openclaw-net` network.

### Sandbox config options

| Setting | Options | Meaning |
|---------|---------|---------|
| `mode` | `off` / `non-main` / `all` | Which agents get sandboxed |
| `scope` | `session` / `agent` / `shared` | One container per session, per agent, or shared |
| `workspaceAccess` | `none` / `ro` / `rw` | Agent workspace access level |
| `ssh.target` | `user@host:port` | SSH target (container name works on shared network) |
| `ssh.workspaceRoot` | path | Where remote workspaces are created |
| `ssh.strictHostKeyChecking` | bool | Verify host keys |

## Step 12b: Configure elevated exec and approvals

The `openclaw` CLI (for cron, gateway commands, etc.) only exists on the gateway,
not in the SSH sandbox. Agents need elevated exec to reach it.

Add `elevatedDefault` to `agents.defaults`:

```json
"agents": {
  "defaults": {
    "elevatedDefault": "off",
    ...
  }
}
```

Add the `elevated` block inside `tools`:

```json
"tools": {
  "profile": "coding",
  "elevated": {
    "enabled": true,
    "allowFrom": {
      "webchat": ["*"],
      "telegram": ["*"]
    }
  }
}
```

If using Telegram, enable exec approvals so the agent can request elevated
access and you can approve from a DM:

```json
"channels": {
  "telegram": {
    "execApprovals": {
      "enabled": true,
      "approvers": [YOUR_TELEGRAM_USER_ID],
      "target": "dm"
    }
  }
}
```

**`elevatedDefault` must be `"off"` with SSH sandboxes.** With Docker sandboxes,
the workspace is a bind mount shared between gateway and sandbox — file tools and
exec see the same files regardless of elevated mode. With SSH sandboxes, there is
no shared filesystem. File tools always route through the SSH bridge to the sandbox.
If `elevatedDefault` is `"on"` or `"full"`, exec routes to the gateway instead,
and the agent sees two different filesystems — file writes succeed but exec can't
find them. `"off"` keeps both tools on the sandbox side. The agent passes
`elevated: true` on specific exec calls (like `openclaw cron`) that need the gateway.

Frequently used elevated commands (like `openclaw`) can be permanently approved
via the exec approvals allowlist. On first use, choose "Always allow" from the
approval prompt, or pre-populate `~/.openclaw/exec-approvals.json`:

```json
{
  "agents": {
    "main": {
      "allowlist": [
        { "pattern": "/usr/local/bin/openclaw" }
      ]
    }
  }
}
```

## Step 13: Set gateway bind mode

Persist the gateway bind setting so it starts correctly:

```bash
sudo -u openclaw bash -c 'echo "OPENCLAW_GATEWAY_BIND=lan" >> /home/openclaw/.openclaw/.env'
```

## Step 14: Restrict sandbox network access to the local LAN

The sandbox container runs under the openclaw user (uid 1001). Its outbound traffic
passes through Podman's pasta network proxy as uid 1001. Use nftables to block
traffic to the local subnet while allowing internet and DNS.

Install nftables if not present:

```bash
sudo apt install nftables
```

Apply rules:

```bash
sudo /usr/sbin/nft -f - <<'NFTEOF'
table inet openclaw-sandbox {
  chain output {
    type filter hook output priority 0; policy accept;

    # Allow openclaw user to reach router/DNS
    meta skuid 1001 ip daddr 192.168.171.1 accept

    # Block openclaw user from rest of local subnet
    meta skuid 1001 ip daddr 192.168.171.0/24 drop
  }
}
NFTEOF
```

**Adjust the subnet and DNS IP to match your network.**

Persist across reboots:

```bash
sudo /usr/sbin/nft list ruleset | sudo tee /etc/nftables.conf > /dev/null
sudo systemctl enable nftables
```

To remove the rules:

```bash
sudo /usr/sbin/nft delete table inet openclaw-sandbox
```

## Step 15: Launch the gateway

```bash
cd / && sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
```

## Step 16: Verify

```bash
# Both containers running
cd /tmp && sudo -u openclaw podman ps

# SSH from gateway to sandbox works
cd /tmp && sudo -u openclaw podman exec openclaw \
  ssh -i /home/node/.openclaw/sandbox-ssh/id_ed25519 \
  -o UserKnownHostsFile=/home/node/.openclaw/sandbox-ssh/known_hosts \
  sandbox@openclaw-sandbox 'echo OK; whoami; python3 --version'

# No Docker socket mounted
cd /tmp && sudo -u openclaw podman exec openclaw \
  ls /var/run/docker.sock 2>&1
# Should show: No such file or directory

# Check gateway logs
cd /tmp && sudo -u openclaw bash -c 'podman logs --tail 20 openclaw'

# Sandbox can reach internet
cd /tmp && sudo -u openclaw podman exec openclaw \
  ssh -i /home/node/.openclaw/sandbox-ssh/id_ed25519 \
  -o UserKnownHostsFile=/home/node/.openclaw/sandbox-ssh/known_hosts \
  sandbox@openclaw-sandbox 'curl -s --max-time 5 https://example.com > /dev/null && echo "internet OK"'

# Sandbox CANNOT reach local LAN (test with a local IP other than router)
cd /tmp && sudo -u openclaw podman exec openclaw \
  ssh -i /home/node/.openclaw/sandbox-ssh/id_ed25519 \
  -o UserKnownHostsFile=/home/node/.openclaw/sandbox-ssh/known_hosts \
  sandbox@openclaw-sandbox 'curl -s --connect-timeout 3 http://192.168.171.154/ 2>&1 || echo "LAN blocked (expected)"'
```

## Step 17: Approve channel pairing

### Telegram (or other messaging channel)

When you first message the bot, it responds with a pairing code:

```bash
cd /tmp && sudo -u openclaw podman exec openclaw \
  node openclaw.mjs pairing approve telegram <PAIRING_CODE>
```

### Control UI (web dashboard)

Set up an SSH tunnel from your computer:

```bash
ssh -L 18789:127.0.0.1:18789 -C -N -l <user> <pi-hostname>
```

Open `http://localhost:18789/` in your browser. On first connect, approve the
device pairing:

```bash
# List pending requests
cd /tmp && sudo -u openclaw podman exec openclaw \
  node openclaw.mjs devices list

# Approve by request ID
cd /tmp && sudo -u openclaw podman exec openclaw \
  node openclaw.mjs devices approve <REQUEST_ID>
```

Refresh the browser after approval.

## Management

### Logs

```bash
cd /tmp && sudo -u openclaw bash -c 'podman logs -f openclaw'
```

### Stop

```bash
cd /tmp && sudo -u openclaw podman stop openclaw
```

### Start (without recreating)

```bash
cd /tmp && sudo -u openclaw podman start openclaw
```

### Full relaunch (recreates gateway container)

```bash
cd /tmp && sudo -u openclaw podman stop openclaw
cd /tmp && sudo -u openclaw podman rm openclaw
cd / && sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
```

### Clear sandbox workspace (forces reseed on next message)

With the workspace volume mount, workspace data lives on the host at
`/home/openclaw/.openclaw/sandbox-workspaces/`. Each agent scope has its own
subdirectory (e.g. `openclaw-ssh-agent-main-<hash>/`).

Clear a single agent's workspace:

```bash
# List sandbox workspaces to find the one you want
sudo -u openclaw ls /home/openclaw/.openclaw/sandbox-workspaces/

# Clear a specific agent workspace
sudo -u openclaw rm -rf /home/openclaw/.openclaw/sandbox-workspaces/openclaw-ssh-agent-main-*/
sudo -u openclaw podman restart openclaw
```

Clear all sandbox workspaces:

```bash
sudo -u openclaw rm -rf /home/openclaw/.openclaw/sandbox-workspaces/*
sudo -u openclaw podman restart openclaw
```

### Rebuild sandbox with new tools

When you modify `sandbox-ssh/Containerfile` and rebuild:

```bash
cd ~/src/openclaw
podman build \
  --build-arg SSH_PUBLIC_KEY="$(sudo cat /home/openclaw/.openclaw/sandbox-ssh/id_ed25519.pub)" \
  -t openclaw-sandbox-ssh:latest -f sandbox-ssh/Containerfile sandbox-ssh/

podman save -o /tmp/sandbox-ssh.tar openclaw-sandbox-ssh:latest
chmod 644 /tmp/sandbox-ssh.tar
cd / && sudo -u openclaw podman load -i /tmp/sandbox-ssh.tar
rm -f /tmp/sandbox-ssh.tar

# Recreate sandbox container with new image and workspace volume
cd /tmp && sudo -u openclaw podman stop openclaw-sandbox
cd /tmp && sudo -u openclaw podman rm openclaw-sandbox
cd /tmp && sudo -u openclaw podman run -d \
  --name openclaw-sandbox \
  --network openclaw-net \
  --restart unless-stopped \
  -v /home/openclaw/.openclaw/sandbox-workspaces:/home/sandbox/workspaces:rw \
  openclaw-sandbox-ssh:latest

# Update known_hosts (host keys changed with rebuild)
cd /tmp
sudo -u openclaw podman exec openclaw-sandbox \
  cat /etc/ssh/ssh_host_ed25519_key.pub | \
  awk '{print "openclaw-sandbox " $1 " " $2}' | \
  sudo tee /home/openclaw/.openclaw/sandbox-ssh/known_hosts > /dev/null
sudo chown 1001:1001 /home/openclaw/.openclaw/sandbox-ssh/known_hosts

# Restart gateway (workspace data persists on host volume — no reseed needed)
sudo -u openclaw podman restart openclaw
```

### Update OpenClaw gateway

The repo uses a fork workflow:

- `upstream` → `https://github.com/openclaw/openclaw.git` (official repo)
- `origin` → `git@github.com:jspv/openclaw.git` (fork with patches)
- `main` branch tracks upstream (clean, no patches)
- `ssh-sandbox` branch has local patches on top of upstream

```bash
cd ~/src/openclaw

# Sync upstream into main
git checkout main
git pull upstream main
git push origin main

# Rebase patches onto updated main
git checkout ssh-sandbox
git rebase main
git push origin ssh-sandbox --force-with-lease

# Build and deploy
podman build -t openclaw:local -f Dockerfile .
podman save -o /tmp/openclaw-image.tar openclaw:local
chmod 644 /tmp/openclaw-image.tar
cd / && sudo -u openclaw podman load -i /tmp/openclaw-image.tar
rm -f /tmp/openclaw-image.tar

# Relaunch
cd /tmp && sudo -u openclaw podman stop openclaw
cd /tmp && sudo -u openclaw podman rm openclaw
cd / && sudo -u openclaw /home/openclaw/run-openclaw-podman.sh
```

**Important:** Do not upgrade through the OpenClaw GUI — it will overwrite the
patched launch script, breaking the `--network openclaw-net` and SSH key mount.
Always use this manual process to keep your local patches intact.

### Uninstall

```bash
# Stop and remove all containers
cd /tmp && sudo -u openclaw podman stop -a
cd /tmp && sudo -u openclaw podman rm -a

# Remove all images from openclaw user's Podman store
cd /tmp && sudo -u openclaw podman rmi -a

# Remove the shared network
cd /tmp && sudo -u openclaw podman network rm openclaw-net

# Disable the Podman socket (if enabled)
sudo systemctl --machine openclaw@ --user disable --now podman.socket 2>/dev/null

# Remove nftables rules
sudo /usr/sbin/nft delete table inet openclaw-sandbox

# Re-persist nftables without the openclaw rules
sudo /usr/sbin/nft list ruleset | sudo tee /etc/nftables.conf > /dev/null
# If no other rules remain:
# sudo systemctl disable nftables

# Remove user and home directory
PATH="/usr/sbin:$PATH" sudo userdel -r openclaw
sudo loginctl disable-linger openclaw 2>/dev/null
sudo rm -rf /run/user/1001

# Remove subuid/subgid entries if added
sudo sed -i '/^openclaw:/d' /etc/subuid /etc/subgid
```

## How it works

### Workspace seeding

On first use, the gateway tars the agent workspace (`/home/node/.openclaw/workspace/`)
and pipes it over SSH to the sandbox container at the configured `workspaceRoot`.
Seeding is lazy — it happens on the first tool call, not at gateway startup. The
gateway checks whether the agent's scope-key directory exists on the sandbox; if
missing, it uploads the workspace via tar over SSH. The result is cached in memory
for the lifetime of the gateway process, so a gateway restart is required to
re-trigger the check after clearing or recreating the sandbox.

After initial seed, the remote workspace is **canonical** — the gateway does not
sync changes back. All file tool operations (read, write, edit) route through SSH
to the sandbox. To reseed, delete the remote workspace directory and restart the
gateway.

### Workspace directory structure

The sandbox workspace volume has the following structure:

```
/home/sandbox/workspaces/                              <-- mounted volume
├── openclaw-ssh-agent-main-<hash>/                    <-- scope-key dir (per agent)
│   └── workspace/                                     <-- agent working directory
│       ├── AGENTS.md, SOUL.md, IDENTITY.md, ...       <-- seeded from gateway
│       ├── MEMORY.md, memory/                         <-- created by agent
│       └── <project files created by agent>
├── openclaw-ssh-agent-research-<hash>/                <-- second agent scope
│   └── workspace/
│       └── ...
```

The gateway workspace (`/home/node/.openclaw/workspace/`) contains the template
files and any agent-modified identity files (IDENTITY.md, USER.md) from the
bootstrap ritual. This is the seed source. It should only contain stock template
files and identity — not agent-created projects, memory files, or artifacts.

**Caution with `elevatedDefault`:** If `elevatedDefault` is set to `"on"` or
`"full"`, exec commands run on the gateway instead of the sandbox. Any files
created via exec (e.g. `git clone`, `mkdir`) land in the gateway workspace,
polluting the seed source. Always use `elevatedDefault: "off"` with SSH
sandboxes (see Step 12b).

### Multi-agent workspace isolation

With `scope: "agent"`, each agent gets its own scope-key directory under the
shared `workspaceRoot`. However, all agents share the same sandbox container
and the same `sandbox` user — **there is no filesystem isolation between
agents**. An agent can navigate to `../` and read or modify a sibling agent's
workspace, including its IDENTITY.md, MEMORY.md, and SOUL.md files.

This is separation by convention, not enforcement. It may be useful in
scenarios where agents need to collaborate or share context, but it also means
one agent could unintentionally (or intentionally) overwrite another agent's
memory and personality files.

To enforce true filesystem isolation between agents, run separate sandbox
containers per agent, each with its own volume mount and SSH target
configuration.

### Tool execution

The gateway runs agent tool calls (exec, read, write, edit) by SSHing into the
sandbox and executing commands there. File operations use a Python3 mutation helper
piped through SSH for atomic writes with path safety checks.

### Network isolation

Both containers run under the `openclaw` user (uid 1001). Outbound traffic passes
through Podman's pasta proxy as uid 1001 on the host. nftables rules on the host
block this uid from reaching the local LAN (except the router/DNS gateway).

The gateway needs internet access for LLM provider APIs and messaging channel APIs
(Telegram, etc.). The sandbox needs internet if agents install packages or fetch
URLs. Both are allowed outbound internet; only local LAN is blocked.

### Inter-container communication

The gateway and sandbox are on the same Podman network (`openclaw-net`). Podman's
built-in DNS resolves container names, so the gateway reaches the sandbox at
`openclaw-sandbox:22` without port publishing or IP addresses.

## Comparison with Docker sandbox approach

| Aspect | Docker sandbox | SSH sandbox (this guide) |
|--------|---------------|------------------------|
| Socket exposure | Podman socket mounted in gateway | None |
| Docker CLI | Required in gateway image | Not needed |
| Path alignment | Container paths must match host paths | Not needed (SSH is path-independent) |
| UID mapping issues | Sandbox UIDs remap through rootless Podman | SSH user owns its own files |
| Sandbox lifecycle | Gateway creates/destroys containers | You manage the sandbox container |
| Network between containers | Via socket API | Via shared Podman network + SSH |
| Rebuild complexity | Rebuild gateway image | Rebuild sandbox image only |
| Multiple agents | Gateway spawns containers automatically | One sandbox per SSH target (manual) |
| Agent isolation | Separate containers per agent | Shared by default; per-agent containers via config (see below) |

## Adding a second agent with its own sandbox

By default, all agents share the same sandbox container. To give a new agent
full filesystem isolation, create a separate sandbox container and configure
a per-agent SSH target.

This example adds a `research` agent with its own container, volume, and
workspace.

### 1. Create the host workspace volume

```bash
sudo -u openclaw mkdir -p /home/openclaw/.openclaw/sandbox-workspaces-research
```

### 2. Build or reuse the sandbox image

If the research agent needs the same tools, reuse the existing image. If it
needs different packages, create a separate Containerfile and build a new image.

### 3. Start the research sandbox container

```bash
cd /tmp && sudo -u openclaw podman run -d \
  --name openclaw-sandbox-research \
  --network openclaw-net \
  --restart unless-stopped \
  -v /home/openclaw/.openclaw/sandbox-workspaces-research:/home/sandbox/workspaces:rw \
  openclaw-sandbox-ssh:latest
```

### 4. Collect the SSH host key

```bash
cd /tmp
sudo -u openclaw podman exec openclaw-sandbox-research \
  cat /etc/ssh/ssh_host_ed25519_key.pub | \
  awk '{print "openclaw-sandbox-research " $1 " " $2}' >> \
  /tmp/research-hostkey.tmp
sudo -u openclaw bash -c \
  'cat /tmp/research-hostkey.tmp >> /home/openclaw/.openclaw/sandbox-ssh/known_hosts'
rm -f /tmp/research-hostkey.tmp
```

Note: This appends the research container's host key to the shared
`known_hosts` file. Each container generates unique host keys, so both
entries are needed.

### 5. Configure the agent in openclaw.json

Add the research agent to `agents.list` with its own workspace and sandbox
SSH target:

```json
"agents": {
  "defaults": {
    "elevatedDefault": "off",
    "sandbox": {
      "mode": "all",
      "backend": "ssh",
      "scope": "agent",
      "workspaceAccess": "rw",
      "ssh": {
        "target": "sandbox@openclaw-sandbox:22",
        "workspaceRoot": "/home/sandbox/workspaces",
        "strictHostKeyChecking": true,
        "identityFile": "/home/node/.openclaw/sandbox-ssh/id_ed25519",
        "knownHostsFile": "/home/node/.openclaw/sandbox-ssh/known_hosts"
      }
    }
  },
  "list": [
    {
      "id": "research",
      "workspace": "~/.openclaw/workspace-research",
      "sandbox": {
        "ssh": {
          "target": "sandbox@openclaw-sandbox-research:22"
        }
      }
    }
  ]
}
```

The research agent inherits all defaults (backend, scope, keys, etc.) but
overrides `ssh.target` to point at its own container. It also gets its own
gateway workspace (`~/.openclaw/workspace-research/`) which is populated
from package templates on first use — the research agent will go through
its own bootstrap ritual and develop its own identity.

### 6. Restart the gateway

```bash
cd /tmp && sudo -u openclaw podman restart openclaw
```

### 7. Verify

```bash
# Both sandbox containers running
cd /tmp && sudo -u openclaw podman ps

# SSH to research sandbox works
cd /tmp && sudo -u openclaw podman exec openclaw \
  ssh -i /home/node/.openclaw/sandbox-ssh/id_ed25519 \
  -o UserKnownHostsFile=/home/node/.openclaw/sandbox-ssh/known_hosts \
  sandbox@openclaw-sandbox-research 'echo OK; whoami'
```

### Architecture with two agents

```
openclaw user (rootless Podman, network: openclaw-net)
┌──────────────────┐          ┌──────────────────────────────────┐
│  Gateway Container│───SSH───▶│  openclaw-sandbox (main agent)   │
│  (openclaw:local) │          │  volume: sandbox-workspaces      │
│  port 18789/18790 │          └──────────────────────────────────┘
│                   │
│                   │───SSH───▶┌──────────────────────────────────┐
│                   │          │  openclaw-sandbox-research        │
│                   │          │  volume: sandbox-workspaces-research│
└──────────────────┘          └──────────────────────────────────┘
```

Each agent has its own container, volume, workspace, identity, and memory —
fully isolated. They share the same SSH keypair and `known_hosts` file, but
that's an authentication detail, not a filesystem boundary.

### Rebuilding per-agent sandbox containers

Follow the same rebuild process as the main sandbox, substituting the
container name and volume. For example, to rebuild the research sandbox:

```bash
cd /tmp && sudo -u openclaw podman stop openclaw-sandbox-research
cd /tmp && sudo -u openclaw podman rm openclaw-sandbox-research
cd /tmp && sudo -u openclaw podman run -d \
  --name openclaw-sandbox-research \
  --network openclaw-net \
  --restart unless-stopped \
  -v /home/openclaw/.openclaw/sandbox-workspaces-research:/home/sandbox/workspaces:rw \
  openclaw-sandbox-ssh:latest

# Update host key for research container
cd /tmp
sudo -u openclaw podman exec openclaw-sandbox-research \
  cat /etc/ssh/ssh_host_ed25519_key.pub | \
  awk '{print "openclaw-sandbox-research " $1 " " $2}' | \
  sudo tee /tmp/research-hostkey.tmp > /dev/null
# Remove old research key and append new one
sudo -u openclaw sed -i '/^openclaw-sandbox-research /d' \
  /home/openclaw/.openclaw/sandbox-ssh/known_hosts
sudo -u openclaw bash -c \
  'cat /tmp/research-hostkey.tmp >> /home/openclaw/.openclaw/sandbox-ssh/known_hosts'
rm -f /tmp/research-hostkey.tmp

# Restart gateway to pick up new sandbox state
sudo -u openclaw podman restart openclaw
```

Workspace data on the host volume persists across rebuilds — no reseed needed.
