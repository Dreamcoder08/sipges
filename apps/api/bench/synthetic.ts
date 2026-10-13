/**
 * Deterministic synthetic records for benchmarks. Field names follow the legacy modules; every
 * value is generated from a fixed vocabulary, so no operational data is involved.
 */

/** Records per module in the legacy installation (counts only), the 1× volume. */
export const BASE_COUNTS = {
  Eventos: 25,
  Actores: 22,
  Demandas: 12,
  Compromisos: 2,
  Narrativas: 7,
  Fuentes: 8,
  Alertas: 9,
  Acciones: 9,
  Directorio_Territorial: 159,
  Actores_Priorizados: 131,
  // RC 1.7 modules are empty in the legacy seed; 20 each keeps the pairing engines busy.
  Intereses: 20,
  Dialogos: 20,
  Oportunidades: 20,
  Hechos_Compartidos: 20,
  Evaluaciones_AARC: 20,
} as const;

export type SyntheticModule = keyof typeof BASE_COUNTS;
export type Payload = Record<string, unknown>;

const VOCABULARY = (
  'agua empleo asamblea directiva dirigentes tierras servidumbre concesion contaminacion polvo ' +
  'pesca maricultura proveedores capacitacion compromiso acuerdo dialogo mesa reunion paro ' +
  'bloqueo movilizacion denuncia rechazo municipalidad subprefectura oficio cronograma ' +
  'trazabilidad legitimidad representacion padron eleccion facebook prensa publicaciones ' +
  'narrativa influencia liderazgo alianza riesgo emergencia seguridad accidente vias salud ' +
  'educacion caminos canal riego ganado pozo bahia transporte vivienda energia'
).split(' ');

const STATES = ['Abierta', 'En seguimiento', 'Cerrada', 'Pendiente', 'Validado', 'Descartada'];
const LEVELS = ['Alta', 'Media', 'Baja', 'Crítica', 'Rojo', 'Amarillo'];
const DIMENSIONS = ['G', 'A', 'D', 'N', 'E', 'I'];

/** Small seeded PRNG (mulberry32) so every run sees the same data. */
export const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const syntheticRecords = (scale: number, seed = 42) => {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const sentence = (words: number) =>
    Array.from({ length: words }, () => pick(VOCABULARY)).join(' ');
  const date = () => `2026-${String(1 + Math.floor(random() * 9)).padStart(2, '0')}-15`;

  const make = (module: SyntheticModule, i: number): Payload => {
    const id = `${module.slice(0, 3).toUpperCase()}-${i}`;
    const common = {
      Proyecto_ID: 'PRJ-SECHURA',
      Territorio: `Sector ${1 + (i % 12)}`,
      Fuente_ID: `FUE-${i % 40}`,
      Observaciones: sentence(12),
    };
    switch (module) {
      case 'Eventos':
        return {
          ...common,
          ID_Evento: id,
          Fecha: date(),
          Tipo_Evento: pick(['Reunión', 'Protesta', 'Denuncia', 'Acuerdo']),
          Descripcion_Hecho: sentence(30),
          Dimension_Principal: pick(DIMENSIONS),
          Relevancia_Preliminar: pick(LEVELS),
          Nivel_Verificacion: pick(['A', 'B', 'C', 'D', 'E']),
          Estado_Validacion: pick(STATES),
          Actor_Principal: `ACT-${i % 50}`,
        };
      case 'Actores':
        return {
          ...common,
          ID_Actor: `ACT-${i}`,
          'Nombre_Actor/Organizacion': `Organización sintética ${i}`,
          Tipo_Actor: pick(['Comunal', 'Estatal', 'Empresa', 'Gremio']),
          Influencia: pick(['Alta', 'Media', 'Baja']),
          Interes: sentence(8),
          Posicion_Proyecto: pick(['A favor', 'Neutral', 'En contra']),
          Capacidad_Movilizacion: pick(['Alta', 'Media', 'Baja']),
        };
      case 'Demandas':
        return {
          ...common,
          ID_Demanda: id,
          Tema: sentence(3),
          Descripcion: sentence(25),
          Dimension: pick(DIMENSIONS),
          Estado: pick(STATES),
          Prioridad: pick(LEVELS),
          Fecha_Registro: date(),
        };
      case 'Compromisos':
        return {
          ...common,
          ID_Compromiso: id,
          Descripcion: sentence(20),
          Responsable: `Equipo ${i % 6}`,
          Estado: pick(['Abierto', 'Vencido', 'Cumplido']),
          Plazo: date(),
          'Avance_%': Math.floor(random() * 100),
        };
      case 'Narrativas':
        return {
          ...common,
          ID_Narrativa: id,
          Tema: sentence(3),
          Descripcion: sentence(25),
          Tono: pick(['Negativo', 'Neutral', 'Positivo']),
          Intensidad: pick(LEVELS),
          'Plataforma/Fuente': pick(['Facebook', 'Radio', 'Prensa']),
        };
      case 'Alertas':
        return {
          ...common,
          ID_Alerta: id,
          Estado: pick(STATES),
          Nivel_Preliminar: pick(LEVELS),
          Dimension: pick(DIMENSIONS),
          Causa: sentence(15),
          Fecha: date(),
        };
      case 'Acciones':
        return {
          ...common,
          ID_Accion: id,
          ID_Alerta: `ALE-${i % 30}`,
          Accion: sentence(12),
          Estado: pick(STATES),
          Plazo: date(),
          Responsable: `Equipo ${i % 6}`,
        };
      case 'Fuentes':
        return { ...common, ID_Fuente: id, Tipo_Fuente: 'Informe', Fecha_Documento: date() };
      case 'Directorio_Territorial':
      case 'Actores_Priorizados':
        return {
          ...common,
          Cargo: pick(['Presidente', 'Secretaria', 'Teniente', 'Regidor']),
          'Institución / Organización': `Institución sintética ${i % 80}`,
          'Nombre actualizado 2026': `Persona sintética ${i}`,
          Prioridad: pick(LEVELS),
          'Estado de verificación': pick(STATES),
        };
      case 'Intereses':
        return {
          ...common,
          Tema_ID: `TEM-${i % 25}`,
          Interes: sentence(10),
          Preocupacion: sentence(10),
          Posicion: sentence(6),
        };
      case 'Dialogos':
        return {
          ...common,
          Proceso: sentence(4),
          Tema: sentence(6),
          Estado: pick(['Abierto', 'Cerrado', 'En curso']),
          Tema_ID: `TEM-${i % 25}`,
        };
      case 'Oportunidades':
        return {
          ...common,
          Oportunidad: sentence(8),
          Tipo: sentence(2),
          Beneficiarios: sentence(4),
          Restricciones: sentence(6),
          Estado: pick(STATES),
        };
      case 'Hechos_Compartidos':
        return {
          ...common,
          Asunto: sentence(8),
          Preguntas: sentence(10),
          Estado: pick(STATES),
          Registros_Relacionados: `OPO-${i % 30}, DIA-${i % 20}`,
        };
      case 'Evaluaciones_AARC':
        return {
          ...common,
          Dimension: pick(['Acceso', 'Aceptabilidad', 'Respeto', 'Corresponsabilidad']),
          Puntaje: 1 + Math.floor(random() * 5),
          Evidencia: sentence(10),
        };
    }
  };

  const out = {} as Record<SyntheticModule, Payload[]>;
  for (const module of Object.keys(BASE_COUNTS) as SyntheticModule[]) {
    out[module] = Array.from({ length: BASE_COUNTS[module] * scale }, (_, i) => make(module, i));
  }
  return out;
};

export const totalRecords = (records: Readonly<Record<string, readonly unknown[]>>) =>
  Object.values(records).reduce((sum, rows) => sum + rows.length, 0);

/** Words that match no document-lab theme: the slowest case, every segment is scanned. */
export const NEUTRAL_VOCABULARY = (
  'tarde manana casa mesa libro ventana camino arbol nube piedra jardin cocina puerta ' +
  'calle ciudad musica pintura ciencia historia lectura silla papel lapiz cuaderno'
).split(' ');

/** A synthetic document: `pages` pages of `lines` lines mixing the vocabulary. */
export const syntheticPages = (
  pages: number,
  lines = 40,
  seed = 7,
  vocabulary: readonly string[] = VOCABULARY,
) => {
  const random = prng(seed);
  const word = () => vocabulary[Math.floor(random() * vocabulary.length)] ?? 'agua';
  return Array.from({ length: pages }, (_, p) =>
    Array.from(
      { length: lines },
      (_, l) => `Linea ${p + 1}.${l + 1}: ${Array.from({ length: 12 }, word).join(' ')}.`,
    ),
  );
};

/** Minimal multi-line PDF (Helvetica, ASCII), enough for pdf.js text extraction. */
export const syntheticPdf = (pages: readonly (readonly string[])[]): Uint8Array => {
  const escape = (text: string) => text.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((lines, i) => {
    const body = lines.map((line) => `(${escape(line)}) Tj T*`).join(' ');
    const stream = `BT /F1 9 Tf 11 TL 36 760 Td ${body} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
};
