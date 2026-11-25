import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Calendar, Clock, MessageSquareText, Pin, RefreshCw } from "lucide-react";
import { AppSettings, SyncPayload } from "../types";
import {
  computeBellStatus,
  formatDateRu,
  pickUpcomingDayIdx,
  shortWeekday,
} from "../utils/schedule";

interface WidgetViewProps {
  previewData?: SyncPayload | null;
  previewSettings?: AppSettings;
  isPreview?: boolean;
}

export function WidgetView({
  previewData,
  previewSettings,
  isPreview = false,
}: WidgetViewProps) {
  const [liveData, setLiveData] = useState<SyncPayload | null>(null);
  const [now, setNow] = useState(new Date());
  const [weekDayIdx, setWeekDayIdx] = useState(0);

  const load = async () => {
    try {
      const payload = await invoke<SyncPayload>("get_cached_data");
      setLiveData(payload);
    } catch {
      // ignore empty cache
    }
  };

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20_000);
    if (isPreview) return () => clearInterval(t);

    load();
    let unlisten: (() => void) | undefined;
    listen<SyncPayload>("urtk-state-updated", (event) => {
      setLiveData(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    const r = setInterval(load, 60_000);
    return () => {
      clearInterval(t);
      clearInterval(r);
      if (unlisten) unlisten();
    };
  }, [isPreview]);

  const data = isPreview ? (previewData ?? null) : liveData;
  const effectiveSettings = isPreview
    ? (previewSettings ?? data?.settings)
    : data?.settings;

  const isLight = effectiveSettings?.theme === "light";
  const cfg = effectiveSettings?.widget;
  const opacity = cfg?.opacity ?? 0.72;
  const showBellTimer = cfg?.showBellTimer ?? true;
  const showTomorrow = cfg?.showTomorrowSchedule ?? true;
  const showWeek = cfg?.showWeekSchedule ?? false;
  const showConsultations = cfg?.showConsultations ?? true;

  const myConsultations = useMemo(() => {
    return (data?.consultations ?? []).filter(
      (c) => (c.isMyTeacher || c.isPinned) && c.slots.length > 0
    );
  }, [data]);

  const isTeacherMode = effectiveSettings?.role === "teacher";
  const activeTargetName = isTeacherMode
    ? effectiveSettings?.selectedTeacher ?? ""
    : effectiveSettings?.selectedGroup ?? "";

  const bellStatus = useMemo(() => {
    return computeBellStatus(
      now,
      data?.schedule ?? [],
      data?.bellsMonday ?? [],
      data?.bellsRegular ?? [],
      activeTargetName
    );
  }, [now, data?.schedule, data?.bellsMonday, data?.bellsRegular, activeTargetName]);

  const scheduleDays = data?.schedule ?? [];
  const nextDay = useMemo(() => {
    if (scheduleDays.length === 0) return undefined;
    return scheduleDays[pickUpcomingDayIdx(scheduleDays, now)] ?? scheduleDays[0];
  }, [scheduleDays, now]);

  const isNextDayToday = nextDay?.date === formatDateRu(now);
  const selectedWeekDay = scheduleDays[Math.min(weekDayIdx, Math.max(0, scheduleDays.length - 1))];
  const noBlocksEnabled = !showBellTimer && !showTomorrow && !showWeek && !showConsultations;

  const handleDrag = (e: MouseEvent<HTMLDivElement>) => {
    if (isPreview || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    getCurrentWindow().startDragging();
  };

  const bgGradient = isLight
    ? `linear-gradient(155deg, rgba(255, 255, 255, ${opacity}) 0%, rgba(240, 244, 252, ${Math.max(0.32, opacity - 0.12)}) 100%)`
    : `linear-gradient(155deg, rgba(32, 36, 46, ${opacity}) 0%, rgba(18, 20, 27, ${Math.min(0.92, opacity + 0.06)}) 100%)`;

  return (
    <div
      onMouseDown={handleDrag}
      className={`${isLight ? "theme-light" : "theme-dark"} w-full h-full p-4 rounded-[24px] flex flex-col gap-3 overflow-hidden group`}
      style={{
        background: bgGradient,
        backgroundClip: "padding-box",
        color: "var(--text-primary)",
        backdropFilter: "blur(34px) saturate(190%)",
        WebkitBackdropFilter: "blur(34px) saturate(190%)",
        border: isLight
          ? "1px solid rgba(255,255,255,0.75)"
          : "1px solid rgba(255,255,255,0.22)",
        boxShadow: isPreview
          ? isLight
            ? "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(15,23,42,0.06), 0 16px 36px rgba(15,23,42,0.14)"
            : "inset 0 1px 0 rgba(255,255,255,0.36), inset 0 -1px 0 rgba(255,255,255,0.06), 0 18px 40px rgba(0,0,0,0.42)"
          : isLight
          ? "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(15,23,42,0.08)"
          : "inset 0 1px 0 rgba(255,255,255,0.38), inset 0 -1px 0 rgba(255,255,255,0.08)",
      }}
    >
      {/* Minimal Apple Widget Header */}
      <div className="flex items-center justify-between shrink-0 cursor-move">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold tracking-[-0.01em] truncate">
            {activeTargetName || "URTK Flow"}
          </span>
          <span
            className="text-[11px] capitalize"
            style={{ color: "var(--text-secondary)" }}
          >
            {now.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className="text-[12px] font-medium tabular"
            style={{ color: "var(--text-secondary)" }}
          >
            {now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
          </span>
          {!isPreview && (
            <button
              onClick={load}
              title="Обновить"
              className="w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 lg-hover transition cursor-pointer"
              style={{ color: "var(--text-secondary)" }}
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Content Modules */}
      <div className="flex-1 overflow-y-auto space-y-2.5 pr-0.5">
        {noBlocksEnabled && (
          <div
            className="rounded-2xl p-4 text-center text-xs"
            style={{ background: "var(--row-bg)", color: "var(--text-secondary)" }}
          >
            Включите нужные блоки в конструкторе виджета
          </div>
        )}

        {showBellTimer && (
          <div
            className="rounded-2xl px-3 py-2 flex items-center justify-between gap-2"
            style={{
              background: "var(--row-bg)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <div className="flex items-center gap-2">
              <Clock className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
              <span className="text-[11.5px] font-medium" style={{ color: "var(--text-secondary)" }}>
                Звонок
              </span>
            </div>
            <span
              className="text-[11.5px] font-semibold tabular"
              style={{ color: bellStatus.active ? "var(--green)" : "var(--text-secondary)" }}
            >
              {bellStatus.text}
            </span>
          </div>
        )}

        {showTomorrow && (
          <div
            className="rounded-2xl p-3 space-y-2"
            style={{
              background: "var(--row-bg)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                <Calendar className="w-3.5 h-3.5" style={{ color: "var(--accent)" }} />
                <span>
                  {nextDay
                    ? `${nextDay.weekday}, ${nextDay.date.slice(0, 5)}`
                    : "Ближайший учебный день"}
                </span>
              </div>
              {nextDay && (
                <span className="text-[10.5px] tabular" style={{ color: "var(--text-tertiary)" }}>
                  {nextDay.lessons.length} пар
                </span>
              )}
            </div>

            {nextDay && nextDay.lessons.length > 0 ? (
              <div className="space-y-1.5">
                {nextDay.lessons.map((l, idx) => {
                  const isRunning =
                    isNextDayToday && bellStatus.activePairNumber === l.pairNumber;
                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-2 py-1 px-2 rounded-xl"
                      style={{
                        background: "var(--pill-bg)",
                        border: isRunning
                          ? "1px solid rgba(48, 209, 88, 0.45)"
                          : "1px solid transparent",
                      }}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-5 h-5 rounded-md text-[10.5px] font-semibold tabular flex items-center justify-center shrink-0"
                          style={{
                            background: isRunning
                              ? "rgba(48, 209, 88, 0.22)"
                              : "var(--accent-soft)",
                            color: isRunning ? "var(--green)" : "var(--accent-text)",
                          }}
                        >
                          {l.pairNumber}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[11.5px] font-medium truncate">{l.subject}</div>
                          <div
                            className="text-[10px] tabular truncate"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {l.timeStart}–{l.timeEnd}
                            {isTeacherMode
                              ? l.groupName
                                ? ` · ${l.groupName}`
                                : ""
                              : l.teacher
                              ? ` · ${l.teacher}`
                              : ""}
                          </div>
                        </div>
                      </div>
                      <span
                        className="text-[10.5px] font-medium tabular shrink-0 px-1.5 py-0.5 rounded-md"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {l.room || "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                {isTeacherMode
                  ? "Выберите преподавателя в Настройках"
                  : "Выберите группу в Настройках"}
              </p>
            )}
          </div>
        )}

        {showWeek && (
          <div
            className="rounded-2xl p-3 space-y-2"
            style={{
              background: "var(--row-bg)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11.5px] font-semibold">Неделя</span>
              <div className="flex gap-1 overflow-x-auto">
                {scheduleDays.map((d, i) => (
                  <button
                    key={d.date + i}
                    onClick={() => setWeekDayIdx(i)}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium tabular shrink-0 transition cursor-pointer ${
                      weekDayIdx === i ? "lg-accent-pill" : ""
                    }`}
                    style={
                      weekDayIdx === i
                        ? undefined
                        : { background: "var(--pill-bg)", color: "var(--text-secondary)" }
                    }
                  >
                    {shortWeekday(d.weekday)}
                  </button>
                ))}
              </div>
            </div>

            {selectedWeekDay && selectedWeekDay.lessons.length > 0 ? (
              <div className="space-y-1">
                {selectedWeekDay.lessons.map((l, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-2 text-[11px] py-1 px-2 rounded-xl"
                    style={{ background: "var(--pill-bg)" }}
                  >
                    <span className="truncate">
                      <span className="tabular opacity-60 mr-1.5">{l.pairNumber}.</span>
                      {l.subject}
                    </span>
                    <span
                      className="text-[10px] tabular shrink-0"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {l.room || "—"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Нет пар на выбранный день
              </p>
            )}
          </div>
        )}

        {showConsultations && (
          <div
            className="rounded-2xl p-3 space-y-2"
            style={{
              background: "var(--row-bg)",
              border: "1px solid var(--border-subtle)",
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                <MessageSquareText className="w-3.5 h-3.5" style={{ color: "var(--green)" }} />
                <span>Консультации</span>
              </div>
              <span className="text-[10.5px] tabular" style={{ color: "var(--text-tertiary)" }}>
                {myConsultations.length}
              </span>
            </div>

            {myConsultations.length > 0 ? (
              <div className="space-y-1.5">
                {myConsultations.slice(0, 5).map((c) => (
                  <div
                    key={c.teacherName}
                    className="p-2 rounded-xl space-y-1"
                    style={{ background: "var(--pill-bg)" }}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-medium truncate">
                      {c.isPinned && (
                        <Pin className="w-2.5 h-2.5 shrink-0" style={{ color: "var(--amber)" }} />
                      )}
                      <span className="truncate">{c.teacherName}</span>
                    </div>
                    {c.slots.map((s, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-[10px] tabular"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        <span>
                          {shortWeekday(s.weekday)} {s.date.slice(0, 5)} · {s.time}
                        </span>
                        <span className="font-semibold" style={{ color: "var(--accent-text)" }}>
                          {s.location.startsWith("http") ? "Онлайн" : s.location}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                Закрепите преподавателей или выберите группу
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
