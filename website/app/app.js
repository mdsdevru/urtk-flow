const STORAGE_SETTINGS = "urtk_flow_pwa_settings_v1";
const STORAGE_CACHE = "urtk_flow_pwa_cache_v1";

const state = {
  settings: loadSettings(),
  data: loadCache(),
  tab: "schedule",
  consultFilter: "active",
  teacherQuery: "",
  groupQuery: "",
  courseFilter: "all",
  selectedDayIdx: 0,
  bellMode: new Date().getDay() === 1 ? "monday" : "regular",
  syncing: false,
  bellStatus: { text: "—", active: false, activePairNumber: null, nextPairNumber: null },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (raw) {
      return Object.assign(
        { theme: "dark", selectedGroup: "", pinnedTeachers: [], hideInstallBanner: false },
        JSON.parse(raw)
      );
    }
  } catch {}
  return { theme: "dark", selectedGroup: "", pinnedTeachers: [], hideInstallBanner: false };
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
    Boolean(state.settings.selectedGroup) &&
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

function setTab(tabId) {
  state.tab = tabId;
  document.querySelectorAll(".tab-view").forEach((v) => {
    v.classList.toggle("active", v.getAttribute("data-view") === tabId);
  });
  document.querySelectorAll(".tab-item").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
  });
  const mainEl = document.getElementById("ios-main");
  if (mainEl) mainEl.scrollTop = 0;
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
  if (!state.settings.selectedGroup) return null;
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
  const grp = state.settings.selectedGroup || "Выбрать";
  const grpEl = document.getElementById("hdr-group-label");
  if (grpEl) grpEl.textContent = grp;

  const curEl = document.getElementById("settings-cur-group");
  if (curEl) curEl.textContent = state.settings.selectedGroup || "Не выбрана";

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

      return `<article class="glass-card consult-card ${item.isPinned ? "is-pinned" : ""}">
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

function selectGroupByName(name) {
  if (!name) return;
  state.settings.selectedGroup = name;
  saveSettings();
  showToast(`Группа ${name} выбрана`);
  syncData();
}

function renderSchedule() {
  const titleEl = document.getElementById("sched-title");
  const subEl = document.getElementById("sched-sub");
  const gInfo = getSelectedGroupInfo();

  if (titleEl) {
    titleEl.textContent = state.settings.selectedGroup
      ? `Расписание · ${state.settings.selectedGroup}`
      : "Расписание";
  }
  if (subEl) {
    subEl.textContent =
      gInfo && gInfo.specialtyName
        ? `${gInfo.course} курс · ${gInfo.specialtyName}`
        : "Академикс · akademiks.urtt.ru";
  }

  const stripEl = document.getElementById("day-strip");
  const listEl = document.getElementById("lesson-list");
  if (!stripEl || !listEl) return;

  // Inline first-run group picker right inside Schedule tab when no group is chosen yet
  if (!state.settings.selectedGroup) {
    stripEl.innerHTML = "";
    const filtered = getFilteredGroups();
    const chipsHtml = filtered.length
      ? filtered
          .slice(0, 80)
          .map(
            (g) =>
              `<button type="button" class="g-chip" data-inline-gname="${escapeHtml(
                g.name
              )}">${escapeHtml(g.name)}</button>`
          )
          .join("")
      : '<div class="chips-loading">Группы загружаются...</div>';

    const courses = [
      ["all", "Все"],
      ["1", "1 курс"],
      ["2", "2 курс"],
      ["3", "3 курс"],
      ["4", "4 курс"],
    ];
    const courseBtns = courses
      .map(
        ([cid, lbl]) =>
          `<button type="button" class="g-chip ${
            state.courseFilter === cid ? "active" : ""
          }" data-inline-course="${cid}">${lbl}</button>`
      )
      .join("");

    listEl.innerHTML = `<div class="glass-card settings-card">
      <div class="sc-head">
        <span>Выберите вашу группу УРТК</span>
      </div>
      <div class="course-pills">${courseBtns}</div>
      <input
        type="search"
        id="inline-group-search"
        class="glass-input compact"
        placeholder="Поиск группы (ИсР-101, Би-131)..."
        value="${escapeHtml(state.groupQuery)}"
        autocomplete="off"
      />
      <div class="group-chips">${chipsHtml}</div>
    </div>`;

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
    listEl.querySelectorAll("[data-inline-course]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.courseFilter = btn.getAttribute("data-inline-course");
        renderSchedule();
      });
    });
    listEl.querySelectorAll("[data-inline-gname]").forEach((btn) => {
      btn.addEventListener("click", () => selectGroupByName(btn.getAttribute("data-inline-gname")));
    });
    renderBells();
    return;
  }

  const days = state.data?.schedule || [];
  if (!days.length) {
    stripEl.innerHTML = "";
    listEl.innerHTML = `<div class="glass-card empty-state">Расписание для группы ${escapeHtml(
      state.settings.selectedGroup
    )} пока не опубликовано.</div>`;
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
    const isToday = activeDay && activeDay.date === formatDateRu(new Date());
    const lessons = activeDay?.lessons || [];

    listEl.innerHTML = lessons
      .map((l) => {
        const pairNum = Number(l.pairNumber) || 0;
        const isRunning = isToday && state.bellStatus.activePairNumber === pairNum;
        const isNext = isToday && !isRunning && state.bellStatus.nextPairNumber === pairNum;
        const consult = findConsultationForTeacher(l.teacher);
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
            <div class="lesson-subj">${escapeHtml(l.subject)}${badgeHtml}</div>
            <div class="lesson-meta tabular">${escapeHtml(l.timeStart)}–${escapeHtml(l.timeEnd)}${
          l.teacher ? ` · ${escapeHtml(l.teacher)}` : ""
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
        const surname = t.split(/\s+/)[0] || t;
        state.teacherQuery = surname;
        state.consultFilter = "all";
        const searchInput = document.getElementById("teacher-search");
        if (searchInput) searchInput.value = surname;
        document.querySelectorAll("[data-cfilter]").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-cfilter") === "all");
        });
        renderConsultations();
        setTab("consultations");
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
  if (!chipsEl) return;
  const filtered = getFilteredGroups();

  if (!filtered.length) {
    chipsEl.innerHTML = '<div class="chips-loading">Группы загружаются...</div>';
    return;
  }

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

function renderAll() {
  renderHeader();
  state.bellStatus = computeBellStatus(new Date());
  updateBellBar();
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

  try {
    const q = state.settings.selectedGroup
      ? `?group=${encodeURIComponent(state.settings.selectedGroup)}`
      : "";
    const resp = await fetch(`/app/api.php${q}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    if (!payload.ok) throw new Error(payload.error || "Ошибка API");

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

document.getElementById("group-search")?.addEventListener("input", (e) => {
  state.groupQuery = e.target.value;
  renderGroups();
});

// Register Service Worker for offline PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
  });
}

// Boot
applyTheme();
initInstallBanner();
if (state.settings.selectedGroup || state.settings.pinnedTeachers.length) {
  state.consultFilter = "mine";
  document.querySelectorAll("[data-cfilter]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-cfilter") === "mine");
  });
}
renderAll();
syncData();
setInterval(updateBellBar, 20000);
