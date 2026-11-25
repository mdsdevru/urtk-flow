use crate::models::{
    UpdateCheckResult, UpdateManifest, UpdateProgress, DEFAULT_UPDATE_ENDPOINT,
};
use ed25519_dalek::{Signature, VerifyingKey};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// Embedded 32-byte Ed25519 public key used to verify official URTK Flow updates.
/// The matching private key is kept strictly offline (DPAPI-protected) on the developer's
/// workstation and is NEVER deployed to the web server or included in the application bundle.
pub const TRUSTED_RELEASE_PUBLIC_KEY_HEX: &str =
    "fc780728b3dfdcfb6b6110b5c7ce143a6d3dd4b8c3cc4251825c242e225b7a5f";

pub const ALLOWED_MANIFEST_HOST: &str = "update.flow.mdsdev.ru";
pub const ALLOWED_DOWNLOAD_HOST: &str = "flow.mdsdev.ru";
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_INSTALLER_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_NOTES_BYTES: usize = 2048;

pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Parses a SemVer string like "1.2.3", "v1.10.0-beta.1" into (major, minor, patch).
pub fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Returns true strictly when `remote` is a newer semantic version than `current`.
pub fn is_newer_version(current: &str, remote: &str) -> bool {
    match (parse_semver(current), parse_semver(remote)) {
        (Some(c), Some(r)) => r > c,
        _ => false,
    }
}

/// Canonical V2 signing payload binding version, publishedAt, notes (SHA-256),
/// installer SHA-256, byte size, and download URL.
pub fn canonical_release_message_v2(
    version: &str,
    published_at: &str,
    notes: &str,
    sha256_hex: &str,
    size_bytes: u64,
    download_url: &str,
) -> String {
    let notes_sha = hex::encode(Sha256::digest(notes.trim().as_bytes()));
    format!(
        "URTK-FLOW-UPDATE-V2\nversion={}\npublishedAt={}\nnotesSha256={}\nsha256={}\nsizeBytes={}\ndownloadUrl={}",
        version.trim(),
        published_at.trim(),
        notes_sha,
        sha256_hex.trim().to_ascii_lowercase(),
        size_bytes,
        download_url.trim()
    )
}

pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validates that a manifest endpoint is strictly the official HTTPS update server.
pub fn validate_manifest_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|e| format!("Некорректный URL сервера обновлений: {e}"))?;
    if url.scheme() != "https" {
        return Err("Сервер обновлений обязан использовать HTTPS.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL сервера обновлений не должен содержать учётные данные.".into());
    }
    if url.port().is_some() {
        return Err("Нестандартный порт сервера обновлений запрещён.".into());
    }
    if url.host_str() != Some(ALLOWED_MANIFEST_HOST) {
        return Err("Недоверенный домен сервера обновлений.".into());
    }
    if url.path() != "/latest.json" || url.query().is_some() || url.fragment().is_some() {
        return Err("Недопустимый путь манифеста обновлений.".into());
    }
    Ok(url)
}

/// Validates that an installer download URL is strictly on the official HTTPS host under /downloads/.
pub fn validate_download_url(raw: &str) -> Result<reqwest::Url, String> {
    let trimmed = raw.trim();
    if trimmed.contains('\\')
        || trimmed.to_ascii_lowercase().contains("%2e")
        || trimmed.to_ascii_lowercase().contains("%2f")
    {
        return Err("Недопустимые символы в адресе загрузчика.".into());
    }
    let url = reqwest::Url::parse(trimmed)
        .map_err(|e| format!("Некорректный downloadUrl в манифесте: {e}"))?;
    if url.scheme() != "https" {
        return Err("Загрузка обновлений разрешена только по HTTPS.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("downloadUrl не должен содержать учётные данные.".into());
    }
    if url.port().is_some() {
        return Err("Нестандартный порт загрузки обновлений запрещён.".into());
    }
    if url.host_str() != Some(ALLOWED_DOWNLOAD_HOST) {
        return Err("Недоверенный домен загрузки установщика.".into());
    }
    let path = url.path();
    if !path.starts_with("/downloads/")
        || !path.ends_with(".exe")
        || path.contains("..")
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Недопустимый путь к установщику обновлений.".into());
    }
    Ok(url)
}

/// Verifies the Ed25519 V2 cryptographic signature over ALL manifest metadata including
/// `publishedAt` and `notes` (preventing phishing text injection in notifications).
pub fn verify_release_signature_v2(
    public_key_hex: &str,
    version: &str,
    published_at: &str,
    notes: &str,
    sha256_hex: &str,
    size_bytes: u64,
    download_url: &str,
    signature_v2_hex: &str,
) -> Result<(), String> {
    let sha_clean = sha256_hex.trim().to_ascii_lowercase();
    if !is_valid_sha256_hex(&sha_clean) {
        return Err("Манифест не содержит корректную контрольную сумму SHA-256.".into());
    }
    if size_bytes == 0 || size_bytes > MAX_INSTALLER_BYTES {
        return Err("Недопустимый размер установщика в манифесте.".into());
    }
    if published_at.len() > 32 || notes.len() > MAX_NOTES_BYTES {
        return Err("Недопустимая длина метаданных манифеста обновлений.".into());
    }
    let sig_clean = signature_v2_hex.trim();
    if sig_clean.len() != 128 || !sig_clean.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "Обновление отклонено: отсутствует или повреждена цифровая подпись Ed25519 V2.".into(),
        );
    }

    let pk_bytes = hex::decode(public_key_hex.trim())
        .map_err(|_| "Внутренняя ошибка открытого ключа подписи.".to_string())?;
    let pk_arr: [u8; 32] = pk_bytes
        .try_into()
        .map_err(|_| "Неверная длина открытого ключа Ed25519.".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&pk_arr)
        .map_err(|_| "Некорректный открытый ключ Ed25519.".to_string())?;

    let sig_bytes = hex::decode(sig_clean)
        .map_err(|_| "Некорректный формат подписи Ed25519.".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "Неверная длина подписи Ed25519.".to_string())?;
    let signature = Signature::from_bytes(&sig_arr);

    let message = canonical_release_message_v2(
        version,
        published_at,
        notes,
        &sha_clean,
        size_bytes,
        download_url,
    );
    verifying_key
        .verify_strict(message.as_bytes(), &signature)
        .map_err(|_| {
            "Цифровая подпись Ed25519 V2 не прошла проверку! Возможна подмена манифеста или описания — обновление заблокировано."
                .to_string()
        })
}

fn build_pinned_client(
    timeout_secs: u64,
    allowed_host: &'static str,
    strict_https: bool,
) -> Result<reqwest::Client, String> {
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 3 {
            return attempt
                .error("Слишком много перенаправлений при обращении к серверу обновлений.");
        }
        let next = attempt.url();
        if strict_https && next.scheme() != "https" {
            return attempt.error("Запрещён редирект на незащищённый HTTP.");
        }
        if strict_https && next.host_str() != Some(allowed_host) {
            return attempt.error("Запрещён редирект на сторонний домен.");
        }
        attempt.follow()
    });

    let mut builder = reqwest::Client::builder()
        .user_agent(format!("URTK-Flow/{} (Windows; x64)", current_version()))
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .redirect(policy);

    if strict_https {
        builder = builder.https_only(true);
    }

    builder
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Checks the official pinned HTTPS update manifest and verifies its Ed25519 V2 signature.
pub async fn check_updates_official(current: &str) -> Result<UpdateCheckResult, String> {
    check_updates_inner(
        DEFAULT_UPDATE_ENDPOINT,
        current,
        TRUSTED_RELEASE_PUBLIC_KEY_HEX,
        true,
    )
    .await
}

async fn check_updates_inner(
    endpoint: &str,
    current: &str,
    public_key_hex: &str,
    strict_origin: bool,
) -> Result<UpdateCheckResult, String> {
    let url = if strict_origin {
        validate_manifest_url(endpoint)?.to_string()
    } else {
        endpoint.trim().to_string()
    };

    let client = build_pinned_client(25, ALLOWED_MANIFEST_HOST, strict_origin)?;
    let resp = client
        .get(&url)
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .await
        .map_err(|e| format!("Не удалось подключиться к серверу обновлений: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Сервер обновлений вернул HTTP {}",
            resp.status().as_u16()
        ));
    }

    let mut body = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Ошибка чтения манифеста обновлений: {e}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_MANIFEST_BYTES {
            return Err("Манифест обновлений превышает допустимый размер.".into());
        }
        body.extend_from_slice(&chunk);
    }

    let manifest: UpdateManifest = serde_json::from_slice(&body)
        .map_err(|e| format!("Некорректный JSON манифеста обновлений: {e}"))?;

    if strict_origin {
        validate_download_url(&manifest.download_url)?;
    }

    // Mandatory Ed25519 V2 verification (including notes & publishedAt)
    verify_release_signature_v2(
        public_key_hex,
        &manifest.version,
        &manifest.published_at,
        &manifest.notes,
        &manifest.sha256,
        manifest.size_bytes,
        &manifest.download_url,
        &manifest.signature_v2,
    )?;

    let update_available = is_newer_version(current, &manifest.version);

    Ok(UpdateCheckResult {
        current_version: current.to_string(),
        update_available,
        manifest: Some(manifest),
        checked_url: url,
        checked_at: chrono::Local::now().format("%H:%M").to_string(),
    })
}

/// Streams the installer into a private per-user updates directory, enforces strict
/// anti-downgrade, HTTPS host pinning, PE header validation, exact byte size, SHA-256,
/// and Ed25519 V2 signature verification over the actual downloaded bytes.
pub async fn download_verified_installer<F>(
    manifest: &UpdateManifest,
    updates_dir: &Path,
    on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(UpdateProgress),
{
    download_verified_installer_inner(
        manifest,
        current_version(),
        TRUSTED_RELEASE_PUBLIC_KEY_HEX,
        updates_dir,
        true,
        on_progress,
    )
    .await
}

async fn download_verified_installer_inner<F>(
    manifest: &UpdateManifest,
    current_ver: &str,
    public_key_hex: &str,
    updates_dir: &Path,
    strict_origin: bool,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(UpdateProgress),
{
    // 1. Strict anti-downgrade / replay protection
    if !is_newer_version(current_ver, &manifest.version) {
        return Err(format!(
            "Обновление отклонено: версия {} не новее текущей ({}).",
            manifest.version, current_ver
        ));
    }

    // 2. Strict download URL validation
    if strict_origin {
        validate_download_url(&manifest.download_url)?;
    }

    // 3. Pre-download Ed25519 V2 signature check
    verify_release_signature_v2(
        public_key_hex,
        &manifest.version,
        &manifest.published_at,
        &manifest.notes,
        &manifest.sha256,
        manifest.size_bytes,
        &manifest.download_url,
        &manifest.signature_v2,
    )?;

    let client = build_pinned_client(300, ALLOWED_DOWNLOAD_HOST, strict_origin)?;

    on_progress(UpdateProgress {
        stage: "connecting".to_string(),
        downloaded_bytes: 0,
        total_bytes: manifest.size_bytes,
        percent: 0,
    });

    let resp = client
        .get(&manifest.download_url)
        .send()
        .await
        .map_err(|e| format!("Ошибка загрузки установщика: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "Не удалось скачать установщик: HTTP {}",
            resp.status().as_u16()
        ));
    }

    if let Some(cl) = resp.content_length() {
        if cl != manifest.size_bytes || cl > MAX_INSTALLER_BYTES {
            return Err("Размер загружаемого файла не соответствует подписанному манифесту.".into());
        }
    }

    tokio::fs::create_dir_all(updates_dir)
        .await
        .map_err(|e| format!("Не удалось подготовить каталог обновлений: {e}"))?;

    if let Ok(mut rd) = tokio::fs::read_dir(updates_dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("exe") {
                let _ = tokio::fs::remove_file(p).await;
            }
        }
    }

    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce)
        .map_err(|e| format!("Ошибка генерации случайного имени файла: {e}"))?;
    let safe_ver: String = manifest
        .version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-')
        .take(24)
        .collect();
    let filename = format!(
        "URTK-Flow-Update-{}-{}.exe",
        if safe_ver.is_empty() { "pkg" } else { &safe_ver },
        hex::encode(nonce)
    );
    let dest_path = updates_dir.join(filename);

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dest_path)
        .await
        .map_err(|e| format!("Не удалось создать защищённый файл обновления: {e}"))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut header_magic = Vec::with_capacity(2);
    let mut stream = resp.bytes_stream();
    let total_bytes = manifest.size_bytes;

    while let Some(chunk_res) = stream.next().await {
        let chunk = match chunk_res {
            Ok(c) => c,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(&dest_path).await;
                return Err(format!("Обрыв соединения при загрузке: {e}"));
            }
        };

        let next_total = downloaded.saturating_add(chunk.len() as u64);
        if next_total > manifest.size_bytes || next_total > MAX_INSTALLER_BYTES {
            drop(file);
            let _ = tokio::fs::remove_file(&dest_path).await;
            return Err(
                "Загрузка прервана: файл превысил подписанный размер. Временный файл удалён."
                    .into(),
            );
        }

        if header_magic.len() < 2 {
            let need = 2 - header_magic.len();
            header_magic.extend_from_slice(&chunk[..chunk.len().min(need)]);
        }

        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(&dest_path).await;
            return Err(format!("Ошибка записи на диск: {e}"));
        }
        hasher.update(&chunk);
        downloaded = next_total;

        let percent = if total_bytes > 0 {
            ((downloaded.saturating_mul(100)) / total_bytes).min(100) as u8
        } else {
            0
        };
        if percent != last_percent || downloaded == total_bytes {
            last_percent = percent;
            on_progress(UpdateProgress {
                stage: "downloading".to_string(),
                downloaded_bytes: downloaded,
                total_bytes,
                percent,
            });
        }
    }

    if let Err(e) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(format!("Ошибка сохранения файла: {e}"));
    }
    drop(file);

    on_progress(UpdateProgress {
        stage: "verifying".to_string(),
        downloaded_bytes: downloaded,
        total_bytes,
        percent: 100,
    });

    if header_magic.as_slice() != b"MZ" {
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(
            "Загруженный файл не является исполняемым установщиком Windows (PE). Файл удалён."
                .into(),
        );
    }

    if downloaded != manifest.size_bytes {
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(format!(
            "Размер загруженного файла ({downloaded}) не совпал с манифестом ({}). Файл удалён.",
            manifest.size_bytes
        ));
    }

    let expected_sha = manifest.sha256.trim().to_ascii_lowercase();
    let actual_bytes = hasher.finalize();
    let actual_hex = hex::encode(actual_bytes);
    if actual_hex != expected_sha {
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(format!(
            "Контрольная сумма SHA-256 не совпала! Ожидалось {expected_sha}, получено {actual_hex}. Файл удалён."
        ));
    }

    if let Err(e) = verify_release_signature_v2(
        public_key_hex,
        &manifest.version,
        &manifest.published_at,
        &manifest.notes,
        &actual_hex,
        downloaded,
        &manifest.download_url,
        &manifest.signature_v2,
    ) {
        let _ = tokio::fs::remove_file(&dest_path).await;
        return Err(e);
    }

    on_progress(UpdateProgress {
        stage: "installing".to_string(),
        downloaded_bytes: downloaded,
        total_bytes,
        percent: 100,
    });

    Ok(dest_path)
}

/// Launches the verified NSIS installer in passive in-place update mode (`/P /UPDATE /R`)
/// after verifying its canonical path resides strictly inside `expected_dir`.
pub fn launch_installer_and_exit(installer_path: &Path, expected_dir: &Path) -> Result<(), String> {
    let canon_dir = std::fs::canonicalize(expected_dir)
        .map_err(|e| format!("Не удалось проверить каталог обновлений: {e}"))?;
    let canon_file = std::fs::canonicalize(installer_path)
        .map_err(|e| format!("Не удалось проверить путь установщика: {e}"))?;

    if !canon_file.is_file()
        || canon_file.extension().and_then(|e| e.to_str()) != Some("exe")
        || canon_file.parent() != Some(canon_dir.as_path())
    {
        return Err("Нарушена целостность пути установщика обновления.".into());
    }

    std::process::Command::new(&canon_file)
        .args(["/P", "/UPDATE", "/R"])
        .spawn()
        .map_err(|e| format!("Не удалось запустить установщик обновления: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn test_keypair() -> (SigningKey, String) {
        let secret = [0x42u8; 32];
        let sk = SigningKey::from_bytes(&secret);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        (sk, pk_hex)
    }

    fn sign_manifest_v2(sk: &SigningKey, m: &mut UpdateManifest) {
        let msg = canonical_release_message_v2(
            &m.version,
            &m.published_at,
            &m.notes,
            &m.sha256,
            m.size_bytes,
            &m.download_url,
        );
        let sig = sk.sign(msg.as_bytes());
        m.signature_v2 = hex::encode(sig.to_bytes());
    }

    #[test]
    fn semver_comparison_handles_multi_digit_and_prefixes() {
        assert!(is_newer_version("1.0.0", "1.1.0"));
        assert!(is_newer_version("1.2.0", "1.10.0"));
        assert!(is_newer_version("1.0.0", "v2.0.0"));
        assert!(!is_newer_version("1.1.0", "1.1.0"));
        assert!(!is_newer_version("1.2.0", "1.1.9"));
        assert!(!is_newer_version("2.0.0", "1.9.9"));
        assert!(!is_newer_version("1.2.0", "1.2.0.1"));
    }

    #[test]
    fn url_pinning_blocks_untrusted_hosts_http_traversal_and_credentials() {
        assert!(validate_manifest_url("https://update.flow.mdsdev.ru/latest.json").is_ok());
        assert!(validate_manifest_url("http://update.flow.mdsdev.ru/latest.json").is_err());
        assert!(validate_manifest_url("https://evil.com/latest.json").is_err());
        assert!(validate_manifest_url("https://update.flow.mdsdev.ru.evil.com/latest.json").is_err());
        assert!(validate_manifest_url("https://user@update.flow.mdsdev.ru/latest.json").is_err());
        assert!(validate_manifest_url("https://update.flow.mdsdev.ru:8443/latest.json").is_err());
        assert!(validate_manifest_url("https://update.flow.mdsdev.ru/other.json").is_err());

        assert!(validate_download_url("https://flow.mdsdev.ru/downloads/URTK-Flow-Setup-1.2.1.exe").is_ok());
        assert!(validate_download_url("http://flow.mdsdev.ru/downloads/URTK-Flow-Setup-1.2.1.exe").is_err());
        assert!(validate_download_url("https://evil.com/downloads/setup.exe").is_err());
        assert!(validate_download_url("https://flow.mdsdev.ru/downloads/../evil.exe").is_err());
        assert!(validate_download_url("https://flow.mdsdev.ru/downloads/%2e%2e/evil.exe").is_err());
        assert!(validate_download_url("https://flow.mdsdev.ru/downloads/script.bat").is_err());
        assert!(validate_download_url("https://flow.mdsdev.ru/app/api.php").is_err());
    }

    async fn start_mock_update_server(
        manifest_json: String,
        payload_bytes: Vec<u8>,
    ) -> (String, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            for _ in 0..8 {
                if let Ok((mut socket, _)) = listener.accept().await {
                    let mut buf = [0u8; 2048];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.starts_with("GET /latest.json") {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            manifest_json.len(),
                            manifest_json
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                    } else if req.starts_with("GET /downloads/setup.exe") {
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload_bytes.len()
                        );
                        let _ = socket.write_all(header.as_bytes()).await;
                        let _ = socket.write_all(&payload_bytes).await;
                    }
                }
            }
        });

        (
            format!("http://{}/latest.json", addr),
            format!("http://{}/downloads/setup.exe", addr),
        )
    }

    #[tokio::test]
    async fn security_regression_signed_v2_updates_and_attack_blocks() {
        let (sk, pk_hex) = test_keypair();
        let fake_exe = b"MZ\x90\x00URTK-FLOW-SIGNED-INSTALLER-PAYLOAD-V1.2.1".to_vec();
        let good_sha = hex::encode(Sha256::digest(&fake_exe));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let dl_url = format!("http://{}/downloads/setup.exe", addr);
        let manifest_url = format!("http://{}/latest.json", addr);

        let mut valid_manifest = UpdateManifest {
            version: "1.2.1".into(),
            published_at: "2026-11-25".into(),
            notes: "Hardened V2 release".into(),
            download_url: dl_url.clone(),
            sha256: good_sha.clone(),
            size_bytes: fake_exe.len() as u64,
            signature: String::new(),
            signature_v2: String::new(),
        };
        sign_manifest_v2(&sk, &mut valid_manifest);
        let manifest_json = serde_json::to_string(&valid_manifest).unwrap();
        let payload_clone = fake_exe.clone();

        tokio::spawn(async move {
            for _ in 0..8 {
                if let Ok((mut socket, _)) = listener.accept().await {
                    let mut buf = [0u8; 2048];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    if req.starts_with("GET /latest.json") {
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            manifest_json.len(),
                            manifest_json
                        );
                        let _ = socket.write_all(resp.as_bytes()).await;
                    } else if req.starts_with("GET /downloads/setup.exe") {
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            payload_clone.len()
                        );
                        let _ = socket.write_all(header.as_bytes()).await;
                        let _ = socket.write_all(&payload_clone).await;
                    }
                }
            }
        });

        let tmp_dir = std::env::temp_dir().join("urtk_flow_sec_test_updates_v2");
        let _ = std::fs::remove_dir_all(&tmp_dir);

        // 1. Valid signed V2 manifest PASSES check and download
        let check = check_updates_inner(&manifest_url, "1.2.0", &pk_hex, false)
            .await
            .unwrap();
        assert!(check.update_available);
        let m = check.manifest.unwrap();
        let path =
            download_verified_installer_inner(&m, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .unwrap();
        assert!(path.exists());
        assert_eq!(std::fs::read(&path).unwrap(), fake_exe);

        // 2. Attack: Phishing tampering of `notes` with valid V2 signature MUST FAIL
        let mut phish_notes = m.clone();
        phish_notes.notes = "Срочно скачайте патч на evil.example".into();
        let notes_err =
            download_verified_installer_inner(&phish_notes, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .unwrap_err();
        assert!(notes_err.contains("Ed25519"));

        // 3. Attack: Tampering of `publishedAt` with valid V2 signature MUST FAIL
        let mut bad_date = m.clone();
        bad_date.published_at = "2099-01-01".into();
        assert!(
            verify_release_signature_v2(
                &pk_hex,
                &bad_date.version,
                &bad_date.published_at,
                &bad_date.notes,
                &bad_date.sha256,
                bad_date.size_bytes,
                &bad_date.download_url,
                &bad_date.signature_v2
            )
            .is_err()
        );

        // 4. Attack: Downgrade / replay MUST FAIL
        let downgrade_err =
            download_verified_installer_inner(&m, "1.2.1", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .unwrap_err();
        assert!(downgrade_err.contains("не новее"));

        // 5. Attack: Empty signatureV2 MUST FAIL
        let mut unsigned_m = m.clone();
        unsigned_m.signature_v2 = String::new();
        assert!(
            download_verified_installer_inner(&unsigned_m, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .is_err()
        );

        // 6. Attack: Forged signature by attacker key MUST FAIL
        let attacker_sk = SigningKey::from_bytes(&[0x99u8; 32]);
        let mut forged_m = m.clone();
        sign_manifest_v2(&attacker_sk, &mut forged_m);
        assert!(
            download_verified_installer_inner(&forged_m, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .is_err()
        );

        // 7. Attack: Tampered binary (1 bit flipped) MUST FAIL & delete temp file
        let mut tampered_exe = fake_exe.clone();
        tampered_exe[10] ^= 0xFF;
        let (_, bad_dl_url) = start_mock_update_server("{}".into(), tampered_exe).await;
        let mut tampered_m = UpdateManifest {
            version: "1.2.2".into(),
            published_at: "2026-11-25".into(),
            notes: "Test".into(),
            download_url: bad_dl_url,
            sha256: good_sha.clone(),
            size_bytes: fake_exe.len() as u64,
            signature: String::new(),
            signature_v2: String::new(),
        };
        sign_manifest_v2(&sk, &mut tampered_m);
        let hash_err =
            download_verified_installer_inner(&tampered_m, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .unwrap_err();
        assert!(hash_err.contains("SHA-256"));

        // 8. Attack: Non-PE payload MUST FAIL PE check
        let non_pe = b"<html><body>fake installer</body></html>".to_vec();
        let non_pe_sha = hex::encode(Sha256::digest(&non_pe));
        let (_, non_pe_url) = start_mock_update_server("{}".into(), non_pe.clone()).await;
        let mut non_pe_m = UpdateManifest {
            version: "1.2.3".into(),
            published_at: "2026-11-25".into(),
            notes: "Test".into(),
            download_url: non_pe_url,
            sha256: non_pe_sha,
            size_bytes: non_pe.len() as u64,
            signature: String::new(),
            signature_v2: String::new(),
        };
        sign_manifest_v2(&sk, &mut non_pe_m);
        let pe_err =
            download_verified_installer_inner(&non_pe_m, "1.2.0", &pk_hex, &tmp_dir, false, |_| {})
                .await
                .unwrap_err();
        assert!(pe_err.contains("PE"));

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
