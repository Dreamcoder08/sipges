import type { ModuleRecord } from '@mascli/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { initialValues } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

export const RecordEditor = ({
  module,
  record,
  pending,
  error,
  onSave,
  onCancel,
}: {
  module: RecordModule;
  record?: ModuleRecord;
  pending: boolean;
  error: string | null;
  onSave: (values: Record<string, string>) => void;
  onCancel: () => void;
}) => {
  const [values, setValues] = useState(() => initialValues(module, record));
  const form = useRef<HTMLFormElement>(null);
  const prefix = useId();
  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
  }, []);
  return (
    <form
      ref={form}
      className={styles.form}
      aria-label={record ? 'Editar registro' : 'Nuevo registro'}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(values);
      }}
    >
      <p>
        Registra información verificable. Después de guardar, abre la ficha para añadir evidencias.
      </p>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <fieldset disabled={pending} className={styles.fields}>
        <legend className="visually-hidden">Datos del registro</legend>
        {MODULES[module].fields.map((field, index) => {
          const id = `${prefix}-${index}`;
          const value = values[field.key] ?? '';
          const common = {
            id,
            value,
            required: field.required,
            onChange: (event: { target: { value: string } }) =>
              setValues((current) => ({ ...current, [field.key]: event.target.value })),
          };
          if (field.options) {
            const options = [...new Set(['', ...field.options, value])];
            return (
              <div className={styles.field} key={field.key}>
                <label htmlFor={id}>{field.label}</label>
                <select {...common}>
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option || 'Por definir'}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          if (field.type === 'textarea')
            return (
              <div className={`${styles.field} ${styles.wide}`} key={field.key}>
                <label htmlFor={id}>{field.label}</label>
                <textarea {...common} rows={3} />
              </div>
            );
          return (
            <Field
              key={field.key}
              {...common}
              label={field.label}
              type={field.type ?? 'text'}
              {...(field.type === 'number'
                ? {
                    min: 0,
                    max: field.key === 'Avance_%' ? 100 : undefined,
                    step: field.key === 'Interacciones_Observadas' ? 1 : 'any',
                  }
                : {})}
            />
          );
        })}
      </fieldset>
      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar registro'}
        </Button>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
};
