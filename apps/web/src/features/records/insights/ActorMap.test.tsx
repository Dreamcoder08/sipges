import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ActorMap } from './ActorMap.tsx';

const rows = [
  {
    _id: 'A-1',
    'Nombre_Actor/Organizacion': 'Municipalidad de prueba',
    Tipo_Actor: 'Autoridad local',
    Influencia: 'Alta',
    Posicion_Proyecto: 'A favor',
  },
  {
    _id: 'A-2',
    'Nombre_Actor/Organizacion': 'Cámara de Comercio de prueba',
    Tipo_Actor: 'Empresa',
    Influencia: 'Media',
    Posicion_Proyecto: 'En contra',
  },
  {
    _id: 'A-3',
    'Nombre_Actor/Organizacion': 'Comunidad de prueba',
    Tipo_Actor: 'Comunal',
    Influencia: 'Baja',
    Posicion_Proyecto: 'Expectante',
  },
];

const mapActors = () =>
  within(screen.getByRole('group', { name: 'Mapa de actores por sector e influencia' }))
    .getAllByRole('button')
    .map((node) => node.getAttribute('aria-label')?.split('.')[0]);
const listedActors = () =>
  screen.getAllByRole('button', { name: /^Ficha de actor/ }).map((node) => node.textContent);

it('keeps the search, sector, position and zoom controls in one toolbar above the map', () => {
  render(<ActorMap rows={rows} onOpen={vi.fn()} />);
  const toolbar = screen.getByRole('group', { name: 'Filtros del mapa de actores' });
  expect(within(toolbar).getByRole('searchbox', { name: 'Buscar actor' })).toBeInTheDocument();
  expect(within(toolbar).getByRole('combobox', { name: 'Sector' })).toBeInTheDocument();
  expect(
    within(toolbar).getByRole('combobox', { name: 'Posición frente al proyecto' }),
  ).toBeInTheDocument();
  expect(within(toolbar).getByRole('button', { name: 'Acercar mapa' })).toBeInTheDocument();
  expect(screen.getByText('3 actores')).toBeInTheDocument();
});

it('narrows the map and the list by actor name, ignoring case and accents', async () => {
  render(<ActorMap rows={rows} onOpen={vi.fn()} />);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar actor' }), 'camara');
  expect(mapActors()).toEqual(['Cámara de Comercio de prueba']);
  expect(listedActors()).toEqual(['Ficha de actor A-2']);
  expect(screen.getByText('1 de 3 actores en el mapa')).toBeInTheDocument();
});

it('narrows the map and the list by position towards the project', async () => {
  render(<ActorMap rows={rows} onOpen={vi.fn()} />);
  await userEvent.selectOptions(
    screen.getByRole('combobox', { name: 'Posición frente al proyecto' }),
    'Expectante',
  );
  expect(mapActors()).toEqual(['Comunidad de prueba']);
  expect(listedActors()).toEqual(['Ficha de actor A-3']);
});

it('still filters by sector and keeps the sector counts of the whole project', async () => {
  render(<ActorMap rows={rows} onOpen={vi.fn()} />);
  const sector = screen.getByRole('combobox', { name: 'Sector' });
  expect(within(sector).getByRole('option', { name: 'Gobierno · 1' })).toBeInTheDocument();
  await userEvent.selectOptions(sector, 'Gobierno');
  expect(mapActors()).toEqual(['Municipalidad de prueba']);
  expect(screen.getByText('1 de 3 actores en el mapa')).toBeInTheDocument();
});

it('says when no actor matches the filters instead of drawing an empty map silently', async () => {
  render(<ActorMap rows={rows} onOpen={vi.fn()} />);
  await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar actor' }), 'zzz');
  expect(screen.getByText('0 de 3 actores en el mapa')).toBeInTheDocument();
  expect(screen.queryAllByRole('button', { name: /^Ficha de actor/ })).toEqual([]);
});
