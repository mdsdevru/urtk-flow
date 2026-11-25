const STORAGE_SETTINGS = "urtk_flow_pwa_settings_v1";
const STORAGE_CACHE = "urtk_flow_pwa_cache_v1";

// Fix iOS WebKit standalone black-translucent bug where window.innerHeight / 100dvh / bottom:0
// stops ~54px short of the physical screen (leaving an empty chin at the bottom).
function syncViewportHeight() {
  const docEl = document.documentElement;
  const isIosStandalone = window.navigator.standalone === true;
  const isStandalone =
    isIosStandalone || window.matchMedia("(display-mode: standalone)").matches;

  const innerH = window.innerHeight;
  let appH = innerH;

  if (isStandalone && window.screen) {
    const minSide = Math.min(window.screen.width, window.screen.height);
    const maxSide = Math.max(window.screen.width, window.screen.height);
    const isLandscape = window.innerWidth > window.innerHeight;
    const screenH = isLandscape ? minSide : maxSide;
    const diff = screenH - innerH;

    if (isIosStandalone && minSide <= 500) {
      appH = screenH;
    } else if (diff > 0 && diff <= 110) {
      appH = screenH;
    }
  }

  docEl.style.setProperty("--app-height", `${appH}px`);
}

syncViewportHeight();
window.addEventListener("resize", () => {
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) return;
  syncViewportHeight();
});
window.addEventListener("orientationchange", () => {
  setTimeout(syncViewportHeight, 120);
});

const state = {
  settings: loadSettings(),
  data: loadCache(),
  tab: "schedule",
  consultFilter: "active",
  teacherQuery: "",
  groupQuery: "",
  extraGroupQuery: "",
  courseFilter: "all",
  selectedDayIdx: 0,
  scheduleViewKey: "primary",
  compareDate: "",
  bellMode: new Date().getDay() === 1 ? "monday" : "regular",
  syncing: false,
  bellStatus: { text: "—", active: false, activePairNumber: null, nextPairNumber: null },
};

function loadSettings() {
  const defaults = {
    theme: "dark",
    role: "student",
    selectedGroup: "",
    selectedTeacher: "",
    multiGroupsEnabled: false,
    extraGroups: [],
    pinnedTeachers: [],
    hideInstallBanner: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw);
      const merged = Object.assign(defaults, parsed);
      if (merged.role !== "student" && merged.role !== "teacher") merged.role = "student";
      if (!Array.isArray(merged.extraGroups)) merged.extraGroups = [];
      return merged;
    }
  } catch {}
  return defaults;
}

function isTeacherRole() {
  return state.settings.role === "teacher";
}

function getActiveTargetName() {
  return isTeacherRole() ? state.settings.selectedTeacher : state.settings.selectedGroup;
}

function getActiveExtraGroups() {
  if (isTeacherRole() || !state.settings.multiGroupsEnabled || !state.settings.selectedGroup) {
    return [];
  }
  const primary = state.settings.selectedGroup.toLowerCase();
  return (state.settings.extraGroups || [])
    .filter((g) => g && g.toLowerCase() !== primary)
    .slice(0, 5);
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(state.settings));
  } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveCache(payload) {
  try {
    localStorage.setItem(STORAGE_CACHE, JSON.stringify(payload));
  } catch {}
}

function showToast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

function applyTheme() {
  const light = state.settings.theme === "light";
  document.body.classList.toggle("theme-light", light);
  document.body.classList.toggle("theme-dark", !light);
  document.documentElement.classList.toggle("theme-light", light);
  const meta = document.getElementById("meta-theme-color");
  if (meta) meta.setAttribute("content", light ? "#eef1f7" : "#080a0f");

  const ico = document.getElementById("ico-theme");
  if (ico) {
    ico.innerHTML = light
      ? '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41" stroke-linecap="round"/>';
  }
  document.querySelectorAll("[data-settheme]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-settheme") === state.settings.theme);
  });
}

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\./g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

function teacherNamesMatch(aRaw, bRaw) {
  const a = normalizeName(aRaw);
  const b = normalizeName(bRaw);
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split(" ");
  const pb = b.split(" ");
  if (pa[0] !== pb[0]) return false;
  if (pa.length === 1 || pb.length === 1) return true;
  if (pa[1][0] !== pb[1][0]) return false;
  if (pa.length >= 3 && pb.length >= 3 && pa[2][0] !== pb[2][0]) return false;
  return true;
}

function isPinnedTeacher(name) {
  return state.settings.pinnedTeachers.some((p) => teacherNamesMatch(p, name));
}

function togglePinTeacher(name) {
  const wasPinned = isPinnedTeacher(name);
  if (wasPinned) {
    state.settings.pinnedTeachers = state.settings.pinnedTeachers.filter(
      (p) => !teacherNamesMatch(p, name)
    );
  } else {
    state.settings.pinnedTeachers.push(name);
  }
  saveSettings();
  showToast(wasPinned ? "Преподаватель откреплён" : "Закреплён вверху списка");
  renderConsultations();
}

function pickUpcomingDayIdx(schedule) {
  if (!schedule || !schedule.length) return 0;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const minTs = now.getHours() >= 19 ? todayStart + 86400000 : todayStart;
  const idx = schedule.findIndex((d) => {
    const [dd, mm, yyyy] = (d.date || "").split(".").map(Number);
    if (!dd || !mm || !yyyy) return false;
    return new Date(yyyy, mm - 1, dd).getTime() >= minTs;
  });
  return idx >= 0 ? idx : 0;
}

function parseMinutesStrict(hhmm) {
  const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatMinutesRu(totalMins) {
  const mins = Math.max(1, Math.round(totalMins));
  if (mins < 60) return `${mins} мин`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

function parseDateRu(dateStr) {
  const [dd, mm, yyyy] = String(dateStr || "").split(".").map(Number);
  if (!dd || !mm || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd);
}

function formatDateRu(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function computeBellStatus(now) {
  const day = now.getDay();
  if (day === 0) {
    return { text: "Выходной", active: false, activePairNumber: null, nextPairNumber: null };
  }

  const bells =
    day === 1
      ? state.data?.bellsMonday || []
      : state.data?.bellsRegular || [];

  const bellByPair = new Map();
  for (const b of bells) {
    const start = parseMinutesStrict((b.part1 || "").split(/[–-]/)[0]);
    const end = parseMinutesStrict((b.part2 || "").split(/[–-]/)[1]);
    if (start !== null && end !== null && end > start) {
      bellByPair.set(b.pairNumber, { start, end });
    }
  }

  const cur = now.getHours() * 60 + now.getMinutes();
  const todayStr = formatDateRu(now);
  const isoDay = day === 0 ? 7 : day;
  const weekMondayTs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (isoDay - 1)
  ).getTime();

  const schedule = state.data?.schedule || [];
  const hasGroupSchedule =
    Boolean(getActiveTargetName()) &&
    schedule.length > 0 &&
    schedule.some((d) => {
      const dt = parseDateRu(d.date);
      return dt !== null && dt.getTime() >= weekMondayTs;
    });

  if (hasGroupSchedule) {
    const todayDay = schedule.find((d) => d.date === todayStr);
    if (!todayDay || !todayDay.lessons || !todayDay.lessons.length) {
      return {
        text: "Сегодня пар нет",
        active: false,
        activePairNumber: null,
        nextPairNumber: null,
      };
    }

    const intervals = [];
    for (const l of todayDay.lessons) {
      const fallback = bellByPair.get(l.pairNumber);
      const start = parseMinutesStrict(l.timeStart) ?? fallback?.start ?? null;
      const end = parseMinutesStrict(l.timeEnd) ?? fallback?.end ?? null;
      if (start !== null && end !== null && end > start) {
        intervals.push({ pairNumber: Number(l.pairNumber) || 0, start, end });
      }
    }

    if (!intervals.length) {
      return {
        text: "Сегодня пар нет",
        active: false,
        activePairNumber: null,
        nextPairNumber: null,
      };
    }

    intervals.sort((a, b) => a.start - b.start || a.end - b.end);

    const activeNow = intervals.filter((x) => cur >= x.start && cur < x.end);
    if (activeNow.length > 0) {
      const current = activeNow.reduce(
        (best, x) => (x.end > best.end ? x : best),
        activeNow[0]
      );
      const upcomingAfter = intervals.find((x) => x.start >= current.end);
      return {
        text: `${current.pairNumber} пара · ещё ${formatMinutesRu(current.end - cur)}`,
        active: true,
        activePairNumber: current.pairNumber,
        nextPairNumber: upcomingAfter ? upcomingAfter.pairNumber : null,
      };
    }

    const nextLesson = intervals.find((x) => cur < x.start);
    if (nextLesson) {
      return {
        text: `До ${nextLesson.pairNumber} пары · ${formatMinutesRu(nextLesson.start - cur)}`,
        active: true,
        activePairNumber: null,
        nextPairNumber: nextLesson.pairNumber,
      };
    }

    return {
      text: "Пары на сегодня закончились",
      active: false,
      activePairNumber: null,
      nextPairNumber: null,
    };
  }

  if (!bells.length) {
    return { text: "УРТК им. Попова", active: false, activePairNumber: null, nextPairNumber: null };
  }

  for (const b of bells) {
    const slot = bellByPair.get(b.pairNumber);
    if (!slot) continue;
    if (cur < slot.start) {
      return {
        text: `До ${b.pairNumber} пары · ${formatMinutesRu(slot.start - cur)}`,
        active: true,
        activePairNumber: null,
        nextPairNumber: Number(b.pairNumber) || null,
      };
    }
    if (cur >= slot.start && cur < slot.end) {
      return {
        text: `${b.pairNumber} пара · ещё ${formatMinutesRu(slot.end - cur)}`,
        active: true,
        activePairNumber: Number(b.pairNumber) || null,
        nextPairNumber: null,
      };
    }
  }
  return {
    text: "Пары на сегодня закончились",
    active: false,
    activePairNumber: null,
    nextPairNumber: null,
  };
}

function updateBellBar() {
  const now = new Date();
  const dateEl = document.getElementById("bell-date");
  const statusEl = document.getElementById("bell-status");
  const barEl = document.getElementById("bell-bar");
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString("ru-RU", {
      weekday: "short",
      day: "numeric",
      month: "long",
    });
  }
  const prevActive = state.bellStatus.activePairNumber;
  const prevNext = state.bellStatus.nextPairNumber;
  const status = computeBellStatus(now);
  state.bellStatus = status;

  if (statusEl) statusEl.textContent = status.text;
  if (barEl) barEl.classList.toggle("bell-idle", !status.active);

  if (prevActive !== status.activePairNumber || prevNext !== status.nextPairNumber) {
    renderSchedule();
  }
}

const TAB_ORDER = ["schedule", "consultations", "materials", "settings"];

function setTab(tabId, opts = {}) {
  const prevIdx = TAB_ORDER.indexOf(state.tab);
  const nextIdx = TAB_ORDER.indexOf(tabId);
  const dirClass =
    prevIdx !== -1 && nextIdx !== -1 && prevIdx !== nextIdx
      ? nextIdx > prevIdx
        ? "slide-from-right"
        : "slide-from-left"
      : "";

  state.tab = tabId;
  document.querySelectorAll(".tab-view").forEach((v) => {
    const isActive = v.getAttribute("data-view") === tabId;
    v.classList.remove("slide-from-right", "slide-from-left");
    v.classList.toggle("active", isActive);
    if (isActive && dirClass) {
      void v.offsetWidth;
      v.classList.add(dirClass);
    }
  });
  document.querySelectorAll(".tab-item").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
  });
  if (!opts.preserveScroll) {
    const mainEl = document.getElementById("ios-main");
    if (mainEl) mainEl.scrollTop = 0;
  }
}

function shortWeekday(weekday) {
  const key = String(weekday || "").trim().toLowerCase();
  if (key.startsWith("пон")) return "Пн";
  if (key.startsWith("вто")) return "Вт";
  if (key.startsWith("сре")) return "Ср";
  if (key.startsWith("чет")) return "Чт";
  if (key.startsWith("пят")) return "Пт";
  if (key.startsWith("суб")) return "Сб";
  if (key.startsWith("вос")) return "Вс";
  return String(weekday || "").slice(0, 2);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHttpUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed.length > 2048 || /[\x00-\x1F\x7F\\]/.test(trimmed)) {
    return null;
  }
  try {
    const u = new URL(trimmed);
    if (u.username || u.password) return null;
    const host = (u.hostname || "").toLowerCase();
    if (
      !host ||
      !host.includes(".") ||
      host.startsWith("[") ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return null;
    }
    if (u.protocol === "https:") return u.href;
    if (u.protocol === "http:" && host === "moodle.urtk.su") return u.href;
  } catch {}
  return null;
}

function getSelectedGroupInfo() {
  if (isTeacherRole() || !state.settings.selectedGroup) return null;
  const target = state.settings.selectedGroup.toLowerCase();
  return (state.data?.groups || []).find((g) => g.name.toLowerCase() === target) || null;
}

function findConsultationForTeacher(teacherName) {
  if (!teacherName) return null;
  return (
    (state.data?.consultations || []).find(
      (c) => c.slots && c.slots.length > 0 && teacherNamesMatch(c.teacherName, teacherName)
    ) || null
  );
}

function renderDriveSlots() {
  const gInfo = getSelectedGroupInfo();
  const safeDrive = gInfo && gInfo.driveUrl ? safeHttpUrl(gInfo.driveUrl) : null;

  const schedSlot = document.getElementById("sched-drive-slot");
  const matSlot = document.getElementById("materials-drive-slot");

  if (!safeDrive || !gInfo) {
    if (schedSlot) schedSlot.innerHTML = "";
    if (matSlot) matSlot.innerHTML = "";
    return;
  }

  const cardHtml = `<a class="glass-card drive-banner" href="${escapeHtml(
    safeDrive
  )}" target="_blank" rel="noopener noreferrer">
    <div>
      <div class="drive-banner-title">Папка группы ${escapeHtml(gInfo.name)}</div>
      <div class="drive-banner-sub">${escapeHtml(
        gInfo.specialtyName
          ? `${gInfo.course} курс · ${gInfo.specialtyName}`
          : "Материалы вашей группы на Google Диске"
      )}</div>
    </div>
    <span class="drive-banner-badge">Диск ↗</span>
  </a>`;

  if (schedSlot) schedSlot.innerHTML = cardHtml;
  if (matSlot) matSlot.innerHTML = cardHtml;
}

function renderHeader() {
  const teacherMode = isTeacherRole();
  const targetName = getActiveTargetName();
  const grpEl = document.getElementById("hdr-group-label");
  if (grpEl) {
    if (teacherMode && targetName) {
      const surname = targetName.split(/\s+/)[0] || targetName;
      grpEl.textContent = surname;
    } else {
      grpEl.textContent = targetName || "Выбрать";
    }
  }

  const titleEl = document.getElementById("profile-card-title");
  if (titleEl) {
    titleEl.textContent = teacherMode ? "Преподаватель УРТК" : "Учебная группа УРТК";
  }

  const curEl = document.getElementById("settings-cur-group");
  if (curEl) {
    curEl.textContent = targetName || (teacherMode ? "Не выбран" : "Не выбрана");
  }

  document.querySelectorAll("[data-setrole]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-setrole") === state.settings.role);
  });

  const gSearch = document.getElementById("group-search");
  if (gSearch) {
    gSearch.placeholder = teacherMode
      ? "Поиск по фамилии преподавателя..."
      : "Найти группу (например, ИсР-101, Э-171)...";
  }

  const stEl = document.getElementById("hdr-status");
  if (stEl) {
    if (state.syncing) {
      stEl.textContent = "Синхронизация...";
    } else if (state.data?.lastSyncedAt) {
      stEl.textContent = `Обновлено в ${state.data.lastSyncedAt}`;
    } else {
      stEl.textContent = "УРТК им. А.С. Попова";
    }
  }

  const syncIcon = document.getElementById("ico-sync");
  if (syncIcon) syncIcon.classList.toggle("spinning", state.syncing);
}

function renderConsultations() {
  const weekEl = document.getElementById("consult-week");
  const listEl = document.getElementById("consult-list");
  if (!listEl) return;

  const raw = state.data?.consultations || [];
  const activeCount = raw.filter((c) => c.slots && c.slots.length > 0).length;
  if (weekEl) {
    weekEl.textContent = state.data?.consultationWeekRange
      ? `${state.data.consultationWeekRange} · активных: ${activeCount}`
      : "Загрузка графика консультаций...";
  }

  const q = state.teacherQuery.trim().toLowerCase();
  const items = raw
    .map((c) => ({ ...c, isPinned: isPinnedTeacher(c.teacherName) }))
    .filter((c) => {
      if (q && !c.teacherName.toLowerCase().includes(q)) return false;
      if (state.consultFilter === "mine") return c.isMyTeacher || c.isPinned;
      if (state.consultFilter === "active") return c.slots.length > 0;
      return true;
    })
    .sort((a, b) => {
      const score = (x) => {
        const aSlots = x.slots.length > 0;
        if (x.isPinned && aSlots) return 0;
        if (x.isPinned) return 1;
        if (x.isMyTeacher && aSlots) return 2;
        if (x.isMyTeacher) return 3;
        if (aSlots) return 4;
        return 5;
      };
      return score(a) - score(b) || a.teacherName.localeCompare(b.teacherName, "ru");
    });

  if (!items.length) {
    listEl.innerHTML = `<div class="glass-card empty-state">${
      state.consultFilter === "mine"
        ? "Пока нет преподавателей вашей группы или закреплённых. Выберите группу или переключитесь на «Есть слоты»."
        : "По вашему запросу консультаций не найдено."
    }</div>`;
    return;
  }

  listEl.innerHTML = items
    .map((item) => {
      const slotsHtml = item.slots.length
        ? `<div class="slot-list">${item.slots
            .map((s) => {
              const safeUrl = safeHttpUrl(s.location);
              const locEl = safeUrl
                ? `<a class="slot-loc online" href="${escapeHtml(
                    safeUrl
                  )}" target="_blank" rel="noopener noreferrer">Онлайн ↗</a>`
                : `<span class="slot-loc tabular">${escapeHtml(s.location || "Уточнить")}</span>`;
              return `<div class="slot-row">
                <div>
                  <div class="slot-day tabular">${escapeHtml(s.weekday)} · ${escapeHtml(s.date)}</div>
                  <div class="slot-time tabular">${escapeHtml(s.time)}</div>
                </div>
                ${locEl}
              </div>`;
            })
            .join("")}</div>`
        : "";

      return `<article class="glass-card consult-card ${item.isPinned ? "is-pinned" : ""}" data-consult-teacher="${escapeHtml(item.teacherName)}">
        <div class="cc-head">
          <div>
            <div class="cc-name">${escapeHtml(item.teacherName)}</div>
            <div class="cc-meta">
              ${item.isPinned ? '<span class="badge-amber">Закреплён</span>' : ""}
              ${item.isMyTeacher ? '<span class="badge-blue">Моя группа</span>' : ""}
              <span>${
                item.slots.length
                  ? `Слотов на неделе: ${Number(item.slots.length) || 0}`
                  : "Консультаций на неделе нет"
              }</span>
            </div>
          </div>
          <button type="button" class="pin-btn ${item.isPinned ? "pinned" : ""}" data-pin="${escapeHtml(
        item.teacherName
      )}" aria-label="${item.isPinned ? "Открепить" : "Закрепить вверху"}">
            <svg viewBox="0 0 24 24" fill="${item.isPinned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">
              <path d="M12 17v5M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16h14v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6a1 1 0 011-1h1V3H7v2h1a1 1 0 011 1z" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
        ${slotsHtml}
      </article>`;
    })
    .join("");

  listEl.querySelectorAll("[data-pin]").forEach((btn) => {
    btn.addEventListener("click", () => togglePinTeacher(btn.getAttribute("data-pin")));
  });
}

function getFilteredGroups() {
  const groups = state.data?.groups || [];
  const q = state.groupQuery.trim().toLowerCase();
  return groups.filter((g) => {
    if (state.courseFilter !== "all" && String(g.course) !== state.courseFilter) return false;
    if (!q) return true;
    return (
      g.name.toLowerCase().includes(q) ||
      (g.specialtyName || "").toLowerCase().includes(q) ||
      String(g.course).includes(q)
    );
  });
}

function getFilteredDirectoryTeachers() {
  const list = state.data?.teachers || [];
  const q = state.groupQuery.trim().toLowerCase();
  if (!q) return list;
  return list.filter((t) => (t.name || "").toLowerCase().includes(q));
}

function selectGroupByName(name) {
  if (!name) return;
  state.settings.role = "student";
  state.settings.selectedGroup = name;
  state.settings.extraGroups = (state.settings.extraGroups || []).filter(
    (g) => g.toLowerCase() !== name.toLowerCase()
  );
  state.scheduleViewKey = "primary";
  state.scheduleChanges = [];
  saveSettings();
  showToast(`Группа ${name} выбрана`);
  syncData();
  syncPushGroupIfSubscribed();
}

function selectTeacherProfile(name) {
  if (!name) return;
  state.settings.role = "teacher";
  state.settings.selectedTeacher = name;
  state.scheduleViewKey = "primary";
  state.scheduleChanges = [];
  saveSettings();
  showToast(`Преподаватель ${name} выбран`);
  syncData();
  syncPushGroupIfSubscribed();
}

function setProfileRole(role) {
  const next = role === "teacher" ? "teacher" : "student";
  if (state.settings.role === next) return;
  state.settings.role = next;
  state.groupQuery = "";
  const gSearch = document.getElementById("group-search");
  if (gSearch) gSearch.value = "";
  state.scheduleViewKey = "primary";
  state.scheduleChanges = [];
  saveSettings();
  renderAll();
  syncData();
  syncPushGroupIfSubscribed();
}

function toggleExtraGroup(groupName) {
  if (!groupName) return;
  if (groupName.toLowerCase() === (state.settings.selectedGroup || "").toLowerCase()) {
    showToast("Это ваша основная группа");
    return;
  }
  const cur = state.settings.extraGroups || [];
  const exists = cur.some((g) => g.toLowerCase() === groupName.toLowerCase());
  if (!exists && cur.length >= 5) {
    showToast("Максимум 5 дополнительных групп");
    return;
  }
  state.settings.extraGroups = exists
    ? cur.filter((g) => g.toLowerCase() !== groupName.toLowerCase())
    : [...cur, groupName];
  state.settings.multiGroupsEnabled = true;
  if (exists && state.scheduleViewKey.toLowerCase() === groupName.toLowerCase()) {
    state.scheduleViewKey = "primary";
  }
  saveSettings();
  showToast(exists ? `Группа ${groupName} убрана` : `Добавлена группа ${groupName}`);
  renderGroups();
  syncData();
}

function computeMobileDayComparison(dateStr, sources) {
  const dt = parseDateRu(dateStr);
  const bells = dt && dt.getDay() === 1
    ? state.data?.bellsMonday || []
    : state.data?.bellsRegular || [];
  const bellTimeByPair = new Map();
  for (const b of bells) {
    const s = (b.part1 || "").split(/[–-]/)[0]?.trim() || "";
    const e = (b.part2 || "").split(/[–-]/)[1]?.trim() || "";
    if (s && e) bellTimeByPair.set(b.pairNumber, { start: s, end: e });
  }

  let minPair = 99;
  let maxPair = 0;
  const lessonsByGroup = new Map();

  const finishes = sources.map((src) => {
    const day = (src.days || []).find((d) => d.date === dateStr);
    const lessons = day?.lessons || [];
    lessonsByGroup.set(src.name, lessons);
    let sMin = null, sStr = null, eMin = null, eStr = null;
    for (const l of lessons) {
      const p = Number(l.pairNumber) || 0;
      if (p > 0) {
        if (p < minPair) minPair = p;
        if (p > maxPair) maxPair = p;
      }
      const fb = bellTimeByPair.get(p);
      const st = l.timeStart || fb?.start || "";
      const et = l.timeEnd || fb?.end || "";
      const sm = parseMinutesStrict(st);
      const em = parseMinutesStrict(et);
      if (sm !== null && (sMin === null || sm < sMin)) { sMin = sm; sStr = st; }
      if (em !== null && (eMin === null || em > eMin)) { eMin = em; eStr = et; }
    }
    return { name: src.name, isPrimary: src.isPrimary, count: lessons.length, start: sStr, end: eStr };
  });

  if (maxPair === 0 || minPair === 99) {
    return { slots: [], commonFreePairs: [], allFreeAfter: null, finishes };
  }

  const slots = [];
  const commonFreePairs = [];
  for (let p = minPair; p <= maxPair; p++) {
    const entries = sources.map((src) => ({
      groupName: src.name,
      isPrimary: src.isPrimary,
      lessons: (lessonsByGroup.get(src.name) || []).filter((l) => Number(l.pairNumber) === p),
    }));
    const allFree = entries.every((e) => e.lessons.length === 0);
    if (allFree) commonFreePairs.push(p);
    const withTime = entries.flatMap((e) => e.lessons).find((l) => l.timeStart && l.timeEnd);
    const fb = bellTimeByPair.get(p);
    const timeRange = withTime
      ? `${withTime.timeStart}–${withTime.timeEnd}`
      : fb
      ? `${fb.start}–${fb.end}`
      : "";
    slots.push({ pairNumber: p, timeRange, allFree, entries });
  }

  let latestEnd = -1;
  let allFreeAfter = null;
  for (const f of finishes) {
    if (f.end) {
      const m = parseMinutesStrict(f.end);
      if (m !== null && m > latestEnd) {
        latestEnd = m;
        allFreeAfter = f.end;
      }
    }
  }
  return { slots, commonFreePairs, allFreeAfter, finishes };
}

function renderSchedule() {
  const titleEl = document.getElementById("sched-title");
  const subEl = document.getElementById("sched-sub");
  const multiBarEl = document.getElementById("multi-group-bar");
  const stripEl = document.getElementById("day-strip");
  const listEl = document.getElementById("lesson-list");
  if (!stripEl || !listEl) return;

  const teacherMode = isTeacherRole();
  const targetName = getActiveTargetName();
  const gInfo = getSelectedGroupInfo();
  const extras = getActiveExtraGroups();

  let viewKey = state.scheduleViewKey;
  if (teacherMode || !extras.length || (viewKey !== "primary" && viewKey !== "compare" && !extras.includes(viewKey))) {
    viewKey = "primary";
    state.scheduleViewKey = "primary";
  }

  if (titleEl) {
    if (viewKey === "compare") {
      titleEl.textContent = "Сравнение и окна";
    } else if (viewKey !== "primary") {
      titleEl.textContent = `Расписание · ${viewKey}`;
    } else {
      titleEl.textContent = targetName ? `Расписание · ${targetName}` : "Расписание";
    }
  }
  if (subEl) {
    if (teacherMode) {
      subEl.textContent = "Режим преподавателя · Академикс";
    } else if (viewKey === "compare") {
      subEl.textContent = `Общие окна и пары (${extras.length + 1} групп)`;
    } else if (viewKey !== "primary") {
      subEl.textContent = "Дополнительная группа · Академикс";
    } else {
      subEl.textContent =
        gInfo && gInfo.specialtyName
          ? `${gInfo.course} курс · ${gInfo.specialtyName}`
          : "Академикс · akademiks.urtt.ru";
    }
  }

  // Multi-group chips bar
  if (multiBarEl) {
    if (!teacherMode && targetName && extras.length) {
      multiBarEl.classList.remove("hidden");
      multiBarEl.innerHTML = [
        `<button type="button" class="multi-chip ${viewKey === "primary" ? "active" : ""}" data-mview="primary">Моя · ${escapeHtml(state.settings.selectedGroup)}</button>`,
        ...extras.map(
          (gn) =>
            `<button type="button" class="multi-chip ${viewKey === gn ? "active" : ""}" data-mview="${escapeHtml(gn)}">${escapeHtml(gn)}</button>`
        ),
        `<button type="button" class="multi-chip ${viewKey === "compare" ? "active" : ""}" data-mview="compare">Сравнение</button>`,
      ].join("");
      multiBarEl.querySelectorAll("[data-mview]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.scheduleViewKey = btn.getAttribute("data-mview") || "primary";
          state.selectedDayIdx = 0;
          renderSchedule();
        });
      });
    } else {
      multiBarEl.classList.add("hidden");
      multiBarEl.innerHTML = "";
    }
  }

  // Inline first-run picker when no group/teacher is chosen yet
  if (!targetName) {
    stripEl.innerHTML = "";
    const roleSegHtml = `<div class="segmented">
      <button type="button" class="seg-btn ${!teacherMode ? "active" : ""}" data-inline-role="student">Студент</button>
      <button type="button" class="seg-btn ${teacherMode ? "active" : ""}" data-inline-role="teacher">Преподаватель</button>
    </div>`;

    if (teacherMode) {
      const tList = getFilteredDirectoryTeachers();
      const tChips = tList.length
        ? tList
            .map(
              (t) =>
                `<button type="button" class="g-chip" data-inline-tname="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`
            )
            .join("")
        : '<div class="chips-loading">Преподаватели загружаются...</div>';

      listEl.innerHTML = `<div class="glass-card settings-card">
        <div class="sc-head"><span>Выберите преподавателя УРТК</span></div>
        ${roleSegHtml}
        <input type="search" id="inline-group-search" class="glass-input compact" placeholder="Поиск по фамилии преподавателя..." value="${escapeHtml(state.groupQuery)}" autocomplete="off" />
        <div class="group-chips">${tChips}</div>
      </div>`;
    } else {
      const filtered = getFilteredGroups();
      const chipsHtml = filtered.length
        ? filtered
            .slice(0, 80)
            .map(
              (g) =>
                `<button type="button" class="g-chip" data-inline-gname="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`
            )
            .join("")
        : '<div class="chips-loading">Группы загружаются...</div>';

      const courses = [["all", "Все"], ["1", "1 курс"], ["2", "2 курс"], ["3", "3 курс"], ["4", "4 курс"]];
      const courseBtns = courses
        .map(
          ([cid, lbl]) =>
            `<button type="button" class="g-chip ${state.courseFilter === cid ? "active" : ""}" data-inline-course="${cid}">${lbl}</button>`
        )
        .join("");

      listEl.innerHTML = `<div class="glass-card settings-card">
        <div class="sc-head"><span>Выберите вашу группу УРТК</span></div>
        ${roleSegHtml}
        <div class="course-pills">${courseBtns}</div>
        <input type="search" id="inline-group-search" class="glass-input compact" placeholder="Поиск группы (ИсР-101, Э-171)..." value="${escapeHtml(state.groupQuery)}" autocomplete="off" />
        <div class="group-chips">${chipsHtml}</div>
      </div>`;
    }

    const inp = document.getElementById("inline-group-search");
    if (inp) {
      inp.addEventListener("input", (e) => {
        state.groupQuery = e.target.value;
        renderSchedule();
        renderGroups();
        const nextInp = document.getElementById("inline-group-search");
        if (nextInp) {
          nextInp.focus();
          nextInp.setSelectionRange(nextInp.value.length, nextInp.value.length);
        }
      });
    }
    listEl.querySelectorAll("[data-inline-role]").forEach((btn) => {
      btn.addEventListener("click", () => setProfileRole(btn.getAttribute("data-inline-role")));
    });
    listEl.querySelectorAll("[data-inline-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.courseFilter = btn.getAttribute("data-inline-course");
        renderSchedule();
      });
    });
    listEl.querySelectorAll("[data-inline-gname]").forEach((btn) => {
      btn.addEventListener("click", () => selectGroupByName(btn.getAttribute("data-inline-gname")));
    });
    listEl.querySelectorAll("[data-inline-tname]").forEach((btn) => {
      btn.addEventListener("click", () => selectTeacherProfile(btn.getAttribute("data-inline-tname")));
    });
    renderBells();
    return;
  }

  // Compare & Common Windows Mode
  if (viewKey === "compare") {
    const sources = [
      { name: state.settings.selectedGroup, isPrimary: true, days: state.data?.schedule || [] },
      ...extras.map((gn) => ({
        name: gn,
        isPrimary: false,
        days: (state.data?.extraSchedules && state.data.extraSchedules[gn]) || [],
      })),
    ];

    const dateMap = new Map();
    for (const s of sources) {
      for (const d of s.days) {
        if (d.date && !dateMap.has(d.date)) dateMap.set(d.date, d.weekday);
      }
    }
    const compareDates = Array.from(dateMap.entries())
      .map(([date, weekday]) => ({ date, weekday }))
      .sort((a, b) => (parseDateRu(a.date)?.getTime() || 0) - (parseDateRu(b.date)?.getTime() || 0));

    if (!compareDates.length) {
      stripEl.innerHTML = "";
      listEl.innerHTML = '<div class="glass-card empty-state">Расписания для сравнения пока не загружены.</div>';
      renderBells();
      return;
    }

    if (!state.compareDate || !compareDates.some((d) => d.date === state.compareDate)) {
      const todayStr = formatDateRu(new Date());
      const hit = compareDates.find((d) => d.date === todayStr);
      state.compareDate = hit ? hit.date : compareDates[0].date;
    }

    stripEl.innerHTML = compareDates
      .map(
        (d) => `<button type="button" class="day-pill ${d.date === state.compareDate ? "active" : ""}" data-cmpdate="${escapeHtml(d.date)}">
          <div class="dp-wd">${escapeHtml(shortWeekday(d.weekday))}</div>
          <div class="dp-dt tabular">${escapeHtml(String(d.date || "").slice(0, 5))}</div>
        </button>`
      )
      .join("");

    stripEl.querySelectorAll("[data-cmpdate]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.compareDate = btn.getAttribute("data-cmpdate") || "";
        renderSchedule();
      });
    });

    const cmp = computeMobileDayComparison(state.compareDate, sources);
    const summaryTitle = cmp.commonFreePairs.length
      ? `Общие окна: ${cmp.commonFreePairs.map((p) => `${p} пара`).join(", ")}`
      : cmp.slots.length
      ? "Общих окон между парами нет"
      : "В этот день пар нет";

    const freeAfterHtml = cmp.allFreeAfter
      ? `<span class="badge-green tabular">Все свободны после ${escapeHtml(cmp.allFreeAfter)}</span>`
      : "";

    const finishesHtml = cmp.finishes
      .map(
        (f) => `<span class="compare-fin-pill tabular"><strong>${escapeHtml(f.name)}</strong>: ${
          f.count > 0 ? `${f.count} пар (${escapeHtml(f.start || "")}–${escapeHtml(f.end || "")})` : "пар нет"
        }</span>`
      )
      .join("");

    const summaryCard = `<div class="glass-card compare-summary">
      <div class="compare-sum-top"><span>${escapeHtml(summaryTitle)}</span>${freeAfterHtml}</div>
      <div class="compare-finishes">${finishesHtml}</div>
    </div>`;

    const slotCards = cmp.slots
      .map((slot) => {
        const rows = slot.entries
          .map((e) => {
            const free = !e.lessons.length;
            const subj = free
              ? '<span class="compare-free">Свободно (окно)</span>'
              : `<span class="compare-subj">${escapeHtml(e.lessons.map((l) => l.subject).join(" / "))}</span>`;
            const room = free
              ? ""
              : `<span class="compare-room tabular">${escapeHtml(
                  e.lessons
                    .map((l) => l.room || "—")
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .join(", ")
                )}</span>`;
            return `<div class="compare-row">
              <div class="compare-row-left">
                <span class="compare-grp ${e.isPrimary ? "is-primary" : ""}">${escapeHtml(e.groupName)}</span>
                ${subj}
              </div>
              ${room}
            </div>`;
          })
          .join("");

        return `<article class="glass-card compare-card ${slot.allFree ? "is-all-free" : ""}">
          <div class="compare-head">
            <div class="compare-head-left">
              <span class="${slot.allFree ? "badge-green" : "badge-blue"} tabular">${slot.pairNumber} пара</span>
              <span class="compare-time tabular">${escapeHtml(slot.timeRange)}</span>
            </div>
            ${slot.allFree ? '<span class="badge-green">Общее окно</span>' : ""}
          </div>
          <div class="compare-rows">${rows}</div>
        </article>`;
      })
      .join("");

    listEl.innerHTML = summaryCard + slotCards;
    renderBells();
    return;
  }

  const days =
    viewKey === "primary"
      ? state.data?.schedule || []
      : (state.data?.extraSchedules && state.data.extraSchedules[viewKey]) || [];

  if (!days.length) {
    stripEl.innerHTML = "";
    listEl.innerHTML = `<div class="glass-card empty-state">Расписание для ${
      viewKey !== "primary"
        ? `группы ${escapeHtml(viewKey)}`
        : teacherMode
        ? `преподавателя ${escapeHtml(targetName)}`
        : `группы ${escapeHtml(targetName)}`
    } пока не опубликовано.</div>`;
  } else {
    if (state.selectedDayIdx >= days.length) state.selectedDayIdx = 0;
    stripEl.innerHTML = days
      .map(
        (d, idx) => `<button type="button" class="day-pill ${
          idx === state.selectedDayIdx ? "active" : ""
        }" data-dayidx="${idx}">
          <div class="dp-wd">${escapeHtml(shortWeekday(d.weekday))}</div>
          <div class="dp-dt tabular">${escapeHtml(String(d.date || "").slice(0, 5))}</div>
        </button>`
      )
      .join("");

    stripEl.querySelectorAll("[data-dayidx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedDayIdx = Number(btn.getAttribute("data-dayidx")) || 0;
        renderSchedule();
      });
    });

    const activeDay = days[state.selectedDayIdx];
    const isToday = viewKey === "primary" && activeDay && activeDay.date === formatDateRu(new Date());
    const lessons = activeDay?.lessons || [];

    listEl.innerHTML = lessons
      .map((l) => {
        const pairNum = Number(l.pairNumber) || 0;
        const isRunning = isToday && state.bellStatus.activePairNumber === pairNum;
        const isNext = isToday && !isRunning && state.bellStatus.nextPairNumber === pairNum;
        const consult = !teacherMode ? findConsultationForTeacher(l.teacher) : null;
        const groupPillHtml =
          teacherMode && l.groupName
            ? `<span class="lesson-badges"><span class="badge-blue">${escapeHtml(l.groupName)}</span></span>`
            : "";
        const badgeHtml = isRunning
          ? '<span class="lesson-badges"><span class="badge-green">Идёт сейчас</span></span>'
          : isNext
          ? '<span class="lesson-badges"><span class="badge-blue">Следующая</span></span>'
          : "";
        const consultBtnHtml = consult
          ? `<button type="button" class="lesson-consult-ico" data-jump-teacher="${escapeHtml(
              l.teacher
            )}" aria-label="Консультация преподавателя" title="Консультация (${
              Number(consult.slots.length) || 0
            })"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
          : "";

        return `<article class="glass-card lesson-card ${
          isRunning ? "is-running" : isNext ? "is-next" : ""
        }">
          <div class="pair-box tabular ${isRunning ? "is-running" : ""}">
            <span class="pair-num">${pairNum}</span>
            <span class="pair-lbl">пара</span>
          </div>
          <div class="lesson-body">
            <div class="lesson-subj">${escapeHtml(l.subject)}${groupPillHtml}${badgeHtml}</div>
            <div class="lesson-meta tabular">${escapeHtml(l.timeStart)}–${escapeHtml(l.timeEnd)}${
          !teacherMode && l.teacher ? ` · ${escapeHtml(l.teacher)}` : ""
        }</div>
          </div>
          <div class="lesson-right">
            ${consultBtnHtml}
            <span class="lesson-room tabular">${escapeHtml(l.room || "—")}</span>
          </div>
        </article>`;
      })
      .join("");

    listEl.querySelectorAll("[data-jump-teacher]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = String(btn.getAttribute("data-jump-teacher") || "").trim();
        const consult = findConsultationForTeacher(t);
        const targetName = consult ? consult.teacherName : t;
        const isInMine = Boolean(
          consult && (consult.isMyTeacher || isPinnedTeacher(consult.teacherName))
        );

        state.teacherQuery = "";
        state.consultFilter = isInMine ? "mine" : "active";
        const searchInput = document.getElementById("teacher-search");
        if (searchInput) searchInput.value = "";
        document.querySelectorAll("[data-cfilter]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-cfilter") === state.consultFilter);
        });
        renderConsultations();
        setTab("consultations");

        clearTimeout(window._urtkJumpScrollTimer);
        clearTimeout(window._urtkJumpFlashTimer);
        window._urtkJumpScrollTimer = setTimeout(() => {
          const cards = document.querySelectorAll("#consult-list [data-consult-teacher]");
          let targetCard = null;
          cards.forEach((el) => {
            if (!targetCard && teacherNamesMatch(el.getAttribute("data-consult-teacher") || "", targetName)) {
              targetCard = el;
            }
          });
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
            window._urtkJumpFlashTimer = setTimeout(() => {
              targetCard.classList.remove("consult-flash-once");
              void targetCard.offsetWidth;
              targetCard.classList.add("consult-flash-once");
              targetCard.addEventListener(
                "animationend",
                () => targetCard.classList.remove("consult-flash-once"),
                { once: true }
              );
            }, 360);
          }
        }, 200);
      });
    });
  }

  renderBells();
}

function renderBells() {
  const rowsEl = document.getElementById("bells-rows");
  if (!rowsEl) return;
  const list =
    state.bellMode === "monday"
      ? state.data?.bellsMonday || []
      : state.data?.bellsRegular || [];
  rowsEl.innerHTML = list
    .map(
      (b) => `<div class="bell-r">
        <span>${Number(b.pairNumber) || 0} пара</span>
        <span>${escapeHtml(b.part1)} · ${escapeHtml(b.part2)}</span>
      </div>`
    )
    .join("");
  document.querySelectorAll("[data-bellmode]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-bellmode") === state.bellMode);
  });
}

function renderGroups() {
  const chipsEl = document.getElementById("group-chips");
  const teacherMode = isTeacherRole();

  if (chipsEl) {
    if (teacherMode) {
      const list = getFilteredDirectoryTeachers();
      if (!list.length) {
        chipsEl.innerHTML = '<div class="chips-loading">Преподаватели загружаются...</div>';
      } else {
        chipsEl.innerHTML = list
          .map(
            (t) => `<button type="button" class="g-chip ${
              t.name.toLowerCase() === (state.settings.selectedTeacher || "").toLowerCase()
                ? "active"
                : ""
            }" data-tname="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`
          )
          .join("");
        chipsEl.querySelectorAll("[data-tname]").forEach((btn) => {
          btn.addEventListener("click", () => selectTeacherProfile(btn.getAttribute("data-tname")));
        });
      }
    } else {
      const filtered = getFilteredGroups();
      if (!filtered.length) {
        chipsEl.innerHTML = '<div class="chips-loading">Группы загружаются...</div>';
      } else {
        chipsEl.innerHTML = filtered
          .slice(0, 80)
          .map(
            (g) => `<button type="button" class="g-chip ${
              g.name === state.settings.selectedGroup ? "active" : ""
            }" data-gname="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`
          )
          .join("");
        chipsEl.querySelectorAll("[data-gname]").forEach((btn) => {
          btn.addEventListener("click", () => selectGroupByName(btn.getAttribute("data-gname")));
        });
      }
    }
  }

  // Extra Groups (Multi-groups) card in Settings (student mode only)
  const extraCard = document.getElementById("extra-groups-card");
  if (extraCard) {
    extraCard.classList.toggle("hidden", teacherMode);
  }
  const toggleBtn = document.getElementById("btn-multi-toggle");
  const extraBody = document.getElementById("extra-groups-body");
  const countPill = document.getElementById("extra-groups-count");
  const enabled = Boolean(state.settings.multiGroupsEnabled);
  const pickedList = (state.settings.extraGroups || []).filter(
    (g) => g.toLowerCase() !== (state.settings.selectedGroup || "").toLowerCase()
  );

  if (toggleBtn) toggleBtn.setAttribute("aria-checked", enabled ? "true" : "false");
  if (extraBody) extraBody.classList.toggle("hidden", !enabled);
  if (countPill) {
    countPill.textContent = `${pickedList.length} / 5`;
    countPill.classList.toggle("hidden", !enabled || !pickedList.length);
  }

  if (enabled && !teacherMode) {
    const selEl = document.getElementById("extra-selected-chips");
    if (selEl) {
      selEl.innerHTML = pickedList
        .map(
          (gn) =>
            `<button type="button" class="g-chip active" data-xremove="${escapeHtml(gn)}">${escapeHtml(gn)} ×</button>`
        )
        .join("");
      selEl.querySelectorAll("[data-xremove]").forEach((btn) => {
        btn.addEventListener("click", () => toggleExtraGroup(btn.getAttribute("data-xremove")));
      });
    }

    const extraChipsEl = document.getElementById("extra-group-chips");
    if (extraChipsEl) {
      const q = (state.extraGroupQuery || "").trim().toLowerCase();
      const primaryLow = (state.settings.selectedGroup || "").toLowerCase();
      const candidates = (state.data?.groups || []).filter((g) => {
        if (g.name.toLowerCase() === primaryLow) return false;
        if (!q) return true;
        return g.name.toLowerCase().includes(q) || (g.specialtyName || "").toLowerCase().includes(q);
      });
      extraChipsEl.innerHTML = candidates
        .slice(0, 80)
        .map((g) => {
          const isPicked = pickedList.some((x) => x.toLowerCase() === g.name.toLowerCase());
          return `<button type="button" class="g-chip ${isPicked ? "active" : ""}" data-xtoggle="${escapeHtml(g.name)}">${escapeHtml(g.name)}</button>`;
        })
        .join("");
      extraChipsEl.querySelectorAll("[data-xtoggle]").forEach((btn) => {
        btn.addEventListener("click", () => toggleExtraGroup(btn.getAttribute("data-xtoggle")));
      });
    }
  }
}

function diffSchedules(prevDays, nextDays) {
  if (!Array.isArray(prevDays) || !prevDays.length || !Array.isArray(nextDays) || !nextDays.length) {
    return [];
  }
  const normDay = (d) =>
    (d.lessons || [])
      .map((l) => ({
        pair: Number(l.pairNumber) || 0,
        subject: String(l.subject || "").trim(),
        teacher: String(l.teacher || "").trim(),
        group: String(l.groupName || "").trim(),
        room: String(l.room || "").trim(),
        time: String(l.timeStart || "").trim(),
      }))
      .sort((a, b) => a.pair - b.pair || a.subject.localeCompare(b.subject));

  const prevMap = new Map(prevDays.map((d) => [d.date, normDay(d)]));
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const changes = [];

  for (const nd of nextDays) {
    const dt = parseDateRu(nd.date);
    if (dt && dt.getTime() < todayStart.getTime()) continue;
    const prevLessons = prevMap.get(nd.date);
    const nextLessons = normDay(nd);
    const shortDate = String(nd.date || "").slice(0, 5);
    if (!prevLessons) {
      if (nextLessons.length) {
        changes.push(`${shortDate}: появилось расписание (${nextLessons.length} пар)`);
      }
      continue;
    }
    if (JSON.stringify(prevLessons) !== JSON.stringify(nextLessons)) {
      if (prevLessons.length !== nextLessons.length) {
        const delta = nextLessons.length - prevLessons.length;
        changes.push(`${shortDate}: изменились пары (${delta > 0 ? "+" + delta : delta})`);
      } else {
        let detail = null;
        for (let i = 0; i < nextLessons.length; i++) {
          const pl = prevLessons[i];
          const nl = nextLessons[i];
          if (!pl) continue;
          if (pl.room !== nl.room && pl.subject === nl.subject) {
            detail = `${shortDate}: ${nl.pair} пара — ауд. ${pl.room || "—"} → ${nl.room || "—"}`;
            break;
          }
          if (pl.subject !== nl.subject || pl.teacher !== nl.teacher) {
            detail = `${shortDate}: замена на ${nl.pair} паре (${nl.subject})`;
            break;
          }
        }
        changes.push(detail || `${shortDate}: обновились пары/аудитории`);
      }
    }
  }
  return changes;
}

function renderScheduleDiff() {
  const slot = document.getElementById("sched-diff-slot");
  if (!slot) return;
  const changes = state.scheduleChanges || [];
  if (!changes.length) {
    slot.innerHTML = "";
    return;
  }
  slot.innerHTML = `<div class="glass-card diff-banner">
    <div>
      <div class="diff-title">Расписание изменилось</div>
      <div class="diff-items">${changes.map((c) => escapeHtml(c)).join("<br/>")}</div>
    </div>
    <button type="button" class="diff-close" id="btn-diff-close" aria-label="Скрыть">×</button>
  </div>`;
  document.getElementById("btn-diff-close")?.addEventListener("click", () => {
    state.scheduleChanges = [];
    renderScheduleDiff();
  });
}

function renderAll() {
  renderHeader();
  state.bellStatus = computeBellStatus(new Date());
  updateBellBar();
  renderScheduleDiff();
  renderDriveSlots();
  renderConsultations();
  renderSchedule();
  renderGroups();
}

async function syncData() {
  state.syncing = true;
  renderHeader();
  const errBox = document.getElementById("error-box");
  if (errBox) errBox.classList.add("hidden");

  const prevData = state.data;

  try {
    const params = new URLSearchParams();
    if (isTeacherRole()) {
      if (state.settings.selectedTeacher) {
        params.set("teacher", state.settings.selectedTeacher);
      }
    } else {
      if (state.settings.selectedGroup) {
        params.set("group", state.settings.selectedGroup);
      }
      const extras = getActiveExtraGroups();
      if (extras.length) {
        params.set("extras", extras.join(","));
      }
    }
    const qs = params.toString();
    const resp = await fetch(`/app/api.php${qs ? "?" + qs : ""}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (!payload.ok) throw new Error(payload.error || "Ошибка API");

    const prevTarget = prevData?.selectedTeacher || prevData?.selectedGroup || "";
    const nextTarget = payload.selectedTeacher || payload.selectedGroup || "";
    if (prevTarget && nextTarget && prevTarget.toLowerCase() === nextTarget.toLowerCase()) {
      const changes = diffSchedules(prevData.schedule, payload.schedule);
      if (changes.length) {
        state.scheduleChanges = changes;
        showToast("Расписание обновилось!");
      }
    }

    state.data = payload;
    saveCache(payload);
    state.selectedDayIdx = pickUpcomingDayIdx(payload.schedule);

    if (
      (payload.groupTeachers?.length || state.settings.pinnedTeachers.length) &&
      state.consultFilter === "active"
    ) {
      state.consultFilter = "mine";
      document.querySelectorAll("[data-cfilter]").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-cfilter") === state.consultFilter);
      });
    }
  } catch (e) {
    if (errBox) {
      errBox.textContent = state.data
        ? `Офлайн-режим (показан кэш): ${e.message}`
        : `Не удалось загрузить данные: ${e.message}`;
      errBox.classList.remove("hidden");
    }
  } finally {
    state.syncing = false;
    renderAll();
  }
}

function initInstallBanner() {
  const banner = document.getElementById("ios-install-banner");
  if (!banner || state.settings.hideInstallBanner) return;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  if (!isStandalone) {
    banner.classList.remove("hidden");
  }
  const closeBtn = document.getElementById("ib-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      banner.classList.add("hidden");
      state.settings.hideInstallBanner = true;
      saveSettings();
    });
  }
}

// Event bindings
document.querySelectorAll(".tab-item").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.getAttribute("data-tab")));
});

document.getElementById("btn-group-pill")?.addEventListener("click", () => setTab("settings"));
document.getElementById("btn-sync")?.addEventListener("click", () => syncData());
document.getElementById("btn-theme")?.addEventListener("click", () => {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  saveSettings();
  applyTheme();
});

document.querySelectorAll("[data-settheme]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.settings.theme = btn.getAttribute("data-settheme");
    saveSettings();
    applyTheme();
  });
});

document.querySelectorAll("[data-cfilter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.consultFilter = btn.getAttribute("data-cfilter");
    document.querySelectorAll("[data-cfilter]").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    renderConsultations();
  });
});

document.querySelectorAll("[data-bellmode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.bellMode = btn.getAttribute("data-bellmode");
    renderBells();
  });
});

document.getElementById("teacher-search")?.addEventListener("input", (e) => {
  state.teacherQuery = e.target.value;
  renderConsultations();
});

document.querySelectorAll("[data-setrole]").forEach((btn) => {
  btn.addEventListener("click", () => {
    setProfileRole(btn.getAttribute("data-setrole"));
  });
});

document.getElementById("btn-multi-toggle")?.addEventListener("click", () => {
  state.settings.multiGroupsEnabled = !state.settings.multiGroupsEnabled;
  if (!state.settings.multiGroupsEnabled) {
    state.scheduleViewKey = "primary";
  }
  saveSettings();
  renderAll();
  if (state.settings.multiGroupsEnabled && getActiveExtraGroups().length) {
    syncData();
  }
});

document.getElementById("extra-group-search")?.addEventListener("input", (e) => {
  state.extraGroupQuery = e.target.value;
  renderGroups();
});

document.getElementById("group-search")?.addEventListener("input", (e) => {
  state.groupQuery = e.target.value;
  renderGroups();
});

// --- Web Push Notifications (iOS 16.4+ Standalone PWA & Android) ---
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneMode() {
  return window.navigator.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
}

async function getPushRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration("/app/");
    return reg || (await navigator.serviceWorker.ready);
  } catch {
    return null;
  }
}

async function refreshPushUi() {
  const pill = document.getElementById("push-status-pill");
  const note = document.getElementById("push-note");
  const toggleBtn = document.getElementById("btn-push-toggle");
  const testBtn = document.getElementById("btn-push-test");
  if (!pill || !toggleBtn) return;

  pill.classList.remove("is-on", "is-warn");

  if (isIosDevice() && !isStandaloneMode()) {
    pill.textContent = "Нужна установка";
    pill.classList.add("is-warn");
    if (note) {
      note.textContent =
        "На iPhone пуш-уведомления работают только в приложении с экрана «Домой»: нажмите «Поделиться» → «На экран „Домой“».";
    }
    toggleBtn.textContent = "Установите на экран «Домой»";
    toggleBtn.disabled = true;
    testBtn?.classList.add("hidden");
    return;
  }

  if (!("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)) {
    pill.textContent = "Недоступно";
    toggleBtn.textContent = "Браузер не поддерживает Push";
    toggleBtn.disabled = true;
    testBtn?.classList.add("hidden");
    return;
  }

  if (Notification.permission === "denied") {
    pill.textContent = "Запрещены";
    pill.classList.add("is-warn");
    if (note) {
      note.textContent =
        "Уведомления отключены в системных настройках телефона. Разрешите их для URTK Flow и перезапустите приложение.";
    }
    toggleBtn.textContent = "Доступ запрещён";
    toggleBtn.disabled = true;
    testBtn?.classList.add("hidden");
    return;
  }

  const reg = await getPushRegistration();
  const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  toggleBtn.disabled = false;

  const targetName = getActiveTargetName();
  if (sub) {
    pill.textContent = "Включены";
    pill.classList.add("is-on");
    if (note) {
      note.textContent = targetName
        ? `Отслеживается расписание ${isTeacherRole() ? "преподавателя" : "группы"} ${targetName} (проверка каждые 15 мин).`
        : "Выберите группу или преподавателя выше, чтобы получать уведомления о заменах.";
    }
    toggleBtn.textContent = "Отключить уведомления";
    toggleBtn.classList.remove("push-btn-primary");
    testBtn?.classList.remove("hidden");
  } else {
    pill.textContent = "Выключены";
    if (note) {
      note.textContent =
        "Присылать пуш-уведомление на телефон, если в «Академиксе» появятся замены, отменятся пары или сменится аудитория.";
    }
    toggleBtn.textContent = "Включить уведомления";
    toggleBtn.classList.add("push-btn-primary");
    testBtn?.classList.add("hidden");
  }
}

async function syncPushGroupIfSubscribed() {
  const targetName = getActiveTargetName();
  if (!targetName || !("PushManager" in window)) return;
  try {
    const reg = await getPushRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) return;
    await fetch("/app/push.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "subscribe",
        role: state.settings.role,
        group: state.settings.selectedGroup,
        teacher: state.settings.selectedTeacher,
        subscription: sub.toJSON(),
      }),
    });
    refreshPushUi();
  } catch {}
}

async function togglePushSubscription() {
  const toggleBtn = document.getElementById("btn-push-toggle");
  if (!toggleBtn) return;
  toggleBtn.disabled = true;

  try {
    const reg = await getPushRegistration();
    if (!reg) throw new Error("Service Worker ещё не готов");
    const existing = await reg.pushManager.getSubscription();

    if (existing) {
      await fetch("/app/push.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unsubscribe", endpoint: existing.endpoint }),
      }).catch(() => {});
      await existing.unsubscribe();
      showToast("Уведомления отключены");
      return;
    }

    const targetName = getActiveTargetName();
    if (!targetName) {
      showToast(
        isTeacherRole()
          ? "Сначала выберите преподавателя выше"
          : "Сначала выберите учебную группу выше"
      );
      return;
    }

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      showToast("Нужно разрешить уведомления");
      return;
    }

    const vapidResp = await fetch("/app/push.php?action=vapid", { cache: "no-store" });
    const vapidJson = await vapidResp.json();
    if (!vapidResp.ok || !vapidJson.ok || !vapidJson.publicKey) {
      throw new Error("Не удалось получить ключ сервера");
    }

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidJson.publicKey),
    });

    const saveResp = await fetch("/app/push.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "subscribe",
        role: state.settings.role,
        group: state.settings.selectedGroup,
        teacher: state.settings.selectedTeacher,
        subscription: sub.toJSON(),
      }),
    });
    const saveJson = await saveResp.json();
    if (!saveResp.ok || !saveJson.ok) {
      await sub.unsubscribe().catch(() => {});
      throw new Error(saveJson.error || "Ошибка сохранения подписки");
    }

    showToast(`Уведомления для ${targetName} включены`);
  } catch (e) {
    showToast(e.message || "Не удалось настроить уведомления");
  } finally {
    await refreshPushUi();
  }
}

async function sendTestPush() {
  const testBtn = document.getElementById("btn-push-test");
  if (!testBtn) return;
  testBtn.disabled = true;
  try {
    const reg = await getPushRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (!sub) {
      showToast("Сначала включите уведомления");
      return;
    }
    const resp = await fetch("/app/push.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", subscription: sub.toJSON() }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || "Ошибка отправки");
    }
    showToast("Тестовое уведомление отправлено");
  } catch (e) {
    showToast(e.message || "Не удалось отправить тест");
  } finally {
    testBtn.disabled = false;
  }
}

document.getElementById("btn-push-toggle")?.addEventListener("click", togglePushSubscription);
document.getElementById("btn-push-test")?.addEventListener("click", sendTestPush);

// Register Service Worker for offline PWA support & Web Push
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/app/sw.js", { scope: "/app/", updateViaCache: "none" })
      .then((reg) => {
        reg.update().catch(() => {});
        refreshPushUi();
      })
      .catch(() => {});
  });
}

// Boot
applyTheme();
initInstallBanner();
refreshPushUi();
if (getActiveTargetName() || state.settings.pinnedTeachers.length) {
  state.consultFilter = "mine";
  document.querySelectorAll("[data-cfilter]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-cfilter") === "mine");
  });
}
renderAll();
syncData();
setInterval(updateBellBar, 20000);
