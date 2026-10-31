import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AccountMenu } from './AccountMenu.tsx';

const renderMenu = (unread: number) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AccountMenu
        me={{ username: 'demo', full_name: 'Persona Sintética', role: 'consulta', active: 1 }}
        project="ACME/P1"
        unread={unread}
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
