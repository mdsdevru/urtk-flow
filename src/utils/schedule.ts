import { BellSlot, DaySchedule } from "../types";

export interface BellStatus {
  text: string;
  active: boolean;
  activePairNumber: number | null;
  nextPairNumber: number | null;
}

export function shortWeekday(weekday: string): string {
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

export function normalizeTeacherKey(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\./g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function teacherNamesMatch(aRaw: string, bRaw: string): boolean {
  const a = normalizeTeacherKey(aRaw);
  const b = normalizeTeacherKey(bRaw);
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

export function parseMinutesStrict(hhmm: string): number | null {
  const m = String(hhmm || "")
    .trim()
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatMinutesRu(totalMins: number): string {
  const mins = Math.max(1, Math.round(totalMins));
  if (mins < 60) return `${mins} мин`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

export function parseDateRu(dateStr: string): Date | null {
  const [dd, mm, yyyy] = String(dateStr || "").split(".").map(Number);
  if (!dd || !mm || !yyyy) return null;
  return new Date(yyyy, mm - 1, dd);
}

export function formatDateRu(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export function pickUpcomingDayIdx(schedule: DaySchedule[], now = new Date()): number {
  if (!schedule.length) return 0;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const minTs = now.getHours() >= 19 ? todayStart + 86_400_000 : todayStart;
  const idx = schedule.findIndex((d) => {
    const dt = parseDateRu(d.date);
    return dt !== null && dt.getTime() >= minTs;
  });
  return idx >= 0 ? idx : 0;
}

export function computeBellStatus(
  now: Date,
  schedule: DaySchedule[],
  bellsMonday: BellSlot[],
  bellsRegular: BellSlot[],
  selectedGroup: string
): BellStatus {
  const day = now.getDay();
  if (day === 0) {
    return {
      text: "Выходной",
      active: false,
      activePairNumber: null,
      nextPairNumber: null,
    };
  }

  const bells = day === 1 ? bellsMonday : bellsRegular;
  const bellByPair = new Map<number, { start: number; end: number }>();
  for (const b of bells) {
    const start = parseMinutesStrict(b.part1.split(/[–-]/)[0] || "");
    const end = parseMinutesStrict(b.part2.split(/[–-]/)[1] || "");
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

  const hasGroupSchedule =
    Boolean(selectedGroup) &&
    schedule.length > 0 &&
    schedule.some((d) => {
      const dt = parseDateRu(d.date);
      return dt !== null && dt.getTime() >= weekMondayTs;
    });

  if (hasGroupSchedule) {
    const todayDay = schedule.find((d) => d.date === todayStr);
    if (!todayDay || todayDay.lessons.length === 0) {
      return {
        text: "Сегодня пар нет",
        active: false,
        activePairNumber: null,
        nextPairNumber: null,
      };
    }

    const intervals: { pairNumber: number; start: number; end: number }[] = [];
    for (const l of todayDay.lessons) {
      const fallback = bellByPair.get(l.pairNumber);
      const start = parseMinutesStrict(l.timeStart) ?? fallback?.start ?? null;
      const end = parseMinutesStrict(l.timeEnd) ?? fallback?.end ?? null;
      if (start !== null && end !== null && end > start) {
        intervals.push({ pairNumber: l.pairNumber, start, end });
      }
    }

    if (intervals.length === 0) {
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
        nextPairNumber: upcomingAfter?.pairNumber ?? null,
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

  for (const b of bells) {
    const slot = bellByPair.get(b.pairNumber);
    if (!slot) continue;
    if (cur < slot.start) {
      return {
        text: `До ${b.pairNumber} пары · ${formatMinutesRu(slot.start - cur)}`,
        active: true,
        activePairNumber: null,
        nextPairNumber: b.pairNumber,
      };
    }
    if (cur >= slot.start && cur < slot.end) {
      return {
        text: `${b.pairNumber} пара · ещё ${formatMinutesRu(slot.end - cur)}`,
        active: true,
        activePairNumber: b.pairNumber,
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
