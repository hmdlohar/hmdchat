#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${ANDROID_BUILD_IMAGE:-mingc/android-build-box:latest}"
GRADLE_VOLUME="${ANDROID_GRADLE_VOLUME:-hmdchat-gradle-cache}"
HOME_VOLUME="${ANDROID_HOME_VOLUME:-hmdchat-android-home}"
NPM_CACHE_VOLUME="${ANDROID_NPM_CACHE_VOLUME:-hmdchat-npm-cache}"

if ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  docker pull "${IMAGE_NAME}"
fi

docker run --rm \
  -e HOME=/cache/home \
  -e GRADLE_USER_HOME=/cache/gradle \
  -e NPM_CONFIG_CACHE=/cache/npm \
  -v "${ROOT_DIR}:/workspace" \
  -v "${GRADLE_VOLUME}:/cache/gradle" \
  -v "${HOME_VOLUME}:/cache/home" \
  -v "${NPM_CACHE_VOLUME}:/cache/npm" \
  -w /workspace \
  "${IMAGE_NAME}" \
  bash -lc '
    mkdir -p "$HOME"
    mkdir -p "$GRADLE_USER_HOME" "$NPM_CONFIG_CACHE"
    bash scripts/mobile/android-ensure-debug-keystore.sh
    if [ ! -d node_modules ]; then
      npm install
    fi
    if [ ! -d android ]; then
      npx cap add android
    fi
    npx cap sync android
    cd android
    chmod +x gradlew
    ./gradlew assembleDebug
  '

echo
echo "Android debug APK:"
echo "  ${ROOT_DIR}/android/app/build/outputs/apk/debug/app-debug.apk"
