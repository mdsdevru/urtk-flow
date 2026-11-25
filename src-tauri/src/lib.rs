mod autostart;
mod db;
mod models;
mod parsers;
mod updater;
mod widgets;

use db::Database;
use models::{
    AppSettings, DaySchedule, SyncPayload, UpdateCheckResult, UpdateManifest,
    DEFAULT_UPDATE_ENDPOINT,
};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub db: Mutex<Database>,
}

static SYNC_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Strictly validates external URLs before delegating to the OS shell opener.
/// Blocks file://, smb://, UNC paths, javascript:, ms-msdt:, credentials-in-URL,
/// IP literals, and localhost/private hosts.
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err("Некорректная длина ссылки.".into());
    }
    if trimmed.chars().any(|c| c.is_control() || c == '\\') {
        return Err("Ссылка содержит недопустимые символы.".into());
    }

    let url = reqwest::Url::parse(trimmed).map_err(|_| "Некорректный формат ссылки.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Ссылки с учётными данными запрещены.".into());
    }

    let host = match url.host_str() {
        Some(h) if !h.is_empty() => h.to_ascii_lowercase(),
        _ => return Err("Ссылки без домена запрещены.".into()),
    };

    if host.starts_with('[')
        || host.parse::<std::net::IpAddr>().is_ok()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || !host.contains('.')
    {
        return Err("Переход на IP-адреса и локальные адреса запрещён.".into());
    }

    match url.scheme() {
        "https" => Ok(url.to_string()),
        // Moodle URTK officially runs over HTTP only
        "http" if host == "moodle.urtk.su" => Ok(url.to_string()),
        _ => Err("Разрешены только защищённые HTTPS-ссылки.".into()),
    }
}

fn find_group_id(groups: &[models::GroupInfo], selected_group: &str) -> String {
    let clean = selected_group.trim();
    if clean.is_empty() || clean.len() > 40 {
        return String::new();
    }
    groups
        .iter()
        .find(|g| g.name.eq_ignore_ascii_case(clean) || g.id == clean)
        .map(|g| g.id.clone())
        .unwrap_or_default()
}

fn sanitize_morning_time(raw: &str) -> String {
    let trimmed = raw.trim();
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() == 2 {
        if let (Ok(h), Ok(m)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            if h <= 23 && m <= 59 {
                return format!("{h:02}:{m:02}");
            }
        }
    }
    "07:30".to_string()
}

fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    if settings.theme != "dark" && settings.theme != "light" {
        settings.theme = "dark".to_string();
    }
    settings.selected_group = settings.selected_group.trim().chars().take(40).collect();
    settings.pinned_teachers = settings
        .pinned_teachers
        .into_iter()
        .map(|s| s.trim().chars().take(120).collect::<String>())
        .filter(|s| !s.is_empty())
        .take(100)
        .collect();
    settings.hidden_teachers = settings
        .hidden_teachers
        .into_iter()
        .map(|s| s.trim().chars().take(120).collect::<String>())
        .filter(|s| !s.is_empty())
        .take(100)
        .collect();
    settings.sync_interval_minutes = settings.sync_interval_minutes.clamp(5, 1440);
    settings.notifications.morning_time = sanitize_morning_time(&settings.notifications.morning_time);
    settings.widget.opacity = settings.widget.opacity.clamp(0.35, 0.92);
    settings.widget.width = settings.widget.width.clamp(240.0, 720.0);
    settings.widget.height = settings.widget.height.clamp(240.0, 900.0);
    settings.update_endpoint = DEFAULT_UPDATE_ENDPOINT.to_string();
    settings
}

fn day_schedule_fingerprint(day: &DaySchedule) -> String {
    day.lessons
        .iter()
        .map(|l| {
            format!(
                "{}:{}-{}:{}:{}",
                l.pair_number, l.time_start, l.time_end, l.subject, l.room
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Detects changed schedule days between a previous sync and a new sync for the same group.
fn detect_schedule_changes(prev_days: &[DaySchedule], next_days: &[DaySchedule]) -> Vec<String> {
    if prev_days.is_empty() || next_days.is_empty() {
        return Vec::new();
    }
    let prev_map: HashMap<&str, String> = prev_days
        .iter()
        .map(|d| (d.date.as_str(), day_schedule_fingerprint(d)))
        .collect();

    let today_str = chrono::Local::now().format("%d.%m.%Y").to_string();
    let mut changed = Vec::new();
    for d in next_days {
        if let Some(old_fp) = prev_map.get(d.date.as_str()) {
            if *old_fp != day_schedule_fingerprint(d) {
                let label = if d.date == today_str {
                    format!("Сегодня ({})", d.date)
                } else {
                    format!("{}, {}", d.weekday, d.date)
                };
                changed.push(label);
            }
        }
    }
    changed
}

/// Shared sync implementation invoked by UI, system tray, and background scheduler.
async fn run_sync_cycle(
    app: &AppHandle,
    group_override: Option<String>,
) -> Result<SyncPayload, String> {
    if SYNC_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(cached) = db.load_cached_payload() {
            return Ok(cached);
        }
    }

    let result = async {
        let state = app.state::<AppState>();
        let (mut settings, prev_cache) = {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            (sanitize_settings(db.load_settings()), db.load_cached_payload())
        };
        settings.autostart = autostart::is_enabled();

        if let Some(g) = group_override {
            let clean: String = g.trim().chars().take(40).collect();
            if !clean.is_empty() {
                settings.selected_group = clean;
            }
        }

        let groups = parsers::fetch_groups().await?;
        let group_id = find_group_id(&groups, &settings.selected_group);

        let (schedule, group_teachers) = if !group_id.is_empty() {
            parsers::fetch_group_schedule(&group_id)
                .await
                .unwrap_or_default()
        } else {
            (Vec::new(), Vec::new())
        };

        let (week_range, consultations) =
            parsers::fetch_consultations(&group_teachers, &settings.pinned_teachers).await?;

        let mut new_detected = Vec::new();
        let mut schedule_changes = Vec::new();

        if let Some(prev) = &prev_cache {
            let same_group = !settings.selected_group.is_empty()
                && prev
                    .settings
                    .selected_group
                    .eq_ignore_ascii_case(&settings.selected_group);

            if same_group {
                schedule_changes = detect_schedule_changes(&prev.schedule, &schedule);
            }

            let prev_keys: HashSet<String> = prev
                .consultations
                .iter()
                .filter(|c| c.is_my_teacher || c.is_pinned)
                .flat_map(|c| {
                    c.slots
                        .iter()
                        .map(move |s| format!("{}|{}|{}", c.teacher_name, s.date, s.time))
                })
                .collect();

            if !prev.consultations.is_empty() {
                for c in consultations
                    .iter()
                    .filter(|c| c.is_my_teacher || c.is_pinned)
                {
                    for s in &c.slots {
                        let key = format!("{}|{}|{}", c.teacher_name, s.date, s.time);
                        if !prev_keys.contains(&key) {
                            new_detected.push(format!("{} — {} ({})", c.teacher_name, s.date, s.time));
                        }
                    }
                }
            }
        }

        if settings.notifications.enabled {
            if !new_detected.is_empty() && settings.notifications.on_new_consultation {
                let body = new_detected
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("\n");
                let _ = app
                    .notification()
                    .builder()
                    .title("URTK Flow: Новые консультации")
                    .body(body)
                    .show();
            }

            if !schedule_changes.is_empty() && settings.notifications.on_schedule_change {
                let body = format!(
                    "Обновлено расписание группы {}: {}",
                    settings.selected_group,
                    schedule_changes.join("; ")
                );
                let _ = app
                    .notification()
                    .builder()
                    .title("URTK Flow: Изменение расписания")
                    .body(body)
                    .show();
            }
        }

        let payload = SyncPayload {
            last_synced_at: chrono::Local::now().format("%H:%M").to_string(),
            consultation_week_range: week_range,
            groups,
            schedule,
            group_teachers,
            consultations,
            bells_monday: parsers::urtk_bells_monday(),
            bells_regular: parsers::urtk_bells_regular(),
            settings: settings.clone(),
            new_consultations_detected: new_detected,
        };

        {
            let db = state.db.lock().map_err(|e| e.to_string())?;
            db.save_cached_payload(&payload)?;
        }

        let _ = widgets::sync_widget_window(app, &settings.widget);
        let _ = app.emit("urtk-state-updated", &payload);

        Ok(payload)
    }
    .await;

    SYNC_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

/// Checks whether today's morning summary notification should fire right now,
/// ensuring at-most-once delivery per calendar date via SQLite `kv_store`.
fn maybe_send_morning_summary(app: &AppHandle) {
    let now = chrono::Local::now();
    let today_iso = now.format("%Y-%m-%d").to_string();
    let today_ru = now.format("%d.%m.%Y").to_string();

    let state = app.state::<AppState>();
    let (settings, cached_opt, already_sent) = {
        let Ok(db) = state.db.lock() else {
            return;
        };
        let s = sanitize_settings(db.load_settings());
        let last_sent = db.get_kv("last_morning_summary_date");
        (s, db.load_cached_payload(), last_sent.as_deref() == Some(today_iso.as_str()))
    };

    if already_sent
        || !settings.notifications.enabled
        || !settings.notifications.morning_summary
    {
        return;
    }

    let parts: Vec<&str> = settings.notifications.morning_time.split(':').collect();
    if parts.len() != 2 {
        return;
    }
    let (Ok(target_h), Ok(target_m)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) else {
        return;
    };
    let target_min = target_h * 60 + target_m;
    let cur_min = now
        .format("%H")
        .to_string()
        .parse::<u32>()
        .unwrap_or(0)
        * 60
        + now
            .format("%M")
            .to_string()
            .parse::<u32>()
            .unwrap_or(0);

    // Fire within a 45-minute window after morning_time (covers boot slightly after target time)
    if cur_min < target_min || cur_min > target_min + 45 {
        return;
    }

    let Some(cached) = cached_opt else {
        return;
    };

    // Persist sent marker before showing notification
    if let Ok(db) = state.db.lock() {
        let _ = db.set_kv("last_morning_summary_date", &today_iso);
    }

    let today_lessons = cached
        .schedule
        .iter()
        .find(|d| d.date == today_ru)
        .map(|d| d.lessons.as_slice())
        .unwrap_or(&[]);

    let today_consult_count: usize = cached
        .consultations
        .iter()
        .filter(|c| c.is_my_teacher || c.is_pinned)
        .map(|c| c.slots.iter().filter(|s| s.date.starts_with(&today_ru[..5])).count())
        .sum();

    let schedule_part = if let Some(first) = today_lessons.first() {
        format!(
            "Сегодня {} пар (с {} в ауд. {}).",
            today_lessons.len(),
            first.time_start,
            if first.room.is_empty() { "—" } else { &first.room }
        )
    } else if !settings.selected_group.is_empty() {
        "На сегодня пар по расписанию нет.".to_string()
    } else {
        "Выберите учебную группу для сводки по парам.".to_string()
    };

    let consult_part = if today_consult_count > 0 {
        format!(" Консультаций ваших преподавателей сегодня: {today_consult_count}.")
    } else {
        String::new()
    };

    let _ = app
        .notification()
        .builder()
        .title("URTK Flow · Утренняя сводка")
        .body(format!("{schedule_part}{consult_part}"))
        .show();
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let safe_url = validate_external_url(&url)?;
    app.opener()
        .open_url(safe_url, None::<&str>)
        .map_err(|e| format!("Не удалось открыть ссылку: {e}"))
}

#[tauri::command]
fn get_app_version() -> String {
    updater::current_version().to_string()
}

#[tauri::command]
fn get_autostart_status() -> bool {
    autostart::is_enabled()
}

#[tauri::command]
fn set_autostart(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let actual = autostart::set_enabled(enabled)?;
    if let Ok(db) = state.db.lock() {
        let mut s = db.load_settings();
        s.autostart = actual;
        let _ = db.save_settings(&s);
    }
    Ok(actual)
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateCheckResult, String> {
    let result = updater::check_updates_official(updater::current_version()).await?;
    if result.update_available {
        let _ = app.emit("urtk-update-available", &result);
    }
    Ok(result)
}

#[tauri::command]
async fn download_and_install_update(
    app: AppHandle,
    manifest: UpdateManifest,
) -> Result<(), String> {
    let updates_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не удалось определить каталог данных приложения: {e}"))?
        .join("updates");

    let app_for_progress = app.clone();
    let installer_path =
        updater::download_verified_installer(&manifest, &updates_dir, move |progress| {
            let _ = app_for_progress.emit("urtk-update-progress", &progress);
        })
        .await?;

    updater::launch_installer_and_exit(&installer_path, &updates_dir)?;

    let app_to_exit = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        app_to_exit.exit(0);
    });

    Ok(())
}

#[tauri::command]
fn get_cached_data(state: State<'_, AppState>) -> Result<SyncPayload, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut settings = sanitize_settings(db.load_settings());
    settings.autostart = autostart::is_enabled();

    if let Some(mut payload) = db.load_cached_payload() {
        payload.settings = settings;
        return Ok(payload);
    }
    Ok(SyncPayload {
        last_synced_at: String::new(),
        consultation_week_range: String::new(),
        groups: Vec::new(),
        schedule: Vec::new(),
        group_teachers: Vec::new(),
        consultations: Vec::new(),
        bells_monday: parsers::urtk_bells_monday(),
        bells_regular: parsers::urtk_bells_regular(),
        settings,
        new_consultations_detected: Vec::new(),
    })
}

#[tauri::command]
async fn sync_all(app: AppHandle, group_override: Option<String>) -> Result<SyncPayload, String> {
    run_sync_cycle(&app, group_override).await
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<SyncPayload, String> {
    let mut settings = sanitize_settings(settings);

    let current_reg = autostart::is_enabled();
    if settings.autostart != current_reg {
        settings.autostart = autostart::set_enabled(settings.autostart)?;
    }

    if let Some((lx, ly)) = widgets::current_widget_position(&app) {
        settings.widget.x = Some(lx);
        settings.widget.y = Some(ly);
    }

    let payload = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        if settings.widget.x.is_none() || settings.widget.y.is_none() {
            let prev = db.load_settings();
            if settings.widget.x.is_none() {
                settings.widget.x = prev.widget.x;
            }
            if settings.widget.y.is_none() {
                settings.widget.y = prev.widget.y;
            }
        }
        db.save_settings(&settings)?;

        let mut payload = db.load_cached_payload().unwrap_or_else(|| SyncPayload {
            last_synced_at: String::new(),
            consultation_week_range: String::new(),
            groups: Vec::new(),
            schedule: Vec::new(),
            group_teachers: Vec::new(),
            consultations: Vec::new(),
            bells_monday: parsers::urtk_bells_monday(),
            bells_regular: parsers::urtk_bells_regular(),
            settings: settings.clone(),
            new_consultations_detected: Vec::new(),
        });

        for c in &mut payload.consultations {
            c.is_pinned = settings
                .pinned_teachers
                .iter()
                .any(|pt| parsers::teacher_names_match(&c.teacher_name, pt));
        }
        parsers::sort_consultations(&mut payload.consultations);
        payload.settings = settings.clone();
        db.save_cached_payload(&payload)?;
        payload
    };

    if let Some(main_win) = app.get_webview_window("main") {
        widgets::apply_main_window_chrome(&main_win, &settings.theme);
    }

    widgets::sync_widget_window(&app, &settings.widget)?;
    let _ = app.emit("urtk-state-updated", &payload);

    Ok(payload)
}

#[tauri::command]
fn send_test_notification(app: AppHandle) -> Result<(), String> {
    app.notification()
        .builder()
        .title("URTK Flow")
        .body("Уведомления Windows работают! Вы будете получать сводки по консультациям и изменениям расписания.")
        .show()
        .map_err(|e| e.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            let db = Database::new(app_dir).expect("failed to init sqlite db");
            let mut initial_settings = sanitize_settings(db.load_settings());
            initial_settings.autostart = autostart::is_enabled();
            app.manage(AppState { db: Mutex::new(db) });

            let is_boot_autostart = autostart::launched_via_autostart();

            if let Some(main_win) = app.get_webview_window("main") {
                widgets::apply_main_window_chrome(&main_win, &initial_settings.theme);

                // Intercept Alt+F4 / taskbar CloseRequested so main window hides cleanly to tray
                let win_for_close = main_win.clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_for_close.hide();
                    }
                });

                if is_boot_autostart && initial_settings.start_minimized_on_boot {
                    let _ = main_win.hide();
                } else {
                    let _ = main_win.show();
                    let _ = main_win.unminimize();
                    let _ = main_win.set_focus();
                }
            }

            if initial_settings.widget.enabled {
                let _ = widgets::sync_widget_window(app.handle(), &initial_settings.widget);
            }

            // 1. Background schedule/consultation sync & morning summary scheduler
            let sync_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // If started minimized via Windows autostart, run an initial sync promptly
                if is_boot_autostart {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    let _ = run_sync_cycle(&sync_handle, None).await;
                }
                let mut last_sync_instant = Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    maybe_send_morning_summary(&sync_handle);

                    let interval_mins = {
                        let state = sync_handle.state::<AppState>();
                        let mins = state
                            .db
                            .lock()
                            .map(|db| db.load_settings().sync_interval_minutes.clamp(5, 1440))
                            .unwrap_or(30);
                        mins
                    };

                    if last_sync_instant.elapsed() >= Duration::from_secs(interval_mins as u64 * 60) {
                        let _ = run_sync_cycle(&sync_handle, None).await;
                        last_sync_instant = Instant::now();
                    }
                }
            });

            // 2. Background periodic update checker (8s after launch + every 4 hours)
            let bg_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let mut last_notified_version = String::new();
                loop {
                    let (enabled, push_enabled) = {
                        let state = bg_handle.state::<AppState>();
                        let flags = state
                            .db
                            .lock()
                            .map(|db| {
                                let s = db.load_settings();
                                (s.auto_update_check, s.notifications.enabled)
                            })
                            .unwrap_or((false, false));
                        flags
                    };

                    if enabled {
                        if let Ok(res) =
                            updater::check_updates_official(updater::current_version()).await
                        {
                            if res.update_available {
                                let _ = bg_handle.emit("urtk-update-available", &res);
                                if let Some(ref m) = res.manifest {
                                    if push_enabled && last_notified_version != m.version {
                                        last_notified_version = m.version.clone();
                                        let _ = bg_handle
                                            .notification()
                                            .builder()
                                            .title(format!(
                                                "Доступно обновление URTK Flow {}",
                                                m.version
                                            ))
                                            .body(if m.notes.is_empty() {
                                                "Откройте Настройки → Обновления для установки."
                                                    .to_string()
                                            } else {
                                                m.notes.clone()
                                            })
                                            .show();
                                    }
                                }
                            }
                        }
                    }

                    tokio::time::sleep(Duration::from_secs(4 * 3600)).await;
                }
            });

            let show_item =
                MenuItem::with_id(app, "show", "Открыть URTK Flow", true, None::<&str>)?;
            let widget_item = MenuItem::with_id(
                app,
                "toggle_widget",
                "Показать / скрыть виджет",
                true,
                None::<&str>,
            )?;
            let sync_item =
                MenuItem::with_id(app, "sync_now", "Обновить данные", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &widget_item, &sync_item, &quit_item])?;

            if let Some(icon) = app.default_window_icon().cloned() {
                let _ = TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("URTK Flow")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(tray.app_handle());
                        }
                    })
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app),
                        "toggle_widget" => {
                            let state = app.state::<AppState>();
                            let next_opt = state.db.lock().ok().and_then(|db| {
                                let mut s = sanitize_settings(db.load_settings());
                                s.widget.enabled = !s.widget.enabled;
                                db.save_settings(&s).ok()?;
                                let mut payload = db.load_cached_payload()?;
                                payload.settings = s.clone();
                                let _ = db.save_cached_payload(&payload);
                                Some((s, payload))
                            });
                            if let Some((s, payload)) = next_opt {
                                let _ = widgets::sync_widget_window(app, &s.widget);
                                let _ = app.emit("urtk-state-updated", &payload);
                            }
                        }
                        "sync_now" => {
                            let h = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = run_sync_cycle(&h, None).await;
                            });
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .build(app);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external_url,
            get_app_version,
            get_autostart_status,
            set_autostart,
            check_for_updates,
            download_and_install_update,
            get_cached_data,
            sync_all,
            save_settings,
            send_test_notification
        ])
        .run(tauri::generate_context!())
        .expect("error while running URTK Flow");
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use models::LessonItem;

    #[test]
    fn external_url_validator_blocks_dangerous_schemes_and_local_targets() {
        assert!(validate_external_url("https://akademiks.urtt.ru").is_ok());
        assert!(validate_external_url("https://docs.google.com/spreadsheets/d/abc").is_ok());
        assert!(validate_external_url("https://drive.google.com/drive/folders/17T4G7gCd").is_ok());
        assert!(validate_external_url("https://telemost.yandex.ru/j/12345").is_ok());
        assert!(validate_external_url("http://moodle.urtk.su/").is_ok());

        let blocked = [
            "file:///C:/Windows/System32/cmd.exe",
            "smb://attacker.example/share/evil.exe",
            r"\\attacker.example\share\evil.exe",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ms-msdt:/id PCWDiagnostic",
            "mailto:test@example.com",
            "http://evil.example/phish",
            "https://127.0.0.1:8080/admin",
            "https://[::1]/secret",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/test",
            "https://router.local/",
            "https://urtt.ru@evil.example/login",
            "https://akademiks.urtt.ru/\r\nInjected",
        ];
        for bad in blocked {
            assert!(
                validate_external_url(bad).is_err(),
                "Expected URL to be blocked: {bad}"
            );
        }
    }

    #[test]
    fn settings_sanitizer_clamps_values_and_pins_update_endpoint() {
        let mut s = AppSettings::default();
        s.theme = "evil-theme".into();
        s.widget.opacity = 99.0;
        s.widget.width = 99999.0;
        s.widget.height = 1.0;
        s.notifications.morning_time = "99:99".into();
        s.update_endpoint = "http://evil.example/latest.json".into();
        s.hidden_teachers = vec!["A".repeat(500), "   ".into()];

        let clean = sanitize_settings(s);
        assert_eq!(clean.theme, "dark");
        assert_eq!(clean.widget.opacity, 0.92);
        assert_eq!(clean.widget.width, 720.0);
        assert_eq!(clean.widget.height, 240.0);
        assert_eq!(clean.notifications.morning_time, "07:30");
        assert_eq!(clean.update_endpoint, DEFAULT_UPDATE_ENDPOINT);
        assert_eq!(clean.hidden_teachers.len(), 1);
        assert_eq!(clean.hidden_teachers[0].len(), 120);
    }

    #[test]
    fn find_group_id_rejects_arbitrary_unknown_group_strings() {
        let groups = vec![models::GroupInfo {
            id: "grp-1".into(),
            name: "ИсР-101".into(),
            course: "1".into(),
            specialty_code: String::new(),
            specialty_name: String::new(),
            drive_url: None,
        }];
        assert_eq!(find_group_id(&groups, "ИсР-101"), "grp-1");
        assert_eq!(find_group_id(&groups, "../../../etc/passwd"), "");
        assert_eq!(find_group_id(&groups, "unknown-injected-group"), "");
    }

    #[test]
    fn schedule_change_detector_catches_modified_lessons() {
        let prev = vec![DaySchedule {
            date: "26.11.2026".into(),
            weekday: "Четверг".into(),
            lessons: vec![LessonItem {
                pair_number: 1,
                time_start: "08:00".into(),
                time_end: "09:35".into(),
                subject: "Математика".into(),
                teacher: "Биц Н.А.".into(),
                room: "457".into(),
                lesson_type: None,
            }],
        }];
        let mut next = prev.clone();
        assert!(detect_schedule_changes(&prev, &next).is_empty());

        next[0].lessons[0].room = "215".into();
        let diff = detect_schedule_changes(&prev, &next);
        assert_eq!(diff.len(), 1);
        assert!(diff[0].contains("26.11.2026"));
    }
}
