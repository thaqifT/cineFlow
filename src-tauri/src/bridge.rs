use axum::{
    body::Body,
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, ConnectInfo, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use if_addrs::get_if_addrs;
use qrcode::{render::svg, QrCode};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use uuid::Uuid;

const HTTP_PORT: u16 = 41837;
const HTTPS_PORT: u16 = 41838;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_MOTION_HISTORY: usize = 10_000;
const PLUGIN_STALE_MS: u64 = 2500;
const PHONE_HTML: &[u8] = include_bytes!("../../src/phone/index.html");
const PHONE_JS: &[u8] = include_bytes!("../../src/phone/phone.js");
const PHONE_CSS: &[u8] = include_bytes!("../../src/phone/phone.css");
const PLUGIN_LUA: &[u8] = include_bytes!("../../src/plugin/Main.plugin.lua");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanAddress {
    pub name: String,
    pub address: String,
    #[serde(skip)]
    score: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub url: String,
    pub qr: String,
    pub setup_qr: String,
    pub port: u16,
    pub phone_port: u16,
    pub phone_setup_url: String,
    pub ca_fingerprint: String,
    pub interfaces: Vec<LanAddress>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeState {
    pub phone_connected: bool,
    pub plugin_connected: bool,
    pub plugin_connected_ms_ago: Option<u64>,
    pub status: String,
    pub take: Option<Value>,
}

#[derive(Deserialize)]
struct AuthQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct PhoneQuery {
    token: Option<String>,
}

#[derive(Deserialize)]
struct PluginEvent {
    #[serde(rename = "type")]
    kind: Option<String>,
    status: Option<String>,
    take: Option<Value>,
    preview: Option<Value>,
}

#[derive(Clone)]
pub struct Bridge {
    app: AppHandle,
    token: String,
    data: Arc<Mutex<BridgeData>>,
    events: broadcast::Sender<String>,
}

struct BridgeData {
    phone_connected: bool,
    phone_connected_at: Option<Instant>,
    last_plugin_poll: Option<Instant>,
    status: String,
    take: Option<Value>,
    cutscene: Option<Value>,
    cutscene_revision: u64,
    commands: VecDeque<Value>,
    latest_motion: Option<Value>,
    latest_motion_sequence: u64,
    last_polled_motion_sequence: u64,
    motion_history: VecDeque<Value>,
}

impl Bridge {
    pub fn new(app: AppHandle) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            app,
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            data: Arc::new(Mutex::new(BridgeData {
                phone_connected: false,
                phone_connected_at: None,
                last_plugin_poll: None,
                status: "Offline".into(),
                take: None,
                cutscene: None,
                cutscene_revision: 0,
                commands: VecDeque::new(),
                latest_motion: None,
                latest_motion_sequence: 0,
                last_polled_motion_sequence: 0,
                motion_history: VecDeque::new(),
            })),
            events,
        }
    }

    fn authenticated(&self, supplied: Option<&str>) -> bool {
        let Some(supplied) = supplied else { return false };
        supplied.len() == self.token.len() && bool::from(supplied.as_bytes().ct_eq(self.token.as_bytes()))
    }

    pub fn snapshot(&self) -> BridgeState {
        let data = self.data.lock().unwrap();
        let plugin_connected_ms_ago = plugin_age_ms(data.last_plugin_poll, Instant::now());
        BridgeState {
            phone_connected: data.phone_connected,
            plugin_connected: plugin_connected_ms_ago.is_some_and(|ms| ms < PLUGIN_STALE_MS),
            plugin_connected_ms_ago,
            status: data.status.clone(),
            take: data.take.clone(),
        }
    }

    pub fn publish_state(&self) {
        let state = self.snapshot();
        let _ = self.app.emit("bridge-state", &state);
        let _ = self.events.send(json!({
            "type": "state",
            "phoneConnected": state.phone_connected,
            "pluginConnected": state.plugin_connected,
            "status": state.status,
            "take": state.take,
        }).to_string());
    }

    pub fn set_cutscene(&self, cutscene: Value) {
        let mut data = self.data.lock().unwrap();
        data.cutscene = Some(cutscene);
        data.cutscene_revision += 1;
    }

    pub fn queue_command(&self, command: &str, start: Option<f64>) -> bool {
        if !matches!(command, "preview" | "stop-preview" | "calibrate") { return false; }
        let mut payload = json!({ "type": command });
        if command == "preview" {
            // Studio starts where the desktop playhead is, so pressing Play mid-take
            // does not silently restart the shot from zero.
            if let Some(seconds) = start.filter(|value| value.is_finite() && *value >= 0.0) {
                payload["start"] = json!(seconds);
            }
        }
        self.data.lock().unwrap().commands.push_back(payload);
        if command == "calibrate" {
            let _ = self.events.send(json!({ "type": "command", "command": command }).to_string());
        }
        true
    }

    fn set_take(&self, take: Value) {
        self.data.lock().unwrap().take = Some(take.clone());
        let _ = self.app.emit("take-saved", &take);
        self.publish_state();
    }

    fn handle_phone_message(&self, raw: &str) -> Option<String> {
        let message: Value = serde_json::from_str(raw).ok()?;
        match message.get("type")?.as_str()? {
            "hello" => {
                let mut data = self.data.lock().unwrap();
                data.phone_connected = true;
                data.phone_connected_at = Some(Instant::now());
                data.status = "Camera connected".into();
                drop(data);
                self.publish_state();
            }
            "motion" => {
                let alpha = message.get("alpha")?.as_f64()?;
                let beta = message.get("beta")?.as_f64()?;
                let gamma = message.get("gamma")?.as_f64()?;
                if [alpha, beta, gamma].iter().any(|value| !value.is_finite() || value.abs() > 360.0) { return None; }
                let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
                let mut data = self.data.lock().unwrap();
                data.latest_motion_sequence += 1;
                let sequence = data.latest_motion_sequence;
                if data.last_plugin_poll.zip(data.phone_connected_at).is_none_or(|(poll, connected)| poll < connected) {
                    data.last_polled_motion_sequence = sequence;
                }
                let motion = json!({ "alpha": alpha, "beta": beta, "gamma": gamma, "timestamp": timestamp });
                data.latest_motion = Some(motion.clone());
                let mut sample = motion.clone();
                sample["sequence"] = json!(sequence);
                data.motion_history.push_back(sample);
                if data.motion_history.len() > MAX_MOTION_HISTORY { data.motion_history.pop_front(); }
                drop(data);
                let _ = self.app.emit("phone-motion", &motion);
                let _ = self.events.send(json!({ "type": "motion", "motionSequence": sequence, "alpha": alpha, "beta": beta, "gamma": gamma, "timestamp": timestamp }).to_string());
            }
            "record" | "stop-record" => {
                let mut data = self.data.lock().unwrap();
                if !data.last_plugin_poll.is_some_and(|at| at.elapsed().as_millis() as u64 <= PLUGIN_STALE_MS) {
                    let text = if message["type"] == "record" { "Connect the Studio plugin before recording." } else { "Studio plugin disconnected." };
                    return Some(json!({ "type": "error", "message": text }).to_string());
                }
                let kind = message["type"].as_str().unwrap();
                if kind == "record" {
                    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    let take = json!({ "id": format!("take-{now}"), "startedAt": now });
                    data.take = Some(take.clone());
                    data.commands.push_back(json!({ "type": "record", "take": take }));
                    data.status = "Recording".into();
                } else {
                    let take = data.take.clone();
                    data.commands.push_back(json!({ "type": "stop-record", "take": take }));
                    data.status = "Finishing take".into();
                }
                drop(data);
                self.publish_state();
            }
            _ => {}
        }
        None
    }

    fn disconnect_phone(&self) {
        let mut data = self.data.lock().unwrap();
        data.phone_connected = false;
        data.phone_connected_at = None;
        data.status = if data.last_plugin_poll.is_some_and(|at| (at.elapsed().as_millis() as u64) < PLUGIN_STALE_MS) { "Phone disconnected" } else { "Offline" }.into();
        drop(data);
        self.publish_state();
    }
}

fn plugin_age_ms(last_poll: Option<Instant>, now: Instant) -> Option<u64> {
    last_poll.map(|at| now.saturating_duration_since(at).as_millis() as u64)
}

#[derive(Clone)]
struct ServerContext {
    bridge: Bridge,
    takes_dir: PathBuf,
    ca_der: Arc<Vec<u8>>,
    fingerprint: String,
}

fn bridge_router(context: ServerContext) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/setup", get(setup_page))
        .route("/setup/", get(setup_page))
        .route("/setup/certificate.mobileconfig", get(certificate_profile))
        .route("/setup/certificate.cer", get(certificate_download))
        .route("/phone", get(phone_html))
        .route("/phone/", get(phone_html))
        .route("/phone/phone.js", get(phone_js))
        .route("/phone/phone.css", get(phone_css))
        .route("/plugin/config", get(plugin_config))
        .route("/plugin/poll", get(plugin_poll))
        .route("/plugin/event", axum::routing::post(plugin_event))
        .route("/plugin/Main.plugin.lua", get(plugin_lua))
        .route("/ws/phone", get(phone_ws))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(context)
}

fn response(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response {
    Response::builder().status(status).header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff").body(body.into()).unwrap()
}

async fn health(State(context): State<ServerContext>) -> impl IntoResponse {
    let state = context.bridge.snapshot();
    Json(json!({ "ok": true, "phoneConnected": state.phone_connected, "pluginConnected": state.plugin_connected, "status": state.status, "take": state.take }))
}

async fn setup_page(State(context): State<ServerContext>, headers: axum::http::HeaderMap) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).filter(|v| v.chars().all(|c| c.is_ascii_alphanumeric() || ".:-[]".contains(c))).unwrap_or("127.0.0.1:41837");
    let profile_url = format!("http://{host}/setup/certificate.mobileconfig");
    let certificate_url = format!("http://{host}/setup/certificate.cer");
    let html = format!(r#"<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Cineflow phone sensor setup</title><style>body{{font:16px system-ui,sans-serif;max-width:38rem;margin:2rem auto;padding:0 1rem;color:#17212b}}li{{margin:.8rem 0;line-height:1.45}}a,code{{overflow-wrap:anywhere}}code{{font-size:.8rem;background:#eef2f5;padding:.35rem;border-radius:.3rem}}aside{{background:#fff3d5;padding:1rem;border-radius:.6rem;line-height:1.45}}</style><h1>Cineflow phone sensor setup</h1><p>iPhone Safari requires a trusted HTTPS connection to read motion sensors. Install Cineflow’s local certificate on this phone, then trust it explicitly.</p><ol><li><a href="{profile_url}">Install the Cineflow certificate profile (iPhone)</a>. Android users: <a href="{certificate_url}">download the CA certificate</a>.</li><li>On iPhone, open <b>Settings → General → VPN &amp; Device Management</b> and install the downloaded Cineflow profile.</li><li>On iPhone, open <b>Settings → General → About → Certificate Trust Settings</b> and enable full trust for the Cineflow local certificate. On Android, install it as a CA certificate under Security settings.</li><li>Return to Cineflow and scan its HTTPS camera QR code.</li></ol><p>Verify this fingerprint matches the desktop app before trusting:</p><p><code>{}</code></p><aside>This local development CA has broad HTTPS trust on this phone. Only trust it on your own local network; remove it from phone settings when no longer needed. Its private key stays on this computer.</aside></html>"#, context.fingerprint);
    response(StatusCode::OK, "text/html; charset=utf-8", html)
}

async fn certificate_profile(State(context): State<ServerContext>) -> Response {
    let id = Uuid::new_v4().to_string().to_uppercase();
    let profile = format!(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>PayloadContent</key><array><dict><key>PayloadContent</key><data>{}</data><key>PayloadDescription</key><string>Trust Cineflow's local phone bridge certificate</string><key>PayloadDisplayName</key><string>Cineflow Local Certificate Authority</string><key>PayloadIdentifier</key><string>com.cineflow.local-ca.{id}</string><key>PayloadType</key><string>com.apple.security.root</string><key>PayloadUUID</key><string>{id}</string><key>PayloadVersion</key><integer>1</integer></dict></array><key>PayloadDescription</key><string>Local HTTPS support for the Cineflow phone camera. Verify the fingerprint in the desktop app before installing and trusting.</string><key>PayloadDisplayName</key><string>Cineflow Phone Camera HTTPS</string><key>PayloadIdentifier</key><string>com.cineflow.phone-https.{id}</string><key>PayloadOrganization</key><string>Cineflow Studio</string><key>PayloadRemovalDisallowed</key><false/><key>PayloadType</key><string>Configuration</string><key>PayloadUUID</key><string>{id}</string><key>PayloadVersion</key><integer>1</integer></dict></plist>"#, BASE64.encode(&*context.ca_der));
    let mut response = response(StatusCode::OK, "application/x-apple-aspen-config", profile);
    response.headers_mut().insert(header::CONTENT_DISPOSITION, "attachment; filename=\"cineflow-phone-https.mobileconfig\"".parse().unwrap());
    response
}

async fn certificate_download(State(context): State<ServerContext>) -> Response {
    let mut response = response(StatusCode::OK, "application/pkix-cert", context.ca_der.as_ref().clone());
    response.headers_mut().insert(header::CONTENT_DISPOSITION, "attachment; filename=\"cineflow-local-ca.cer\"".parse().unwrap());
    response
}

async fn phone_html() -> Response { response(StatusCode::OK, "text/html; charset=utf-8", PHONE_HTML) }
async fn phone_js() -> Response { response(StatusCode::OK, "text/javascript; charset=utf-8", PHONE_JS) }
async fn phone_css() -> Response { response(StatusCode::OK, "text/css; charset=utf-8", PHONE_CSS) }
async fn plugin_lua(State(context): State<ServerContext>, Query(query): Query<AuthQuery>) -> Response {
    if !context.bridge.authenticated(query.token.as_deref()) { return response(StatusCode::UNAUTHORIZED, "text/plain; charset=utf-8", "Unauthorized"); }
    response(StatusCode::OK, "text/plain; charset=utf-8", PLUGIN_LUA)
}

async fn plugin_config(State(context): State<ServerContext>, ConnectInfo(remote): ConnectInfo<SocketAddr>) -> Response {
    if !remote.ip().is_loopback() { return response(StatusCode::FORBIDDEN, "text/plain; charset=utf-8", "Studio must connect locally"); }
    response(StatusCode::OK, "application/json", json!({ "port": HTTP_PORT, "token": context.bridge.token }).to_string())
}

async fn plugin_poll(State(context): State<ServerContext>, Query(query): Query<AuthQuery>) -> Response {
    if !context.bridge.authenticated(query.token.as_deref()) { return response(StatusCode::UNAUTHORIZED, "text/plain; charset=utf-8", "Unauthorized"); }
    let (snapshot, payload) = {
        let mut data = context.bridge.data.lock().unwrap();
        data.last_plugin_poll = Some(Instant::now());
        if data.status == "Offline" { data.status = if data.phone_connected { "Ready" } else { "Studio plugin connected" }.into(); }
        let plugin_connected = true;
        let first_sequence = data.motion_history.front().and_then(|sample| sample["sequence"].as_u64()).unwrap_or(data.latest_motion_sequence + 1);
        if data.last_polled_motion_sequence < first_sequence.saturating_sub(1) { data.last_polled_motion_sequence = first_sequence.saturating_sub(1); }
        let motion_batch: Vec<Value> = data.motion_history.iter().filter(|sample| sample["sequence"].as_u64().unwrap_or(0) > data.last_polled_motion_sequence).cloned().collect();
        data.last_polled_motion_sequence = data.latest_motion_sequence;
        let take_count = data.commands.len().min(20);
        let commands: Vec<Value> = data.commands.drain(..take_count).collect();
        let state = BridgeState { phone_connected: data.phone_connected, plugin_connected, plugin_connected_ms_ago: Some(0), status: data.status.clone(), take: data.take.clone() };
        let payload = json!({
            "ok": true, "phoneConnected": state.phone_connected, "pluginConnected": state.plugin_connected,
            "status": state.status, "take": state.take, "motion": data.latest_motion,
            "motionSequence": data.latest_motion_sequence, "motionBatch": motion_batch,
            "commands": commands, "cutscene": data.cutscene, "cutsceneRevision": data.cutscene_revision,
        });
        (state, payload)
    };
    let _ = context.bridge.app.emit("bridge-state", &snapshot);
    response(StatusCode::OK, "application/json", payload.to_string())
}

async fn plugin_event(State(context): State<ServerContext>, Query(query): Query<AuthQuery>, Json(event): Json<PluginEvent>) -> Response {
    if !context.bridge.authenticated(query.token.as_deref()) { return response(StatusCode::UNAUTHORIZED, "text/plain; charset=utf-8", "Unauthorized"); }
    if event.kind.as_deref() == Some("status") {
        if let Some(status) = event.status { context.bridge.data.lock().unwrap().status = status.chars().take(80).collect(); }
    } else if matches!(event.kind.as_deref(), Some("preview") | Some("preview-frame")) {
        // Studio cannot stream rendered frames, so the plugin sends the camera pose and
        // the geometry it is framing; the app projects that itself.
        if let Some(payload) = event.preview { let _ = context.bridge.app.emit("plugin-preview", &payload); }
        return response(StatusCode::OK, "application/json", r#"{"ok":true}"#);
    } else if event.kind.as_deref() == Some("take-saved") {
        if let Some(take) = event.take {
            let name = take.get("id").and_then(Value::as_str).unwrap_or("take");
            let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
            if let Err(error) = tokio::fs::create_dir_all(&context.takes_dir).await {
                return response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.to_string());
            }
            let bytes = match serde_json::to_vec_pretty(&take) { Ok(bytes) => bytes, Err(error) => return response(StatusCode::BAD_REQUEST, "text/plain; charset=utf-8", error.to_string()) };
            if let Err(error) = tokio::fs::write(context.takes_dir.join(format!("{safe}.json")), bytes).await {
                return response(StatusCode::INTERNAL_SERVER_ERROR, "text/plain; charset=utf-8", error.to_string());
            }
            context.bridge.set_take(take);
            context.bridge.data.lock().unwrap().status = "Take saved".into();
        }
    }
    context.bridge.publish_state();
    response(StatusCode::OK, "application/json", r#"{"ok":true}"#)
}

async fn phone_ws(ws: WebSocketUpgrade, State(context): State<ServerContext>, Query(query): Query<PhoneQuery>) -> Response {
    if !context.bridge.authenticated(query.token.as_deref()) { return StatusCode::UNAUTHORIZED.into_response(); }
    ws.max_message_size(64 * 1024).on_upgrade(move |socket| phone_socket(socket, context))
}

async fn phone_socket(socket: WebSocket, context: ServerContext) {
    let (mut sender, mut receiver) = socket.split();
    let state = context.bridge.snapshot();
    let initial = json!({ "type": "state", "phoneConnected": state.phone_connected, "pluginConnected": state.plugin_connected, "status": state.status, "take": state.take });
    if sender.send(Message::Text(initial.to_string().into())).await.is_err() { return; }
    let mut events = context.bridge.events.subscribe();
    loop {
        tokio::select! {
            incoming = receiver.next() => match incoming {
                Some(Ok(Message::Text(text))) => if let Some(reply) = context.bridge.handle_phone_message(text.as_str()) {
                    if sender.send(Message::Text(reply.into())).await.is_err() { break; }
                },
                Some(Ok(Message::Ping(payload))) => if sender.send(Message::Pong(payload)).await.is_err() { break; },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            event = events.recv() => match event {
                Ok(text) => if sender.send(Message::Text(text.into())).await.is_err() { break; },
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    context.bridge.disconnect_phone();
}

fn is_virtual_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["cloudflarewarp", "warp", "tailscale", "zerotier", "vpn", "forti", "openvpn", "proton", "nordlynx", "anyconnect", "vmware", "virtualbox", "hyper-v", "vethernet", "docker", "wsl", "hamachi", "bluetooth", "wi-fi direct", "tap", "tun"]
        .iter().any(|word| lower.contains(*word))
        || (lower.contains("local area connection") && lower.contains('*'))
}

fn is_preferred_adapter(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["wi-fi", "wifi", "wireless", "ethernet", "local area connection"].iter().any(|word| {
        lower == *word || lower.strip_prefix(*word).is_some_and(|tail| tail.trim().chars().all(|c| c.is_ascii_digit()))
    })
}

// Rank candidates so the QR encodes a LAN IP the phone can actually reach:
// real adapters over tunnels, Wi-Fi/Ethernet over obscure names, private ranges over public.
fn rank_addresses(entries: Vec<(String, Ipv4Addr)>) -> Vec<LanAddress> {
    let mut seen = std::collections::HashSet::new();
    let mut addresses = Vec::new();
    for (name, address) in entries {
        if !seen.insert(address) { continue; }
        let lower = name.to_ascii_lowercase();
        let wifi = lower.starts_with("wi-fi") || lower.starts_with("wifi") || lower.starts_with("wireless");
        let score = (if is_virtual_adapter(&name) { 0 } else { 100 })
            + (if is_preferred_adapter(&name) { 40 } else { 0 })
            + (if address.is_private() { 20 } else { 0 })
            + (if wifi { 10 } else { 0 });
        addresses.push(LanAddress { name, address: address.to_string(), score });
    }
    addresses.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
    addresses
}

pub fn get_local_addresses() -> Vec<LanAddress> {
    let mut entries = Vec::new();
    for interface in get_if_addrs().unwrap_or_default() {
        let IpAddr::V4(address) = interface.ip() else { continue };
        if interface.is_loopback() || address.is_unspecified() || address.is_multicast() { continue; }
        entries.push((interface.name, address));
    }
    rank_addresses(entries)
}

fn qr_data_url(text: &str) -> Result<String, String> {
    let code = QrCode::new(text.as_bytes()).map_err(|error| error.to_string())?;
    let svg = code.render::<svg::Color>().min_dimensions(240, 240).build();
    Ok(format!("data:image/svg+xml;base64,{}", BASE64.encode(svg)))
}

fn certificate_paths(directory: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    (directory.join("ca-certificate.pem"), directory.join("ca-private.pem"), directory.join("server-certificate.pem"), directory.join("server-private.pem"))
}

fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(data).map_err(|error| error.to_string())
}

fn make_local_certificates(directory: &Path, addresses: &[LanAddress]) -> Result<(Vec<u8>, String), String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let (ca_cert_path, ca_key_path, server_cert_path, server_key_path) = certificate_paths(directory);
    // Reuse the persisted CA only when its certificate and private key match; otherwise replace it.
    let ca_pem: String = match (fs::read_to_string(&ca_cert_path), fs::read_to_string(&ca_key_path)) {
        (Ok(certificate), Ok(key_pem)) => {
            let usable = KeyPair::from_pem(&key_pem)
                .ok()
                .and_then(|key| Issuer::from_ca_cert_pem(&certificate, key).ok())
                .is_some();
            if usable { certificate } else { create_certificate_authority(&ca_cert_path, &ca_key_path)? }
        }
        _ => create_certificate_authority(&ca_cert_path, &ca_key_path)?,
    };
    let issuer_key = KeyPair::from_pem(&fs::read_to_string(&ca_key_path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let issuer = Issuer::from_ca_cert_pem(&ca_pem, issuer_key).map_err(|error| error.to_string())?;
    let ca_der = decode_pem(&ca_pem)?;
    let server_key = KeyPair::generate().map_err(|error| error.to_string())?;
    let mut subject_alt_names = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    subject_alt_names.extend(addresses.iter().map(|address| address.address.clone()));
    let mut params = CertificateParams::new(subject_alt_names).map_err(|error| error.to_string())?;
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server_cert = params.signed_by(&server_key, &issuer).map_err(|error| error.to_string())?.pem();
    write_private(&server_cert_path, server_cert.as_bytes())?;
    write_private(&server_key_path, server_key.serialize_pem().as_bytes())?;
    let fingerprint = Sha256::digest(&ca_der).iter().map(|byte| format!("{byte:02X}")).collect::<Vec<_>>().join(":");
    Ok((ca_der, fingerprint))
}

fn decode_pem(pem: &str) -> Result<Vec<u8>, String> {
    let body = pem.lines().filter(|line| !line.starts_with("-----")).collect::<String>();
    BASE64.decode(body).map_err(|error| error.to_string())
}

fn create_certificate_authority(cert_path: &Path, key_path: &Path) -> Result<String, String> {
    let key = KeyPair::generate().map_err(|error| error.to_string())?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(|error| error.to_string())?;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "Cineflow Local Certificate Authority");
    name.push(DnType::OrganizationName, "Cineflow Studio");
    params.distinguished_name = name;
    let certificate = params.self_signed(&key).map_err(|error| error.to_string())?.pem();
    write_private(key_path, key.serialize_pem().as_bytes())?;
    fs::write(cert_path, &certificate).map_err(|error| error.to_string())?;
    Ok(certificate)
}

pub async fn start_bridge_servers(
    app: AppHandle,
    bridge: Bridge,
    takes_dir: PathBuf,
    cert_dir: PathBuf,
) -> Result<BridgeInfo, String> {
    let interfaces = get_local_addresses();
    let (ca_der, fingerprint) = make_local_certificates(&cert_dir, &interfaces)?;
    let (http_listener, https_listener) = bind_listeners()?;
    let cert_path = certificate_paths(&cert_dir);
    let tls = RustlsConfig::from_pem_file(&cert_path.2, &cert_path.3).await.map_err(|error| error.to_string())?;
    let context = ServerContext { bridge: bridge.clone(), takes_dir, ca_der: Arc::new(ca_der), fingerprint: fingerprint.clone() };
    let router = bridge_router(context);
    let http = tokio::net::TcpListener::from_std(http_listener).map_err(|error| error.to_string())?;
    let http_router = router.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(http, http_router.into_make_service_with_connect_info::<SocketAddr>()).await { eprintln!("Cineflow HTTP bridge stopped: {error}"); }
    });
    let status_bridge = bridge.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_plugin_connected = false;
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let connected = status_bridge.snapshot().plugin_connected;
            if connected != last_plugin_connected {
                last_plugin_connected = connected;
                status_bridge.publish_state();
            }
        }
    });
    tauri::async_runtime::spawn(async move {
        let server = match axum_server::from_tcp_rustls(https_listener, tls) {
            Ok(server) => server,
            Err(error) => { eprintln!("Cineflow HTTPS bridge could not start: {error}"); return; }
        };
        if let Err(error) = server.serve(router.into_make_service_with_connect_info::<SocketAddr>()).await { eprintln!("Cineflow HTTPS bridge stopped: {error}"); }
    });
    let host = interfaces.first().map(|item| item.address.as_str()).unwrap_or("127.0.0.1");
    let url = format!("https://{host}:{HTTPS_PORT}/phone?token={}", bridge.token);
    let setup_url = format!("http://{host}:{HTTP_PORT}/setup/");
    let info = BridgeInfo {
        qr: qr_data_url(&url)?,
        setup_qr: qr_data_url(&setup_url)?,
        url,
        port: HTTP_PORT,
        phone_port: HTTPS_PORT,
        phone_setup_url: setup_url,
        ca_fingerprint: fingerprint,
        interfaces,
    };
    let _ = app.emit("bridge-state", &bridge.snapshot());
    Ok(info)
}

fn bind_listeners() -> Result<(TcpListener, TcpListener), String> {
    let http = TcpListener::bind(("0.0.0.0", HTTP_PORT)).map_err(|error| format!("Could not bind Studio HTTP port {HTTP_PORT}: {error}"))?;
    let https = match TcpListener::bind(("0.0.0.0", HTTPS_PORT)) {
        Ok(listener) => listener,
        Err(error) => { drop(http); return Err(format!("Could not bind phone HTTPS port {HTTPS_PORT}: {error}")); }
    };
    http.set_nonblocking(true).map_err(|error| error.to_string())?;
    https.set_nonblocking(true).map_err(|error| error.to_string())?;
    Ok((http, https))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cineflow-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn ranks_real_lan_adapters_above_vpn_and_virtual_interfaces() {
        let ranked = rank_addresses(vec![
            ("CloudflareWARP".into(), "172.16.0.2".parse().unwrap()),
            ("Ethernet 2".into(), "10.0.2.121".parse().unwrap()),
            ("Wi-Fi".into(), "192.168.1.24".parse().unwrap()),
            ("Local Area Connection* 9".into(), "192.168.137.1".parse().unwrap()),
            ("Fortinet SSL VPN".into(), "10.99.0.2".parse().unwrap()),
        ]);
        let order: Vec<&str> = ranked.iter().map(|item| item.address.as_str()).collect();
        let position = |address: &str| order.iter().position(|item| *item == address).expect("address ranked");
        assert_eq!(order[0], "192.168.1.24", "Wi-Fi should be the first choice for the QR code");
        assert!(position("10.0.2.121") < position("172.16.0.2"), "Ethernet must outrank the WARP tunnel");
        assert!(position("10.0.2.121") < position("10.99.0.2"), "Ethernet must outrank the VPN tunnel");
    }

    #[test]
    fn keeps_a_candidate_when_every_adapter_is_virtual() {
        let ranked = rank_addresses(vec![("Tailscale".into(), "100.64.0.5".parse().unwrap())]);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].address, "100.64.0.5");
    }

    #[test]
    fn reports_how_long_ago_the_studio_plugin_last_polled() {
        let now = Instant::now();
        assert_eq!(plugin_age_ms(None, now), None, "no poll yet means there is no age to report");
        assert_eq!(plugin_age_ms(Some(now), now), Some(0));
        let past = now.checked_sub(Duration::from_millis(1500)).expect("instant arithmetic");
        let age = plugin_age_ms(Some(past), now).expect("age for a past poll");
        assert!((1400..1700).contains(&age), "expected roughly 1500ms, got {age}");
        assert!(age < PLUGIN_STALE_MS, "1500ms must still count as connected");
    }

    #[test]
    fn renders_qr_codes_as_data_urls() {
        let url = "https://192.168.1.24:41838/phone?token=abc";
        assert!(qr_data_url(url).expect("render QR").starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn creates_a_persistent_local_certificate_authority() {
        let dir = temp_dir();
        let addresses = vec![LanAddress { name: "Wi-Fi".into(), address: "192.168.1.24".into(), score: 0 }];

        let (der, fingerprint) = make_local_certificates(&dir, &addresses).expect("first certificate generation");
        assert!(!der.is_empty());
        assert_eq!(fingerprint.split(':').count(), 32, "SHA-256 fingerprint must be 32 colon-separated byte pairs");
        assert!(fingerprint.chars().all(|character| character.is_ascii_hexdigit() || character == ':'));

        let (ca_path, _, _, _) = certificate_paths(&dir);
        let decoded = decode_pem(&fs::read_to_string(&ca_path).expect("read CA PEM")).expect("decode CA PEM");
        assert_eq!(decoded, der, "downloadable certificate must match the fingerprinted CA");
        assert!(dir.join("server-certificate.pem").exists());
        assert!(dir.join("server-private.pem").exists());

        let (der_again, fingerprint_again) = make_local_certificates(&dir, &addresses).expect("second certificate generation");
        assert_eq!(fingerprint_again, fingerprint, "the CA must be reused across restarts");
        assert_eq!(der_again, der);

        fs::remove_dir_all(&dir).ok();
    }
}

