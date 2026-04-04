// Memoir — Tauri desktop shell.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const DEBUG_LOG_PATH: &str = "/tmp/memoir-debug.log";

fn log_line(msg: &str) {
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(DEBUG_LOG_PATH) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{}] {}", ts, msg);
    }
}

#[tauri::command]
fn log_debug(message: String) -> Result<(), String> {
    log_line(&format!("[frontend] {}", message));
    Ok(())
}

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
        .invoke_handler(tauri::generate_handler![read_store, write_store, data_dir, log_debug])
        .setup(|_app| {
            let _ = fs::remove_file(DEBUG_LOG_PATH);
            log_line("rust: tauri builder setup complete");
            Ok(())
        })
        .on_page_load(|_window, payload| {
            log_line(&format!("rust: page load url={}", payload.url()));
        })
        .run(tauri::generate_context!())
        .expect("error while running Memoir");
}
