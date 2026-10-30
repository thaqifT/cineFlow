# Cineflow Studio

Local-first Roblox cutscene editor built with Tauri 2 and Rust, with a vanilla HTML/CSS/JavaScript desktop interface and a browser-based phone rotation controller.

## Prerequisites

- Node.js 20.19+ (or 22.12+) and npm
- Rust stable toolchain with Cargo
- Tauri v2 platform prerequisites: WebView2 on Windows; follow the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for other platforms

## Run locally

```sh
npm install
npm start
```

`npm start` launches `tauri dev` and Vite. `npm run build` builds the desktop frontend; `npm run tauri build` packages the desktop app. Rust handles native commands, local HTTP/HTTPS servers, WebSockets, QR generation, certificate creation, project dialogs, and saved takes. The same desktop editor and phone HTML/JS clients are served/embedded; the UI does not use Node in the desktop runtime.

## Architecture

| Component | Implementation |
| --- | --- |
| Desktop shell | Tauri 2 (system WebView) configured in `src-tauri/tauri.conf.json` |
| Main orchestration | `src-tauri/src/main.rs` (Rust commands and app state) |
| Frontend IPC | `@tauri-apps/api/core` + `@tauri-apps/api/event`, wrapped by `src/desktop/tauri-bridge.js` and exposed as the same `window.cineflow` API the editor already uses |
| Local HTTP (Studio, port 41837) and HTTPS (phone, port 41838) | `axum` on Tokio in `src-tauri/src/bridge.rs` (HTTPS via `axum-server` + rustls) |
| Phone WebSocket (`/ws/phone`) | `tokio-tungstenite` through `axum::extract::ws` |
| QR codes | `qrcode` crate (SVG data URLs) |
| Local CA + phone certificate | `rcgen` (persisted under the app data directory) |
| Cutscene/take file I/O | `std::fs` / `tokio::fs` |
| Roblox Studio plugin | `src/plugin/Main.plugin.lua`, unchanged: still talks to `http://127.0.0.1:41837` |
| Phone client | `src/phone/*`, unchanged HTML/JS, now embedded and served by Rust |
| Desktop dashboard | `src/desktop/*` vanilla HTML/CSS/JS, preserved as-is |

## Connect Roblox Studio and your phone

1. In Cineflow, click **Export Studio Plugin**, then install the exported Lua file in Roblox Studio with **Plugins → Save as Local Plugin**.
2. Click **Start phone bridge** in Cineflow. Allow local-network access if Windows Firewall prompts.
3. In Studio, open the Cineflow plugin and click **Connect to desktop app**. The plugin still uses the compatible loopback HTTP endpoint `127.0.0.1:41837`; allow plugin HTTP requests in Studio settings if prompted.
4. For iPhone sensors, first open the **First-time phone setup** QR. Install the local certificate profile, compare its SHA-256 fingerprint with the desktop app, then enable full trust in **Settings → General → About → Certificate Trust Settings**. This local CA has broad HTTPS trust on the phone; only install it on your own trusted network and remove it when no longer needed.
5. Scan the HTTPS camera QR, tap **Enable motion sensors**, set a neutral pose, and record. Phone sensor capture is rotation-only. Saved takes can be added to the timeline with **Recorded motion → Use**.

Cineflow listens on `0.0.0.0:41837` for the Studio-compatible local HTTP bridge and `0.0.0.0:41838` for phone HTTPS/WSS. The QR favors a Wi-Fi/Ethernet LAN address over VPN and virtual adapters. Both services are available only while the app is running. Keep the phone and desktop on the same reachable LAN and allow those ports through the local firewall if necessary.

## Playing cutscenes in your game

Two plugin buttons write everything a place needs: **Install player runtime to game** creates the runtime ModuleScript, the camera client, the saved cutscene data and the camera remote; **Add touch trigger to place** adds a neon pad with a ProximityPrompt and a script so a player who touches it gets the cutscene. Full manual steps, the runtime API and a copy-paste prompt for Studio's AI assistant are in [docs/studio-cutscene-setup.md](docs/studio-cutscene-setup.md).

Camera takes are anchored to the spot they were recorded from (a red `Workspace.CineflowData.CameraAnchor` block marks it), so preview always replays from that spot rather than from wherever the editor camera currently is. While Studio previews, the app's viewport shows a live wireframe proxy of the scene: Studio cannot stream rendered pixels to a plugin, so the plugin sends the camera transform and nearby geometry and the app projects it.

## First-version constraints

- Phone capture is rotation-only (alpha/beta/gamma), not real-world position tracking or video recording.
- Camera preview in a published Roblox experience needs the generated client camera runtime and a caller that invokes `CineflowRuntime.PlaySavedForPlayer(name, player)`. Server-side animation and trigger clips are available through `CineflowRuntime.PlaySaved(name)`.
- Verify the plugin in Roblox Studio; the Studio runtime is not included in the desktop tests.

## Checks

```sh
npm run check:frontend
npm run check
npm test
```

The latter two commands require Rust/Cargo. `npm run check` checks the frontend and runs `cargo check`; `npm test` runs the Rust unit tests.
