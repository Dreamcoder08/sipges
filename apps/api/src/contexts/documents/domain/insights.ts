/**
 * Document lab lexical reading (app.py:1704-1760): every text section is split into sentences
 * and matched against seven theme vocabularies. Matches are candidate findings for human
 * review, never facts. Pure functions; extraction of the text happens in an adapter.
 */

export const DOC_TERMS: Readonly<Record<string, readonly string[]>> = {
  'Representatividad y gobernanza': [
    'representatividad',
    'mandato',
    'directiva',
    'elección',
    'asamblea',
    'comunidad',
    'vigencia',
    'junta',
  ],
  'Demandas e intereses': [
    'demanda',
    'solicitud',
    'preocupación',
    'empleo',
    'proveedores',
    'capacitación',
    'petición',
    'reclamo',
  ],
  'Compromisos y trazabilidad': [
    'compromiso',
    'acuerdo',
    'responsable',
    'plazo',
    'seguimiento',
    'cumplimiento',
    'acta',
  ],
  'Controversias y hechos compartidos': [
    'controversia',
    'versión',
    'evidencia',
    'verificación',
    'fuente',
    'denuncia',
    'cuestionamiento',
  ],
  'Diálogo y construcción de consensos': [
    'diálogo',
    'reunión',
    'negociación',
    'participación',
    'consenso',
    'facilitación',
    'mesa',
  ],
  'Oportunidades de valor compartido': [
    'oportunidad',
    'desarrollo',
    'inversión',
    'beneficio',
    'contratación',
    'servicios',
    'productiva',
  ],
  'Territorio y ambiente': [
    'territorio',
    'ambiental',
    'agua',
    'suelo',
    'salud',
    'impacto',
    'área de influencia',
  ],
};

export const DOC_ACTIONS: Readonly<Record<string, string>> = {
  'Representatividad y gobernanza':
    'Comprobar mandato, vigencia y fuentes de representación antes de formalizar interlocución.',
  'Demandas e intereses':
    'Diferenciar demandas explícitas de intereses expresamente documentados y evitar inferir motivaciones.',
  'Compromisos y trazabilidad':
    'Contrastar actas, responsables y fechas antes de registrar compromisos como confirmados.',
  'Controversias y hechos compartidos':
    'Abrir ficha de hechos por verificar, reunir fuentes y registrar versiones sin dar por probada ninguna.',
  'Diálogo y construcción de consensos':
    'Evaluar condiciones de participación informada y posibles preguntas para una agenda de diálogo.',
  'Oportunidades de valor compartido':
    'Evaluar beneficios potenciales, restricciones, responsable institucional y viabilidad antes de prometer acciones.',
  'Territorio y ambiente':
    'Solicitar contraste técnico territorial y distinguir percepciones de impactos confirmados.',
};

/** One located text section, e.g. `Página 3` or `Tabla 1, fila 2`. */
export type TextChunk = { readonly location: string; readonly text: string };

export type Finding = {
  readonly id: string;
  readonly tema: string;
  readonly ubicacion: string;
  readonly fragmento: string;
  readonly terminos: readonly string[];
  readonly accion_sugerida: string;
  readonly estado: 'Candidato no verificado';
};

export const MAX_FINDINGS = 75;
export const MAX_FINDINGS_PER_THEME = 12;
const EXCERPT_LENGTH = 480;
const MIN_SEGMENT_LENGTH = 20;

/** Python string slicing counts code points, not UTF-16 units. */
export const takeCodePoints = (text: string, count: number) =>
  Array.from(text).slice(0, count).join('');

const codePointLength = (text: string) => Array.from(text).length;

/** `unicodedata.normalize('NFKD', s).encode('ascii', 'ignore')`: accents folded away. */
export const foldAscii = (text: string) => text.normalize('NFKD').replace(/\P{ASCII}/gu, '');

const FOLDED_TERMS = Object.entries(DOC_TERMS).map(
  ([theme, words]) => [theme, words.map((word) => ({ word, folded: foldAscii(word) }))] as const,
);

/** Python `' '.join(s.split())`. */
const collapseWhitespace = (text: string) => text.split(/\s+/u).filter(Boolean).join(' ');

/** Sentence ends or line breaks start a new segment (app.py `re.split`). */
const SEGMENT_BREAK = /(?<=[.!?])\s+|\n+/u;

export const documentInsights = (chunks: readonly TextChunk[]) => {
  const items: Finding[] = [];
  const counts = new Map<string, number>();
  for (const { location, text } of chunks) {
    for (const raw of text.split(SEGMENT_BREAK)) {
      const segment = collapseWhitespace(raw);
      if (codePointLength(segment) < MIN_SEGMENT_LENGTH) continue;
      const simplified = foldAscii(segment.toLowerCase());
      for (const [theme, words] of FOLDED_TERMS) {
        const hits = words.filter((w) => simplified.includes(w.folded)).map((w) => w.word);
        const themeCount = counts.get(theme) ?? 0;
        if (hits.length > 0 && themeCount < MAX_FINDINGS_PER_THEME && items.length < MAX_FINDINGS) {
          items.push({
            id: `H${String(items.length + 1).padStart(3, '0')}`,
            tema: theme,
            ubicacion: location,
            fragmento: takeCodePoints(segment, EXCERPT_LENGTH),
            terminos: hits.slice(0, 6),
            accion_sugerida: DOC_ACTIONS[theme] ?? '',
            estado: 'Candidato no verificado',
          });
          counts.set(theme, themeCount + 1);
        }
      }
    }
  }
  return { items, themes: Object.fromEntries(counts) as Record<string, number> };
};

/** Themes ordered by finding count, ties in first-seen order (Python's stable sort). */
export const recommendationsFor = (themes: Readonly<Record<string, number>>) =>
  Object.entries(themes)
    .sort(([, a], [, b]) => b - a)
    .map(([tema, count]) => ({
      tema,
      accion: DOC_ACTIONS[tema] ?? '',
      hallazgos_candidatos: count,
    }));

const FINGERPRINT_STOPWORDS = new Set([
  'sobre',
  'entre',
  'desde',
  'hasta',
  'estos',
  'estas',
  'donde',
  'para',
  'tiene',
  'como',
  'documento',
  'proyecto',
  'social',
  'sechura',
  'tambien',
  'dicho',
  'segun',
]);

/** Distinctive words of five or more ASCII letters or digits (app.py `_fingerprint`). */
export const fingerprint = (text: string) =>
  new Set(
    (foldAscii(text.toLowerCase()).match(/[a-z0-9]{5,}/g) ?? []).filter(
      (word) => !FINGERPRINT_STOPWORDS.has(word),
    ),
  );

export type ComparisonCandidate = {
  readonly tema: string;
  readonly a: { readonly ubicacion: string; readonly fragmento: string };
  readonly b: { readonly ubicacion: string; readonly fragmento: string };
  readonly terminos_comunes: readonly string[];
  readonly coincidencia_lexica: number;
  readonly tipo: string;
  readonly advertencia: string;
};

const MIN_SIMILARITY = 0.11;
export const MAX_COMPARISONS = 40;

/**
 * Same-theme finding pairs that share at least two distinctive words with a Jaccard index of
 * at least 0.11, most similar first (app.py:1876-1910).
 */
export const compareFindings = (a: readonly Finding[], b: readonly Finding[]) => {
  const candidates: ComparisonCandidate[] = [];
  for (const ia of a) {
    const fa = fingerprint(ia.fragmento);
    if (fa.size === 0) continue;
    for (const ib of b) {
      if (ia.tema !== ib.tema) continue;
      const fb = fingerprint(ib.fragmento);
      const overlap = [...fa].filter((word) => fb.has(word));
      if (overlap.length < 2) continue;
      const union = new Set([...fa, ...fb]).size;
      const similarity = overlap.length / Math.max(1, union);
      if (similarity < MIN_SIMILARITY) continue;
      candidates.push({
        tema: ia.tema,
        a: { ubicacion: ia.ubicacion, fragmento: ia.fragmento },
        b: { ubicacion: ib.ubicacion, fragmento: ib.fragmento },
        terminos_comunes: overlap.sort().slice(0, 10),
        coincidencia_lexica: Math.round(similarity * 100) / 100,
        tipo: 'Coincidencia temática; verificar diferencias entre versiones',
        advertencia: 'No constituye contradicción demostrada ni acuerdo confirmado.',
      });
    }
  }
  candidates.sort((x, y) => y.coincidencia_lexica - x.coincidencia_lexica);
  return { comparisons: candidates.slice(0, MAX_COMPARISONS), total: candidates.length };
};
