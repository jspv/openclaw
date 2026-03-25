# SSH Sandbox Image

Debian bookworm-slim container running sshd, used as the SSH sandbox backend
for OpenClaw. The gateway SSHes into this container to execute agent tool calls
(exec, file read/write/edit) in an isolated environment.

## What's inside

- openssh-server (key-only auth, sandbox user only)
- bash, git, curl, jq, python3, ripgrep, tar, coreutils, findutils

## Build

The SSH public key is baked into the image at build time:

```bash
cd ~/src/openclaw
podman build \
  --build-arg SSH_PUBLIC_KEY="$(sudo cat /home/openclaw/.openclaw/sandbox-ssh/id_ed25519.pub)" \
  -t openclaw-sandbox-ssh:latest -f sandbox-ssh/Containerfile sandbox-ssh/
```

## Adding tools

Edit `Containerfile` to add packages, then rebuild and redeploy. See the
"Rebuild sandbox with new tools" section in the setup guide.
