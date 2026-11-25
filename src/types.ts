export interface GroupInfo {
  id: string;
  name: string;
  course: string;
  specialtyCode: string;
  specialtyName: string;
  driveUrl?: string | null;
}

export interface TeacherInfo {
  id: string;
  name: string;
}

export interface LessonItem {
  pairNumber: number;
  timeStart: string;
  timeEnd: string;
  subject: string;
  teacher: string;
  room: string;
  lessonType?: string | null;
  groupName?: string | null;
}

export interface DaySchedule {
  date: string;
  weekday: string;
  lessons: LessonItem[];
}

export interface ConsultationSlot {
  weekday: string;
  date: string;
  time: string;
  location: string;
}

export interface TeacherConsultations {
  teacherName: string;
  isMyTeacher: boolean;
  isPinned: boolean;
  slots: ConsultationSlot[];
}

export interface BellSlot {
  pairNumber: number;
  part1: string;
  part2: string;
  breakAfter: string;
}

export interface WidgetConfig {
  enabled: boolean;
  showTomorrowSchedule: boolean;
  showWeekSchedule: boolean;
  showConsultations: boolean;
  showBellTimer: boolean;
  opacity: number;
  pinToDesktop: boolean;
  width: number;
  height: number;
  x?: number | null;
  y?: number | null;
}

export interface NotificationSettings {
  enabled: boolean;
  morningSummary: boolean;
  morningTime: string;
  onNewConsultation: boolean;
  onScheduleChange: boolean;
}

export interface AppSettings {
  theme: "dark" | "light";
  role: "student" | "teacher";
  selectedGroup: string;
  selectedTeacher: string;
  multiGroupsEnabled: boolean;
  extraGroups: string[];
  pinnedTeachers: string[];
  hiddenTeachers: string[];
  syncIntervalMinutes: number;
  notifications: NotificationSettings;
  widget: WidgetConfig;
  autostart: boolean;
  startMinimizedOnBoot: boolean;
  autoUpdateCheck: boolean;
  updateEndpoint: string;
}

export interface UpdateManifest {
  version: string;
  publishedAt: string;
  notes: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number;
  signature?: string;
  signatureV2?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  updateAvailable: boolean;
  manifest?: UpdateManifest | null;
  checkedUrl: string;
  checkedAt: string;
}

export interface UpdateProgress {
  stage: "connecting" | "downloading" | "verifying" | "installing" | string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface SyncPayload {
  lastSyncedAt: string;
  consultationWeekRange: string;
  groups: GroupInfo[];
  teachers: TeacherInfo[];
  schedule: DaySchedule[];
  extraSchedules: Record<string, DaySchedule[]>;
  groupTeachers: string[];
  consultations: TeacherConsultations[];
  bellsMonday: BellSlot[];
  bellsRegular: BellSlot[];
  settings: AppSettings;
  newConsultationsDetected: string[];
}
