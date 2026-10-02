# Self-hosting kit

Pull-based deploy of the node server build to a Linux box behind nginx, under a sub-path.
Why it pulls instead of using a CI runner, how rollback works and what the runner
alternative costs: [docs/DEPLOY.md](../docs/DEPLOY.md).

| File | Installed as |
|---|---|
| `crush-deploy.sh` | `$ROOT/bin/crush-deploy.sh` (root, 755) |
| `crush.service` | `/etc/systemd/system/crush.service` |
| `crush-deploy.service`, `crush-deploy.timer` | `/etc/systemd/system/` |
| `nginx-crush.conf` | an nginx snippet, included in the site's 443 `server` block |
| `deploy.env.example` | `$ENV` (root, 600), filled in for the box |

Templates use `@ROOT@`, `@ENV@`, `@BASE@`, `@NOSLASH@` and `@PORT@`. Pick the values once, as
root, in one shell:

```bash
ROOT=<deploy root>          # e.g. a new directory under /srv
ENV=<env file>              # e.g. a new directory under /etc, holding deploy.env
BASE=/crush/                # APP_BASE
PORT=<unused port>          # ss -ltn shows what is taken
CHECK_PORT=<another unused port>
render() { sed -e "s|@ROOT@|$ROOT|g" -e "s|@ENV@|$ENV|g" -e "s|@BASE@|$BASE|g" \
  -e "s|@NOSLASH@|${BASE%/}|g" -e "s|@PORT@|$PORT|g" "$1"; }
```

## 1. User, directories, Node

```bash
useradd --system --user-group --home-dir "$ROOT/cache" --no-create-home --shell /usr/sbin/nologin crush
install -d -m 755 -o root  -g root  "$ROOT" "$ROOT/bin" "$ROOT/state"
install -d -m 755 -o crush -g crush "$ROOT/releases" "$ROOT/src" "$ROOT/shared" "$ROOT/cache"
install -d -m 700 -o crush -g crush "$ROOT/shared/pglite"
```

Node (the version `node -v` reports on a dev machine; v24 today), unpacked root-owned, with its
checksum verified:

```bash
V=v24.15.0; T=node-$V-linux-x64.tar.xz
cd "$(mktemp -d)" && curl -fsSLO "https://nodejs.org/dist/$V/$T" -O "https://nodejs.org/dist/$V/SHASUMS256.txt"
grep " $T\$" SHASUMS256.txt | sha256sum -c - && mkdir "$ROOT/node" && tar -xJf "$T" -C "$ROOT/node" --strip-components=1 --no-same-owner
```

## 2. Script, env file, units

Install by temp name + `mv`, never by overwriting: a running bash reads its script by offset.

```bash
install -m 755 deploy/crush-deploy.sh "$ROOT/bin/.crush-deploy.sh.new" && mv -f "$ROOT/bin/.crush-deploy.sh.new" "$ROOT/bin/crush-deploy.sh"
install -d -m 700 "$(dirname "$ENV")"
install -m 600 deploy/deploy.env.example "$ENV"     # then set PORT, CRUSH_CHECK_PORT, APP_BASE
for u in crush.service crush-deploy.service crush-deploy.timer; do render "deploy/$u" > "/etc/systemd/system/$u"; done
systemd-analyze verify /etc/systemd/system/crush.service /etc/systemd/system/crush-deploy.service
systemctl daemon-reload
```

`daemon-reload` restarts nothing (it does re-draw the random delay of other timers that use
`RandomizedDelaySec`, e.g. a certbot renewal timer). `crush.service` stays inactive until the first
release exists.

## 3. First deploy

```bash
systemctl start crush-deploy.service           # builds, checks, goes live (a few minutes)
journalctl -u crush-deploy.service -n 50 --no-pager
curl -fsS "http://127.0.0.1:$PORT$BASE" -o /dev/null && echo live
systemctl enable crush.service
```

To deploy a commit that is not on GitHub yet, bundle it, copy it over and point the env file at it:

```bash
git bundle create crush.bundle <branch>                                   # on the dev machine
install -m 644 -o crush -g crush crush.bundle "$ROOT/cache/crush.bundle"  # on the box
# in $ENV: CRUSH_REPO=$ROOT/cache/crush.bundle  CRUSH_BRANCH=<branch>
```

Switching back to GitHub is the same edit: `CRUSH_REPO=https://github.com/<owner>/<repo>.git`,
`CRUSH_BRANCH=main`. The next poll deploys `main` if its commit differs from the live one.

## 4. nginx route

Back up the site config, add one `include`, validate, then **reload** (never restart):

```bash
SITE=<the site file under sites-available>
cp -a "$SITE" "$SITE.bak-$(date -u +%Y%m%dT%H%M%SZ)"
render deploy/nginx-crush.conf > /etc/nginx/snippets/crush.conf
# inside the site's `server { listen 443 ssl; server_name ...; }` block add:
#     include snippets/crush.conf;
nginx -t && systemctl reload nginx
```

## 5. Timer

```bash
systemctl enable --now crush-deploy.timer
systemctl list-timers crush-deploy.timer
```

## Operating it

| Task | Command |
|---|---|
| What is live | `cat $ROOT/current/REVISION` |
| Deploy log | `journalctl -u crush-deploy.service` |
| App log | `journalctl -u crush.service` |
| Deploy now | `systemctl start crush-deploy.service` |
| Retry a commit marked failed | `rm $ROOT/state/failed-<sha>` |
| Roll back by hand | see below |
| Pause deploys | `systemctl stop crush-deploy.timer` |
| Update the deploy script | step 2's `install` + `mv` line; units: re-render + `daemon-reload` |

Roll back by hand, from `$ROOT`. Marking the bad commit failed keeps the next poll from
redeploying it; the next *new* commit on the branch deploys as usual.

```bash
touch "state/failed-$(cat current/REVISION)"
ls releases                                    # pick the older release
ln -sfn releases/<older> current.new && mv -fT current.new current && systemctl restart crush.service
```
