import type { ModuleRecord, Role } from '@mascli/contracts';
import { MODULES, type RecordField, type RecordModule } from './modules.ts';

export const canWriteRecords = (role: Role) => role === 'admin' || role === 'analista';
export const displayValue = (value: unknown) =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
/** Display-only: hides the seed's internal "DEMO-" code prefix and file prefix; stored data is untouched. */
export const presentText = (text: string) =>
  text.replace(/\bDEMO-([A-Z]{1,3}-\d{2})\b/g, '$1').replace(/\bdemo-(fuente-\d{2})/g, '$1');
export const fieldValue = (record: ModuleRecord | undefined, field: RecordField) => {
  if (!record)
    return field.initial ?? (field.type === 'date' ? new Date().toISOString().slice(0, 10) : '');
  // An explicitly cleared canonical field must not resurrect an imported alias.
  if (Object.hasOwn(record, field.key)) return displayValue(record[field.key]);
  for (const key of field.aliases ?? []) {
    if (record[key] != null && record[key] !== '') return displayValue(record[key]);
  }
  return '';
};
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
  return payload;
};
