use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub course: String,
    pub specialty_code: String,
    pub specialty_name: String,
    pub drive_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeacherInfo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LessonItem {
    pub pair_number: u32,
    pub time_start: String,
    pub time_end: String,
    pub subject: String,
    pub teacher: String,
    pub room: String,
    pub lesson_type: Option<String>,
    #[serde(default)]
    pub group_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySchedule {
    pub date: String,
    pub weekday: String,
    pub lessons: Vec<LessonItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsultationSlot {
    pub weekday: String,
    pub date: String,
    pub time: String,
    pub location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeacherConsultations {
    pub teacher_name: String,
    pub is_my_teacher: bool,
    pub is_pinned: bool,
    pub slots: Vec<ConsultationSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BellSlot {
    pub pair_number: u32,
    pub part1: String,
    pub part2: String,
    pub break_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetConfig {
    pub enabled: bool,
    pub show_tomorrow_schedule: bool,
    pub show_week_schedule: bool,
    pub show_consultations: bool,
    pub show_bell_timer: bool,
    pub opacity: f32,
    pub pin_to_desktop: bool,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            show_tomorrow_schedule: true,
            show_week_schedule: false,
            show_consultations: true,
            show_bell_timer: true,
            opacity: 0.72,
            pin_to_desktop: true,
            width: 350.0,
            height: 450.0,
            x: None,
            y: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub enabled: bool,
    pub morning_summary: bool,
    pub morning_time: String,
    pub on_new_consultation: bool,
    pub on_schedule_change: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            morning_summary: true,
            morning_time: "07:30".to_string(),
            on_new_consultation: true,
            on_schedule_change: true,
        }
    }
}

pub const DEFAULT_UPDATE_ENDPOINT: &str = "https://update.flow.mdsdev.ru/latest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_role")]
    pub role: String,
    pub selected_group: String,
    #[serde(default)]
    pub selected_teacher: String,
    #[serde(default)]
    pub multi_groups_enabled: bool,
    #[serde(default)]
    pub extra_groups: Vec<String>,
    pub pinned_teachers: Vec<String>,
    pub hidden_teachers: Vec<String>,
    pub sync_interval_minutes: u32,
    pub notifications: NotificationSettings,
    pub widget: WidgetConfig,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_true")]
    pub start_minimized_on_boot: bool,
    #[serde(default = "default_true")]
    pub auto_update_check: bool,
    #[serde(default = "default_update_endpoint")]
    pub update_endpoint: String,
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_role() -> String {
    "student".to_string()
}

fn default_true() -> bool {
    true
}

fn default_update_endpoint() -> String {
    DEFAULT_UPDATE_ENDPOINT.to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            role: default_role(),
            selected_group: String::new(),
            selected_teacher: String::new(),
            multi_groups_enabled: false,
            extra_groups: Vec::new(),
            pinned_teachers: Vec::new(),
            hidden_teachers: Vec::new(),
            sync_interval_minutes: 30,
            notifications: NotificationSettings::default(),
            widget: WidgetConfig::default(),
            autostart: false,
            start_minimized_on_boot: true,
            auto_update_check: true,
            update_endpoint: default_update_endpoint(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateManifest {
    pub version: String,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub notes: String,
    pub download_url: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub signature_v2: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub update_available: bool,
    pub manifest: Option<UpdateManifest>,
    pub checked_url: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPayload {
    pub last_synced_at: String,
    pub consultation_week_range: String,
    pub groups: Vec<GroupInfo>,
    #[serde(default)]
    pub teachers: Vec<TeacherInfo>,
    pub schedule: Vec<DaySchedule>,
    #[serde(default)]
    pub extra_schedules: std::collections::HashMap<String, Vec<DaySchedule>>,
    pub group_teachers: Vec<String>,
    pub consultations: Vec<TeacherConsultations>,
    pub bells_monday: Vec<BellSlot>,
    pub bells_regular: Vec<BellSlot>,
    pub settings: AppSettings,
    pub new_consultations_detected: Vec<String>,
}
