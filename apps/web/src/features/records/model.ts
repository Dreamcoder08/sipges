import { recordDueDate } from '@sipges/kernel';
import type { ModuleRecord, Role } from '@sipges/contracts';
import { MODULES, type RecordField, type RecordModule } from './modules.ts';

export const canWriteRecords = (role: Role) => role === 'admin' || role === 'analista';
export const displayValue = (value: unknown) =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
/**
 * Short values (phones, dates, numbers, short choices such as «Alta») stay on one line in
 * tables; long text wraps. Without this a phone number was split across two lines.
 */
export const isCompactField = (field: RecordField) =>
  field.type === 'tel' ||
  field.type === 'date' ||
  field.type === 'number' ||
  (!!field.options?.length && field.options.every((option) => option.length <= 14));
export const fieldValue = (record: ModuleRecord | undefined, field: RecordField) => {
  if (!record)
    return field.initial ?? (field.type === 'date' ? new Date().toISOString().slice(0, 10) : '');
  // Imported ISO-only Plazo is already an effective deadline. Preserve it when
  // editing another field; narrative Plazo never becomes a calendar date.
  if (field.key === 'Fecha_Vencimiento') {
    const effective = recordDueDate(record);
    if (effective) return effective;
  }
  // An explicitly cleared canonical field must not resurrect an imported alias.
  if (Object.hasOwn(record, field.key)) return displayValue(record[field.key]);
  for (const key of field.aliases ?? []) {
    if (record[key] != null && record[key] !== '') return displayValue(record[key]);
  }
  return '';
};
/** Bookkeeping keys: shown elsewhere (code, project) or never edited by hand. */
const INTERNAL_KEYS = new Set([
  '_id',
  '_updated_at',
  'Proyecto_ID',
  'Proyecto',
  // Evidence links written by uploads; the evidence panel lists them with their files.
  'Adjuntos',
]);
const isScalar = (value: unknown): value is string | number | boolean =>
  ['string', 'number', 'boolean'].includes(typeof value);
/**
 * Stored keys the module form does not cover (other matrix columns, imports, integrations).
 * They are shown and, when scalar, edited as «Otros datos» so no stored content stays hidden.
 */
export const extraFields = (module: RecordModule, record: ModuleRecord | undefined) => {
  if (!record) return [];
  const covered = new Set<string>();
  for (const field of MODULES[module].fields) {
    covered.add(field.key);
    if (Object.hasOwn(record, field.key)) continue;
    const alias = field.aliases?.find((key) => record[key] != null && record[key] !== '');
    if (alias) covered.add(alias);
  }
  return Object.keys(record)
    .filter((key) => !covered.has(key) && !INTERNAL_KEYS.has(key))
    .map((key) => ({ key, value: record[key], editable: isScalar(record[key]) }));
};
export const initialExtras = (module: RecordModule, record?: ModuleRecord) =>
  Object.fromEntries(
    extraFields(module, record)
      .filter((field) => field.editable)
      .map((field) => [field.key, displayValue(field.value)]),
  );

export const initialValues = (module: RecordModule, record?: ModuleRecord) =>
  Object.fromEntries(MODULES[module].fields.map((field) => [field.key, fieldValue(record, field)]));
export const safePublicUrl = (value: string) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hostname.endsWith('.invalid')
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** PUT replaces a payload: take the latest saved record and overlay only editable fields. */
export const recordPayload = (
  module: RecordModule,
  values: Record<string, string>,
  projectId: string,
  projectLabel: string,
  latest?: ModuleRecord,
  extras: Record<string, string> = {},
) => {
  const payload: Record<string, unknown> = {
    ...latest,
    Proyecto_ID: projectId,
    Proyecto:
      typeof latest?.Proyecto === 'string' && latest.Proyecto.trim()
        ? latest.Proyecto
        : projectLabel || projectId,
  };
  delete payload._id;
  delete payload._updated_at;
  for (const field of MODULES[module].fields) {
    const value = (values[field.key] ?? '').trim();
    if (field.required && !value) throw new Error(`Complete ${field.label.toLowerCase()}.`);
    if (field.type === 'url' && value && !safePublicUrl(value))
      throw new Error('Use un enlace http:// o https:// sin credenciales.');
    if (field.type === 'number' && value) {
      const n = Number(value);
      if (
        !Number.isFinite(n) ||
        n < 0 ||
        (field.key === 'Avance_%' && n > 100) ||
        (field.key === 'Interacciones_Observadas' && !Number.isInteger(n))
      )
        throw new Error(`Revise ${field.label.toLowerCase()}.`);
      payload[field.key] = n;
    } else payload[field.key] = value;
  }
  // Only changed «Otros datos» are written; untouched ones keep their stored type.
  for (const [key, raw] of Object.entries(extras)) {
    const before = latest?.[key];
    if (INTERNAL_KEYS.has(key) || !isScalar(before) || displayValue(before) === raw) continue;
    const value = raw.trim();
    if (typeof before === 'boolean') {
      if (!['true', 'false'].includes(value)) throw new Error(`Revise ${key}: use true o false.`);
      payload[key] = value === 'true';
    } else if (typeof before === 'number') {
      if (!value || !Number.isFinite(Number(value)))
        throw new Error(`Revise ${key}: use un número.`);
      payload[key] = Number(value);
    } else payload[key] = value;
  }
  return payload;
};
