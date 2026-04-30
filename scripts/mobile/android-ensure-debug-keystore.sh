#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KEYSTORE_DIR="${ROOT_DIR}/.android"
KEYSTORE_PATH="${KEYSTORE_DIR}/debug.keystore"

if [ -f "${KEYSTORE_PATH}" ]; then
  exit 0
fi

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool not found in PATH."
  exit 1
fi

mkdir -p "${KEYSTORE_DIR}"

keytool -genkeypair \
  -v \
  -keystore "${KEYSTORE_PATH}" \
  -storepass android \
  -alias androiddebugkey \
  -keypass android \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"

echo "Created stable debug keystore:"
echo "  ${KEYSTORE_PATH}"
