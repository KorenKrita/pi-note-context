import { spyOn } from "bun:test";

/** Capture only the configured 55-minute timer; leave Pi's own scheduling/IO timers untouched. */
export async function withIdleTimers<T>(run: (timers: { fire(): void; handle: ReturnType<typeof setTimeout> }[]) => Promise<T>): Promise<T> {
  const original = globalThis.setTimeout;
  const timers: { fire(): void; handle: ReturnType<typeof setTimeout> }[] = [];
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    const handle = original(callback, delay, ...args) as ReturnType<typeof setTimeout>;
    if (delay === 55 * 60_000) timers.push({ handle, fire: () => { clearTimeout(handle); callback(); } });
    return handle;
  }) as typeof setTimeout);
  try {
    return await run(timers);
  } finally {
    for (const timer of timers) clearTimeout(timer.handle);
    spy.mockRestore();
  }
}
