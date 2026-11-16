import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuditPage } from '../features/audit/index.ts';
import { IrsaPage, MethodologyPage } from '../features/indicators/index.ts';
import { recordFieldLabel } from '../features/records/modules.ts';
import { SituationalPage } from '../features/analysis/index.ts';
import type { FeatureContext } from '../shared/api/feature-context.ts';
import { server } from '../test/server.ts';

/**
 * functional-10 T3 (F7–F11): no stored key reaches a person on the IRSA, Situación, Auditoría
 * and Metodología screens, even when the API answers with every key it can hold.
 */
const STORED_KEY = /[a-z]+_[a-z]+|[A-Z][a-z]+_[A-Z]/;

const context: FeatureContext = {
  scope: 'SIPGES/PRJ-SINTETICO',
  projectId: 'PRJ-SINTETICO',
  projectLabel: 'Proyecto sintético',
  role: 'admin',
  username: 'persona',
  fullName: 'Persona Sintética',
};
const scores = { G: 15, A: 20, D: 0, N: 0, E: 0, I: 0 };
const weights = { G: 0.2, A: 0.2, D: 0.2, N: 0.1, E: 0.1, I: 0.2 };
const contributions = {
  active_alert: 18,
  high_event: 8,
  critical_event: 12,
  open_demand: 7,
  pending_action: 5,
  unverified_narrative: 6,
};
const indicator = {
  code: 'I5',
  score: 40,
  confidence: 'Alta',
  method: 'Riesgo inverso del porcentaje de registros clave con Fuente_ID o evidencia asociada.',
  evidence_count: 2,
  explanation: 'Dos registros sintéticos',
  availability: 'Disponible',
  name: 'Trazabilidad documental',
  definition: 'Definición sintética',
  dimension: 'I',
  dimension_label: 'Institucional',
};
const details = { G: [], A: [], D: [], N: [], E: [], I: [] };
const excerpt = (fields: Record<string, string>, id: string) => ({ ...fields, id });

const page = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {node}
    </QueryClientProvider>,
  );
const settle = async (text: string | RegExp) => {
  await screen.findByText(text);
};

beforeEach(() => {
  server.use(
    // Parts of Situación that read other lists; empty here.
    http.get('*/api/narrativas', () => HttpResponse.json([])),
    http.get('*/system/document-lab/review', () =>
      HttpResponse.json({ items: [], total: 0, limit: 50, offset: 0, themes: {}, limitations: '' }),
    ),
    http.get('*/system/irsa', () =>
      HttpResponse.json({
        irsa: 7,
        level: 'Verde',
        scores,
        drivers: [],
        config_version: '0.4-indicators',
        weights,
        thresholds: { Verde: [0, 30], Rojo: [30, 100] },
        details,
        availability: scores,
        indicators: [indicator],
        status: 'PROVISIONAL',
        notes: [],
      }),
    ),
    http.get('*/system/irsa/config', () =>
      HttpResponse.json({ weights, thresholds: { Verde: [0, 30] }, contributions }),
    ),
    http.get('*/system/irsa/history', () =>
      HttpResponse.json([
        {
          id: 1,
          ts: '2026-11-14T15:00:00Z',
          irsa: 7,
          level: 'Verde',
          scores,
          config_version: '0.4-indicators',
          note: 'Corte sintético',
        },
      ]),
    ),
    http.get('*/system/indicators', () =>
      HttpResponse.json({
        dimensions: details,
        dimension_scores: scores,
        availability: scores,
        indicators: [indicator],
        method_note: 'Reglas provisionales',
        validation_status: 'PROVISIONAL',
      }),
    ),
    http.get('*/system/model-status', () =>
      HttpResponse.json({
        version: 'SIPGES 1.1.0 · Prototipo final de tesis',
        content_validation: 'Pendiente de juicio de expertos',
        release_rule: 'Requiere revisión',
      }),
    ),
    http.get('*/system/situational-analysis', () =>
      HttpResponse.json({
        project_id: context.projectId,
        project_name: 'Proyecto sintético',
        generated_at: '2026-11-14T15:00:00Z',
        method: 'Síntesis descriptiva basada en registros.',
        counts: {
          eventos: 1,
          actores: 1,
          demandas: 1,
          compromisos: 0,
          narrativas: 0,
          alertas: 1,
          acciones: 0,
          fuentes: 0,
        },
        alertas_activas: 1,
        demandas_pendientes: 1,
        territorios: [['Pampa Sintética', 1]],
        temas_demanda: [['Agua', 1]],
        niveles_alerta: [['Rojo', 1]],
        eventos_recientes: [
          excerpt(
            {
              Fecha: '2026-11-14',
              Territorio: 'Pampa Sintética',
              Descripcion_Hecho: 'Asamblea sintética',
              Nivel_Verificacion: 'B - Corroborada',
              Fuente_ID: 'F-1',
            },
            'EV-1',
          ),
        ],
        alertas_prioritarias: [
          excerpt(
            {
              Fecha: '2026-11-14',
              Nivel_Preliminar: 'Rojo',
              Causa: 'Corte de agua sintético',
              Accion_Sugerida: 'Convocar mesa',
              Fuente_ID: 'F-2',
            },
            'AL-1',
          ),
        ],
        demandas_abiertas: [
          excerpt(
            {
              Fecha_Registro: '2026-11-13',
              Tema: 'Agua',
              Descripcion: 'Demanda sintética',
              Estado: 'Nueva',
              Fuente_ID: 'F-3',
            },
            'D-1',
          ),
        ],
        actores: [
          excerpt(
            {
              'Nombre_Actor/Organizacion': 'Junta sintética',
              Posicion_Proyecto: 'Neutral',
              Influencia: 'Media',
              Fuente_Principal: 'Acta sintética',
            },
            'A-1',
          ),
        ],
        observaciones: ['Observación sintética.'],
        escenarios: [{ nombre: 'Intermedio', supuesto: 'Supuesto sintético.' }],
        recomendaciones: ['Recomendación sintética.'],
        limitations: ['Limitación sintética.'],
      }),
    ),
    http.get('*/system/audit', () =>
      HttpResponse.json(
        [
          ['Eventos', 'CREATE', 'Registro creado en SIPGES'],
          ['Directorio_Territorial', 'UPDATE', 'Registro actualizado'],
          ['Lecciones_Territoriales', 'DELETE', 'Registro eliminado'],
          ['Laboratorio_Documental', 'REVIEW', 'Revisión sintética'],
          ['IRSA', 'CONFIG_UPDATE', 'Pesos sintéticos'],
          ['IRSA', 'SNAPSHOT', 'Corte sintético'],
          ['Sesiones', 'SESSIONS_END_OTHERS', 'Sesiones sintéticas cerradas'],
          ['Cuentas', 'MFA_RESET', 'Verificación sintética restablecida'],
          ['Automatizaciones', 'PUSH_SEND', 'Envío sintético'],
          ['Automatizaciones', 'CHANNEL_SEND', 'Aviso sintético'],
          ['IA externa', 'EGRESS', 'Envío sintético seudonimizado'],
          ['Fuentes', 'UPLOAD', 'Archivo sintético'],
          ['Vinculos', 'CLASSIFY', 'Clasificación sintética'],
          ['Hechos_Compartidos', 'IMPORT', 'Importación sintética'],
          ['Sesiones', 'SESSION_END', 'Sesión sintética cerrada'],
        ].map(([module, action, detail], index) => ({
          id: index + 1,
          ts: '2026-11-14T15:00:00Z',
          module,
          record_id: `R-${index + 1}`,
          action,
          detail,
        })),
      ),
    ),
  );
});

describe('ninguna clave almacenada en pantalla (functional-10 T3)', () => {
  it('IRSA', async () => {
    page(<IrsaPage {...context} />);
    await settle(/7,0 \/ 100 · Verde/);
    await settle('Corte sintético');
    await screen.findByRole('group', { name: 'Contribuciones del prototipo' });
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });

  it('Situación', async () => {
    page(<SituationalPage {...context} fieldLabel={recordFieldLabel} />);
    await settle('Junta sintética');
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });

  it('Auditoría', async () => {
    page(<AuditPage {...context} />);
    await settle('Sesión sintética cerrada');
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });

  it('Metodología', async () => {
    page(<MethodologyPage {...context} />);
    await settle('Reglas provisionales');
    await settle(/SIPGES 1\.1\.0/);
    expect(document.body.textContent).not.toMatch(STORED_KEY);
  });
});
