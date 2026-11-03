/**
 * Generates the parity fixtures of the Rust text-analysis engine (engines/crates/text-analysis)
 * from the TypeScript engine (apps/api/src/contexts/intelligence/domain/{text-analysis,classifier}.ts).
 * Every input is synthetic.
 *
 *   node engines/fixtures/text-analysis.ts          # rewrite the fixtures
 *   node engines/fixtures/text-analysis.ts --check  # fail when the committed fixtures are stale
 *
 * Each case stores `op`, the request as raw JSON text and `value`, `JSON.stringify` of the
 * TypeScript result, which the Rust engine must reproduce byte for byte. Requests per op:
 *
 *   text_analysis   {text, project_id, source_url, narratives?}  → analyzeText(...) envelope
 *   classify_record {payload}                                   → classifyRecord(payload)
 *   text_cosine     {a, b}                                      → cosine(a, b)
 *   public_http_url {url}                                       → isPublicHttpUrl(url)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyRecord } from '../../apps/api/src/contexts/intelligence/domain/classifier.ts';
import {
  analyzeText,
  cosine,
  isPublicHttpUrl,
} from '../../apps/api/src/contexts/intelligence/domain/text-analysis.ts';

type Op = 'text_analysis' | 'classify_record' | 'text_cosine' | 'public_http_url';
type Case = { readonly name: string; readonly op: Op; readonly request: string; readonly value: string };

const FIXTURES = fileURLToPath(new URL('./text-analysis.json', import.meta.url));
const PARITY = fileURLToPath(
  new URL('../../apps/api/test/intelligence/python-parity.fixture.json', import.meta.url),
);

/** The API's digest: node:crypto SHA-256 of the UTF-8 text, lowercase hex. */
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type Narratives = readonly Readonly<Record<string, unknown>>[];

/** Reference implementation of each engine request over the TypeScript functions. */
const run = (op: Op, req: Record<string, unknown>): unknown => {
  switch (op) {
    case 'text_analysis':
      return analyzeText(
        {
          text: req['text'] as string,
          projectId: req['project_id'] as string,
          sourceUrl: req['source_url'] as string,
        },
        (req['narratives'] as Narratives | null | undefined) ?? [],
        sha256,
      );
    case 'classify_record':
      return classifyRecord(req['payload']);
    case 'text_cosine':
      return cosine(req['a'] as number[], req['b'] as number[]);
    case 'public_http_url':
      return isPublicHttpUrl(req['url'] as string);
  }
};

const cases: Case[] = [];

/** A case whose request is raw JSON text: key order and number spelling reach the engine as written. */
const addText = (name: string, op: Op, request: string) => {
  cases.push({ name, op, request, value: JSON.stringify(run(op, JSON.parse(request))) });
};
const add = (name: string, op: Op, req: Record<string, unknown>) =>
  addText(name, op, JSON.stringify(req));

const text = (name: string, t: string, narratives: Narratives = [], sourceUrl = '') =>
  add(`text/${name}`, 'text_analysis', {
    text: t,
    project_id: 'PRJ-SECHURA',
    source_url: sourceUrl,
    narratives,
  });
const classify = (name: string, payload: unknown) =>
  add(`classify/${name}`, 'classify_record', { payload });

// --- inputs of apps/api/test/intelligence (python-parity.fixture.json) -------------------------

const parity = JSON.parse(readFileSync(PARITY, 'utf8')) as {
  classifier: { payload: unknown }[];
  narratives: Record<string, unknown>[];
  text_analysis: { text: string }[];
};
const sechura = parity.narratives.filter(
  (r) => (r['Proyecto_ID'] || r['project_id'] || 'PRJ-SECHURA') === 'PRJ-SECHURA',
);
parity.text_analysis.forEach((c, i) => text(`parity-${i}`, c.text, sechura, 'https://example.org/p'));
parity.classifier.forEach((c, i) => classify(`parity-${i}`, c.payload));

// --- text analysis: limits and whitespace ------------------------------------------------------

text('empty', '');
text('whitespace-only-js-set', ' \t\n\r\v\f\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff');
text('not-js-whitespace-u0085-u180e', '\u0085\u180e');
text('exactly-20000-emoji', '😀'.repeat(20_000));
text('20001-emoji-too-long', '😀'.repeat(20_001));
text('20000-after-trim', `  ${'a'.repeat(19_999)}é \ufeff`);
text('20001-code-points-ascii', 'b'.repeat(20_001));

// --- text analysis: every term and signal ------------------------------------------------------

text(
  'every-term',
  'Directiva, eleccion, presidente, asamblea, representacion, comunidad campesina, administracion, dirigente. ' +
    'Territorio, tierras, concesion, servidumbre, predio, linderos, ocupacion. ' +
    'Empleo, trabajo, contratacion, proveedor, beneficio, salario, inversion. ' +
    'Agua, contaminacion, ambiente, impacto, polvo, residuo, ecosistema. ' +
    'Dialogo, reunion, acuerdo, compromiso, mesa de trabajo, informacion, consulta. ' +
    'Protesta, paro, bloqueo, movilizacion, conflicto, denuncia, rechazo. ' +
    'Accidente, amenaza, riesgo, emergencia, seguridad, evacuacion.',
  [
    { Tema: 'Agua', Descripcion: 'polvo' },
    { Tema: 'Trabajo', Descripcion: 'proveedores locales' },
    { Tema: null, Descripcion: 'Emergencia y evacuación' },
  ],
);
text(
  'every-signal',
  'Paro, marcha, movilización, bloqueo y plantón. Exigimos, reclamamos, solicitamos; demanda por incumplimiento. ' +
    'Convocatoria a asamblea y reunión: mesa de diálogo. Dicen que, se rumorea, supuestamente, trascendió, al parecer.',
);
text('only-unverified-signal', 'Al parecer, supuestamente nada.');
text('only-demand-signal', 'Exigimos respuesta.');
text('no-terms', 'Un texto neutro sin coincidencias.');
text('topics-tie-sort', 'agua predio empleo dialogo');

// --- text analysis: whole-word edges (Unicode \p{L}\p{N}_ boundaries) --------------------------

text('word-inside-word', 'aguas paros reparo empleos Paraguay subagua');
text('word-with-digits-and-underscore', 'agua1 1agua _agua agua_ paro2 x_paro');
text('word-with-punctuation', '(agua) "paro"; bloqueo! ¿empleo? «riesgo» agua-paro paro/bloqueo');
text('word-next-to-accented-letter', 'éagua aguaé ñparo paroñ');
text('word-next-to-combining-mark', 'agua\u0301 a\u0300gua paro\u0327');
text('word-next-to-non-latin-letters', 'αagua aguaβ жparo paroж 水agua agua水 عagua');
text('word-next-to-non-ascii-digits', '٣agua agua٣ ²agua agua½ Ⅻparo');
text('word-next-to-emoji', '😀agua paro😀 🇵🇪bloqueo 👩‍👩‍👧empleo');
text('word-next-to-mc-mark-devanagari', 'agua\u093e paro\u0903');

// --- text analysis: case folding and normalization ---------------------------------------------

text('accents-and-n', 'AGUA CONTAMINACIÓN Elección REUNIÓN Diálogo Señal ÑANDÚ evacuación Ü');
text('decomposed-input', 'contaminacio\u0301n reunio\u0301n movilizacio\u0301n dia\u0301logo');
text('nfkd-ligatures-fullwidth', 'ﬁn ＡＧＵＡ ｐａｒｏ ᵃᵍᵘᵃ ⓐⓖⓤⓐ 𝐚𝐠𝐮𝐚 ㍿ ½');
text('mixed-scripts', 'ΟΔΟΣ ΣΑΣ Σ İstanbul ıi КРАЙ 中文 العربية agua ﬀ ß ǅ');
text('turkish-dotted-i', 'İNVERSİON İNFORMACİON informacion');
text('greek-final-sigma', 'ΑΣ. ΑΣΑ ΣΑ Σ agua');

// --- text analysis: fragment cut at 500 code points --------------------------------------------

text('fragment-surrogate-at-cut', `${'x'.repeat(499)}😀😀 agua`);
text('fragment-zwj-at-cut', `${'y'.repeat(497)}👩‍👩‍👧‍👦 paro`);
text('fragment-flag-at-cut', `${'z'.repeat(499)}🇵🇪🇨🇱 bloqueo`);
text('fragment-combining-at-cut', `${'e\u0301'.repeat(250)}agua`);

// --- text analysis: narratives with odd values -------------------------------------------------

text(
  'narratives-odd-values',
  'agua paro empleo directiva territorio',
  [
    { Tema: 0, Descripcion: 'agua' },
    { Tema: 1.5, Descripcion: 1e21 },
    { Tema: -0, Descripcion: 0.1 + 0.2 },
    { Tema: true, Descripcion: false },
    { Tema: null, Descripcion: null },
    { Tema: ['agua'], Descripcion: { paro: 'directiva' } },
    { Tema: [], Descripcion: {} },
    { Tema: { 2: 'b', 1: 'a', z: 'Territorio' }, Descripcion: [null, true, 'empleo'] },
    { Descripcion: 'PARO y CONTAMINACIÓN' },
    { Tema: 'Contrataciones', Otro: 'agua' },
    {},
    { Tema: 'subagua', Descripcion: 'reparo' },
    { Tema: 'DIRECTIVA', Descripcion: 1e-7 },
  ],
  'https://example.org/n?q=1',
);
addText(
  'text/raw-number-spellings',
  'text_analysis',
  '{"text":"agua","project_id":"P","source_url":"","narratives":[{"Tema":-0.0,"Descripcion":1E2},{"Tema":12345678901234567890,"Descripcion":"agua"},{"Tema":"x","Tema":"agua"}]}',
);
addText('text/narratives-absent', 'text_analysis', '{"text":"agua","project_id":"P","source_url":"u"}');
addText('text/narratives-null', 'text_analysis', '{"text":"agua","project_id":"P","source_url":"u","narratives":null}');
add('text/project-and-url-unicode', 'text_analysis', {
  text: 'Paro',
  project_id: 'PRJ-ñ"\\',
  source_url: 'https://ejemplo.pe/ñ?a="b"\n',
  narratives: [],
});

// --- classifier ---------------------------------------------------------------------------------

classify('empty-object', {});
classify('null', null);
classify('string', 'Demanda de agua y facebook');
classify('number', 12.5);
classify('array', ['prensa', 'redes sociales', 1, null, true]);
classify('every-strong-g', {
  t: 'representacion legal facultades gobernanza padron eleccion interlocucion junta transitoria administrador judicial legitimidad comunal organo comunal representacion fragmentada',
});
classify('every-weak', {
  t: 'sunarp bdpi consulta previa directiva fundacion comunal actor organizacion relacionamiento roles agenda atencion pedido requerimiento controversia exposicion publica reputacional comentarios saneamiento acceso rutas agricultor agricolas bahia transito institucional resolucion municipalidad cronograma hitos presentacion',
});
classify('every-strong-a-d-n', {
  a: 'mapa de actores capacidad de influencia influencia alta capacidad de movilizacion movilizacion alta alianza actor critico liderazgo',
  d: 'demanda demandas solicitan solicitud compromiso empleo proveedores beneficios capacitacion expectativas',
  n: 'narrativa facebook medios digitales redes sociales notas periodisticas prensa publicaciones tono negativo no verificado desinformacion',
});
classify('every-strong-e-i', {
  e: 'agua pesca maricultura biodiversidad pozo ganadero ganado servidumbre derechos superficiales territorio ambiental',
  i: 'convocatoria formal cargos firmados carta de invitacion comunicacion institucional trazabilidad coordinacion institucional oficio subprefectura proinversion minem fase de estructuracion contrato/bases concurso internacional adjudicacion',
});
classify('accents-uppercase', { Titulo: 'GOBERNANZA y ELECCIÓN', Detalle: 'Representación Legal; DESINFORMACIÓN' });
classify('decomposed', { d: 'eleccio\u0301n desinformacio\u0301n' });
classify('ties-keep-order', { x: 'oficio agua' });
classify('tie-g-a', { x: 'padron alianza' });
classify('half-even-confidence', { x: 'bdpi' });
classify('half-even-two', { x: 'sunarp bdpi' });
classify('half-even-three', { x: 'sunarp bdpi directiva' });
classify('margin-small', { x: 'gobernanza actor' });
classify('severity-orange', { x: 'bloqueo en la via, riesgo alto' });
classify('severity-red', { x: 'agua; personas fallecidas y lesiones graves' });
classify('severity-red-blocked-for-n', { x: 'facebook prensa fallecido' });
classify('mina-de-sal', { x: 'mina de sal: enfrentamiento por el control y posesion' });
classify('influence-and-mobilization', { x: 'influencia movilizacion' });
classify('odd-values', {
  n: 1e21,
  m: -0,
  f: 0.1 + 0.2,
  s: 1e-7,
  b: false,
  z: null,
  arr: [[], {}, [1, [2]]],
  obj: { 10: 'diez', 2: 'dos', b: 'prensa', a: { '': '' } },
});
classify('escapes', { 'k"\\\n': 'tab\there\u0001\u001f\u007f\u2028 "prensa"', '\b\f\r': '' });
classify('mixed-scripts', { x: 'ΣΑΣ İ ﬁ ＡＧＵＡ 中文 😀 👩‍👩‍👧 Ⅻ' });
addText('classify/raw-number-spellings', 'classify_record', '{"payload":{"a":1E2,"b":-0.0,"c":12345678901234567890,"d":1.0,"e":"x","e":"agua"}}');
classify('high-score', {
  x: 'administrador judicial facultades representacion legal gobernanza padron eleccion interlocucion junta transitoria legitimidad comunal',
});

// --- cosine -------------------------------------------------------------------------------------

const cos = (name: string, a: number[], b: number[]) => add(`cosine/${name}`, 'text_cosine', { a, b });
cos('identical', [1, 0], [1, 0]);
cos('orthogonal', [1, 0], [0, 1]);
cos('different-length', [1, 0], [1, 0, 0]);
cos('empty', [], []);
cos('zero-vector', [0, 0], [1, 2]);
cos('floats', [0.1, 0.2, 0.3], [0.3, 0.2, 0.1000001]);
cos('negative', [-1, 2.5, 3], [4, -5, 6e-3]);
cos('overflow-nan', [1e200, 1e200], [1e200, -1e200]);
cos('opposite', [1, 2, 3], [-1, -2, -3]);
addText('cosine/raw-spellings', 'text_cosine', '{"a":[1E0,-0.0,12345678901234567890],"b":[2,3.5,1e-300]}');

// --- isPublicHttpUrl -----------------------------------------------------------------------------

const url = (name: string, u: string) => add(`url/${name}`, 'public_http_url', { url: u });
url('https', 'https://example.org/x');
url('upper-scheme', 'HTTP://example.org');
url('javascript', 'javascript:alert(1)');
url('no-host', 'https:///nohost');
url('ftp', 'ftp://example.org');
url('empty', '');
url('query-host', 'http://?q');
url('hash-host', 'https://#x');
url('host-only', 'http://a');
url('leading-space', ' http://example.org');
url('newline-host', 'http://\nexample');
url('mixed-case-scheme', 'hTtPs://example.org');
url('scheme-with-plus', 'http+x://example.org');
url('unicode-host', 'https://ñandú.pe/ruta');
url('dotless-i-scheme', 'httpſ://example.org');

// --- output -----------------------------------------------------------------------------------

const out = `{"source":"engines/fixtures/text-analysis.ts","cases":[
${cases.map((x) => JSON.stringify(x)).join(',\n')}
]}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(FIXTURES, 'utf8') !== out) {
    console.error(`Stale fixtures: ${FIXTURES}. Run node engines/fixtures/text-analysis.ts`);
    process.exit(1);
  }
  console.log(`Fixtures are current (${cases.length} cases).`);
} else {
  writeFileSync(FIXTURES, out);
  console.log(`Wrote ${cases.length} cases to ${FIXTURES}`);
}
