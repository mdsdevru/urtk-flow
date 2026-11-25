import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowDownCircle,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  Clock,
  ExternalLink,
  FolderOpen,
  LayoutGrid,
  MessageSquareText,
  Pin,
  Power,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Titlebar } from "./components/Titlebar";
import { WidgetView } from "./components/WidgetView";
import {
  AppSettings,
  GroupInfo,
  SyncPayload,
  TeacherConsultations,
  UpdateCheckResult,
  UpdateProgress,
} from "./types";
import {
  computeBellStatus,
  formatDateRu,
  pickUpcomingDayIdx,
  teacherNamesMatch,
} from "./utils/schedule";

type TabId = "schedule" | "consultations" | "materials" | "widget" | "settings";

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  selectedGroup: "",
  pinnedTeachers: [],
  hiddenTeachers: [],
  syncIntervalMinutes: 30,
  notifications: {
    enabled: true,
    morningSummary: true,
    morningTime: "07:30",
    onNewConsultation: true,
    onScheduleChange: true,
  },
  widget: {
    enabled: false,
    showTomorrowSchedule: true,
    showWeekSchedule: false,
    showConsultations: true,
    showBellTimer: true,
    opacity: 0.72,
    pinToDesktop: true,
    width: 350,
    height: 450,
    x: null,
    y: null,
  },
  autostart: false,
  startMinimizedOnBoot: true,
  autoUpdateCheck: true,
  updateEndpoint: "https://update.flow.mdsdev.ru/latest.json",
};

function safeOpenExternal(url: string) {
  invoke("open_external_url", { url }).catch(() => {});
}

function isSafeHttpsUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "https:" && !u.username && !u.password;
  } catch {
    return false;
  }
}

export default function App() {
  const isWidgetWindow =
    window.location.hash === "#widget" ||
    getCurrentWindow().label.startsWith("widget-");

  if (isWidgetWindow) {
    return <WidgetView />;
  }

  return <MainApp />;
}

function GlassSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-checked={checked ? "true" : "false"}
      onClick={() => onChange(!checked)}
      className="lg-switch"
    >
      <span className="lg-switch-thumb" />
    </button>
  );
}

function MainApp() {
  const [tab, setTab] = useState<TabId>("schedule");
  const [data, setData] = useState<SyncPayload | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(new Date());

  const [consultFilter, setConsultFilter] = useState<"mine" | "active" | "all">("active");
  const [teacherQuery, setTeacherQuery] = useState("");
  const [groupQuery, setGroupQuery] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);

  // App version & auto-updater state
  const [appVersion, setAppVersion] = useState("1.3.0");
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const applyPayload = (payload: SyncPayload, resetDayIdx = false) => {
    setData(payload);
    setSettings({ ...DEFAULT_SETTINGS, ...payload.settings });
    if (resetDayIdx) {
      setSelectedDayIdx(pickUpcomingDayIdx(payload.schedule));
    }
    if (payload.groupTeachers.length > 0 || payload.settings.pinnedTeachers.length > 0) {
      setConsultFilter((prev) => (prev === "active" ? "mine" : prev));
    }
  };

  const syncAll = async (customSettings?: AppSettings) => {
    setSyncing(true);
    setError(null);
    try {
      const payload = await invoke<SyncPayload>("sync_all", {
        groupOverride: customSettings?.selectedGroup ?? null,
      });
      applyPayload(payload, true);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const clockTimer = setInterval(() => setNow(new Date()), 20_000);
    let unlistenAvail: (() => void) | undefined;
    let unlistenProg: (() => void) | undefined;
    let unlistenState: (() => void) | undefined;

    listen<UpdateCheckResult>("urtk-update-available", (ev) => {
      setUpdateCheck(ev.payload);
    }).then((fn) => {
      unlistenAvail = fn;
    });

    listen<UpdateProgress>("urtk-update-progress", (ev) => {
      setUpdateProgress(ev.payload);
    }).then((fn) => {
      unlistenProg = fn;
    });

    listen<SyncPayload>("urtk-state-updated", (ev) => {
      applyPayload(ev.payload, false);
    }).then((fn) => {
      unlistenState = fn;
    });

    (async () => {
      try {
        const ver = await invoke<string>("get_app_version");
        setAppVersion(ver);
      } catch {
        // fallback version
      }
      try {
        const cached = await invoke<SyncPayload>("get_cached_data");
        applyPayload(cached, true);
      } catch {
        // No cache yet
      }
      await syncAll();
    })();

    return () => {
      clearInterval(clockTimer);
      if (unlistenAvail) unlistenAvail();
      if (unlistenProg) unlistenProg();
      if (unlistenState) unlistenState();
    };
  }, []);

  const checkForUpdates = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const res = await invoke<UpdateCheckResult>("check_for_updates");
      setUpdateCheck(res);
      if (res.updateAvailable && res.manifest) {
        showToast(`Доступна версия ${res.manifest.version}`);
      } else {
        showToast(`Установлена актуальная версия (${res.currentVersion})`);
      }
    } catch (e) {
      setUpdateError(String(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const installAvailableUpdate = async () => {
    if (!updateCheck?.manifest) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    try {
      await invoke("download_and_install_update", { manifest: updateCheck.manifest });
    } catch (e) {
      setUpdateError(String(e));
      setInstallingUpdate(false);
      setUpdateProgress(null);
    }
  };

  const persistSettings = async (next: AppSettings, resync = false) => {
    setSettings(next);
    try {
      const updated = await invoke<SyncPayload>("save_settings", { settings: next });
      setData(updated);
      if (resync) {
        await syncAll(next);
      }
    } catch (e) {
      setError(String(e));
    }
  };

  const togglePinTeacher = (name: string) => {
    const alreadyPinned = settings.pinnedTeachers.some((pt) => teacherNamesMatch(pt, name));
    const pinned = alreadyPinned
      ? settings.pinnedTeachers.filter((pt) => !teacherNamesMatch(pt, name))
      : [...settings.pinnedTeachers, name];
    persistSettings({ ...settings, pinnedTeachers: pinned });
    showToast(alreadyPinned ? "Преподаватель откреплён" : "Преподаватель закреплён вверху");
  };

  const selectGroup = (groupName: string) => {
    const next = { ...settings, selectedGroup: groupName };
    persistSettings(next, true);
    showToast(`Группа ${groupName} выбрана`);
  };

  const toggleWidget = () => {
    const next = {
      ...settings,
      widget: { ...settings.widget, enabled: !settings.widget.enabled },
    };
    persistSettings(next);
    showToast(next.widget.enabled ? "Виджет открыт на рабочем столе" : "Виджет скрыт");
  };

  const toggleTheme = () => {
    const nextTheme: "dark" | "light" = settings.theme === "dark" ? "light" : "dark";
    persistSettings({ ...settings, theme: nextTheme });
  };

  const testNotification = async () => {
    try {
      await invoke("send_test_notification");
      showToast("Тестовое уведомление отправлено");
    } catch (e) {
      setError(String(e));
    }
  };

  const jumpToTeacherConsultation = (teacherShortName: string) => {
    const surname = teacherShortName.trim().split(/\s+/)[0] || teacherShortName;
    setTeacherQuery(surname);
    setConsultFilter("all");
    setTab("consultations");
  };

  const selectedGroupInfo = useMemo<GroupInfo | undefined>(() => {
    if (!settings.selectedGroup) return undefined;
    return (data?.groups ?? []).find(
      (g) => g.name.toLowerCase() === settings.selectedGroup.toLowerCase()
    );
  }, [data?.groups, settings.selectedGroup]);

  const bellStatus = useMemo(
    () =>
      computeBellStatus(
        now,
        data?.schedule ?? [],
        data?.bellsMonday ?? [],
        data?.bellsRegular ?? [],
        settings.selectedGroup
      ),
    [now, data?.schedule, data?.bellsMonday, data?.bellsRegular, settings.selectedGroup]
  );

  const filteredConsultations = useMemo(() => {
    const list = (data?.consultations ?? []).map((c) => ({
      ...c,
      isPinned: settings.pinnedTeachers.some((pt) => teacherNamesMatch(pt, c.teacherName)),
    }));
    const q = teacherQuery.trim().toLowerCase();
    const score = (x: TeacherConsultations) => {
      const hasSlots = x.slots.length > 0;
      if (x.isPinned && hasSlots) return 0;
      if (x.isPinned) return 1;
      if (x.isMyTeacher && hasSlots) return 2;
      if (x.isMyTeacher) return 3;
      if (hasSlots) return 4;
      return 5;
    };
    return list
      .filter((c) => {
        if (q && !c.teacherName.toLowerCase().includes(q)) return false;
        if (consultFilter === "mine") return c.isMyTeacher || c.isPinned;
        if (consultFilter === "active") return c.slots.length > 0;
        return true;
      })
      .sort((a, b) => score(a) - score(b) || a.teacherName.localeCompare(b.teacherName, "ru"));
  }, [data, settings.pinnedTeachers, consultFilter, teacherQuery]);

  const filteredGroups = useMemo(() => {
    const list = data?.groups ?? [];
    const q = groupQuery.trim().toLowerCase();
    return list.filter((g) => {
      if (courseFilter !== "all" && g.course !== courseFilter) return false;
      if (!q) return true;
      return (
        g.name.toLowerCase().includes(q) ||
        g.specialtyName.toLowerCase().includes(q) ||
        g.course.includes(q)
      );
    });
  }, [data, groupQuery, courseFilter]);

  const myActiveCount = useMemo(
    () =>
      (data?.consultations ?? []).filter(
        (c) =>
          (c.isMyTeacher ||
            settings.pinnedTeachers.some((pt) => teacherNamesMatch(pt, c.teacherName))) &&
          c.slots.length > 0
      ).length,
    [data, settings.pinnedTeachers]
  );

  const totalActiveCount = useMemo(
    () => (data?.consultations ?? []).filter((c) => c.slots.length > 0).length,
    [data]
  );

  const findConsultationForTeacher = (teacherName: string): TeacherConsultations | undefined => {
    if (!teacherName) return undefined;
    return (data?.consultations ?? []).find(
      (c) => c.slots.length > 0 && teacherNamesMatch(c.teacherName, teacherName)
    );
  };

  // Primary tab = Schedule («Пары» / «Расписание»), Consultations second
  const navItems: { id: TabId; label: string; icon: typeof CalendarDays; badge?: number }[] = [
    { id: "schedule", label: "Расписание", icon: CalendarDays },
    {
      id: "consultations",
      label: "Консультации",
      icon: MessageSquareText,
      badge: myActiveCount || totalActiveCount || undefined,
    },
    { id: "materials", label: "Материалы ДО", icon: FolderOpen },
    { id: "widget", label: "Виджет", icon: LayoutGrid },
    { id: "settings", label: "Настройки", icon: Settings },
  ];

  const themeClass = settings.theme === "light" ? "theme-light" : "theme-dark";
  const activeDay = data?.schedule?.[selectedDayIdx];
  const isSelectedDayToday = activeDay?.date === formatDateRu(now);

  return (
    <div className={`lg-shell ${themeClass}`}>
      <Titlebar
        selectedGroup={settings.selectedGroup}
        syncing={syncing}
        widgetEnabled={settings.widget.enabled}
        theme={settings.theme}
        lastSyncedAt={data?.lastSyncedAt}
        onSync={() => syncAll()}
        onToggleWidget={toggleWidget}
        onToggleTheme={toggleTheme}
      />

      <div className="flex flex-1 min-h-0 px-3.5 pb-3.5 gap-4">
        {/* Floating macOS 26 Tahoe Sidebar */}
        <aside className="lg-sidebar w-54 shrink-0 p-2.5 flex flex-col justify-between">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-[14px] text-[13px] font-medium transition cursor-pointer ${
                    active ? "lg-accent-pill" : "lg-hover"
                  }`}
                  style={active ? undefined : { color: "var(--text-primary)" }}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon
                      className="w-4 h-4"
                      style={active ? undefined : { color: "var(--text-secondary)" }}
                    />
                    {item.label}
                  </span>
                  {item.badge !== undefined && (
                    <span
                      className="text-[11px] font-semibold tabular px-2 py-0.5 rounded-full"
                      style={
                        active
                          ? { background: "rgba(255,255,255,0.22)", color: "#fff" }
                          : { background: "var(--pill-bg)", color: "var(--text-secondary)" }
                      }
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="space-y-2">
            {updateCheck?.updateAvailable && updateCheck.manifest && (
              <button
                onClick={() => setTab("settings")}
                className="w-full text-left p-3 rounded-[15px] cursor-pointer space-y-1 transition hover:brightness-110"
                style={{
                  background: "var(--accent-soft)",
                  border: "1px solid rgba(10, 132, 255, 0.35)",
                }}
              >
                <div
                  className="flex items-center justify-between text-[11px] font-semibold"
                  style={{ color: "var(--accent-text)" }}
                >
                  <span>Доступно обновление</span>
                  <ArrowDownCircle className="w-3.5 h-3.5" />
                </div>
                <div className="text-[12.5px] font-semibold tabular">
                  v{updateCheck.manifest.version}
                </div>
              </button>
            )}

            {/* Group quick card */}
            <button
              onClick={() => setTab("settings")}
              className="w-full text-left p-3 rounded-[15px] transition lg-hover cursor-pointer space-y-1"
              style={{
                background: "var(--row-bg)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <div
                className="flex items-center justify-between text-[11px]"
                style={{ color: "var(--text-secondary)" }}
              >
                <span>Группа</span>
                <Users className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
              </div>
              <div className="text-[13.5px] font-semibold truncate">
                {settings.selectedGroup || "Выбрать группу"}
              </div>
            </button>
          </div>
        </aside>

        {/* Main Content Canvas */}
        <main className="flex-1 overflow-y-auto pr-1.5 space-y-5 relative">
          {error && (
            <div
              className="lg-card p-3.5 text-xs flex items-center justify-between"
              style={{ borderColor: "rgba(255, 69, 58, 0.45)", color: "var(--red)" }}
            >
              <span>Ошибка: {error}</span>
              <button onClick={() => setError(null)} className="underline cursor-pointer ml-3">
                Скрыть
              </button>
            </div>
          )}

          {toast && (
            <div className="fixed bottom-5 right-5 z-50 lg-capsule rounded-full px-4 py-2 text-xs font-medium flex items-center gap-2">
              <Check className="w-3.5 h-3.5" style={{ color: "var(--green)" }} />
              <span>{toast}</span>
            </div>
          )}

          {/* TAB 1: SCHEDULE & BELLS (Primary) */}
          {tab === "schedule" && (
            <div className="space-y-4 pb-2">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                    Расписание{settings.selectedGroup ? ` · ${settings.selectedGroup}` : ""}
                  </h1>
                  <p className="text-[12.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                    {selectedGroupInfo?.specialtyName
                      ? `${selectedGroupInfo.course} курс · ${selectedGroupInfo.specialtyName}`
                      : "Академикс (akademiks.urtt.ru)"}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {selectedGroupInfo?.driveUrl && isSafeHttpsUrl(selectedGroupInfo.driveUrl) && (
                    <button
                      onClick={() => safeOpenExternal(selectedGroupInfo.driveUrl!)}
                      className="lg-capsule px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                      style={{ color: "var(--green)" }}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>Диск группы</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  )}
                  <button
                    onClick={() => safeOpenExternal("https://akademiks.urtt.ru")}
                    className="lg-capsule px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                    style={{ color: "var(--accent-text)" }}
                  >
                    <span>Академикс</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Live Bell Status Bar */}
              <div className="lg-card px-4 py-3 flex items-center justify-between gap-3 text-[13px]">
                <div className="flex items-center gap-2.5" style={{ color: "var(--text-secondary)" }}>
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      background: bellStatus.active ? "var(--green)" : "var(--text-tertiary)",
                    }}
                  />
                  <span className="capitalize">
                    {now.toLocaleDateString("ru-RU", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                  </span>
                </div>
                <span
                  className="font-semibold tabular"
                  style={{ color: bellStatus.active ? "var(--green)" : "var(--text-secondary)" }}
                >
                  {bellStatus.text}
                </span>
              </div>

              {!settings.selectedGroup ? (
                /* Zero-friction First-Run Inline Group Picker */
                <div className="lg-card p-5 space-y-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[15px] font-semibold">Выберите вашу группу УРТК</div>
                      <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                        Расписание пар, папка ДО и консультации ваших преподавателей подгрузятся сразу
                      </div>
                    </div>
                    <div className="lg-capsule rounded-full p-1 flex items-center text-[11.5px]">
                      {[
                        ["all", "Все"],
                        ["1", "1 курс"],
                        ["2", "2 курс"],
                        ["3", "3 курс"],
                        ["4", "4 курс"],
                      ].map(([cid, clabel]) => (
                        <button
                          key={cid}
                          onClick={() => setCourseFilter(cid)}
                          className={`px-2.5 py-1 rounded-full font-medium cursor-pointer ${
                            courseFilter === cid ? "lg-accent-pill" : ""
                          }`}
                          style={courseFilter === cid ? undefined : { color: "var(--text-secondary)" }}
                        >
                          {clabel}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="relative">
                    <Search
                      className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2"
                      style={{ color: "var(--text-tertiary)" }}
                    />
                    <input
                      value={groupQuery}
                      onChange={(e) => setGroupQuery(e.target.value)}
                      placeholder="Найти группу или специальность (например, ИсР-101, Би-131)..."
                      className="lg-input w-full pl-10 pr-4 py-2 rounded-full text-[13px]"
                    />
                  </div>

                  <div className="flex flex-wrap gap-1.5 max-h-52 overflow-y-auto pt-0.5">
                    {filteredGroups.map((g) => (
                      <button
                        key={g.name}
                        onClick={() => selectGroup(g.name)}
                        className="px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer lg-capsule"
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : data?.schedule && data.schedule.length > 0 ? (
                <>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {data.schedule.map((d, idx) => {
                      const active = selectedDayIdx === idx;
                      const isToday = d.date === formatDateRu(now);
                      return (
                        <button
                          key={d.date + idx}
                          onClick={() => setSelectedDayIdx(idx)}
                          className={`px-4 py-2 rounded-[16px] text-xs font-medium shrink-0 transition cursor-pointer ${
                            active ? "lg-accent-pill" : "lg-capsule"
                          }`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span>{d.weekday}</span>
                            {isToday && (
                              <span
                                className="w-1.5 h-1.5 rounded-full"
                                style={{ background: active ? "#fff" : "var(--green)" }}
                              />
                            )}
                          </div>
                          <div className="text-[10.5px] tabular opacity-75 mt-0.5">{d.date}</div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-2.5">
                    {(activeDay?.lessons ?? []).map((lesson, idx) => {
                      const isRunning =
                        isSelectedDayToday && bellStatus.activePairNumber === lesson.pairNumber;
                      const isNext =
                        isSelectedDayToday &&
                        !isRunning &&
                        bellStatus.nextPairNumber === lesson.pairNumber;
                      const teacherConsult = findConsultationForTeacher(lesson.teacher);

                      return (
                        <div
                          key={idx}
                          className={`lg-card lg-card-interactive p-4 flex items-center justify-between gap-4 ${
                            isRunning ? "lg-lesson-active" : isNext ? "lg-lesson-next" : ""
                          }`}
                        >
                          <div className="flex items-center gap-3.5 min-w-0">
                            <div
                              className="w-11 h-11 rounded-[14px] flex flex-col items-center justify-center shrink-0 tabular"
                              style={{
                                background: isRunning
                                  ? "rgba(48, 209, 88, 0.2)"
                                  : "var(--accent-soft)",
                                color: isRunning ? "var(--green)" : "var(--accent-text)",
                              }}
                            >
                              <span className="text-sm font-bold leading-none">
                                {lesson.pairNumber}
                              </span>
                              <span className="text-[9.5px] opacity-80 mt-0.5">пара</span>
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-[13.5px] truncate">
                                  {lesson.subject}
                                </span>
                                {isRunning && (
                                  <span
                                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                    style={{
                                      background: "rgba(48, 209, 88, 0.18)",
                                      color: "var(--green)",
                                    }}
                                  >
                                    Идёт сейчас
                                  </span>
                                )}
                                {!isRunning && isNext && (
                                  <span
                                    className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                    style={{
                                      background: "var(--accent-soft)",
                                      color: "var(--accent-text)",
                                    }}
                                  >
                                    Следующая
                                  </span>
                                )}
                              </div>
                              <div
                                className="text-xs mt-0.5 tabular truncate"
                                style={{ color: "var(--text-secondary)" }}
                              >
                                {lesson.timeStart}–{lesson.timeEnd}
                                {lesson.teacher ? ` · ${lesson.teacher}` : ""}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {teacherConsult && (
                              <button
                                type="button"
                                onClick={() => jumpToTeacherConsultation(lesson.teacher)}
                                title={`Консультации преподавателя (${teacherConsult.slots.length})`}
                                className="px-2.5 py-1.5 rounded-full text-[11px] font-medium flex items-center gap-1.5 transition hover:brightness-110 cursor-pointer"
                                style={{
                                  background: "var(--accent-soft)",
                                  color: "var(--accent-text)",
                                  border: "1px solid rgba(10, 132, 255, 0.24)",
                                }}
                              >
                                <MessageSquareText className="w-3 h-3" />
                                <span className="hidden md:inline">Консультация</span>
                              </button>
                            )}
                            <span
                              className="px-3 py-1.5 rounded-full text-xs font-semibold tabular"
                              style={{
                                background: "var(--row-bg)",
                                border: "1px solid var(--border-subtle)",
                              }}
                            >
                              {lesson.room || "—"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="lg-card p-10 text-center space-y-2">
                  <p className="text-sm font-medium">
                    Расписание для группы {settings.selectedGroup} пока не опубликовано
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    Попробуйте обновить данные позже или проверьте расписание в «Академиксе».
                  </p>
                </div>
              )}

              {/* Bells */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {[
                  { title: "Звонки · Понедельник", list: data?.bellsMonday ?? [] },
                  { title: "Звонки · Вт–Сб", list: data?.bellsRegular ?? [] },
                ].map((group) => (
                  <div key={group.title} className="lg-card p-4 space-y-2.5">
                    <div className="flex items-center gap-2 text-[13px] font-semibold">
                      <Clock className="w-4 h-4" style={{ color: "var(--accent)" }} />
                      <span>{group.title}</span>
                    </div>
                    <div className="space-y-1.5 text-xs tabular">
                      {group.list.map((b) => (
                        <div
                          key={b.pairNumber}
                          className="flex items-center justify-between py-1.5 px-3 rounded-xl"
                          style={{ background: "var(--row-bg)" }}
                        >
                          <span className="font-medium">{b.pairNumber} пара</span>
                          <span style={{ color: "var(--text-secondary)" }}>
                            {b.part1} · {b.part2}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TAB 2: CONSULTATIONS */}
          {tab === "consultations" && (
            <div className="space-y-4 pb-2">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                    Консультации
                  </h1>
                  <p
                    className="text-[12.5px] mt-0.5 tabular"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {data?.consultationWeekRange || "Загрузка недели..."} · активных:{" "}
                    {totalActiveCount}
                  </p>
                </div>

                {/* Apple Segmented Control */}
                <div className="lg-capsule rounded-full p-1 flex items-center text-[12px]">
                  {(
                    [
                      ["mine", "Мои"],
                      ["active", "Есть слоты"],
                      ["all", "Все"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setConsultFilter(id)}
                      className={`px-3.5 py-1 rounded-full font-medium transition cursor-pointer ${
                        consultFilter === id ? "lg-accent-pill" : ""
                      }`}
                      style={
                        consultFilter === id ? undefined : { color: "var(--text-secondary)" }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <Search
                  className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2"
                  style={{ color: "var(--text-tertiary)" }}
                />
                <input
                  value={teacherQuery}
                  onChange={(e) => setTeacherQuery(e.target.value)}
                  placeholder="Поиск по ФИО преподавателя"
                  className="lg-input w-full pl-10 pr-4 py-2.5 rounded-full text-[13px]"
                />
              </div>

              {filteredConsultations.length === 0 ? (
                <div className="lg-card p-10 text-center space-y-2">
                  <p className="text-sm font-medium">
                    {consultFilter === "mine"
                      ? "Нет закреплённых преподавателей или совпадений по группе"
                      : "Ничего не найдено"}
                  </p>
                  <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
                    Выберите группу в Настройках или закрепите нужных преподавателей булавкой во вкладке «Есть слоты».
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
                  {filteredConsultations.map((item) => (
                    <ConsultationCard
                      key={item.teacherName}
                      item={item}
                      onTogglePin={() => togglePinTeacher(item.teacherName)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: DISTANCE MATERIALS */}
          {tab === "materials" && (
            <div className="space-y-5 pb-2">
              <div>
                <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Материалы ДО</h1>
                <p className="text-[12.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  Ресурсы УРТК им. А.С. Попова и персональные папки групп
                </p>
              </div>

              {selectedGroupInfo?.driveUrl && isSafeHttpsUrl(selectedGroupInfo.driveUrl) && (
                <button
                  onClick={() => safeOpenExternal(selectedGroupInfo.driveUrl!)}
                  className="w-full lg-card lg-card-interactive p-4 flex items-center justify-between gap-4 text-left cursor-pointer"
                  style={{ borderColor: "rgba(48, 209, 88, 0.4)" }}
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className="w-10 h-10 rounded-[13px] flex items-center justify-center shrink-0"
                      style={{ background: "rgba(48, 209, 88, 0.18)", color: "var(--green)" }}
                    >
                      <FolderOpen className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[14px] font-semibold">
                        Папка вашей группы {selectedGroupInfo.name} на Google Диске
                      </div>
                      <div
                        className="text-xs mt-0.5 truncate"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {selectedGroupInfo.course} курс
                        {selectedGroupInfo.specialtyName
                          ? ` · ${selectedGroupInfo.specialtyName}`
                          : " · Прямая ссылка из Навигатора ДО"}
                      </div>
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 shrink-0" style={{ color: "var(--green)" }} />
                </button>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  {
                    title: "Таблица консультаций",
                    desc: "Google Sheets",
                    url: "https://docs.google.com/spreadsheets/d/1xKpaWPKBcv-emcRpAfYRCK767D8dLiYnJjnzvOgBies/edit?usp=sharing",
                  },
                  {
                    title: "Навигатор ДО",
                    desc: "Папки 1–4 курсов",
                    url: "https://docs.google.com/spreadsheets/d/167kcyEYDRVdzexEauqZDi6uNG3ZFEGe2tvXXl5YERMg/edit?usp=sharing",
                  },
                  {
                    title: "Google Диск ДО",
                    desc: "Общие материалы",
                    url: "https://drive.google.com/drive/folders/1-wAAAAcRdG75cosGex_KIW2VDgml0nrp?usp=sharing",
                  },
                  {
                    title: "Moodle УРТК",
                    desc: "Дистанционный портал",
                    url: "http://moodle.urtk.su/",
                  },
                ].map((link) => (
                  <button
                    key={link.title}
                    onClick={() => safeOpenExternal(link.url)}
                    className="lg-card lg-card-interactive p-4 text-left space-y-2 cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <BookOpen className="w-4 h-4" style={{ color: "var(--accent)" }} />
                      <ExternalLink
                        className="w-3.5 h-3.5"
                        style={{ color: "var(--text-tertiary)" }}
                      />
                    </div>
                    <div>
                      <div className="text-[13.5px] font-semibold">{link.title}</div>
                      <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                        {link.desc}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="lg-card p-4 space-y-3">
                <div className="text-[13.5px] font-semibold">
                  Все группы УРТК ({data?.groups.length ?? 0})
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-96 overflow-y-auto pr-1">
                  {(data?.groups ?? []).map((g) => {
                    const active = g.name === settings.selectedGroup;
                    return (
                      <div
                        key={g.name}
                        className="p-3 rounded-[14px] flex items-center justify-between gap-2 transition"
                        style={{
                          background: active ? "var(--accent-soft)" : "var(--row-bg)",
                          border: "1px solid var(--border-subtle)",
                        }}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold">{g.name}</div>
                          <div
                            className="text-[11px] truncate"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {g.course} курс{g.specialtyName ? ` · ${g.specialtyName}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {g.driveUrl && isSafeHttpsUrl(g.driveUrl) && (
                            <button
                              onClick={() => safeOpenExternal(g.driveUrl!)}
                              title="Папка группы на Google Диске"
                              className="p-1.5 rounded-full lg-capsule cursor-pointer"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              <FolderOpen className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            onClick={() => selectGroup(g.name)}
                            className={`px-2.5 py-1 rounded-full text-[11px] font-medium cursor-pointer ${
                              active ? "lg-accent-pill" : "lg-capsule"
                            }`}
                          >
                            {active ? "Выбрана" : "Выбрать"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: WIDGET BUILDER */}
          {tab === "widget" && (
            <div className="space-y-5 pb-2">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                    Виджет рабочего стола
                  </h1>
                  <p className="text-[12.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                    Все изменения применяются мгновенно и к предпросмотру, и к виджету на рабочем столе
                  </p>
                </div>
                <button
                  onClick={toggleWidget}
                  className={`px-4 py-2 rounded-full text-xs font-semibold cursor-pointer ${
                    settings.widget.enabled ? "lg-capsule" : "lg-accent-pill"
                  }`}
                >
                  {settings.widget.enabled ? "Скрыть с рабочего стола" : "Показать на рабочем столе"}
                </button>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <div className="lg-card p-5 space-y-3 xl:col-span-5">
                  <div className="text-[13.5px] font-semibold mb-1">Модули</div>

                  {(
                    [
                      ["showBellTimer", "Таймер до звонка"],
                      ["showTomorrowSchedule", "Ближайший учебный день"],
                      ["showWeekSchedule", "Неделя с переключением дней"],
                      ["showConsultations", "Консультации моих преподавателей"],
                      [
                        "pinToDesktop",
                        "Прибить к рабочему столу (как в Windows 7, не сворачивается по Win+D)",
                      ],
                    ] as const
                  ).map(([key, label]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 py-2.5 px-3.5 rounded-[14px]"
                      style={{ background: "var(--row-bg)" }}
                    >
                      <span className="text-[12.5px]">{label}</span>
                      <GlassSwitch
                        checked={settings.widget[key]}
                        onChange={(val) =>
                          persistSettings({
                            ...settings,
                            widget: { ...settings.widget, [key]: val },
                          })
                        }
                      />
                    </div>
                  ))}

                  <div className="pt-2 space-y-2">
                    <div
                      className="flex justify-between text-xs tabular"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <span>Размер</span>
                      <span>
                        {Math.round(settings.widget.width)} × {Math.round(settings.widget.height)}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: "Компакт", w: 300, h: 360 },
                        { label: "Стандарт", w: 350, h: 450 },
                        { label: "Широкий", w: 420, h: 520 },
                      ].map((preset) => {
                        const active = Math.round(settings.widget.width) === preset.w;
                        return (
                          <button
                            key={preset.label}
                            onClick={() =>
                              persistSettings({
                                ...settings,
                                widget: {
                                  ...settings.widget,
                                  width: preset.w,
                                  height: preset.h,
                                },
                              })
                            }
                            className={`py-1.5 rounded-full text-xs font-medium cursor-pointer ${
                              active ? "lg-accent-pill" : "lg-capsule"
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="pt-2 space-y-2">
                    <div
                      className="flex justify-between text-xs tabular"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      <span>Плотность стекла</span>
                      <span>{Math.round(settings.widget.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.35}
                      max={0.92}
                      step={0.03}
                      value={settings.widget.opacity}
                      onChange={(e) =>
                        persistSettings({
                          ...settings,
                          widget: { ...settings.widget, opacity: parseFloat(e.target.value) },
                        })
                      }
                      className="lg-slider"
                    />
                  </div>
                </div>

                {/* Live wallpaper stage preview */}
                <div className="lg-wallpaper-stage rounded-[24px] p-6 xl:col-span-7 flex flex-col items-center justify-center relative overflow-hidden min-h-[460px] border border-white/15">
                  <div className="text-[11px] font-medium text-white/70 mb-4 px-3 py-1 rounded-full bg-black/25 backdrop-blur-md">
                    Живой предпросмотр на обоях
                  </div>
                  <div
                    className="transition-all duration-200 max-w-full"
                    style={{
                      width: `${Math.min(410, Math.round(settings.widget.width * 0.92))}px`,
                      height: `${Math.min(450, Math.round(settings.widget.height * 0.88))}px`,
                    }}
                  >
                    <WidgetView isPreview previewData={data} previewSettings={settings} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: SETTINGS */}
          {tab === "settings" && (
            <div className="space-y-4 max-w-3xl pb-2">
              <div>
                <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Настройки</h1>
                <p className="text-[12.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
                  Учебная группа, автосинхронизация, уведомления Windows и обновления
                </p>
              </div>

              {/* Group selection */}
              <div className="lg-card p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[14px] font-semibold">
                    <Users className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    <span>Учебная группа УРТК</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {settings.selectedGroup && (
                      <span
                        className="px-2.5 py-0.5 rounded-full text-xs font-medium"
                        style={{
                          background: "var(--accent-soft)",
                          color: "var(--accent-text)",
                        }}
                      >
                        {settings.selectedGroup}
                      </span>
                    )}
                    <div className="lg-capsule rounded-full p-0.5 flex items-center text-[11px]">
                      {[
                        ["all", "Все"],
                        ["1", "1 к."],
                        ["2", "2 к."],
                        ["3", "3 к."],
                        ["4", "4 к."],
                      ].map(([cid, clabel]) => (
                        <button
                          key={cid}
                          onClick={() => setCourseFilter(cid)}
                          className={`px-2 py-0.5 rounded-full font-medium cursor-pointer ${
                            courseFilter === cid ? "lg-accent-pill" : ""
                          }`}
                          style={courseFilter === cid ? undefined : { color: "var(--text-secondary)" }}
                        >
                          {clabel}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <input
                  value={groupQuery}
                  onChange={(e) => setGroupQuery(e.target.value)}
                  placeholder="Поиск группы (например, ИсР-101, Би-131)..."
                  className="lg-input w-full px-4 py-2 rounded-full text-[13px]"
                />

                <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pt-1">
                  {filteredGroups.map((g) => {
                    const active = g.name === settings.selectedGroup;
                    return (
                      <button
                        key={g.name}
                        onClick={() => selectGroup(g.name)}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer ${
                          active ? "lg-accent-pill" : "lg-capsule"
                        }`}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Notifications */}
              <div className="lg-card p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[14px] font-semibold">
                    <Bell className="w-4 h-4" style={{ color: "var(--green)" }} />
                    <span>Уведомления Windows</span>
                  </div>
                  <button
                    onClick={testNotification}
                    className="lg-capsule px-3.5 py-1.5 rounded-full text-xs font-medium cursor-pointer"
                  >
                    Проверить пуш
                  </button>
                </div>

                {(
                  [
                    ["enabled", "Включить push-уведомления Windows"],
                    ["morningSummary", "Утренняя сводка пар и консультаций"],
                    ["onNewConsultation", "Уведомлять о новой консультации"],
                    ["onScheduleChange", "Уведомлять об изменении расписания"],
                  ] as const
                ).map(([key, label]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px]"
                    style={{ background: "var(--row-bg)" }}
                  >
                    <span className="text-[12.5px]">{label}</span>
                    <GlassSwitch
                      checked={settings.notifications[key]}
                      onChange={(val) =>
                        persistSettings({
                          ...settings,
                          notifications: { ...settings.notifications, [key]: val },
                        })
                      }
                    />
                  </div>
                ))}

                <div
                  className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px]"
                  style={{ background: "var(--row-bg)" }}
                >
                  <span className="text-[12.5px]">Время утренней сводки</span>
                  <input
                    type="time"
                    value={settings.notifications.morningTime}
                    onChange={(e) =>
                      persistSettings({
                        ...settings,
                        notifications: {
                          ...settings.notifications,
                          morningTime: e.target.value,
                        },
                      })
                    }
                    className="lg-input px-3 py-1 rounded-full text-xs tabular"
                  />
                </div>
              </div>

              {/* System, Background Sync & Autostart */}
              <div className="lg-card p-5 space-y-3">
                <div className="flex items-center gap-2 text-[14px] font-semibold">
                  <Power className="w-4 h-4" style={{ color: "var(--accent)" }} />
                  <span>Система и фоновая синхронизация</span>
                </div>

                <div
                  className="flex items-center justify-between gap-3 py-2.5 px-3.5 rounded-[14px]"
                  style={{ background: "var(--row-bg)" }}
                >
                  <div>
                    <div className="text-[12.5px]">Интервал автообновления расписания</div>
                    <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      Работает в фоне, даже когда окно свёрнуто в системный трей
                    </div>
                  </div>
                  <div className="lg-capsule rounded-full p-1 flex items-center text-[11.5px] shrink-0">
                    {[15, 30, 60].map((mins) => (
                      <button
                        key={mins}
                        onClick={() =>
                          persistSettings({ ...settings, syncIntervalMinutes: mins })
                        }
                        className={`px-2.5 py-1 rounded-full font-medium tabular cursor-pointer ${
                          settings.syncIntervalMinutes === mins ? "lg-accent-pill" : ""
                        }`}
                        style={
                          settings.syncIntervalMinutes === mins
                            ? undefined
                            : { color: "var(--text-secondary)" }
                        }
                      >
                        {mins} мин
                      </button>
                    ))}
                  </div>
                </div>

                <div
                  className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px]"
                  style={{ background: "var(--row-bg)" }}
                >
                  <div>
                    <div className="text-[12.5px]">Запускать URTK Flow вместе с Windows</div>
                    <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      Добавляет приложение в автозагрузку текущего пользователя
                    </div>
                  </div>
                  <GlassSwitch
                    checked={settings.autostart}
                    onChange={(val) => {
                      persistSettings({ ...settings, autostart: val });
                      showToast(val ? "Автозагрузка с Windows включена" : "Автозагрузка отключена");
                    }}
                  />
                </div>

                <div
                  className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px]"
                  style={{ background: "var(--row-bg)" }}
                >
                  <div>
                    <div className="text-[12.5px]">При автозапуске сворачивать в трей</div>
                    <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                      Главное окно не мешает после входа в систему, виджет появляется на обоях
                    </div>
                  </div>
                  <GlassSwitch
                    checked={settings.startMinimizedOnBoot}
                    onChange={(val) =>
                      persistSettings({ ...settings, startMinimizedOnBoot: val })
                    }
                  />
                </div>
              </div>

              {/* Auto-Updater */}
              <div className="lg-card p-5 space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[14px] font-semibold">
                    <ShieldCheck className="w-4 h-4" style={{ color: "var(--accent)" }} />
                    <span>Обновления</span>
                    <span
                      className="px-2 py-0.5 rounded-full text-[11px] font-medium tabular"
                      style={{ background: "var(--pill-bg)", color: "var(--text-secondary)" }}
                    >
                      v{appVersion}
                    </span>
                  </div>

                  <button
                    onClick={() => checkForUpdates()}
                    disabled={checkingUpdate || installingUpdate}
                    className="lg-capsule px-3.5 py-1.5 rounded-full text-xs font-medium flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${checkingUpdate ? "animate-spin" : ""}`} />
                    <span>{checkingUpdate ? "Проверка..." : "Проверить обновления"}</span>
                  </button>
                </div>

                <div
                  className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px]"
                  style={{ background: "var(--row-bg)" }}
                >
                  <span className="text-[12.5px]">Проверять обновления автоматически в фоне</span>
                  <GlassSwitch
                    checked={settings.autoUpdateCheck}
                    onChange={(val) => persistSettings({ ...settings, autoUpdateCheck: val })}
                  />
                </div>

                <div
                  className="flex items-center justify-between py-2.5 px-3.5 rounded-[14px] text-xs"
                  style={{ background: "var(--row-bg)" }}
                >
                  <div>
                    <div className="font-medium">Защита канала обновлений</div>
                    <div
                      className="text-[11px] mt-0.5 tabular"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      update.flow.mdsdev.ru · HTTPS + подпись Ed25519 V2 + SHA-256
                    </div>
                  </div>
                  <span
                    className="px-2.5 py-1 rounded-full text-[11px] font-semibold shrink-0"
                    style={{ background: "rgba(48, 209, 88, 0.18)", color: "var(--green)" }}
                  >
                    Активна
                  </span>
                </div>

                {updateError && (
                  <div
                    className="p-3 rounded-[14px] text-xs"
                    style={{
                      background: "rgba(255, 69, 58, 0.14)",
                      border: "1px solid rgba(255, 69, 58, 0.35)",
                      color: "var(--red)",
                    }}
                  >
                    {updateError}
                  </div>
                )}

                {updateCheck && !updateCheck.updateAvailable && !updateError && (
                  <div
                    className="p-3 rounded-[14px] text-xs flex items-center justify-between"
                    style={{
                      background: "var(--row-bg)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <Check className="w-3.5 h-3.5" style={{ color: "var(--green)" }} />
                      <span>Установлена последняя версия (v{updateCheck.currentVersion})</span>
                    </span>
                    <span className="tabular" style={{ color: "var(--text-tertiary)" }}>
                      {updateCheck.checkedAt}
                    </span>
                  </div>
                )}

                {updateCheck?.updateAvailable && updateCheck.manifest && (
                  <div
                    className="p-4 rounded-[16px] space-y-3"
                    style={{
                      background: "var(--accent-soft)",
                      border: "1px solid rgba(10, 132, 255, 0.38)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[13.5px] font-semibold">
                          Новая версия URTK Flow {updateCheck.manifest.version}
                        </div>
                        <div
                          className="text-[11.5px] mt-0.5 tabular"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {updateCheck.manifest.publishedAt}
                          {updateCheck.manifest.sizeBytes > 0
                            ? ` · ${(updateCheck.manifest.sizeBytes / 1048576).toFixed(2)} МБ`
                            : ""}
                        </div>
                      </div>
                      <button
                        onClick={installAvailableUpdate}
                        disabled={installingUpdate}
                        className="lg-accent-pill px-4 py-1.5 rounded-full text-xs font-semibold cursor-pointer disabled:opacity-60 shrink-0"
                      >
                        {installingUpdate ? "Обновление..." : "Скачать и установить"}
                      </button>
                    </div>

                    {updateCheck.manifest.notes && (
                      <p
                        className="text-xs leading-relaxed"
                        style={{ color: "var(--text-primary)" }}
                      >
                        {updateCheck.manifest.notes}
                      </p>
                    )}

                    {updateProgress && (
                      <div className="space-y-1.5">
                        <div className="flex justify-between text-[11px] tabular">
                          <span>
                            {updateProgress.stage === "verifying"
                              ? "Проверка подписи Ed25519 V2 и SHA-256..."
                              : updateProgress.stage === "installing"
                              ? "Запуск установщика..."
                              : "Загрузка обновления..."}
                          </span>
                          <span>{updateProgress.percent}%</span>
                        </div>
                        <div
                          className="w-full h-1.5 rounded-full overflow-hidden"
                          style={{ background: "rgba(255,255,255,0.14)" }}
                        >
                          <div
                            className="h-full rounded-full transition-all duration-150"
                            style={{
                              width: `${updateProgress.percent}%`,
                              background: "var(--accent)",
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ConsultationCard({
  item,
  onTogglePin,
}: {
  item: TeacherConsultations;
  onTogglePin: () => void;
}) {
  return (
    <div
      className="lg-card lg-card-interactive p-4 space-y-3"
      style={item.isPinned ? { borderColor: "rgba(255, 159, 10, 0.36)" } : undefined}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-[13.5px] font-semibold truncate">{item.teacherName}</h3>
            {item.isPinned && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0"
                style={{ background: "rgba(255, 159, 10, 0.2)", color: "var(--amber)" }}
              >
                Закреплён
              </span>
            )}
            {item.isMyTeacher && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0"
                style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}
              >
                Моя группа
              </span>
            )}
          </div>
          <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {item.slots.length > 0
              ? `Слотов на неделе: ${item.slots.length}`
              : "Консультаций на неделе нет"}
          </p>
        </div>

        <button
          type="button"
          onClick={onTogglePin}
          title={item.isPinned ? "Открепить" : "Закрепить вверху"}
          className="w-8 h-8 rounded-full flex items-center justify-center transition cursor-pointer shrink-0 lg-capsule"
          style={
            item.isPinned
              ? {
                  background: "rgba(255, 159, 10, 0.22)",
                  borderColor: "rgba(255, 159, 10, 0.42)",
                  color: "var(--amber)",
                }
              : { color: "var(--text-tertiary)" }
          }
        >
          <Pin className="w-3.5 h-3.5" fill={item.isPinned ? "currentColor" : "none"} />
        </button>
      </div>

      {item.slots.length > 0 && (
        <div className="space-y-1.5">
          {item.slots.map((slot, i) => {
            const isUrl = isSafeHttpsUrl(slot.location);
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-[14px]"
                style={{
                  background: "var(--row-bg)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div className="min-w-0">
                  <div className="text-xs font-medium tabular">
                    {slot.weekday} · {slot.date}
                  </div>
                  <div
                    className="text-xs mt-0.5 tabular"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {slot.time}
                  </div>
                </div>
                {isUrl ? (
                  <button
                    onClick={() => safeOpenExternal(slot.location)}
                    className="px-3 py-1 rounded-full text-[11px] font-semibold flex items-center gap-1 shrink-0 cursor-pointer"
                    style={{
                      background: "rgba(48, 209, 88, 0.18)",
                      color: "var(--green)",
                    }}
                  >
                    <span>Онлайн</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                ) : (
                  <span
                    className="px-2.5 py-1 rounded-full text-xs font-semibold tabular shrink-0"
                    style={{
                      background: "var(--accent-soft)",
                      color: "var(--accent-text)",
                    }}
                  >
                    {slot.location || "Уточнить"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
