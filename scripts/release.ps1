param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [string]$Notes = "Обновление URTK Flow.",
    [string]$PublicDownloadBase = "https://flow.mdsdev.ru/downloads",
    [string]$SigningKeyPath = (Join-Path $env:USERPROFILE ".urtk-flow-signing\urtk-flow-ed25519.key")
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

if (-not (Test-Path $SigningKeyPath)) {
    throw "Offline Ed25519 signing key not found at: $SigningKeyPath"
}

Write-Host "==> [1/6] Updating version to $Version across app configs..." -ForegroundColor Cyan

$pkgPath = Join-Path $Root "package.json"
$pkgRaw = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
Write-Utf8NoBom $pkgPath ($pkgRaw -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"")

$tauriConfPath = Join-Path $Root "src-tauri\tauri.conf.json"
$tauriRaw = [System.IO.File]::ReadAllText($tauriConfPath, [System.Text.Encoding]::UTF8)
Write-Utf8NoBom $tauriConfPath ($tauriRaw -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`"")

$cargoPath = Join-Path $Root "src-tauri\Cargo.toml"
$cargoRaw = [System.IO.File]::ReadAllText($cargoPath, [System.Text.Encoding]::UTF8)
$cargoUpdated = [regex]::Replace($cargoRaw, '(?m)^version = "[^"]+"', "version = `"$Version`"", 1)
Write-Utf8NoBom $cargoPath $cargoUpdated

Write-Host "==> [2/6] Running Rust unit & security regression tests..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "src-tauri")
cargo test --lib
if ($LASTEXITCODE -ne 0) { throw "Cargo tests failed!" }
Pop-Location

Write-Host "==> [3/6] Building NSIS Wizard Installer for v$Version..." -ForegroundColor Cyan
npm run tauri build -- --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed!" }

$nsisSrc = Join-Path $Root "src-tauri\target\release\bundle\nsis\URTK Flow_${Version}_x64-setup.exe"
if (-not (Test-Path $nsisSrc)) {
    throw "Expected installer not found: $nsisSrc"
}

Write-Host "==> [4/6] Publishing installer & calculating SHA-256..." -ForegroundColor Cyan
$dlDir = Join-Path $Root "website\downloads"
$updDir = Join-Path $Root "website\updates"
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
New-Item -ItemType Directory -Force -Path $updDir | Out-Null

Get-ChildItem -Path $dlDir -Filter "URTK-Flow-Setup-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force

$fileName = "URTK-Flow-Setup-${Version}.exe"
$destWeb = Join-Path $dlDir $fileName
$destRoot = Join-Path $Root $fileName
Copy-Item $nsisSrc $destWeb -Force
Copy-Item $nsisSrc $destRoot -Force

$sha256 = (Get-FileHash -Path $destWeb -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeBytes = (Get-Item $destWeb).Length
$sizeMbRu = ("{0:N2}" -f ($sizeBytes / 1MB)).Replace(".", ",")
$dateStr = (Get-Date).ToString("yyyy-MM-dd")
$downloadUrl = "$($PublicDownloadBase.TrimEnd('/'))/$fileName"

Write-Host "==> [5/6] Signing release manifest (Ed25519 V1 + V2, DPAPI-protected key)..." -ForegroundColor Cyan
$tmpNotesFile = Join-Path $env:TEMP ("urtk_notes_" + [guid]::NewGuid().ToString("N") + ".txt")
Write-Utf8NoBom $tmpNotesFile $Notes
Push-Location (Join-Path $Root "src-tauri")
try {
    # Ensure the offline private key is DPAPI-encrypted at rest on Windows
    $null = cargo run --quiet --bin sign_release -- protect $SigningKeyPath
    if ($LASTEXITCODE -ne 0) { throw "DPAPI protection check failed!" }

    # V1 signature keeps seamless auto-update compatibility for v1.2.0 users
    $signatureV1 = (cargo run --quiet --bin sign_release -- sign $SigningKeyPath $Version $sha256 "$sizeBytes" $downloadUrl).Trim()
    if ($LASTEXITCODE -ne 0 -or $signatureV1.Length -ne 128) { throw "Ed25519 V1 signing failed!" }

    # V2 signature binds publishedAt and notes (SHA-256) in addition to installer hash/size/url
    $signatureV2 = (cargo run --quiet --bin sign_release -- sign-v2 $SigningKeyPath $Version $dateStr $tmpNotesFile $sha256 "$sizeBytes" $downloadUrl).Trim()
    if ($LASTEXITCODE -ne 0 -or $signatureV2.Length -ne 128) { throw "Ed25519 V2 signing failed!" }
} finally {
    Pop-Location
    Remove-Item $tmpNotesFile -Force -ErrorAction SilentlyContinue
}

$manifestObj = [ordered]@{
    version     = $Version
    publishedAt = $dateStr
    notes       = $Notes
    downloadUrl = $downloadUrl
    sha256      = $sha256
    sizeBytes   = $sizeBytes
    signature   = $signatureV1
    signatureV2 = $signatureV2
}
$manifestJson = $manifestObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText((Join-Path $updDir "latest.json"), $manifestJson, $utf8NoBom)

Write-Host "==> [6/6] Updating static fallbacks in website/index.html..." -ForegroundColor Cyan
$htmlPath = Join-Path $Root "website\index.html"
$html = Get-Content $htmlPath -Raw -Encoding UTF8
$html = [regex]::Replace($html, 'URTK-Flow-Setup-[0-9]+\.[0-9]+\.[0-9]+\.exe', $fileName)
$html = [regex]::Replace($html, '(<span[^>]*data-release-version[^>]*>)[^<]+(</span>)', "`${1}$Version`${2}")
$html = [regex]::Replace($html, '(<span[^>]*data-release-size[^>]*>)[^<]+(</span>)', "`${1}$sizeMbRu МБ`${2}")
$html = [regex]::Replace($html, '(<code[^>]*data-release-sha256[^>]*>)[^<]+(</code>)', "`${1}$sha256`${2}")
[System.IO.File]::WriteAllText($htmlPath, $html, $utf8NoBom)

Write-Host ""
Write-Host "SIGNED RELEASE v$Version READY!" -ForegroundColor Green
Write-Host "  Installer  : $destWeb ($sizeMbRu MB)"
Write-Host "  SHA-256    : $sha256"
Write-Host "  Ed25519 V1 : $($signatureV1.Substring(0, 20))...$($signatureV1.Substring(108))"
Write-Host "  Ed25519 V2 : $($signatureV2.Substring(0, 20))...$($signatureV2.Substring(108))"
Write-Host "  Manifest   : $(Join-Path $updDir 'latest.json')"
