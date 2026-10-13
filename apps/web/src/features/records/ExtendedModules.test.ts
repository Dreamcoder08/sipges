import { expect, it } from 'vitest';
import { MODULES, type RecordModule } from './modules.ts';
import { recordPayload } from './model.ts';
it.each(['alertas', 'acciones', 'intereses', 'dialogos', 'oportunidades', 'hechos', 'aarc'])(
  'supports editable scoped %s records and preserves imported evidence',
  (name) => {
    const definition = MODULES[name as RecordModule];
    expect(definition).toBeDefined();
    const title = definition.titleField;
    const payload = recordPayload(
      name as RecordModule,
      { [title]: 'Synthetic record' },
      'P',
      'Project',
      { _id: '1', Adjuntos: ['evidence'], Imported: 'retained' },
    );
    expect(payload[title]).toBe('Synthetic record');
    expect(payload.Adjuntos).toEqual(['evidence']);
    expect(payload.Proyecto_ID).toBe('P');
  },
);
