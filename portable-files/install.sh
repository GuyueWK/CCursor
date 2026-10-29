#!/usr/bin/env bash
# install.sh - CCursor portable one-click installer (macOS / Linux)
#
# The whole package is offline: dist/cli.cjs + dist/models-catalog.json +
# vsix/*.vsix + node_modules/acorn ship in this folder, no npm/network needed.
# Only requirement on the target machine: Node.js >= 18 and Cursor IDE.
#
# Usage:
#   ./install.sh
#   ./install.sh --reinstall
#   ./install.sh --status
#   ./install.sh --uninstall
#   ./install.sh --cursor-root /path/to/cursor/resources/app
#   ./install.sh --force   # proceed while Cursor is running
set -u

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTION="install"
CURSOR_ROOT_OVERRIDE=""
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --reinstall) ACTION="update"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --status) ACTION="status"; shift ;;
    --force) FORCE=1; shift ;;
    --cursor-root) CURSOR_ROOT_OVERRIDE="$2"; shift 2 ;;
    --cursor-root=*) CURSOR_ROOT_OVERRIDE="${1#--cursor-root=}"; shift ;;
    -h|--help)
      echo "Usage: ./install.sh [--reinstall|--status|--uninstall] [--cursor-root PATH] [--force]"
      exit 0 ;;
    *) echo "[X] Unknown option: $1" >&2; exit 1 ;;
  esac
done

step() { echo ""; echo "==> $1"; }
ok() { echo "[OK] $1"; }
warn() { echo "[!] $1"; }
fail() { echo "[X] $1" >&2; exit 1; }

echo "Package: $PACKAGE_DIR"

# -- 1. Verify package contents --
step "Verifying package contents"
[ -f "$PACKAGE_DIR/dist/cli.cjs" ] || fail "Missing dist/cli.cjs - the archive was not fully extracted."
[ -f "$PACKAGE_DIR/node_modules/acorn/package.json" ] || fail "Missing node_modules/acorn - the archive was not fully extracted."
VSIX_COUNT=$(ls "$PACKAGE_DIR"/vsix/*.vsix 2>/dev/null | wc -l | tr -d ' ')
[ "$VSIX_COUNT" -gt 0 ] || fail "No .vsix found under vsix/ - the archive was not fully extracted."
[ -f "$PACKAGE_DIR/dist/models-catalog.json" ] || warn "dist/models-catalog.json is missing - defaults release will skip the model catalog."
ok "cli.cjs + vsix + acorn runtime present"

# -- 2. Node.js prerequisite --
step "Checking Node.js"
command -v node >/dev/null 2>&1 || fail "Node.js not found in PATH (need >= 18). Install Node.js from https://nodejs.org/ first."
NODE_VERSION="$(node --version)"
echo "node: $NODE_VERSION"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js $NODE_VERSION is too old (need >= 18)."
ok "Node.js OK"

# -- 3. Stale-backup guard (needs the resolved app root, so ask the bundled CLI) --
# Cursor self-updates leave old *.backup-byok-* behind; restoring them would put
# old-version files over the new app. Implemented in node (already required).
if [ "$ACTION" != "uninstall" ] && [ "$ACTION" != "status" ]; then
  step "Checking for stale backups from a previous Cursor version"
  if [ -n "$CURSOR_ROOT_OVERRIDE" ]; then
    export CCURSOR_CURSOR_ROOT="$CURSOR_ROOT_OVERRIDE"
  fi
  node -e '
    const fs = require("fs");
    const path = require("path");
    const { execFileSync } = require("child_process");
    function versionOf(file) {
      try { return JSON.parse(fs.readFileSync(file, "utf8")).version || ""; }
      catch { return ""; }
    }
    function findAppRoot() {
      if (process.env.CCURSOR_CURSOR_ROOT) return process.env.CCURSOR_CURSOR_ROOT;
      const home = process.env.HOME || "";
      const candidates = process.platform === "darwin"
        ? ["/Applications/Cursor.app/Contents/Resources/app", path.join(home, "Applications/Cursor.app/Contents/Resources/app")]
        : ["/opt/Cursor/resources/app", "/opt/cursor/resources/app", "/usr/share/cursor/resources/app",
            path.join(home, ".local/share/cursor/resources/app")];
      return candidates.find((root) => fs.existsSync(path.join(root, "product.json"))
        && fs.existsSync(path.join(root, "out/vs/workbench/workbench.desktop.main.js"))) || "";
    }
    // Reuse the bundled CLI resolver output instead of duplicating detection:
    // `node dist/cli.cjs status` fails when Cursor is missing, so resolve here first.
    const appRoot = findAppRoot();
    if (!appRoot) { console.error("Cursor installation not found. Re-run with --cursor-root /path/to/cursor/resources/app."); process.exit(2); }
    console.log("Cursor app root: " + appRoot);
    const currentVersion = versionOf(path.join(appRoot, "product.json"));
    console.log("Cursor product.json version: " + currentVersion);
    const stale = fs.readdirSync(appRoot)
      .filter((name) => name.startsWith("product.json.backup-byok-"))
      .map((name) => ({ name, version: versionOf(path.join(appRoot, name)) }))
      .filter((entry) => entry.version && currentVersion && entry.version !== currentVersion);
    if (stale.length === 0) { console.log("No stale backups"); process.exit(0); }
    console.log("Stale backups from an older Cursor version, removing:");
    const out = execFileSync("find", [appRoot, "-maxdepth", "4", "-name", "*.backup-byok-*"], { encoding: "utf8" });
    out.split("\n").filter(Boolean).forEach((file) => { fs.rmSync(file, { force: true }); console.log("deleted: " + file); });
  ' || {
    CODE=$?
    [ $CODE -eq 2 ] && fail "Cursor not found. Re-run with --cursor-root /path/to/cursor/resources/app."
    fail "Stale-backup check failed (exit $CODE)."
  }
  # Re-export for the CLI call below (node -e ran in a child process).
  if [ -z "${CCURSOR_CURSOR_ROOT:-}" ] && [ -n "$CURSOR_ROOT_OVERRIDE" ]; then
    export CCURSOR_CURSOR_ROOT="$CURSOR_ROOT_OVERRIDE"
  fi
fi

# -- 4. Cursor running? --
if [ "$ACTION" != "status" ]; then
  if pgrep -xi cursor >/dev/null 2>&1; then
    warn "Cursor seems to be running. Patched files may be locked."
    warn "Recommended: fully quit Cursor (not just reload window) before installing."
    if [ "$FORCE" -eq 0 ]; then
      fail "Aborted to avoid a partial install. Quit Cursor and retry, or re-run with --force."
    fi
    warn "--force given, proceeding while Cursor is running."
  else
    ok "Cursor is not running"
  fi
fi

# -- 5. Run the bundled CLI (offline, no npm/network) --
step "Running bundled CLI: $ACTION"
if [ -n "$CURSOR_ROOT_OVERRIDE" ]; then
  export CCURSOR_CURSOR_ROOT="$CURSOR_ROOT_OVERRIDE"
fi
# Default CCURSOR_CURSOR_ROOT to the override only; otherwise the CLI auto-detects.
node "$PACKAGE_DIR/dist/cli.cjs" "$ACTION" || fail "CLI $ACTION failed."
ok "CLI finished"

# -- 6. Verify + next steps --
if [ "$ACTION" != "uninstall" ]; then
  step "Verifying installation"
  node "$PACKAGE_DIR/dist/cli.cjs" status || fail "Status check failed."
  echo ""
  ok "Done. Next steps:"
  echo "  1. Fully quit Cursor if it is still open, then reopen it."
  echo "  2. Open the Cursor++ sidebar panel and configure your providers / API keys (~/.ccursor/providers.json)."
  echo "  3. After every Cursor update, re-run ./install.sh (updates overwrite the patched files)."
else
  echo ""
  ok "Uninstalled. Restart Cursor for changes to take effect."
fi
