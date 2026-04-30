#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APK_PATH="${APK_PATH:-${ROOT_DIR}/android/app/build/outputs/apk/debug/app-debug.apk}"
PACKAGE_NAME="${PACKAGE_NAME:-com.hmd.hmdchat.mobile}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found in PATH."
  exit 1
fi

if [ ! -f "${APK_PATH}" ]; then
  echo "APK not found: ${APK_PATH}"
  echo "Build first with: npm run mobile:docker:build"
  exit 1
fi

echo "Connected devices:"
adb devices
echo

ADB_ARGS=()
if [ -n "${ADB_SERIAL:-}" ]; then
  ADB_ARGS=(-s "${ADB_SERIAL}")
fi

set +e
INSTALL_OUTPUT="$(adb "${ADB_ARGS[@]}" install -r "${APK_PATH}" 2>&1)"
INSTALL_STATUS=$?
set -e

echo "${INSTALL_OUTPUT}"

if [ ${INSTALL_STATUS} -ne 0 ]; then
  if printf '%s' "${INSTALL_OUTPUT}" | grep -q "INSTALL_FAILED_UPDATE_INCOMPATIBLE"; then
    echo
    echo "Existing app signed with different key. Uninstalling old app and retrying..."
    adb "${ADB_ARGS[@]}" uninstall "${PACKAGE_NAME}" || true
    adb "${ADB_ARGS[@]}" install -r "${APK_PATH}"
  else
    exit ${INSTALL_STATUS}
  fi
fi

echo
echo "Installed ${PACKAGE_NAME} from:"
echo "  ${APK_PATH}"
echo
adb "${ADB_ARGS[@]}" shell monkey -p "${PACKAGE_NAME}" -c android.intent.category.LAUNCHER 1

echo
echo "Launched ${PACKAGE_NAME}"
