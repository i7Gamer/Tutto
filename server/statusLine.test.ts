/**
 * @vitest-environment node
 *
 * The sticky console line itself: what bytes reach stdout, when nothing is
 * written at all, and how it gets out of the way of ordinary log output.
 *
 * Every dependency is injected, so these run without a terminal, a server or a
 * real clock — which is the only way to assert on carriage returns and padding
 * at all (a real TTY would swallow exactly the characters under test).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createStatusLine,
  isStatusLineEnabled,
  STATUS_LINE_ENV_VAR,
  STATUS_LINE_INTERVAL_MS,
  type StatusLineConsole,
} from './statusLine';

const IDLE = '[activity] idle — safe to restart';
const BUSY = '[activity] 1 game in progress · 4 players — DO NOT RESTART';

/** One ordered recording of everything the status line did, in the order it did it. */
const makeRecorder = () => {
  const events: string[] = [];
  const hostConsole: StatusLineConsole = {
    log: (...args) => events.push(`log:${args.join(' ')}`),
    warn: (...args) => events.push(`warn:${args.join(' ')}`),
    error: (...args) => events.push(`error:${args.join(' ')}`),
  };
  return {
    events,
    hostConsole,
    write: (chunk: string) => { events.push(`write:${chunk}`); },
  };
};

const blanks = (length: number): string => ' '.repeat(length);

describe('isStatusLineEnabled', () => {
  it('is on only for the explicit opt-in value', () => {
    expect(isStatusLineEnabled({ [STATUS_LINE_ENV_VAR]: '1' })).toBe(true);
  });

  it.each([
    ['unset', {}],
    ['off', { [STATUS_LINE_ENV_VAR]: '0' }],
    ['a word instead of the flag', { [STATUS_LINE_ENV_VAR]: 'true' }],
    ['empty', { [STATUS_LINE_ENV_VAR]: '' }],
  ])('is off when %s', (_label, env) => {
    expect(isStatusLineEnabled(env)).toBe(false);
  });
});

describe('createStatusLine on a terminal', () => {
  let recorder: ReturnType<typeof makeRecorder>;
  let render: ReturnType<typeof vi.fn<() => string>>;

  const build = (): ReturnType<typeof createStatusLine> => createStatusLine({
    render,
    write: recorder.write,
    isTTY: true,
    hostConsole: recorder.hostConsole,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    recorder = makeRecorder();
    render = vi.fn<() => string>(() => IDLE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints the line immediately on start, with no newline of its own', () => {
    build().start();

    expect(recorder.events).toEqual([`write:\r${IDLE}`]);
  });

  it('writes nothing while the line would say the same thing', () => {
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;

    statusLine.refresh();
    statusLine.refresh();

    expect(recorder.events).toEqual([]);
  });

  it('repaints in place when the line changes', () => {
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;
    render.mockReturnValue(BUSY);

    statusLine.refresh();

    expect(recorder.events).toEqual([`write:\r${BUSY}`]);
  });

  // Without the padding, the tail of the longer previous line stays on screen
  // and the two texts read as one.
  it('blanks the tail of a longer previous line', () => {
    render.mockReturnValue(BUSY);
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;
    render.mockReturnValue(IDLE);

    statusLine.refresh();

    expect(recorder.events).toEqual([`write:\r${IDLE}${blanks(BUSY.length - IDLE.length)}`]);
  });

  it('repaints on its own once the state changes under it', () => {
    build().start();
    recorder.events.length = 0;

    vi.advanceTimersByTime(STATUS_LINE_INTERVAL_MS);
    expect(recorder.events).toEqual([]);

    render.mockReturnValue(BUSY);
    vi.advanceTimersByTime(STATUS_LINE_INTERVAL_MS);

    expect(recorder.events).toEqual([`write:\r${BUSY}`]);
  });

  // A [client-error] report landing mid-line would otherwise be half overwritten
  // by the next repaint — the status line has to yield the line first.
  it.each([
    ['log', (c: StatusLineConsole) => c.log('client crashed')],
    ['warn', (c: StatusLineConsole) => c.warn('client crashed')],
    ['error', (c: StatusLineConsole) => c.error('client crashed')],
  ])('clears itself around console.%s and repaints underneath', (method, emit) => {
    build().start();
    recorder.events.length = 0;

    emit(recorder.hostConsole);

    expect(recorder.events).toEqual([
      `write:\r${blanks(IDLE.length)}\r`,
      `${method}:client crashed`,
      `write:\r${IDLE}`,
    ]);
  });

  it('passes every argument through to the real console method', () => {
    build().start();
    recorder.events.length = 0;

    recorder.hostConsole.log('one', 'two', 'three');

    expect(recorder.events).toContain('log:one two three');
  });

  it('repaints the current line, not the one from when the console was patched', () => {
    build().start();
    render.mockReturnValue(BUSY);
    recorder.events.length = 0;

    recorder.hostConsole.log('client crashed');

    expect(recorder.events.at(-1)).toBe(`write:\r${BUSY}`);
  });

  it('gives the console back on stop', () => {
    const statusLine = build();
    statusLine.start();
    statusLine.stop();
    recorder.events.length = 0;

    recorder.hostConsole.log('after shutdown');

    expect(recorder.events).toEqual(['log:after shutdown']);
  });

  it('ends the line so shutdown logging starts on a clean one', () => {
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;

    statusLine.stop();

    expect(recorder.events).toEqual(['write:\n']);
  });

  it('stops repainting once stopped', () => {
    const statusLine = build();
    statusLine.start();
    statusLine.stop();
    recorder.events.length = 0;
    render.mockReturnValue(BUSY);

    vi.advanceTimersByTime(STATUS_LINE_INTERVAL_MS * 3);

    expect(recorder.events).toEqual([]);
  });

  it('does nothing when stopped without ever being started', () => {
    build().stop();

    expect(recorder.events).toEqual([]);
  });

  // Both signal handlers and the shutdown path can reach stop(); a second
  // trailing newline would push a blank line into the middle of the log.
  it('is safe to stop twice', () => {
    const statusLine = build();
    statusLine.start();
    statusLine.stop();
    recorder.events.length = 0;

    statusLine.stop();

    expect(recorder.events).toEqual([]);
  });
});

describe('createStatusLine without a terminal', () => {
  let recorder: ReturnType<typeof makeRecorder>;
  let render: ReturnType<typeof vi.fn<() => string>>;

  const build = (): ReturnType<typeof createStatusLine> => createStatusLine({
    render,
    write: recorder.write,
    isTTY: false,
    hostConsole: recorder.hostConsole,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    recorder = makeRecorder();
    render = vi.fn<() => string>(() => IDLE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Carriage returns and padding are meaningless in a file or a `docker logs`
  // stream, so a redirected log gets whole lines — still only when they change.
  it('prints whole lines instead of rewriting one', () => {
    const statusLine = build();
    statusLine.start();
    render.mockReturnValue(BUSY);
    statusLine.refresh();

    expect(recorder.events).toEqual([`write:${IDLE}\n`, `write:${BUSY}\n`]);
  });

  it('still writes nothing while the line would say the same thing', () => {
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;

    statusLine.refresh();

    expect(recorder.events).toEqual([]);
  });

  // There is no line to yield, so the console is left exactly as it was.
  it('leaves the console alone', () => {
    build().start();
    recorder.events.length = 0;

    recorder.hostConsole.log('client crashed');

    expect(recorder.events).toEqual(['log:client crashed']);
  });

  it('adds no trailing newline on stop', () => {
    const statusLine = build();
    statusLine.start();
    recorder.events.length = 0;

    statusLine.stop();

    expect(recorder.events).toEqual([]);
  });
});
