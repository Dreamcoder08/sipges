import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RecordDetail } from './RecordDetail.tsx';

it('shows why a MASCLI 4.0 alert was raised, with links to its records', () => {
  render(
    <RecordDetail
      module="alertas"
      record={{
        _id: 'AL-7',
        Causa: 'Naranja – Requiere intervención preventiva: existen 3 registros…',
        Nivel_Preliminar: 'Naranja',
        Origen: 'MASCLI 4.0',
        Situacion: 'tema:empleo local',
        Explicacion:
          '3 registros relacionados con el tema «Empleo local» en 5 día(s).\nParticipan Comunidad Norte.',
        Registros_Relacionados: ['Demandas:D-1', 'Eventos:EV-1'],
      }}
    />,
  );
  expect(
    screen.getByRole('heading', { name: 'Por qué se generó esta alerta' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Participan Comunidad Norte.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Demandas D-1' })).toHaveAttribute(
    'href',
    '/objeto/demandas/D-1',
  );
  expect(screen.queryByText('Registros_Relacionados')).not.toBeInTheDocument();
});

it('keeps other alerts exactly as before', () => {
  render(<RecordDetail module="alertas" record={{ _id: 'AL-1', Causa: 'Bloqueo', Otro: 'x' }} />);
  expect(screen.queryByText('Por qué se generó esta alerta')).not.toBeInTheDocument();
  expect(screen.getByText('Otro')).toBeInTheDocument();
});
