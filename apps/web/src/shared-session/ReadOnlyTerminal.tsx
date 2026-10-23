import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
// 与 `TerminalSurface` 同理：样式跟着 xterm 进懒加载的 chunk，不进入口。
import "@xterm/xterm/css/xterm.css";

import { terminalWebSocketUrl } from "@/api/sockets";
import type { Source } from "@/api/source";
import { usePreferencesStore } from "@/app/preferences-store";
import { TERMINAL_SCROLLBACK } from "@/terminal/surface/constants";
import {
  terminalAppearance,
  terminalSchemeAttribute,
  terminalTheme,
  watchAppTheme,
} from "@/terminal/surface/appearance";
import {
  createTerminalTransport,
  type TerminalTransport,
} from "@/terminal/transport";

/** 断开之后多久重连（源离线、中继重启时）。 */
const RECONNECT_MS = 2_000;

export type ReadOnlyTerminalState = "connecting" | "live" | "offline";

/**
 * 只读附着一条终端会话（契约 §60.1）：画面照常来，xterm 不收键盘
 * （`disableStdin`），不发 `input` / `terminate`；`resize` 只改这一端自己的视图。
 * core 那边对只读的人同样丢掉输入，这里只是不让人以为能打字。
 */
export function ReadOnlyTerminal({
  source,
  sessionId,
  onState,
}: {
  source: Source;
  sessionId: string;
  onState?: (state: ReadOnlyTerminalState) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const colorScheme = usePreferencesStore(
    (state) => state.terminal.colorScheme,
  );
  const stateRef = React.useRef(onState);
  stateRef.current = onState;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK,
      ...terminalAppearance(usePreferencesStore.getState().terminal, container),
      disableStdin: true,
      cursorBlink: false,
    });
    terminalRef.current = terminal;
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // 容器还没布局（宽高为 0）时 fit 会抛；下一次观测再来。
      }
    };
    refit();

    let disposed = false;
    let transport: TerminalTransport | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (state: ReadOnlyTerminalState) => stateRef.current?.(state);

    const connect = () => {
      if (disposed) return;
      report("connecting");
      transport = createTerminalTransport(
        terminalWebSocketUrl(sessionId, undefined, source),
        {
          onHello: () => {
            terminal.reset();
            report("live");
            transport?.resize(terminal.cols, terminal.rows);
          },
          onSnapshot: (data) => terminal.write(data),
          onOutput: (data) => terminal.write(data),
          onStale: () => terminal.reset(),
          onClose: () => {
            transport = null;
            if (disposed) return;
            report("offline");
            timer = setTimeout(connect, RECONNECT_MS);
          },
        },
      );
    };
    connect();

    const observer = new ResizeObserver(() => {
      refit();
      transport?.resize(terminal.cols, terminal.rows);
    });
    observer.observe(container);

    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      transport?.close();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [source, sessionId]);

  // 应用主题或终端配色变了：只换调色板，不重建（与 `TerminalSurface` 一致，#501）。
  // 属性随渲染写在外层上，所以这个 effect 跑的时候计算样式已经是新的。
  React.useEffect(() => {
    const apply = () => {
      const container = containerRef.current;
      const terminal = terminalRef.current;
      if (container && terminal)
        terminal.options.theme = terminalTheme(container);
    };
    apply();
    return watchAppTheme(apply);
  }, [colorScheme]);

  return (
    <div
      data-slot="read-only-terminal"
      data-term-scheme={terminalSchemeAttribute(colorScheme)}
      className="h-full min-h-0 w-full overflow-hidden bg-term p-2"
    >
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
