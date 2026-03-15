use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{
    activity::{self, ActivityType, StatusDisplayType},
    DiscordIpc, DiscordIpcClient,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const DEFAULT_DISCORD_CLIENT_ID: &str = "1177081335727267940";
const DISCORD_RECONNECT_COOLDOWN: Duration = Duration::from_secs(15);
const LEGACY_PLUGIN_SETTINGS_FILE: &str = "plugin-settings.json";
const PLUGIN_STATE_FILE: &str = "plugin-state.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginField {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub name: &'static str,
    pub description: &'static str,
    pub enabled: bool,
    pub fields: Vec<PluginField>,
    pub config: Map<String, Value>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct StoredPlugins {
    plugins: HashMap<String, StoredPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StoredPlugin {
    enabled: bool,
    config: Map<String, Value>,
}

impl Default for StoredPlugin {
    fn default() -> Self {
        Self {
            enabled: false,
            config: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPayload {
    title: String,
    artist: String,
    #[serde(default)]
    album: String,
    #[serde(rename = "videoId")]
    _video_id: String,
    url: String,
    #[serde(default)]
    image_url: String,
    song_duration: u64,
    elapsed_seconds: u64,
    is_paused: bool,
}

#[derive(Debug, Clone, Copy)]
struct PluginDefinition {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    default_enabled: bool,
    default_config: fn() -> Map<String, Value>,
    fields: fn() -> Vec<PluginField>,
}

pub struct PluginManager {
    stored: StoredPlugins,
    discord: DiscordController,
}

impl PluginManager {
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("failed to create data dir {data_dir:?}: {error}"))?;

        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| format!("failed to resolve app config dir: {error}"))?;
        fs::create_dir_all(&config_dir)
            .map_err(|error| format!("failed to create config dir {config_dir:?}: {error}"))?;

        let managed_path = config_dir.join(LEGACY_PLUGIN_SETTINGS_FILE);
        let state_path = data_dir.join(PLUGIN_STATE_FILE);
        let legacy_path = data_dir.join(LEGACY_PLUGIN_SETTINGS_FILE);
        let stored = read_stored_plugins(&managed_path)?
            .or_else(|| read_stored_plugins(&state_path).ok().flatten())
            .or_else(|| read_stored_plugins(&legacy_path).ok().flatten())
            .unwrap_or_default();

        let mut manager = Self {
            stored,
            discord: DiscordController::default(),
        };
        manager.ensure_defaults();
        manager.refresh_backend("discord-rpc");
        Ok(manager)
    }

    pub fn list(&self) -> Vec<PluginDescriptor> {
        plugin_definitions()
            .iter()
            .map(|definition| self.describe_plugin(*definition))
            .collect()
    }

    pub fn dispatch(&mut self, plugin_id: &str, event: &str, payload: Value) -> Result<(), String> {
        match plugin_id {
            "discord-rpc" => {
                let descriptor = self
                    .list()
                    .into_iter()
                    .find(|plugin| plugin.id == plugin_id)
                    .ok_or_else(|| format!("unknown plugin: {plugin_id}"))?;
                if !descriptor.enabled {
                    return Ok(());
                }

                match event {
                    "playback:update" => {
                        let playback = serde_json::from_value::<PlaybackPayload>(payload)
                            .map_err(|error| format!("invalid playback payload: {error}"))?;
                        self.discord.update(playback, &descriptor.config);
                    }
                    "playback:clear" => self.discord.clear_activity(),
                    _ => {}
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn ensure_defaults(&mut self) {
        for definition in plugin_definitions() {
            self.stored
                .plugins
                .entry(definition.id.to_string())
                .or_insert_with(|| StoredPlugin {
                    enabled: definition.default_enabled,
                    config: (definition.default_config)(),
                });
        }
    }

    fn describe_plugin(&self, definition: PluginDefinition) -> PluginDescriptor {
        let record = self.stored.plugins.get(definition.id);
        PluginDescriptor {
            id: definition.id.to_string(),
            name: definition.name,
            description: definition.description,
            enabled: record
                .map(|plugin| plugin.enabled)
                .unwrap_or(definition.default_enabled),
            fields: (definition.fields)(),
            config: self.merged_config(definition),
        }
    }

    fn merged_config(&self, definition: PluginDefinition) -> Map<String, Value> {
        let mut config = (definition.default_config)();
        if let Some(stored) = self.stored.plugins.get(definition.id) {
            for (key, value) in &stored.config {
                config.insert(key.clone(), value.clone());
            }
        }
        config
    }

    fn refresh_backend(&mut self, plugin_id: &str) {
        if plugin_id == "discord-rpc" {
            if let Some(definition) = plugin_definition("discord-rpc") {
                let descriptor = self.describe_plugin(definition);
                self.discord
                    .apply_plugin_state(descriptor.enabled, &descriptor.config);
            }
        }
    }
}

fn read_stored_plugins(path: &PathBuf) -> Result<Option<StoredPlugins>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str::<StoredPlugins>(&contents)
            .map(Some)
            .map_err(|error| format!("failed to parse {path:?}: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read {path:?}: {error}")),
    }
}

#[derive(Default)]
struct DiscordController {
    client: Option<DiscordIpcClient>,
    current_client_id: Option<String>,
    last_playback: Option<PlaybackPayload>,
    last_connect_attempt: Option<Instant>,
}

impl DiscordController {
    fn apply_plugin_state(&mut self, enabled: bool, config: &Map<String, Value>) {
        if !enabled {
            self.disconnect();
            return;
        }

        if let Some(playback) = self.last_playback.clone() {
            self.update(playback, config);
        }
    }

    fn update(&mut self, playback: PlaybackPayload, config: &Map<String, Value>) {
        self.last_playback = Some(playback.clone());

        if playback.title.trim().is_empty() || playback.artist.trim().is_empty() {
            self.clear_activity();
            return;
        }

        if let Err(error) = self.ensure_connected(config) {
            if error != "discord reconnect cooldown" {
                eprintln!("discord-rpc: {error}");
            }
            return;
        }

        let activity = build_discord_activity(&playback, config);

        if let Some(client) = self.client.as_mut() {
            if client.set_activity(activity.clone()).is_err() {
                if client.reconnect().is_ok() {
                    let _ = client.set_activity(activity);
                }
            }
        }
    }

    fn clear_activity(&mut self) {
        self.last_playback = None;
        if let Some(client) = self.client.as_mut() {
            let _ = client.clear_activity();
        }
    }

    fn disconnect(&mut self) {
        self.last_playback = None;
        self.last_connect_attempt = None;

        if let Some(mut client) = self.client.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }

        self.current_client_id = None;
    }

    fn ensure_connected(&mut self, config: &Map<String, Value>) -> Result<(), String> {
        let client_id = config
            .get("clientId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(DEFAULT_DISCORD_CLIENT_ID);

        if self.client.is_some() && self.current_client_id.as_deref() == Some(client_id) {
            return Ok(());
        }

        if let Some(last_attempt) = self.last_connect_attempt {
            if last_attempt.elapsed() < DISCORD_RECONNECT_COOLDOWN {
                return Err("discord reconnect cooldown".to_string());
            }
        }

        self.disconnect();
        self.last_connect_attempt = Some(Instant::now());

        let mut client = DiscordIpcClient::new(client_id);
        client
            .connect()
            .map_err(|error| format!("failed to connect to Discord IPC: {error}"))?;

        self.client = Some(client);
        self.current_client_id = Some(client_id.to_string());
        self.last_connect_attempt = None;
        Ok(())
    }
}

fn build_discord_activity(
    playback: &PlaybackPayload,
    config: &Map<String, Value>,
) -> activity::Activity<'static> {
    let mut activity = activity::Activity::new()
        .name("YouTube Music")
        .activity_type(ActivityType::Listening)
        .status_display_type(StatusDisplayType::Details)
        .details(sanitize_activity_text(&playback.title))
        .state(sanitize_activity_text(&playback.artist))
        .details_url(playback.url.clone());

    let mut assets =
        activity::Assets::new().large_text(sanitize_activity_text(if playback.album.is_empty() {
            &playback.title
        } else {
            &playback.album
        }));

    if !playback.image_url.is_empty() {
        assets = assets.large_image(playback.image_url.clone());
    }

    activity = activity.assets(assets);

    let show_remaining_time = config
        .get("showRemainingTime")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if show_remaining_time && !playback.is_paused && playback.song_duration > 0 {
        let elapsed_ms = playback.elapsed_seconds.min(playback.song_duration) as i64 * 1_000;
        let duration_ms = playback.song_duration as i64 * 1_000;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        activity = activity.timestamps(
            activity::Timestamps::new()
                .start(now_ms - elapsed_ms)
                .end(now_ms - elapsed_ms + duration_ms),
        );
    }

    if config
        .get("showPlayButton")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        activity = activity.buttons(vec![activity::Button::new(
            "Play on YouTube Music",
            playback.url.clone(),
        )]);
    }

    activity
}

fn sanitize_activity_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "Unknown".to_string();
    }

    let value: String = trimmed.chars().take(128).collect();
    if value.chars().count() == 1 {
        format!("{value} ")
    } else {
        value
    }
}

fn plugin_definitions() -> [PluginDefinition; 2] {
    [
        PluginDefinition {
            id: "discord-rpc",
            name: "Discord RPC",
            description: "Shows the current song in Discord Rich Presence.",
            default_enabled: true,
            default_config: discord_default_config,
            fields: discord_fields,
        },
        PluginDefinition {
            id: "precise-volume-control",
            name: "Precise Volume Control",
            description: "Adds 1% volume steps, wheel support and session volume restore.",
            default_enabled: true,
            default_config: precise_volume_default_config,
            fields: precise_volume_fields,
        },
    ]
}

fn plugin_definition(id: &str) -> Option<PluginDefinition> {
    plugin_definitions()
        .into_iter()
        .find(|definition| definition.id == id)
}

fn discord_default_config() -> Map<String, Value> {
    Map::from_iter([
        (
            "clientId".to_string(),
            Value::String(DEFAULT_DISCORD_CLIENT_ID.to_string()),
        ),
        ("showPlayButton".to_string(), Value::Bool(true)),
        ("showRemainingTime".to_string(), Value::Bool(true)),
    ])
}

fn discord_fields() -> Vec<PluginField> {
    vec![
        PluginField {
            key: "clientId",
            label: "Discord Client ID",
            kind: "string",
            min: None,
            max: None,
            step: None,
            placeholder: Some(DEFAULT_DISCORD_CLIENT_ID),
        },
        PluginField {
            key: "showPlayButton",
            label: "Show play button",
            kind: "boolean",
            min: None,
            max: None,
            step: None,
            placeholder: None,
        },
        PluginField {
            key: "showRemainingTime",
            label: "Show remaining time",
            kind: "boolean",
            min: None,
            max: None,
            step: None,
            placeholder: None,
        },
    ]
}

fn precise_volume_default_config() -> Map<String, Value> {
    Map::from_iter([
        ("steps".to_string(), json!(1)),
        ("arrowShortcuts".to_string(), Value::Bool(true)),
        ("mouseWheel".to_string(), Value::Bool(true)),
        ("savedVolume".to_string(), Value::Null),
    ])
}

fn precise_volume_fields() -> Vec<PluginField> {
    vec![
        PluginField {
            key: "steps",
            label: "Volume step",
            kind: "number",
            min: Some(1.0),
            max: Some(25.0),
            step: Some(1.0),
            placeholder: None,
        },
        PluginField {
            key: "arrowShortcuts",
            label: "Arrow up/down shortcuts",
            kind: "boolean",
            min: None,
            max: None,
            step: None,
            placeholder: None,
        },
        PluginField {
            key: "mouseWheel",
            label: "Mouse wheel volume",
            kind: "boolean",
            min: None,
            max: None,
            step: None,
            placeholder: None,
        },
    ]
}
