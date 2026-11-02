import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ChipRow } from './ChipRow.tsx';

const rect = (left: number, width: number) =>
  ({ left, right: left + width, width, top: 0, bottom: 40, height: 40, x: left, y: 0 }) as DOMRect;

/** Lays the chips out 120 px apart in a 360 px row, as on a phone, since jsdom has no layout. */
const layOut = (row: HTMLElement) => {
  row.getBoundingClientRect = () => rect(0, 360);
  [...row.children].forEach((chip, index) => {
    chip.getBoundingClientRect = () => rect(index * 120 - row.scrollLeft, 110);
  });
};

const Row = ({ pressed }: { pressed: number }) => (
  <ChipRow label="Vistas">
    {['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco'].map((name, index) => (
      <button key={name} type="button" aria-pressed={index === pressed}>
        {name}
      </button>
    ))}
  </ChipRow>
);

it('scrolls a chosen chip that starts off-screen to the start of the row', () => {
  const { rerender } = render(<Row pressed={0} />);
  const row = screen.getByRole('group', { name: 'Vistas' });
  layOut(row);
  rerender(<Row pressed={3} />);
  expect(row.scrollLeft).toBe(360);
});

it('leaves the row where it is when the chosen chip is already visible', () => {
  const { rerender } = render(<Row pressed={0} />);
  const row = screen.getByRole('group', { name: 'Vistas' });
  layOut(row);
  rerender(<Row pressed={1} />);
  expect(row.scrollLeft).toBe(0);
});

it('reveals the chosen chip again when chips before it grow', () => {
  let resized: (() => void) | undefined;
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: () => void) {
      resized = callback;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  try {
    render(<Row pressed={1} />);
    const row = screen.getByRole('group', { name: 'Vistas' });
    // A late count widens the first chip and pushes the chosen one past the right edge.
    row.getBoundingClientRect = () => rect(0, 360);
    const chosen = row.children[1] as HTMLElement;
    chosen.getBoundingClientRect = () => rect(300 - row.scrollLeft, 110);
    resized?.();
    expect(row.scrollLeft).toBe(300);
  } finally {
    globalThis.ResizeObserver = original;
  }
});
