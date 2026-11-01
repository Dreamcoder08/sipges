import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { expect, it } from 'vitest';
import { AccountMenu } from './AccountMenu.tsx';

const renderMenu = (unread: number, links?: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountMenu
        me={{ username: 'demo', full_name: 'Persona Sintética', role: 'consulta', active: 1 }}
        project="ACME/P1"
        unread={unread}
        links={links}
        onSignedOut={() => undefined}
      />
    </QueryClientProvider>,
  );

// WCAG 2.5.3 (label in name): the accessible name must contain the text the button shows.
it('names the trigger with the visible name and role', () => {
  renderMenu(0);
  const trigger = screen.getByRole('button', { name: /^Cuenta de / });
  expect(trigger).toHaveAccessibleName(/Persona Sintética\s*Consulta/);
  expect(trigger).not.toHaveAccessibleName(/sin leer/);
});

it('adds the unread notifications to the trigger name', () => {
  renderMenu(3);
  const trigger = screen.getByRole('button', { name: /^Cuenta de / });
  expect(trigger).toHaveAccessibleName(/Persona Sintética\s*Consulta.*3 notificaciones sin leer/);
});

it('has no theme control: the appearance choice lives in Configuración', async () => {
  const user = userEvent.setup();
  renderMenu(0, <a href="/version-4">Configuración</a>);
  await user.click(screen.getByRole('button', { name: /^Cuenta de / }));
  const sheet = screen.getByRole('dialog', { name: 'Cuenta' });
  expect(within(sheet).queryByRole('radio')).toBeNull();
  expect(within(sheet).queryByText('Apariencia')).toBeNull();
  expect(
    within(within(sheet).getByRole('navigation', { name: 'Cuenta y ajustes' })).getByRole('link', {
      name: 'Configuración',
    }),
  ).toBeVisible();
  expect(within(sheet).getByRole('button', { name: 'Cerrar sesión' })).toBeVisible();
});
