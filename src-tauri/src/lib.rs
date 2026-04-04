// Memoir — Tauri desktop shell.
// All app logic is in the frontend (index.html, script.js, local-api.js).
// This Rust side only exposes two Tauri commands for reading/writing the
// local data file, so the frontend can persist notes/tasks/events to disk
// instead of browser localStorage.

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn data_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create app data dir: {e}"))?;
    Ok(dir.join("memoir.json"))
}

#[tauri::command]
fn read_store(app: tauri::AppHandle) -> Result<String, String> {
    let path = data_file_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("failed to read store: {e}"))
}

#[tauri::command]
fn write_store(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    let path = data_file_path(&app)?;
    fs::write(&path, contents).map_err(|e| format!("failed to write store: {e}"))
}

#[tauri::command]
fn data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let path = data_file_path(&app)?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![read_store, write_store, data_dir])
        .run(tauri::generate_context!())
        .expect("error while running Memoir");
}
