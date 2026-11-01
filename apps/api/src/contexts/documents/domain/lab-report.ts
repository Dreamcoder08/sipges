import { type ReportDocument, bullet, heading, paragraph, title } from '@sipges/kernel';
import type { Finding } from './insights.ts';

export const ANALYSIS_VERSION = '2.1';

export const ANALYSIS_METHOD =
  'Detección léxica local por categorías; sin modelo generativo, OCR ni búsqueda semántica.';

/**
 * app.py's last limitation said the prototype had no authentication; the TypeScript API is
 * authenticated and tenant-scoped, so that sentence is replaced with the current guidance.
 */
export const ANALYSIS_LIMITATIONS = [
  'Los fragmentos son hallazgos candidatos, NO hechos corroborados.',
  'No se infiere la intención, legitimidad ni delito de personas o colectivos.',
  'La coincidencia de palabras no demuestra un compromiso, acuerdo ni conflicto.',
  'El documento no se almacena y ninguna sugerencia se escribe automáticamente en la base de datos.',
  'Suba solo documentos autorizados para el proyecto activo y evite datos personales innecesarios.',
] as const;

export const COMPARE_METHOD =
  'Comparación léxica local, misma categoría y términos distintivos compartidos; no comprensión semántica.';

export const COMPARE_LIMITATIONS = [
  'Las coincidencias no prueban contradicciones.',
  'Confirmar identidad de actores, fechas y validez documental manualmente.',
  'Los documentos no se guardan ni se integran automáticamente a la base maestra.',
] as const;

export type DocumentAnalysis = {
  readonly version: typeof ANALYSIS_VERSION;
  readonly project_id: string;
  readonly filename: string;
  readonly sha256: string;
  readonly generated_at: string;
  readonly text_sections: number;
  readonly items: readonly Finding[];
  readonly themes: Readonly<Record<string, number>>;
  readonly recommendations: readonly {
    readonly tema: string;
    readonly accion: string;
    readonly hallazgos_candidatos: number;
  }[];
  readonly method: string;
  readonly limitations: readonly string[];
};

export const LAB_REPORT_FILENAME = 'SIPGES_RC20_Lectura_Documental.docx';

/** Outline of app.py `document_lab_report`. */
export const labReport = (analysis: DocumentAnalysis): ReportDocument => ({
  blocks: [
    title(
      'SIPGES (Sistema Inteligente de Predicción y GEStión Social) RC 2.0 | Informe de lectura documental',
    ),
    paragraph('PROTOTIPO · Material para revisión técnica, no informe oficial'),
    ...(['filename', 'project_id', 'sha256', 'generated_at', 'method'] as const).map((key) =>
      paragraph(`${key}: ${analysis[key]}`),
    ),
    heading(1, 'Áreas temáticas y acciones propuestas'),
    ...analysis.recommendations.flatMap((item) => [
      heading(2, item.tema),
      paragraph(`${item.hallazgos_candidatos} fragmentos candidatos. ${item.accion}`),
    ]),
    heading(1, 'Fragmentos con trazabilidad'),
    ...analysis.items.flatMap((x) => [
      heading(3, `${x.id} — ${x.tema} (${x.ubicacion})`),
      paragraph(x.fragmento),
      paragraph(x.accion_sugerida),
    ]),
    heading(1, 'Limitaciones y revisión'),
    ...analysis.limitations.map(bullet),
  ],
});
