import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Alert } from './Alert.tsx';

it('announces errors at once and other tones politely, as before', () => {
  render(
    <>
      <Alert tone="error">Falló</Alert>
      <Alert tone="info">Guardado</Alert>
    </>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Falló');
  expect(screen.getByRole('status')).toHaveTextContent('Guardado');
});

it('drops the live role where a container already reads the message out', () => {
  render(
    <Alert tone="error" announce={false}>
      El analista no respondió.
    </Alert>,
  );
  expect(screen.getByText('El analista no respondió.')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
