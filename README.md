# hmdchat draft

Desktop-first local chat draft that runs as a Node.js process and serves a browser UI.

## Features in this draft

- LAN device discovery over `mDNS` / Bonjour
- manual peer connect by `host:port` for same-machine testing
- text chat between discovered devices
- file transfer between discovered devices
- drag-and-drop file sending
- delivery and read receipts
- configurable received files folder
- `Save as` action that moves file to another path
- local inbox/history persisted to `.data/messages.json`
- unread counters in the device list
- browser UI that feels like a simple desktop messenger

## Runtime model

Each PC runs the same Node.js app:

- Node process advertises itself on LAN
- Node process discovers other peers
- Node process receives files/messages over HTTP
- browser UI connects to the local Node process over WebSocket

This means the actual app logic runs in Node.js, not only in the browser.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open:

```bash
http://localhost:33445
```

## Run in Electron

Install Electron first:

```bash
npm install
```

Then start desktop shell:

```bash
npm run desktop
```

Electron starts local server, waits for `/health`, then loads `http://127.0.0.1:33445` in main window.

## Start Capacitor mobile shell

This repo now includes a Capacitor scaffold for Android. It packages the current web UI into a mobile shell, but the current Node desktop server is not yet replaced with a mobile-native runtime.

Install JS dependencies:

```bash
npm install
```

Initialize Android project:

```bash
npm run mobile:init:android
npm run mobile:sync
```

## Android build in Docker

No local Android SDK required. Build inside Docker:

```bash
npm run mobile:docker:build
```

Open an interactive Android build shell if needed:

```bash
npm run mobile:docker:shell
```

Recommended first-run flow:

```bash
npm run mobile:docker:shell
```

Then inside container:

```bash
if [ ! -d node_modules ]; then npm install; fi
if [ ! -d android ]; then npx cap add android; fi
npx cap sync android
cd android
./gradlew assembleDebug
```

Docker shell/build now use persistent Docker volumes for:

- Gradle cache
- container home
- npm cache

So Gradle wrapper and dependency downloads should not restart from zero every build.
Build scripts also create and reuse a stable repo-local debug keystore at `.android/debug.keystore`, so debug APK identity stays consistent across installs.

Default image:

```bash
mingc/android-build-box:latest
```

Override if needed:

```bash
ANDROID_BUILD_IMAGE=mohamedhelmy/android-docker npm run mobile:docker:build
```

Expected debug APK:

```bash
android/app/build/outputs/apk/debug/app-debug.apk
```

Install to connected Android device:

```bash
npm run mobile:android:install
```

If an older debug build was signed with a different key, installer auto-uninstalls old app and retries once. After switching to the stable repo debug keystore, this should be one-time only.

Select specific device:

```bash
ADB_SERIAL=<device-serial> npm run mobile:android:install
```

## Build packages

Add icons first:

- `build/icons/icon.ico` for Windows
- `build/icons/256x256.png` for Linux

These can be generated from `assets/logo.png`.

Then build:

```bash
npm run dist:linux
npm run dist:win
```

Output goes to `dist/`.

## Run two local instances on one machine

Use separate ports and data directories:

```bash
PORT=33445 DATA_DIR=.data-a DEVICE_NAME=alpha npm start
PORT=33446 DATA_DIR=.data-b DEVICE_NAME=beta npm start
```

If you run two instances with same `DEVICE_NAME`, app now auto-uses unique Bonjour instance names by port. You can also override manually:

```bash
PORT=33445 DEVICE_NAME=alpha SERVICE_INSTANCE_NAME=alpha-1 npm start
PORT=33446 DEVICE_NAME=alpha SERVICE_INSTANCE_NAME=alpha-2 npm start
```

Then open each local URL in a different browser window:

- `http://localhost:33445`
- `http://localhost:33446`

If local discovery does not show both instances automatically, connect them manually from the sidebar:

- on `33445`, connect to `127.0.0.1:33446`
- on `33446`, connect to `127.0.0.1:33445`

You can also pre-seed peers:

```bash
PORT=33445 DATA_DIR=.data-a DEVICE_NAME=alpha SEED_PEERS=127.0.0.1:33446 npm start
PORT=33446 DATA_DIR=.data-b DEVICE_NAME=beta SEED_PEERS=127.0.0.1:33445 npm start
```

## Current limits

- no authentication
- no encryption
- no message deletion/editing
- Electron shell is minimal host only
- file moves use path prompt, not native folder picker
- Capacitor shell exists, but mobile runtime still needs native/mobile replacement for current desktop Node server behavior

## Next useful steps

1. add image previews and drag-multi-file upload
2. add pairing / allow-list before accepting incoming content
3. add desktop notifications
4. add system tray wrapper with Electron or Tauri
