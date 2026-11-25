use crate::models::{AppSettings, SyncPayload};
use rusqlite::{params, Connection};
use std::path::PathBuf;

pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn new(app_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
        let path = app_dir.join("urtk_flow.db");
        let db = Self { path };
        db.init()?;
        Ok(db)
    }

    fn conn(&self) -> Result<Connection, String> {
        let conn = Connection::open(&self.path).map_err(|e| e.to_string())?;
        let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
        Ok(conn)
    }

    fn init(&self) -> Result<(), String> {
        let conn = self.conn()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_settings(&self) -> AppSettings {
        if let Ok(conn) = self.conn() {
            if let Ok(json) = conn.query_row(
                "SELECT value FROM kv_store WHERE key = 'settings'",
                [],
                |row| row.get::<_, String>(0),
            ) {
                if let Ok(settings) = serde_json::from_str::<AppSettings>(&json) {
                    return settings;
                }
            }
        }
        AppSettings::default()
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        let conn = self.conn()?;
        let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
        let now = chrono::Local::now().to_rfc3339();
        conn.execute(
            "INSERT INTO kv_store (key, value, updated_at) VALUES ('settings', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![json, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_cached_payload(&self) -> Option<SyncPayload> {
        let conn = self.conn().ok()?;
        let json = conn
            .query_row(
                "SELECT value FROM kv_store WHERE key = 'last_sync'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()?;
        serde_json::from_str::<SyncPayload>(&json).ok()
    }

    pub fn save_cached_payload(&self, payload: &SyncPayload) -> Result<(), String> {
        let conn = self.conn()?;
        let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        let now = chrono::Local::now().to_rfc3339();
        conn.execute(
            "INSERT INTO kv_store (key, value, updated_at) VALUES ('last_sync', ?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![json, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_kv(&self, key: &str) -> Option<String> {
        let conn = self.conn().ok()?;
        conn.query_row(
            "SELECT value FROM kv_store WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_kv(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn()?;
        let now = chrono::Local::now().to_rfc3339();
        conn.execute(
            "INSERT INTO kv_store (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}
