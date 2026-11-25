#[cfg(target_os = "windows")]
const RUN_KEY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const APP_VALUE_NAME: &str = "URTK Flow";

pub fn launched_via_autostart() -> bool {
    std::env::args().any(|arg| arg == "--autostart")
}

pub fn format_run_command(exe_path: &str) -> String {
    format!("\"{}\" --autostart", exe_path)
}

#[cfg(target_os = "windows")]
pub fn is_enabled() -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = hkcu.open_subkey(RUN_KEY_PATH) else {
        return false;
    };
    let val: Result<String, _> = key.get_value(APP_VALUE_NAME);
    val.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn set_enabled(enabled: bool) -> Result<bool, String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(RUN_KEY_PATH)
        .map_err(|e| format!("Не удалось открыть реестр автозагрузки: {e}"))?;

    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Не удалось определить путь к exe: {e}"))?;
        let exe_str = exe.to_string_lossy();
        let cmd = format_run_command(&exe_str);
        key.set_value(APP_VALUE_NAME, &cmd)
            .map_err(|e| format!("Не удалось записать автозагрузку: {e}"))?;
        Ok(true)
    } else {
        match key.delete_value(APP_VALUE_NAME) {
            Ok(()) => Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("Не удалось удалить автозагрузку: {e}")),
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn set_enabled(_enabled: bool) -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_quoted_autostart_command() {
        let cmd = format_run_command(r"C:\Program Files\URTK Flow\urtk-flow.exe");
        assert_eq!(cmd, r#""C:\Program Files\URTK Flow\urtk-flow.exe" --autostart"#);
    }
}
