import { describe, expect, test } from "bun:test";
import { IdleTidy, type ScheduleIdle } from "../src/idle-tidy.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts";

function clock() {
  let now = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const schedule: ScheduleIdle = (callback, delayMs) => {
    const timer = { at: now + delayMs, callback, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  };
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers) {
      if (timer.cancelled || timer.at > now) continue;
      timer.cancelled = true;
      timer.callback();
    }
  };
  return { schedule, timers, advance };
}

const DELAY = 55 * 60_000;

describe("idle tidy clock", () => {
  test("starts only at agent_end, not input or startup; fires once exactly at the configured deadline", () => {
    const c = clock();
    const idle = new IdleTidy(true, DELAY, c.schedule);
    const sent: string[] = [];
    const end = () => idle.agentEnded(true, () => true, (id) => sent.push(id));
    end(); // No actual user input yet.
    expect(c.timers).toHaveLength(0);
    idle.input(true);
    c.advance(DELAY * 2);
    expect(sent).toEqual([]);
    end();
    c.advance(DELAY - 1);
    expect(sent).toEqual([]);
    c.advance(1);
    expect(sent).toHaveLength(1);
    expect(idle.activeRequest).toBe(sent[0]!);
    c.advance(DELAY * 10);
    expect(sent).toHaveLength(1);
  });

  test("user input and agent_start cancel; retries time from their own end, not an earlier end", () => {
    const c = clock();
    const idle = new IdleTidy(true, 100, c.schedule);
    let sent = 0;
    const end = () => idle.agentEnded(true, () => true, () => sent++);
    idle.input(true);
    end();
    c.advance(90);
    idle.input(true);
    c.advance(100);
    expect(sent).toBe(0);
    end();
    c.advance(90);
    idle.cancel(); // agent_start of an automatic retry
    c.advance(100);
    expect(sent).toBe(0);
    end();
    c.advance(99);
    expect(sent).toBe(0);
    c.advance(1);
    expect(sent).toBe(1);
  });

  test("tidy and all its continuations cannot re-arm; only genuine user input grants another opportunity", () => {
    const c = clock();
    const idle = new IdleTidy(true, 100, c.schedule);
    const sent: string[] = [];
    const end = () => idle.agentEnded(true, () => true, (id) => sent.push(id));
    idle.input(true);
    end();
    c.advance(100);
    const first = idle.activeRequest;
    idle.cancel(); // tidy agent_start
    end();
    expect(idle.activeRequest).toBe(first); // stay scoped across agent_end → auto continuation
    idle.cancel();
    end();
    idle.settled();
    expect(idle.activeRequest).toBeNull();
    c.advance(1000);
    idle.input(false); // extension message, not a real user
    end();
    c.advance(1000);
    expect(sent).toHaveLength(1);
    idle.input(true);
    end();
    c.advance(100);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toBe(sent[1]);
  });

  test("reset invalidates even an already-dispatched stale callback and active request ids", () => {
    const c = clock();
    const idle = new IdleTidy(true, 100, c.schedule);
    let sent = 0;
    idle.input(true);
    idle.agentEnded(true, () => true, () => sent++);
    const old = c.timers[0]!;
    idle.reset();
    old.callback();
    expect(sent).toBe(0);
    idle.agentEnded(true, () => true, () => sent++);
    c.advance(100);
    expect(sent).toBe(0);
    expect(idle.activeRequest).toBeNull();
  });

  test("disabled/non-interactive sessions never schedule; busy or stale sessions never send", () => {
    for (const [enabled, interactive] of [[false, true], [true, false]]) {
      const c = clock();
      const idle = new IdleTidy(enabled!, 100, c.schedule);
      idle.input(true);
      idle.agentEnded(interactive!, () => true, () => { throw new Error("must not send"); });
      expect(c.timers).toHaveLength(0);
    }
    for (const canSend of [() => false, () => { throw new Error("stale ctx"); }]) {
      const c = clock();
      const idle = new IdleTidy(true, 100, c.schedule);
      let sent = 0;
      idle.input(true);
      idle.agentEnded(true, canSend, () => sent++);
      c.advance(100);
      expect(sent).toBe(0);
      expect(idle.activeRequest).toBeNull();
    }
  });

  test("send failure consumes the opportunity and is not retried at later agent_end", () => {
    const c = clock();
    const idle = new IdleTidy(true, 100, c.schedule);
    let sent = 0;
    const end = () => idle.agentEnded(true, () => true, () => { sent++; throw new Error("send failed"); });
    idle.input(true);
    end();
    c.advance(100);
    end();
    c.advance(100);
    expect(sent).toBe(1);
    expect(idle.activeRequest).toBeNull();
  });
});

describe("idle tidy config", () => {
  test("off by default, 55 minutes, opt-in and configurable via existing JSON parser", () => {
    expect(DEFAULT_CONFIG.idleTidyEnabled).toBe(false);
    expect(parseConfig({}).idleTidyAfterMinutes).toBe(55);
    expect(parseConfig({ idleTidyEnabled: true, idleTidyAfterMinutes: 12.5 })).toMatchObject({ idleTidyEnabled: true, idleTidyAfterMinutes: 12.5 });
    expect(parseConfig({ idleTidyEnabled: "true" }).idleTidyEnabled).toBe(false);
    for (const invalid of [0, -1, 0.5, "55", NaN, Infinity, 40_000]) {
      expect(parseConfig({ idleTidyAfterMinutes: invalid }).idleTidyAfterMinutes).toBe(55);
    }
  });
});
