import { type FormEvent, type KeyboardEvent, useId, useRef } from 'react';
import { Icon } from './Icon.tsx';
import styles from './Composer.module.css';

export type ComposerMode = 'buscar' | 'preguntar';

/** The question limit, and how close to it the counter appears. */
const LIMIT = 500;
const COUNT_FROM = 450;
/** The field grows one row per line between these and then scrolls. */
const MIN_ROWS = 2;
const MAX_ROWS = 8;

const MODES: readonly { value: ComposerMode; label: string }[] = [
  { value: 'buscar', label: 'Buscar' },
  { value: 'preguntar', label: 'Preguntar' },
];

/**
 * The chat composer (odd/tasks/chat-first-ui.md T3, design/chat-first/02-atencion-primero.html).
 * One field that grows to 8 lines, a «Buscar | Preguntar» switch made of native radios (arrow
 * keys and the group name come free), a send button that turns into «Detener respuesta» in the
 * same place while an answer is pending, and the keys of a chat box: Enter sends (never while an
 * input method composes), Esc clears or stops, ↑ in an empty box brings back the last question.
 * The page owns the text, so it can fill it (suggestions) and keep it after an error.
 */
export const Composer = ({
  label,
  placeholder,
  hint,
  sendLabel,
  value,
  onValueChange,
  onSubmit,
  mode,
  onModeChange,
  askUnavailable,
  pending = false,
  onStop,
}: {
  /** The field's name; visually hidden, the switch shows the mode. */
  label: string;
  placeholder: string;
  /** What Enter does here, or why the box only searches. */
  hint: string;
  sendLabel: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Called with the trimmed text, never empty and never while pending. */
  onSubmit: (text: string) => void;
  mode: ComposerMode;
  onModeChange?: (mode: ComposerMode) => void;
  /** Why «Preguntar» cannot be chosen; set, it disables that option and describes it. */
  askUnavailable?: string | undefined;
  pending?: boolean;
  onStop?: () => void;
}) => {
  const id = useId();
  const last = useRef('');
  const length = value.length;
  const counting = length >= COUNT_FROM;
  const full = length >= LIMIT;
  // Where field-sizing is supported the stylesheet sizes the field and rows has no effect; elsewhere
  // the field still grows with each line typed (modern-web-guidance form-fields-automatically-fit-contents).
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, value.split('\n').length));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (pending || !text) return;
    last.current = text;
    onSubmit(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // The Enter that confirms an IME candidate must not send: Safari reports it as keyCode 229
      // with isComposing already false (modern-web-guidance ime-safe-enter-submit).
      if (!composing) event.currentTarget.form?.requestSubmit();
      return;
    }
    // Esc and ↑ belong to the input method while it composes.
    if (composing) return;
    if (event.key === 'Escape' && (pending || value)) {
      event.preventDefault();
      if (pending) onStop?.();
      else onValueChange('');
    } else if (
      event.key === 'ArrowUp' &&
      !value &&
      last.current &&
      !(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      onValueChange(last.current);
    }
  };

  return (
    // data-ai: the phone layout and the e2e specs read whether the box asks the analyst.
    <form
      className={styles.composer}
      data-ai={mode === 'preguntar' ? 'on' : 'off'}
      onSubmit={submit}
    >
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <textarea
        id={id}
        className={styles.field}
        rows={rows}
        maxLength={LIMIT}
        value={value}
        aria-describedby={counting ? `${id}-hint ${id}-count` : `${id}-hint`}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.bar}>
        <fieldset className={styles.modes}>
          <legend className="visually-hidden">Modo</legend>
          {MODES.map((option) => {
            const unavailable = option.value === 'preguntar' ? askUnavailable : undefined;
            return (
              <label key={option.value} className={styles.mode} title={unavailable}>
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={option.value}
                  checked={mode === option.value}
                  disabled={unavailable !== undefined}
                  aria-describedby={unavailable === undefined ? undefined : `${id}-why`}
                  onChange={() => onModeChange?.(option.value)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </fieldset>
        {askUnavailable === undefined ? null : (
          <span id={`${id}-why`} className="visually-hidden">
            {askUnavailable}
          </span>
        )}
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
        {counting ? (
          <span id={`${id}-count`} className={styles.counter} data-full={full || undefined}>
            {full ? `${length}/${LIMIT} · Llegaste al límite` : `${length}/${LIMIT}`}
          </span>
        ) : null}
        {/* Mounted while empty so reaching the limit is announced once, not every keystroke. */}
        <span role="status" className="visually-hidden">
          {full ? `Llegaste al límite de ${LIMIT} caracteres.` : null}
        </span>
        {/* One button in one place: it sends, and while an answer is pending it stops it. */}
        <button
          type={pending ? 'button' : 'submit'}
          className={styles.send}
          aria-label={pending ? 'Detener respuesta' : sendLabel}
          title={pending ? 'Detener respuesta · Esc' : undefined}
          onClick={
            pending
              ? (event) => {
                  // Stopping turns this button back into «Enviar» before the click's default
                  // action runs; without this the browser would submit the question again.
                  event.preventDefault();
                  onStop?.();
                }
              : undefined
          }
        >
          <Icon name={pending ? 'stop' : 'arrowUp'} />
        </button>
      </div>
    </form>
  );
};
