import type { MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LayoutGrid, Minus, Moon, RefreshCw, Square, Sun, X } from "lucide-react";
import appIcon from "../assets/app-icon.png";

interface TitlebarProps {
  selectedGroup: string;
  syncing: boolean;
  widgetEnabled: boolean;
  theme: "dark" | "light";
  lastSyncedAt?: string;
  onSync: () => void;
  onToggleWidget: () => void;
  onToggleTheme: () => void;
}

export function Titlebar({
  selectedGroup,
  syncing,
  widgetEnabled,
  theme,
  lastSyncedAt,
  onSync,
  onToggleWidget,
  onToggleTheme,
}: TitlebarProps) {
  const appWindow = getCurrentWindow();

  const handleDragStart = (e: MouseEvent<HTMLElement>) => {
    if (e.button !== 0 || e.detail > 1) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, input, a, [data-no-drag='true']")) return;
    e.preventDefault();
    appWindow.startDragging();
  };

  const handleDoubleClick = (e: MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("button, input, a, [data-no-drag='true']")) return;
    appWindow.toggleMaximize();
  };

  return (
    <header
      onMouseDown={handleDragStart}
      onDoubleClick={handleDoubleClick}
      className="flex items-center justify-between h-13 px-4 shrink-0 cursor-default"
    >
      {/* Left: clean brand identity (draggable) */}
      <div className="flex items-center gap-3 pointer-events-none">
        <img
          src={appIcon}
          alt="URTK Flow"
          className="w-7 h-7 object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.32)]"
        />
        <div className="flex items-center gap-2.5">
          <span className="text-[13.5px] font-semibold tracking-[-0.01em]">
            URTK Flow
          </span>
          {selectedGroup && (
            <span
              className="px-2.5 py-0.5 text-[11px] font-medium rounded-full tabular"
              style={{
                background: "var(--accent-soft)",
                color: "var(--accent-text)",
              }}
            >
              {selectedGroup}
            </span>
          )}
          {lastSyncedAt && (
            <span
              className="text-[11px] tabular hidden md:inline"
              style={{ color: "var(--text-tertiary)" }}
            >
              Обновлено в {lastSyncedAt}
            </span>
          )}
        </div>
      </div>

      {/* Right: floating Liquid Glass toolbar capsule + native window controls */}
      <div className="flex items-center gap-2" data-no-drag="true">
        <div className="lg-capsule rounded-full p-1 flex items-center gap-1">
          <button
            onClick={onToggleTheme}
            title={theme === "dark" ? "Светлое стекло" : "Тёмное стекло"}
            className="w-7 h-7 rounded-full flex items-center justify-center transition lg-hover cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            {theme === "dark" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Moon className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            onClick={onToggleWidget}
            title={widgetEnabled ? "Скрыть виджет" : "Показать виджет на рабочем столе"}
            className={`flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11.5px] font-medium transition cursor-pointer ${
              widgetEnabled ? "lg-accent-pill" : "lg-hover"
            }`}
            style={widgetEnabled ? undefined : { color: "var(--text-primary)" }}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
            <span>Виджет</span>
          </button>

          <button
            onClick={onSync}
            disabled={syncing}
            title="Обновить данные"
            className="flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11.5px] font-medium transition lg-hover cursor-pointer disabled:opacity-50"
            style={{ color: "var(--text-primary)" }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">{syncing ? "Синхр..." : "Обновить"}</span>
          </button>
        </div>

        <div className="flex items-center gap-0.5 ml-1">
          <button
            onClick={() => appWindow.minimize()}
            aria-label="Свернуть"
            className="w-8 h-8 rounded-full flex items-center justify-center lg-hover transition cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => appWindow.toggleMaximize()}
            aria-label="Развернуть"
            className="w-8 h-8 rounded-full flex items-center justify-center lg-hover transition cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            <Square className="w-3 h-3" />
          </button>
          <button
            onClick={() => appWindow.hide()}
            title="Свернуть в трей"
            aria-label="Свернуть в трей"
            className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-red-500 hover:text-white transition cursor-pointer"
            style={{ color: "var(--text-secondary)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
