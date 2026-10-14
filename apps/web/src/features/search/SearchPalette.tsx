import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { objectHref, useInternalNavigate } from '../../shared/lib/navigation.tsx';
import { searchQuery } from './api.ts';
import styles from './SearchPalette.module.css';

const useDebounced = (value: string, ms: number) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
};

const Results = ({ scope, onClose }: { scope: string; onClose: () => void }) => {
  const navigate = useInternalNavigate();
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 200);
  const results = useQuery({ ...searchQuery(scope, q), placeholderData: keepPreviousData });
  const hits = q ? (results.data?.hits ?? []) : [];
  const current = Math.min(active, Math.max(0, hits.length - 1));
  const open = (index: number) => {
    const hit = hits[index];
    if (!hit) return;
    onClose();
    navigate(objectHref(hit.module, hit.id));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(hits.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(current);
    }
  };
  const optionId = (index: number) => `${listId}-${index}`;
  return (
    <>
      <input
        className={styles.input}
        role="combobox"
        aria-label="Buscar en todo el proyecto"
        aria-expanded={hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(hits.length ? { 'aria-activedescendant': optionId(current) } : {})}
        placeholder="Actores, eventos, demandas, fuentes…"
        autoFocus
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <p className={styles.status} role="status" aria-live="polite">
        {!q
          ? 'Escribe para buscar en todos los registros del proyecto.'
          : results.error
            ? isApiError(results.error)
              ? results.error.detail
              : 'No se pudo buscar.'
            : results.isFetching && !results.data
              ? 'Buscando…'
              : `${hits.length} resultado${hits.length === 1 ? '' : 's'}`}
      </p>
      <ul id={listId} role="listbox" aria-label="Resultados" className={styles.list}>
        {hits.map((hit, index) => (
          <li
            key={`${hit.module}/${hit.id}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            className={styles.option}
            onMouseEnter={() => setActive(index)}
            onClick={() => open(index)}
          >
            <span className={styles.type}>{hit.type_label}</span>
            <strong>{hit.title}</strong>
            {hit.match && hit.match.excerpt !== hit.title ? (
              <small>{hit.match.excerpt}</small>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
};

/** Global search across every object type, opened with Ctrl/⌘+K (docs/adr/0011 §5). */
export const SearchPalette = ({ scope }: { scope: string }) => {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-label="Búsqueda global"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⌕</span> Buscar <kbd>Ctrl K</kbd>
      </button>
      {open ? (
        <div className={styles.backdrop} onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={styles.dialog}
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={titleId} className="visually-hidden">
              Búsqueda global
            </h2>
            <Results scope={scope} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
};
