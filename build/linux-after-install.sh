#!/bin/sh
set -eu

# dpkg preserves an existing directory's mode during an in-place upgrade.
# OpenMausBot 0.1.7 installed the application ancestors as 0775, which makes
# the bundled Cua Driver correctly reject its own executable path. A configured
# DEB also needs Electron's Chromium sandbox to be root-owned and setuid. Repair
# only the exact package-owned paths; never weaken a runtime validator and never
# ask an end user to run chmod manually.
if [ -n "${OPENMAUSBOT_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$OPENMAUSBOT_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) APP_ROOT=$TEST_ROOT ;;
    *)
      echo "OpenMausBot test install root must stay under /tmp" >&2
      exit 1
      ;;
  esac
  EXPECTED_OWNER="$(id -un):$(id -gn)"
  TEST_MODE=1
else
  APP_ROOT=/opt/OpenMausBot
  EXPECTED_OWNER=root:root
  TEST_MODE=0
fi

repair_directory() {
  target=$1
  if [ -L "$target" ] || [ ! -d "$target" ]; then
    echo "OpenMausBot package directory is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "OpenMausBot could not secure package directory: $target ($actual)" >&2
    exit 1
  fi
}

repair_executable() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "OpenMausBot package executable is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 0755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:755" ]; then
    echo "OpenMausBot could not secure package executable: $target ($actual)" >&2
    exit 1
  fi
}

repair_chromium_sandbox() {
  target=$1
  if [ -L "$target" ] || [ ! -f "$target" ]; then
    echo "OpenMausBot Chromium sandbox is missing or unsafe: $target" >&2
    exit 1
  fi
  if [ "$TEST_MODE" -eq 0 ]; then chown root:root -- "$target"; fi
  chmod 4755 -- "$target"
  actual="$(stat -c '%U:%G:%a' -- "$target")"
  if [ "$actual" != "$EXPECTED_OWNER:4755" ]; then
    echo "OpenMausBot could not secure Chromium sandbox: $target ($actual)" >&2
    exit 1
  fi
}

CUA_ROOT=$APP_ROOT/resources/cua-linux-x64
repair_directory "$APP_ROOT"
repair_directory "$APP_ROOT/resources"
repair_directory "$CUA_ROOT"
repair_executable "$CUA_ROOT/cua-driver"
repair_executable "$CUA_ROOT/cua-cursor-theme"
repair_chromium_sandbox "$APP_ROOT/chrome-sandbox"
