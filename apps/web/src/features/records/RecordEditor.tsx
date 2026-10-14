import { ClassifierResponse, type ModuleRecord } from '@mascli/contracts';
import { useMutation } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { useEffect, useId, useRef, useState } from 'react';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { displayValue, extraFields, initialExtras, initialValues } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

export const RecordEditor = ({
  module,
  scope,
  record,
  pending,
  error,
  onSave,
  onCancel,
}: {
  module: RecordModule;
  scope: string;
  record?: ModuleRecord;
  pending: boolean;
  error: string | null;
  onSave: (values: Record<string, string>, extras: Record<string, string>) => void;
  onCancel: () => void;
}) => {
  const [values, setValues] = useState(() => initialValues(module, record));
  const [extras, setExtras] = useState(() => initialExtras(module, record));
  const others = extraFields(module, record);
  const form = useRef<HTMLFormElement>(null);
  const prefix = useId();
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const classify = useMutation({
    mutationFn: async (draft: { values: Record<string, string>; revision: number }) => {
      controller.current = new AbortController();
      try {
        const analysis = await requestJson('/system/analyze', ClassifierResponse, {
          scope,
          method: 'POST',
          body: { json: { payload: draft.values } },
          signal: controller.current.signal,
        });
        return { analysis, revision: draft.revision };
      } finally {
        locked.current = false;
      }
    },
  });
  const suggestion = classify.data?.revision === revision ? classify.data.analysis : null;
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
        if (!pending && !classify.isPending) onSave(values, extras);
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
            onChange: (event: { target: { value: string } }) => {
              setRevision((current) => current + 1);
              if (!classify.isPending) classify.reset();
              setValues((current) => ({ ...current, [field.key]: event.target.value }));
            },
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
      {others.length ? (
        <fieldset disabled={pending} className={styles.fields}>
          <legend>Otros datos del registro</legend>
          <p className={`${styles.muted} ${styles.wide}`}>
            Campos guardados en el registro que no forman parte del formulario del módulo (por
            ejemplo, columnas de una matriz importada). Se conservan al guardar.
          </p>
          {others.map((field, index) =>
            field.editable ? (
              <Field
                key={field.key}
                id={`${prefix}-extra-${index}`}
                label={field.key}
                value={extras[field.key] ?? ''}
                onChange={(event) =>
                  setExtras((current) => ({ ...current, [field.key]: event.target.value }))
                }
              />
            ) : (
              <div className={styles.field} key={field.key}>
                <span>{field.key}</span>
                <code>{displayValue(field.value)}</code>
              </div>
            ),
          )}
        </fieldset>
      ) : null}
      {module === 'eventos' ? (
        <section aria-label="Clasificación asistida">
          <Button
            variant="secondary"
            disabled={pending || classify.isPending || !values.Descripcion_Hecho?.trim()}
            onClick={() => {
              if (locked.current) return;
              locked.current = true;
              classify.mutate({ values: { ...values }, revision: revision });
            }}
          >
            {classify.isPending ? 'Analizando dimensión…' : 'Analizar dimensión'}
          </Button>
          {classify.error && classify.variables?.revision === revision ? (
            <Alert tone="error">{errorDetail(classify.error)}</Alert>
          ) : null}
          {suggestion ? (
            <>
              <p>
                {suggestion.dimension} · {suggestion.dimension_label} · confianza orientativa{' '}
                {suggestion.confidence.toFixed(0)}%
              </p>
              <p>{suggestion.nota}</p>
              <p>
                Revise las señales y la fuente. La sugerencia no valida el hecho ni cambia el IRSA.
              </p>
              <ul>
                {Object.values(suggestion.evidence)
                  .flat()
                  .map((item, index) => (
                    <li key={index}>
                      {item.signal} (peso {item.weight})
                    </li>
                  ))}
              </ul>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  if (!suggestion) return;
                  setRevision((current) => current + 1);
                  setValues((current) => ({
                    ...current,
                    Dimension_Principal: `${suggestion.dimension} - ${suggestion.dimension_label}`,
                  }));
                  classify.reset();
                }}
              >
                Aplicar dimensión sugerida
              </Button>
            </>
          ) : null}
        </section>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" disabled={pending || classify.isPending}>
          {pending ? 'Guardando…' : 'Guardar registro'}
        </Button>
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
};
