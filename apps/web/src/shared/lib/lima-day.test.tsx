import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLimaDay } from './lima-day.ts';

// Compiled like the screens that use it, so a value cached by React Compiler would show here.
const Day = () => {
  'use memo';
  const day = useLimaDay();
  return <p>{day}</p>;
};

describe('useLimaDay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves to the next Lima calendar day at Lima midnight without any other render', () => {
    vi.useFakeTimers();
    // 23:59:30 in Lima (UTC-5) on 2026-11-19.
    vi.setSystemTime(new Date('2026-11-20T04:59:30Z'));
    render(<Day />);
    expect(screen.getByText('2026-11-19')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(31_000);
    });
    expect(screen.getByText('2026-11-20')).toBeInTheDocument();
  });

  it('stops its timer when the component unmounts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T04:59:30Z'));
    const { unmount } = render(<Day />);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
