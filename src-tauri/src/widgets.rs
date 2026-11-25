use crate::models::WidgetConfig;
use crate::AppState;
use std::sync::atomic::{AtomicI8, AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub const WIDGET_LABEL: &str = "widget-main";
static MOVE_SEQ: AtomicU64 = AtomicU64::new(0);
// -1 = unset, 0 = unpinned, 1 = pinned
static LAST_PIN_MODE: AtomicI8 = AtomicI8::new(-1);

#[cfg(target_os = "windows")]
pub fn apply_main_window_chrome(window: &tauri::WebviewWindow, theme: &str) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_ROUND,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let corner_pref: u32 = DWMWCP_ROUND as u32;
            let _ = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &corner_pref as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            );
            let dark_mode: i32 = if theme == "light" { 0 } else { 1 };
            let _ = DwmSetWindowAttribute(
                hwnd.0 as _,
                DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
                &dark_mode as *const _ as *const _,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    let tint = if theme == "light" {
        Some((245, 247, 252, 165))
    } else {
        Some((18, 20, 26, 155))
    };
    let _ = window_vibrancy::apply_acrylic(window, tint);
}

#[cfg(not(target_os = "windows"))]
pub fn apply_main_window_chrome(_window: &tauri::WebviewWindow, _theme: &str) {}

/// Locate the exact Desktop Shell host HWND that owns `SHELLDLL_DefView`
/// (either `Progman` on Windows 11 24H2 or the `WorkerW` hosting desktop icons).
/// Setting our widget's owner (`GWLP_HWNDPARENT`) to this window guarantees:
/// 1) Win+D ("Show Desktop") NEVER minimizes or hides the widget (just like Windows 7 Gadgets / Rainmeter).
/// 2) Even at HWND_BOTTOM, the widget always stays ABOVE the desktop wallpaper & icons.
/// 3) Full WebView2 mouse input and dragging continue to work cleanly.
#[cfg(target_os = "windows")]
unsafe fn find_desktop_shell_owner() -> windows_sys::Win32::Foundation::HWND {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetShellWindow,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let defview_cls = wide("SHELLDLL_DefView");
    let progman_cls = wide("Progman");

    let progman = FindWindowW(progman_cls.as_ptr(), std::ptr::null());
    if !progman.is_null() {
        let defview = FindWindowExW(progman, std::ptr::null_mut(), defview_cls.as_ptr(), std::ptr::null());
        if !defview.is_null() {
            return progman;
        }
    }

    struct SearchCtx {
        defview_cls: Vec<u16>,
        found_parent: HWND,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &mut *(lparam as *mut SearchCtx);
        let defview = FindWindowExW(hwnd, std::ptr::null_mut(), ctx.defview_cls.as_ptr(), std::ptr::null());
        if !defview.is_null() {
            ctx.found_parent = hwnd;
            return 0; // stop enumeration
        }
        1
    }

    let mut ctx = SearchCtx {
        defview_cls,
        found_parent: std::ptr::null_mut(),
    };
    EnumWindows(Some(enum_proc), &mut ctx as *mut SearchCtx as LPARAM);

    if !ctx.found_parent.is_null() {
        return ctx.found_parent;
    }
    if !progman.is_null() {
        return progman;
    }
    GetShellWindow()
}

/// Configure the widget HWND according to `pin_to_desktop`:
/// - Always disables DWM square corner rounding and keeps WS_EX_TOOLWINDOW (no taskbar clutter).
/// - When `pin_to_desktop == true`: attaches GWLP_HWNDPARENT to the desktop shell host
///   (Progman / WorkerW with SHELLDLL_DefView) and strips WS_MINIMIZEBOX so Win+D NEVER minimizes it.
/// - When `pin_to_desktop == false`: detaches GWLP_HWNDPARENT (sets owner to 0) and restores
///   WS_MINIMIZEBOX so it behaves like a normal floating window and minimizes normally on Win+D.
#[cfg(target_os = "windows")]
fn configure_desktop_gadget_hwnd(window: &tauri::WebviewWindow, pin_to_desktop: bool) {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
        GWLP_HWNDPARENT, HWND_BOTTOM, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_MINIMIZEBOX,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let raw = hwnd.0 as windows_sys::Win32::Foundation::HWND;

            // 1. Disable DWM corner clipping so our pure transparent CSS rounded-24px glass renders cleanly
            let corner_pref: u32 = DWMWCP_DONOTROUND as u32;
            let _ = DwmSetWindowAttribute(
                raw,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &corner_pref as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            );

            // 2. Toggle WS_MINIMIZEBOX depending on pin mode
            let style = GetWindowLongPtrW(raw, GWL_STYLE);
            let new_style = if pin_to_desktop {
                style & !(WS_MINIMIZEBOX as isize)
            } else {
                style | (WS_MINIMIZEBOX as isize)
            };
            SetWindowLongPtrW(raw, GWL_STYLE, new_style);

            // 3. Toggle WS_EX_TOOLWINDOW: when pinned, hide from Taskbar/Alt+Tab and lock to desktop;
            //    when unpinned, clear WS_EX_TOOLWINDOW so Windows treats it as a normal minimizable window on Win+D.
            let ex_style = GetWindowLongPtrW(raw, GWL_EXSTYLE);
            let new_ex = if pin_to_desktop {
                (ex_style | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize)
            } else {
                (ex_style & !(WS_EX_TOOLWINDOW as isize)) & !(WS_EX_APPWINDOW as isize)
            };
            SetWindowLongPtrW(raw, GWL_EXSTYLE, new_ex);

            // 4. Attach or detach Desktop Shell owner (GWLP_HWNDPARENT)
            if pin_to_desktop {
                let shell_owner = find_desktop_shell_owner();
                if !shell_owner.is_null() {
                    SetWindowLongPtrW(raw, GWLP_HWNDPARENT, shell_owner as isize);
                }
            } else {
                SetWindowLongPtrW(raw, GWLP_HWNDPARENT, 0);
            }

            let z_order = if pin_to_desktop { HWND_BOTTOM } else { HWND_TOP };
            let flags = if pin_to_desktop {
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED
            } else {
                SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED
            };
            SetWindowPos(raw, z_order, 0, 0, 0, 0, flags);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_desktop_gadget_hwnd(_window: &tauri::WebviewWindow, _pin_to_desktop: bool) {}

#[cfg(target_os = "windows")]
pub fn pin_window_to_desktop(window: &tauri::WebviewWindow, pin_to_desktop: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, HWND_NOTOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let z_order = if pin_to_desktop {
                HWND_BOTTOM
            } else {
                HWND_NOTOPMOST
            };
            SetWindowPos(
                hwnd.0 as _,
                z_order,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn pin_window_to_desktop(_window: &tauri::WebviewWindow, _pin_to_desktop: bool) {}

/// Read the current live logical position of the widget window if it exists.
pub fn current_widget_position(app: &AppHandle) -> Option<(f64, f64)> {
    let win = app.get_webview_window(WIDGET_LABEL)?;
    let pos = win.outer_position().ok()?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let lx = pos.x as f64 / scale;
    let ly = pos.y as f64 / scale;
    if lx < -10000.0 || ly < -10000.0 {
        return None;
    }
    Some((lx, ly))
}

/// Synchronizes the desktop widget window cleanly using hide/show lifecycle,
/// persistent screen coordinates, and Win+D-proof Windows 7 Gadget pinning.
pub fn sync_widget_window(app: &AppHandle, config: &WidgetConfig) -> Result<(), String> {
    if !config.enabled {
        if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
            let _ = win.hide();
        }
        return Ok(());
    }

    if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
        let _ = win.set_size(tauri::LogicalSize::new(config.width, config.height));
        if let (Some(x), Some(y)) = (config.x, config.y) {
            if x > -10000.0 && y > -10000.0 {
                let _ = win.set_position(tauri::LogicalPosition::new(x, y));
            }
        }
        let target_pin: i8 = if config.pin_to_desktop { 1 } else { 0 };
        let prev_pin = LAST_PIN_MODE.swap(target_pin, Ordering::SeqCst);
        let pin_changed = prev_pin != target_pin;

        if pin_changed {
            // Windows Shell only re-evaluates GWLP_HWNDPARENT / WS_EX_TOOLWINDOW cleanly across hide -> show
            let _ = win.hide();
            configure_desktop_gadget_hwnd(&win, config.pin_to_desktop);
        }

        let _ = win.unminimize();
        let _ = win.show();
        pin_window_to_desktop(&win, config.pin_to_desktop);
        if !config.pin_to_desktop {
            let _ = win.set_focus();
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        WIDGET_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("URTK Flow Widget")
    .inner_size(config.width, config.height)
    .decorations(false)
    .transparent(true)
    .background_color(tauri::window::Color(0, 0, 0, 0))
    .shadow(false)
    .skip_taskbar(true)
    .minimizable(!config.pin_to_desktop)
    .maximizable(false)
    .resizable(true)
    .always_on_top(false);

    if let (Some(x), Some(y)) = (config.x, config.y) {
        if x > -10000.0 && y > -10000.0 {
            builder = builder.position(x, y);
        }
    } else if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let screen_w = monitor.size().width as f64 / scale;
        let x = (screen_w - config.width - 28.0).max(24.0);
        builder = builder.position(x, 28.0);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    LAST_PIN_MODE.store(if config.pin_to_desktop { 1 } else { 0 }, Ordering::SeqCst);
    configure_desktop_gadget_hwnd(&win, config.pin_to_desktop);

    // Hook widget events: persist dragged position/size + survive CloseRequested & stay pinned to desktop
    let win_clone = win.clone();
    let app_clone = app.clone();
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = win_clone.hide();
        }
        WindowEvent::Moved(pos) => {
            let scale = win_clone.scale_factor().unwrap_or(1.0);
            let lx = pos.x as f64 / scale;
            let ly = pos.y as f64 / scale;
            if lx > -10000.0 && ly > -10000.0 {
                let seq = MOVE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                let app_deb = app_clone.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    if MOVE_SEQ.load(Ordering::SeqCst) == seq {
                        let state = app_deb.state::<AppState>();
                        if let Ok(db) = state.db.lock() {
                            let mut s = db.load_settings();
                            s.widget.x = Some(lx);
                            s.widget.y = Some(ly);
                            let _ = db.save_settings(&s);
                        };
                    }
                });
            }
        }
        WindowEvent::Resized(size) => {
            if size.width > 120 && size.height > 120 {
                let scale = win_clone.scale_factor().unwrap_or(1.0);
                let lw = size.width as f64 / scale;
                let lh = size.height as f64 / scale;
                let state = app_clone.state::<AppState>();
                if let Ok(db) = state.db.lock() {
                    let mut s = db.load_settings();
                    s.widget.width = lw;
                    s.widget.height = lh;
                    let _ = db.save_settings(&s);
                };
            }
        }
        WindowEvent::Focused(false) => {
            let state = app_clone.state::<AppState>();
            let pinned = state
                .db
                .lock()
                .map(|db| db.load_settings().widget.pin_to_desktop)
                .unwrap_or(true);
            if pinned {
                pin_window_to_desktop(&win_clone, true);
            }
        }
        _ => {}
    });

    let _ = win.show();
    pin_window_to_desktop(&win, config.pin_to_desktop);
    Ok(())
}
