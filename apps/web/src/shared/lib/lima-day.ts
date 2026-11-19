import { limaToday } from '@sipges/kernel';
import { useEffect, useState } from 'react';

const DAY_MS = 86_400_000;
// Lima keeps UTC-5 all year, so its midnight is always 05:00 UTC.
const LIMA_MIDNIGHT_UTC_MS = 5 * 3_600_000;

/** Milliseconds from `now` to the next Lima midnight, plus a small margin so the day has turned. */
const untilNextLimaDay = (now: number): number =>
  DAY_MS - ((now - LIMA_MIDNIGHT_UTC_MS) % DAY_MS) + 1_000;

/**
 * The Lima calendar day (YYYY-MM-DD), re-rendered when it changes. Use it instead of `new Date()`
 * during render: React Compiler caches a render-time `new Date()` with the other inputs of its
 * computation, so a value derived from it would stay on yesterday until those inputs change.
 */
export const useLimaDay = (): string => {
  const [day, setDay] = useState(() => limaToday());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    // A timer can fire before the day turns (clock resync, throttled tab); then it arms again
    // instead of waiting for a render that a same-day value would never cause.
    const arm = () => {
      timer = setTimeout(() => {
        const now = limaToday();
        if (now === day) arm();
        else setDay(now);
      }, untilNextLimaDay(Date.now()));
    };
    arm();
    return () => clearTimeout(timer);
  }, [day]);
  return day;
};

/** Noon of a Lima calendar day, a Date whose Lima day is `day` in any host timezone. */
export const limaNoon = (day: string): Date => new Date(`${day}T12:00:00-05:00`);
