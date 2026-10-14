import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { TimeHistogram } from './TimeHistogram.tsx';

const series = [
  { month: '2026-08', count: 1 },
  { month: '2026-09', count: 0 },
  { month: '2026-10', count: 3 },
];

const Harness = () => {
  const [range, setRange] = useState({ from: '', to: '' });
  return (
    <>
      <TimeHistogram
        series={series}
        from={range.from}
        to={range.to}
        label="Actividad"
        onChange={(from, to) => setRange({ from, to })}
      />
      <output>{`${range.from}..${range.to}`}</output>
    </>
  );
};

it('selects a month, extends with Shift and clears on a second click', async () => {
  render(<Harness />);
  const user = userEvent.setup();
  const october = screen.getByRole('button', { name: 'Octubre de 2026: 3 registros' });
  await user.click(october);
  expect(screen.getByRole('status')).toHaveTextContent('2026-10..2026-10');
  expect(october).toHaveAttribute('aria-pressed', 'true');
  await user.keyboard('{Shift>}');
  await user.click(screen.getByRole('button', { name: 'Agosto de 2026: 1 registro' }));
  await user.keyboard('{/Shift}');
  expect(screen.getByRole('status')).toHaveTextContent('2026-08..2026-10');
  expect(screen.getByRole('button', { name: /iembre de 2026: 0 registros/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(october);
  expect(screen.getByRole('status')).toHaveTextContent('2026-10..2026-10');
  october.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('status')).toHaveTextContent('..');
});
