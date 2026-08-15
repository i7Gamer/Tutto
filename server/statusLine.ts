// A single console line that says whether anyone is playing right now, kept at
// the bottom of the server's log and rewritten in place instead of appended.
//
// It exists for one question, asked in front of a terminal: may I close this
// window and restart? The room registry only lives inside this process, so the
// answer has to be visible before the process ends.
//
// Off unless asked for. The opt-in is an environment variable rather than a TTY
// check because the feature belongs to one workflow — start-tutto-prod.bat sets
// it — and a container, a CI run or a spawned test server must log exactly what
// it logged before. See README, "Restart safety".

export const STATUS_LINE_ENV_VAR = 'TUTTO_STATUS_LINE';

/** The only value that turns the line on — matches TRUST_PROXY's convention. */
const STATUS_LINE_ENABLED_VALUE = '1';

/**
 * How often the line is re-rendered. Only a *changed* line is written, so this
 * is the delay before a game starting or ending shows up, not a write rate.
 */
export const STATUS_LINE_INTERVAL_MS = 5_000;

export const isStatusLineEnabled = (env: Record<string, string | undefined>): boolean =>
  env[STATUS_LINE_ENV_VAR] === STATUS_LINE_ENABLED_VALUE;

/** The console methods the sticky line has to get out of the way of. */
export interface StatusLineConsole {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const PATCHED_CONSOLE_METHODS = ['log', 'warn', 'error'] as const;

interface StatusLineDependencies {
  /** The line to display. Called on every tick; cheap and side-effect free. */
  render: () => string;
  write: (chunk: string) => void;
  /** Rewrite one line in place when true, print changed lines when false. */
  isTTY: boolean;
  /** The console to yield the line to. The real global one in production. */
  hostConsole: StatusLineConsole;
  intervalMs?: number;
}

export interface StatusLine {
  start: () => void;
  stop: () => void;
  /** Render and, only if the text changed, write. The tick does exactly this. */
  refresh: () => void;
}

export const createStatusLine = ({
  render,
  write,
  isTTY,
  hostConsole,
  intervalMs = STATUS_LINE_INTERVAL_MS,
}: StatusLineDependencies): StatusLine => {
  let started = false;
  let lastLine = '';
  /** Characters currently occupying the sticky line, for blanking it. */
  let paintedLength = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let originalConsole: StatusLineConsole | null = null;

  const paint = (line: string): void => {
    if (isTTY) {
      // Carriage return, not an ANSI erase sequence: plain cmd.exe honours it
      // without VT processing. The padding blanks whatever the previous, longer
      // line left behind — without it the two texts run together.
      write(`\r${line}${' '.repeat(Math.max(0, paintedLength - line.length))}`);
      paintedLength = line.length;
    } else {
      write(`${line}\n`);
    }
    lastLine = line;
  };

  const refresh = (): void => {
    const line = render();
    if (line === lastLine) return;
    paint(line);
  };

  /** Hands the line back to the terminal, blank, with the cursor at its start. */
  const clear = (): void => {
    write(`\r${' '.repeat(paintedLength)}\r`);
    paintedLength = 0;
  };

  // Anything else reaching stdout — a [client-error] report, a warning — would
  // be half erased by the next repaint. Wrapping the console is what keeps the
  // sticky line strictly below the scrolling log instead of inside it.
  const patchConsole = (): void => {
    if (!isTTY) return;
    originalConsole = { log: hostConsole.log, warn: hostConsole.warn, error: hostConsole.error };
    for (const method of PATCHED_CONSOLE_METHODS) {
      const original = originalConsole[method];
      hostConsole[method] = (...args: unknown[]): void => {
        clear();
        original.call(hostConsole, ...args);
        paint(render());
      };
    }
  };

  const restoreConsole = (): void => {
    if (!originalConsole) return;
    for (const method of PATCHED_CONSOLE_METHODS) {
      hostConsole[method] = originalConsole[method];
    }
    originalConsole = null;
  };

  return {
    start: (): void => {
      if (started) return;
      started = true;
      refresh();
      patchConsole();
      timer = setInterval(refresh, intervalMs);
      // Belt and braces: shutdown stops the line before the closers run, but a
      // repeating timer must never be the reason a process outlives its server.
      timer.unref?.();
    },

    stop: (): void => {
      if (!started) return;
      started = false;
      if (timer) clearInterval(timer);
      timer = null;
      restoreConsole();
      // Close the line the shutdown log is about to write over.
      if (isTTY) write('\n');
    },

    refresh,
  };
};
