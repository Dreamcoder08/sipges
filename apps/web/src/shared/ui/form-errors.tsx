import { useEffect, useId, useRef, useState } from 'react';
import { count } from '../lib/plural.ts';
import styles from './Field.module.css';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** One invalid field: its control id, its label and what to fix, in form order. */
export type FieldError = { id: string; label: string; message: string };

const isControl = (element: Element): element is Control =>
  element instanceof HTMLInputElement ||
  element instanceof HTMLSelectElement ||
  element instanceof HTMLTextAreaElement;

/**
 * What to fix in a field the native constraints (`required`, `min`, `max`, `step`, `type`) reject,
 * in Spanish whatever the browser's language.
 */
export const constraintMessage = (control: Control): string => {
  const validity = control.validity;
  if (validity.valueMissing) return 'Completa este campo.';
  if (control instanceof HTMLInputElement) {
    if (validity.badInput)
      return control.type === 'number' ? 'Escribe un número.' : 'Escribe un valor válido.';
    if (validity.rangeUnderflow) return `Debe ser ${control.min} o más.`;
    if (validity.rangeOverflow) return `Debe ser ${control.max} o menos.`;
    if (validity.stepMismatch)
      return control.step === '1' ? 'Escribe un número entero.' : 'Revisa el valor.';
    if (validity.typeMismatch)
      return control.type === 'url'
        ? 'Escribe una dirección web completa, con https://.'
        : 'Revisa el formato.';
  }
  return 'Revisa este campo.';
};

const errorOf = (control: Control): FieldError => ({
  id: control.id,
  label: (control.labels?.[0]?.textContent ?? control.name).trim(),
  message: constraintMessage(control),
});

/** The id of the message tied to a field with `aria-describedby`. */
export const errorId = (fieldId: string) => `${fieldId}-error`;

/**
 * In-page errors for a form that keeps its native constraints (functional-10 F22). The form sets
 * `noValidate`, so the browser's bubble gives way to messages in the page: `validate` reads the
 * Constraint Validation API on save, lists every invalid field and moves focus to the first one
 * once its message is rendered, so a screen reader reads the error with the field. `recheck`
 * drops or updates a listed field's error while the person corrects it.
 */
export const useFormErrors = () => {
  const [errors, setErrors] = useState<FieldError[]>([]);
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    const id = focusNext.current;
    focusNext.current = null;
    if (id) document.getElementById(id)?.focus();
  }, [errors]);
  const validate = (form: HTMLFormElement) => {
    const found = [...form.elements]
      .filter(isControl)
      .filter((control) => control.willValidate && control.id && !control.validity.valid)
      .map(errorOf);
    focusNext.current = found[0]?.id ?? null;
    setErrors(found);
    return found.length === 0;
  };
  const recheck = (control: EventTarget) => {
    if (!(control instanceof Element) || !isControl(control)) return;
    setErrors((current) =>
      current.some((error) => error.id === control.id)
        ? control.validity.valid
          ? current.filter((error) => error.id !== control.id)
          : current.map((error) => (error.id === control.id ? errorOf(control) : error))
        : current,
    );
  };
  const messageFor = (id: string) => errors.find((error) => error.id === id)?.message;
  return { errors, validate, recheck, messageFor };
};

/** `aria-invalid` and `aria-describedby` for a field, joined to any hint it already has. */
export const errorProps = (id: string, message: string | undefined, describedBy?: string) => {
  const ids = [describedBy, message ? errorId(id) : undefined].filter(Boolean).join(' ');
  return { 'aria-invalid': Boolean(message), ...(ids ? { 'aria-describedby': ids } : {}) };
};

/** The message under an invalid field; nothing while the field is valid. */
export const FieldErrorText = ({ id, message }: { id: string; message: string | undefined }) =>
  message ? (
    <p id={errorId(id)} className={styles.error}>
      {message}
    </p>
  ) : null;

/** Short list of the errors at the top of the form; each entry moves focus to its field. */
export const FormErrorSummary = ({ errors }: { errors: readonly FieldError[] }) => {
  const titleId = useId();
  if (errors.length === 0) return null;
  return (
    <div role="group" aria-labelledby={titleId} className={styles.summary}>
      <p id={titleId} className={styles.summaryTitle}>
        No se pudo guardar: revisa {count(errors.length, 'campo', 'campos')}.
      </p>
      <ul>
        {errors.map((error) => (
          <li key={error.id}>
            <a
              href={`#${error.id}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(error.id)?.focus();
              }}
            >
              {error.label}: {error.message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};
