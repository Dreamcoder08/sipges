import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AppearanceSection } from './AppearanceSection.tsx';

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

it('offers Sistema, Claro and Oscuro as one radio group and says the choice is per device', () => {
  render(<AppearanceSection />);
  expect(screen.getByRole('heading', { name: 'Apariencia' })).toBeInTheDocument();
  const group = screen.getByRole('group', { name: 'Tema' });
  expect(group).toBeInTheDocument();
  expect(screen.getAllByRole('radio').map((radio) => radio.parentElement?.textContent)).toEqual([
    'Sistema',
    'Claro',
    'Oscuro',
  ]);
  expect(screen.getByRole('radio', { name: 'Sistema' })).toBeChecked();
  expect(screen.getByText(/en este dispositivo/i)).toBeInTheDocument();
});

it('pins the theme on <html>, persists it and shows which one is on', async () => {
  const user = userEvent.setup();
  render(<AppearanceSection />);
  await user.click(screen.getByRole('radio', { name: 'Oscuro' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  expect(window.localStorage.getItem('sipges.theme')).toBe('dark');
  expect(screen.getByRole('radio', { name: 'Oscuro' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Sistema' })).not.toBeChecked();
  await user.click(screen.getByRole('radio', { name: 'Claro' }));
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  await user.click(screen.getByRole('radio', { name: 'Sistema' }));
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(window.localStorage.getItem('sipges.theme')).toBeNull();
});
