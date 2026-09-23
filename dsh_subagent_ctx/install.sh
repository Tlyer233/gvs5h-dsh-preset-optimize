#!/usr/bin/env bash
# 安装到 dsh profile（默认 web）。宿主组合插入，所有 preset 共用。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$ROOT/dsh-subagent-ctx"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
CACHE="$PROFILE_DIR/.install-cache"
MANIFEST="$PROFILE_DIR/package.json"

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

need dsh
need node
[ -d "$PLUGIN_DIR" ] || die "missing $PLUGIN_DIR"

mkdir -p "$CACHE"

if command -v npm >/dev/null 2>&1; then
  (cd "$PLUGIN_DIR" && npm pack --pack-destination "$CACHE" >/dev/null)
elif command -v pnpm >/dev/null 2>&1; then
  (cd "$PLUGIN_DIR" && pnpm pack --pack-destination "$CACHE" >/dev/null)
else
  die "need npm or pnpm"
fi

VERSION="$(node -p "require('$PLUGIN_DIR/package.json').version")"
TGZ="$CACHE/dsh-subagent-ctx-$VERSION.tgz"
[ -f "$TGZ" ] || die "pack produced no $TGZ"
echo "packed $TGZ"

STALE="$(node -e '
  const fs = require("fs");
  try {
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const spec = (pkg.dependencies || {})["dsh-subagent-ctx"];
    if (typeof spec === "string" && spec.startsWith("file:")) process.stdout.write(spec.slice(5));
  } catch (error) { }
' "$MANIFEST" || true)"
if [ -n "${STALE:-}" ] && [ ! -f "$STALE" ] && [ "$STALE" != "$TGZ" ]; then
  cp "$TGZ" "$STALE"
  echo "repaired missing spec: $STALE"
fi

echo "installing into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$TGZ" --force

find "$CACHE" -maxdepth 1 -name 'dsh-subagent-ctx-*.tgz' ! -name "$(basename "$TGZ")" -delete 2>/dev/null || true

INSTALLED="$PROFILE_DIR/node_modules/dsh-subagent-ctx/client.js"
if [ -f "$INSTALLED" ] && grep -q "ext/dsh-subagent-ctx/status" "$INSTALLED"; then
  echo "installed copy verified: $INSTALLED"
else
  echo "WARNING: installed copy not verified at $INSTALLED" >&2
fi

cat <<EOF

done. version: $VERSION

next:
  1. 重启 dsh
  2. 刷新 Web GUI（Cmd+Shift+R）
  3. 打开一次性子代理页：底部原「一次性子代理记录」位置应显示 ctx · t/s

remove: ./uninstall.sh
EOF
