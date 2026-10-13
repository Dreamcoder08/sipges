import { type InputHTMLAttributes, useId } from 'react';
import styles from './Field.module.css';

type Props = InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string };

/** Labelled input; the hint is linked with aria-describedby. */
export const Field = ({ label, hint, id, ...input }: Props) => {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} {...(hint ? { 'aria-describedby': hintId } : {})} {...input} />
      {hint ? (
        <small id={hintId} className={styles.hint}>
          {hint}
        </small>
      ) : null}
    </div>
  );
};
