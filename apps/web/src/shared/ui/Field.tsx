import { type InputHTMLAttributes, useId } from 'react';
import styles from './Field.module.css';
import { FieldErrorText, errorProps } from './form-errors.tsx';

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  /** What to fix after a failed save; sets aria-invalid and joins aria-describedby. */
  error?: string | undefined;
};

/** Labelled input; the hint and any error are linked with aria-describedby. */
export const Field = ({ label, hint, error, id, ...input }: Props) => {
  'use memo';
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const described = errorProps(inputId, error, hint ? hintId : undefined);
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        {...(described['aria-describedby']
          ? { 'aria-describedby': described['aria-describedby'] }
          : {})}
        {...(error ? { 'aria-invalid': true } : {})}
        {...input}
      />
      {hint ? (
        <small id={hintId} className={styles.hint}>
          {hint}
        </small>
      ) : null}
      <FieldErrorText id={inputId} message={error} />
    </div>
  );
};
