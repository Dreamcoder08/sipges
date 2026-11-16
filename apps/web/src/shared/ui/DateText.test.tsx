import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DateText } from './DateText.tsx';

// functional-10 T1: people read the Lima day; `<time datetime>` keeps the stored value.
it('shows a stored instant as its Lima date and time and keeps the machine value', () => {
  const { container } = render(<DateText value="2026-11-15T03:33:35Z" time />);
  const time = container.querySelector('time');
  expect(time).toHaveAttribute('datetime', '2026-11-15T03:33:35Z');
  expect(time).toHaveTextContent('14 nov. 2026, 22:33');
});

it('shows a stored day without moving it', () => {
  const { container } = render(<DateText value="2026-11-14" />);
  expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-11-14');
  expect(container).toHaveTextContent('14 nov. 2026');
});

it('leaves text that is not a date as plain text and an empty value as the fallback', () => {
  const { container, rerender } = render(<DateText value="30 días hábiles" />);
  expect(container.querySelector('time')).toBeNull();
  expect(container).toHaveTextContent('30 días hábiles');
  rerender(<DateText value="" fallback="Sin fecha" />);
  expect(container.querySelector('time')).toBeNull();
  expect(container).toHaveTextContent('Sin fecha');
});
