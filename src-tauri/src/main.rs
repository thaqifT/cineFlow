#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use bridge::{Bridge, BridgeInfo, BridgeState};
use serde_json::Value;
use std::{fs, sync::Mutex};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppState {
    bridge: Bridge,
    bridge_info: Mutex<Option<BridgeInfo>>,
    bridge_start: tauri::async_runtime::Mutex<()>,
}

#[tauri::command]
async fn start_bridge(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<BridgeInfo, String> {
    let _guard = state.bridge_start.lock().await;
    if let Some(info) = state.bridge_info.lock().unwrap().clone() { return Ok(info); }
    let user_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&user_data).map_err(|error| error.to_string())?;
    let info = bridge::start_bridge_servers(
        app.clone(),
        state.bridge.clone(),
        user_data.join("takes"),
        user_data.join("phone-certificates"),
    ).await?;
    *state.bridge_info.lock().unwrap() = Some(info.clone());
    Ok(info)
}

#[tauri::command]
fn get_state(state: State<'_, AppState>) -> BridgeState { state.bridge.snapshot() }

#[tauri::command]
fn command(state: State<'_, AppState>, command: String, start: Option<f64>) -> bool { state.bridge.queue_command(&command, start) }

#[tauri::command]
fn set_active_cutscene(state: State<'_, AppState>, cutscene: Value) -> bool {
    state.bridge.set_cutscene(cutscene);
    true
}

#[tauri::command]
async fn save_cutscene(app: tauri::AppHandle, content: Value) -> Result<Value, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("Cineflow Cutscene", &["json"])
            .set_file_name("Cutscene.cineflow.json").blocking_save_file()
    }).await.map_err(|error| error.to_string())?;
    let Some(path) = path else { return Ok(serde_json::json!({ "canceled": true })); };
    let path = path.into_path().map_err(|_| "Selected a non-local cutscene path".to_string())?;
    let bytes = serde_json::to_vec_pretty(&content).map_err(|error| error.to_string())?;
    let file_path = path.to_string_lossy().into_owned();
    fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "canceled": false, "filePath": file_path }))
}

#[tauri::command]
async fn open_cutscene(app: tauri::AppHandle) -> Result<Value, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("Cineflow Cutscene", &["json"]).blocking_pick_file()
    }).await.map_err(|error| error.to_string())?;
    let Some(path) = path else { return Ok(serde_json::json!({ "canceled": true })); };
    let path = path.into_path().map_err(|_| "Selected a non-local cutscene path".to_string())?;
    let file_path = path.to_string_lossy().into_owned();
    let content: Value = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "canceled": false, "filePath": file_path, "content": content }))
}

#[tauri::command]
async fn export_plugin(app: tauri::AppHandle) -> Result<Value, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("Luau source", &["lua"])
            .set_file_name("CineflowStudioPlugin.lua").blocking_save_file()
    }).await.map_err(|error| error.to_string())?;
    let Some(path) = path else { return Ok(serde_json::json!({ "canceled": true })); };
    let path = path.into_path().map_err(|_| "Selected a non-local plugin path".to_string())?;
    let file_path = path.to_string_lossy().into_owned();
    fs::write(&path, include_bytes!("../../src/plugin/Main.plugin.lua")).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "canceled": false, "filePath": file_path }))
}

#[tauri::command]
async fn list_takes(app: tauri::AppHandle) -> Result<Vec<Value>, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("takes");
    let entries = match fs::read_dir(directory) { Ok(entries) => entries, Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()), Err(error) => return Err(error.to_string()) };
    let mut takes = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "json") {
            let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
            let content: Value = serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
            takes.push(serde_json::json!({ "name": entry.file_name().to_string_lossy().into_owned(), "size": metadata.len(), "content": content }));
        }
    }
    Ok(takes)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let bridge = Bridge::new(app.handle().clone());
            app.manage(AppState { bridge, bridge_info: Mutex::new(None), bridge_start: tauri::async_runtime::Mutex::new(()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_bridge, get_state, command, set_active_cutscene,
            save_cutscene, open_cutscene, export_plugin, list_takes
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cineflow Tauri application");
}
