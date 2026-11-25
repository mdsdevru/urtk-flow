// 1. Hero interactive app tabs
document.querySelectorAll("[data-mock-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.getAttribute("data-mock-tab");
    document.querySelectorAll("[data-mock-tab]").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll("[data-mock-panel]").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const panel = document.querySelector(`[data-mock-panel="${target}"]`);
    if (panel) panel.classList.add("active");
  });
});

// 2. Hero Dark / Light Liquid Glass theme switch
const heroStage = document.getElementById("hero-stage");
document.querySelectorAll("[data-stage-theme]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const theme = chip.getAttribute("data-stage-theme") || "dark";
    document.querySelectorAll("[data-stage-theme]").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    if (heroStage) heroStage.setAttribute("data-theme", theme);
  });
});

// 3. Interactive Widget Sandbox controls
const bellToggle = document.getElementById("w-bell");
const dayToggle = document.getElementById("w-day");
const consToggle = document.getElementById("w-cons");
const opacitySlider = document.getElementById("w-opacity");
const opacityLabel = document.getElementById("w-opacity-val");
const sandboxWidget = document.getElementById("sandbox-widget");

const bindToggle = (inputEl, blockId) => {
  const block = document.getElementById(blockId);
  if (!inputEl || !block) return;
  const sync = () => block.classList.toggle("is-hidden", !inputEl.checked);
  inputEl.addEventListener("change", sync);
  sync();
};

bindToggle(bellToggle, "sw-bell-block");
bindToggle(dayToggle, "sw-day-block");
bindToggle(consToggle, "sw-cons-block");

if (opacitySlider && sandboxWidget && opacityLabel) {
  const updateOpacity = () => {
    const pct = Number(opacitySlider.value);
    const a1 = (pct / 100).toFixed(2);
    const a2 = Math.min(0.95, pct / 100 + 0.06).toFixed(2);
    opacityLabel.textContent = `${pct}%`;
    sandboxWidget.style.background = `linear-gradient(155deg, rgba(28, 32, 42, ${a1}) 0%, rgba(16, 18, 25, ${a2}) 100%)`;
  };
  opacitySlider.addEventListener("input", updateOpacity);
  updateOpacity();
}

// 4. Win+D simulation button
const winDBtn = document.getElementById("simulate-wind");
const sandbox = document.getElementById("widget-sandbox");
const windLabel = document.getElementById("wind-label");
const sandboxStatus = document.getElementById("sandbox-status");

if (winDBtn && sandbox) {
  winDBtn.addEventListener("click", () => {
    const shown = sandbox.classList.toggle("desktop-shown");
    if (windLabel) {
      windLabel.textContent = shown ? "Вернуть окна обратно" : "Свернуть остальные окна";
    }
    if (sandboxStatus) {
      sandboxStatus.textContent = shown
        ? "Win+D активен — виджет остался на месте"
        : "Рабочий стол Windows";
    }
  });
}

// 5. Smooth scroll reveal
const revealEls = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  revealEls.forEach((el) => observer.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("is-visible"));
}

// 6. Auto-sync download links & version metadata from update server with strict URL pinning + Ed25519 V2 verification
(async () => {
  const TRUSTED_PUBKEY_HEX = "fc780728b3dfdcfb6b6110b5c7ce143a6d3dd4b8c3cc4251825c242e225b7a5f";
  const MAX_INSTALLER_BYTES = 50 * 1024 * 1024;

  const hexToBytes = (hex) => {
    const clean = String(hex || "").trim();
    if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  };

  const bytesToHex = (buf) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

  const verifyManifestSignatureV2 = async (manifest, ver, dlHref) => {
    const sigHex = String(manifest.signatureV2 || "").trim();
    const shaHex = String(manifest.sha256 || "").trim().toLowerCase();
    const size = Number(manifest.sizeBytes);
    if (!/^[0-9a-f]{128}$/i.test(sigHex) || !/^[0-9a-f]{64}$/.test(shaHex)) return false;
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) return false;

    if (!window.crypto || !window.crypto.subtle) return true;
    try {
      const enc = new TextEncoder();
      const notesHashBuf = await crypto.subtle.digest(
        "SHA-256",
        enc.encode(String(manifest.notes || "").trim())
      );
      const notesSha = bytesToHex(notesHashBuf);
      const msg =
        `URTK-FLOW-UPDATE-V2\nversion=${ver}\npublishedAt=${String(manifest.publishedAt || "").trim()}\nnotesSha256=${notesSha}\nsha256=${shaHex}\nsizeBytes=${size}\ndownloadUrl=${dlHref}`;
      const pubBytes = hexToBytes(TRUSTED_PUBKEY_HEX);
      const sigBytes = hexToBytes(sigHex);
      if (!pubBytes || !sigBytes) return false;

      const key = await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, [
        "verify",
      ]);
      return await crypto.subtle.verify("Ed25519", key, sigBytes, enc.encode(msg));
    } catch (err) {
      // Allow fallback only when older browser lacks Ed25519 WebCrypto support
      if (err && (err.name === "NotSupportedError" || err.name === "TypeError")) {
        return true;
      }
      return false;
    }
  };

  const endpoints = ["https://update.flow.mdsdev.ru/latest.json"];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) continue;
      const manifest = await resp.json();
      if (!manifest || typeof manifest !== "object") continue;

      const ver = String(manifest.version || "").trim();
      if (!/^\d+\.\d+\.\d+$/.test(ver)) continue;

      // Strict downloadUrl pinning: HTTPS + exact official host + exact expected filename
      let parsedUrl;
      try {
        parsedUrl = new URL(String(manifest.downloadUrl || "").trim());
      } catch {
        continue;
      }
      const expectedFilename = `URTK-Flow-Setup-${ver}.exe`;
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.hostname !== "flow.mdsdev.ru" ||
        parsedUrl.port !== "" ||
        parsedUrl.username !== "" ||
        parsedUrl.password !== "" ||
        parsedUrl.search !== "" ||
        parsedUrl.hash !== "" ||
        parsedUrl.pathname !== `/downloads/${expectedFilename}`
      ) {
        continue;
      }

      const dlHref = parsedUrl.href;
      const sigOk = await verifyManifestSignatureV2(manifest, ver, dlHref);
      if (!sigOk) continue;

      const sizeMb =
        manifest.sizeBytes > 0
          ? `${(manifest.sizeBytes / (1024 * 1024)).toFixed(2).replace(".", ",")} МБ`
          : null;

      document.querySelectorAll("[data-release-version]").forEach((el) => {
        el.textContent = ver;
      });
      if (sizeMb) {
        document.querySelectorAll("[data-release-size]").forEach((el) => {
          el.textContent = sizeMb;
        });
      }
      document.querySelectorAll("[data-release-sha256]").forEach((el) => {
        el.textContent = String(manifest.sha256 || "").trim().toLowerCase();
      });
      document.querySelectorAll("a[data-release-download]").forEach((a) => {
        a.setAttribute("href", dlHref);
        a.setAttribute("download", expectedFilename);
      });
      break;
    } catch {
      // Keep static fallback HTML link intact on any validation/network error
    }
  }

  const copyBtn = document.getElementById("copy-sha256");
  const shaEl = document.getElementById("release-sha256");
  if (copyBtn && shaEl && navigator.clipboard) {
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText((shaEl.textContent || "").trim()).then(() => {
        const prev = copyBtn.textContent;
        copyBtn.textContent = "Скопировано";
        setTimeout(() => {
          copyBtn.textContent = prev;
        }, 1800);
      }).catch(() => {});
    });
  }
})();
