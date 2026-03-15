mod plugin_manager;

use std::sync::Mutex;

use plugin_manager::{PluginDescriptor, PluginManager};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, State};

struct AppState {
    plugin_manager: Mutex<PluginManager>,
}

fn debug_plugin_ipc(message: &str) {
    if std::env::var_os("TRASH_MUSIC_DEBUG_PLUGIN_IPC").is_some() {
        eprintln!("trash-music plugin ipc: {message}");
    }
}

impl AppState {
    fn new(app: &AppHandle) -> Result<Self, String> {
        Ok(Self {
            plugin_manager: Mutex::new(PluginManager::load(app)?),
        })
    }
}

#[tauri::command]
fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginDescriptor>, String> {
    debug_plugin_ipc("plugin_list");
    let manager = state
        .plugin_manager
        .lock()
        .map_err(|_| "plugin manager lock poisoned".to_string())?;
    Ok(manager.list())
}

#[tauri::command]
fn plugin_dispatch(
    plugin_id: String,
    event: String,
    payload: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<(), String> {
    debug_plugin_ipc(&format!("plugin_dispatch {plugin_id}:{event}"));
    let mut manager = state
        .plugin_manager
        .lock()
        .map_err(|_| "plugin manager lock poisoned".to_string())?;
    manager.dispatch(&plugin_id, &event, payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(AppState::new(app.handle()).map_err(|error| error.to_string())?);
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }

            if payload.url().domain() != Some("music.youtube.com") {
                return;
            }

            let _ = webview.eval(include_str!("../injected/bootstrap.js"));
        })
        .invoke_handler(tauri::generate_handler![
            plugin_list,
            plugin_dispatch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
