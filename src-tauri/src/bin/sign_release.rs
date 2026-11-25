use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::PathBuf;

const DPAPI_PREFIX: &str = "DPAPI-V1:";
#[cfg(target_os = "windows")]
const DPAPI_ENTROPY: &[u8] = b"URTK-FLOW-ED25519-SIGNING-KEY-V1";

fn canonical_payload_v1(
    version: &str,
    sha256_hex: &str,
    size_bytes: u64,
    download_url: &str,
) -> String {
    format!(
        "URTK-FLOW-UPDATE-V1\nversion={}\nsha256={}\nsizeBytes={}\ndownloadUrl={}",
        version.trim(),
        sha256_hex.trim().to_ascii_lowercase(),
        size_bytes,
        download_url.trim()
    )
}

fn canonical_payload_v2(
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

#[cfg(target_os = "windows")]
fn dpapi_protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut in_buf = plain.to_vec();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: in_buf.len() as u32,
        pbData: in_buf.as_mut_ptr(),
    };
    let mut ent_buf = DPAPI_ENTROPY.to_vec();
    let ent_blob = CRYPT_INTEGER_BLOB {
        cbData: ent_buf.len() as u32,
        pbData: ent_buf.as_mut_ptr(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };

    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            null(),
            &ent_blob,
            null_mut(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    in_buf.fill(0);
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("Windows DPAPI CryptProtectData failed".into());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        LocalFree(out_blob.pbData as _);
    }
    Ok(result)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use windows_sys::Win32::Foundation::LocalFree;

    let mut in_buf = cipher.to_vec();
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: in_buf.len() as u32,
        pbData: in_buf.as_mut_ptr(),
    };
    let mut ent_buf = DPAPI_ENTROPY.to_vec();
    let ent_blob = CRYPT_INTEGER_BLOB {
        cbData: ent_buf.len() as u32,
        pbData: ent_buf.as_mut_ptr(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };

    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            null_mut(),
            &ent_blob,
            null_mut(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return Err("Windows DPAPI CryptUnprotectData failed".into());
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let result = slice.to_vec();
    unsafe {
        std::ptr::write_bytes(out_blob.pbData, 0, out_blob.cbData as usize);
        LocalFree(out_blob.pbData as _);
    }
    Ok(result)
}

fn load_secret_key(key_path: &PathBuf) -> SigningKey {
    let raw = fs::read_to_string(key_path).expect("failed to read private key");
    let trimmed = raw.trim();
    let mut secret_bytes = if let Some(rest) = trimmed.strip_prefix(DPAPI_PREFIX) {
        #[cfg(target_os = "windows")]
        {
            let cipher = hex::decode(rest.trim()).expect("invalid DPAPI hex payload");
            dpapi_unprotect(&cipher).expect("failed to decrypt DPAPI signing key")
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = rest;
            panic!("DPAPI-encrypted key can only be decrypted on Windows");
        }
    } else {
        hex::decode(trimmed).expect("invalid hex in private key")
    };

    let arr: [u8; 32] = secret_bytes
        .clone()
        .try_into()
        .expect("private key must be 32 bytes");
    secret_bytes.fill(0);
    SigningKey::from_bytes(&arr)
}

fn write_protected_key(out_path: &PathBuf, secret: &[u8; 32]) {
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).expect("failed to create key directory");
    }
    #[cfg(target_os = "windows")]
    {
        let cipher = dpapi_protect(secret).expect("failed to protect signing key with DPAPI");
        let content = format!("{}{}", DPAPI_PREFIX, hex::encode(cipher));
        fs::write(out_path, content).expect("failed to write DPAPI-protected private key");
    }
    #[cfg(not(target_os = "windows"))]
    {
        fs::write(out_path, hex::encode(secret)).expect("failed to write private key");
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "Usage:\n  sign_release keygen <key_out_path>\n  sign_release protect <key_path>\n  sign_release pubkey <key_path>\n  sign_release sign <key_path> <version> <sha256_hex> <size_bytes> <download_url>\n  sign_release sign-v2 <key_path> <version> <published_at> <notes_file> <sha256_hex> <size_bytes> <download_url>"
        );
        std::process::exit(2);
    }

    match args[1].as_str() {
        "keygen" => {
            let out_path = PathBuf::from(args.get(2).expect("missing <key_out_path>"));
            if out_path.exists() {
                eprintln!(
                    "Refusing to overwrite existing key file: {}",
                    out_path.display()
                );
                std::process::exit(1);
            }
            let mut secret = [0u8; 32];
            getrandom::getrandom(&mut secret).expect("OS CSPRNG failed");
            let signing_key = SigningKey::from_bytes(&secret);
            let verifying_key = signing_key.verifying_key();

            write_protected_key(&out_path, &secret);
            secret.fill(0);
            println!("{}", hex::encode(verifying_key.to_bytes()));
        }
        "protect" => {
            let key_path = PathBuf::from(args.get(2).expect("missing <key_path>"));
            let raw = fs::read_to_string(&key_path).expect("failed to read key");
            if raw.trim().starts_with(DPAPI_PREFIX) {
                let sk = load_secret_key(&key_path);
                println!("ALREADY_PROTECTED {}", hex::encode(sk.verifying_key().to_bytes()));
                return;
            }
            let bytes = hex::decode(raw.trim()).expect("invalid hex in plaintext key");
            let mut arr: [u8; 32] = bytes.try_into().expect("private key must be 32 bytes");
            let sk = SigningKey::from_bytes(&arr);
            write_protected_key(&key_path, &arr);
            arr.fill(0);
            println!("PROTECTED {}", hex::encode(sk.verifying_key().to_bytes()));
        }
        "pubkey" => {
            let key_path = PathBuf::from(args.get(2).expect("missing <key_path>"));
            let signing_key = load_secret_key(&key_path);
            println!("{}", hex::encode(signing_key.verifying_key().to_bytes()));
        }
        "sign" => {
            if args.len() != 7 {
                eprintln!(
                    "Usage: sign_release sign <key_path> <version> <sha256_hex> <size_bytes> <download_url>"
                );
                std::process::exit(2);
            }
            let key_path = PathBuf::from(&args[2]);
            let version = &args[3];
            let sha256_hex = &args[4];
            let size_bytes: u64 = args[5].parse().expect("invalid size_bytes");
            let download_url = &args[6];

            if sha256_hex.len() != 64 || !sha256_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                eprintln!("sha256 must be 64 hex chars");
                std::process::exit(2);
            }

            let signing_key = load_secret_key(&key_path);
            let msg = canonical_payload_v1(version, sha256_hex, size_bytes, download_url);
            let sig = signing_key.sign(msg.as_bytes());
            println!("{}", hex::encode(sig.to_bytes()));
        }
        "sign-v2" => {
            if args.len() != 9 {
                eprintln!(
                    "Usage: sign_release sign-v2 <key_path> <version> <published_at> <notes_file> <sha256_hex> <size_bytes> <download_url>"
                );
                std::process::exit(2);
            }
            let key_path = PathBuf::from(&args[2]);
            let version = &args[3];
            let published_at = &args[4];
            let notes_file = PathBuf::from(&args[5]);
            let sha256_hex = &args[6];
            let size_bytes: u64 = args[7].parse().expect("invalid size_bytes");
            let download_url = &args[8];

            if sha256_hex.len() != 64 || !sha256_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                eprintln!("sha256 must be 64 hex chars");
                std::process::exit(2);
            }

            let notes = fs::read_to_string(&notes_file).expect("failed to read notes file");
            let signing_key = load_secret_key(&key_path);
            let msg = canonical_payload_v2(
                version,
                published_at,
                &notes,
                sha256_hex,
                size_bytes,
                download_url,
            );
            let sig = signing_key.sign(msg.as_bytes());
            println!("{}", hex::encode(sig.to_bytes()));
        }
        other => {
            eprintln!("Unknown subcommand: {other}");
            std::process::exit(2);
        }
    }
}
