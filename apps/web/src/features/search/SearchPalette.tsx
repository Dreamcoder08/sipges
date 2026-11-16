import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { objectHref, useInternalNavigate } from '../../shared/lib/navigation.tsx';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../../shared/ui/dialog.tsx';
import { Icon } from '../../shared/ui/Icon.tsx';
import { searchQuery } from './api.ts';
import { embedderStatusQuery, embedderUnavailableReason, semanticSearchDown } from './embedder.ts';
import styles from './SearchPalette.module.css';

const useDebounced = (value: string, ms: number) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
};

const SEARCH_EVENT = 'sipges:search';

/** Opens the global search with `text` already typed (the Inicio composer hands its question here). */
export const openSearch = (text: string) =>
  document.dispatchEvent(new CustomEvent<string>(SEARCH_EVENT, { detail: text }));

/** A command of the current screen: «Filtrar Bandeja: alertas» and where it leads. */
export type PaletteCommand = { label: string; href: string };

/** Case- and accent-insensitive, so «situacion» finds «situaciones». */
const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const Results = ({
  scope,
  initialText,
  commands,
  onClose,
}: {
  scope: string;
  initialText: string;
  commands: readonly PaletteCommand[];
  onClose: () => void;
}) => {
  const navigate = useInternalNavigate();
  const listId = useId();
  const [text, setText] = useState(initialText);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim(), 200);
  const results = useQuery({ ...searchQuery(scope, q), placeholderData: keepPreviousData });
  const embedder = useQuery(embedderStatusQuery(scope));
  const hits = q ? (results.data?.hits ?? []) : [];
  const typed = fold(text.trim());
  const shown = commands.filter((command) => fold(command.label).includes(typed));
  // One list for the arrows: the screen's commands first, then the search results.
  const count = shown.length + hits.length;
  const current = Math.min(active, Math.max(0, count - 1));
  const open = (index: number) => {
    const command = shown[index];
    const hit = hits[index - shown.length];
    if (!command && !hit) return;
    onClose();
    navigate(command ? command.href : objectHref(hit?.module ?? '', hit?.id ?? ''));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(Math.min(count - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // The Enter that confirms an IME candidate must not open a result: Safari reports it as
      // keyCode 229 with isComposing already false (modern-web-guidance ime-safe-enter-submit).
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
        aria-expanded={count > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(count ? { 'aria-activedescendant': optionId(current) } : {})}
        placeholder="Buscar actor, demanda, evento, alerta…"
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
      {embedder.data && semanticSearchDown(embedder.data) && (
        <p className={styles.status}>
          Búsqueda por palabras clave: la búsqueda por significado no está disponible (
          {embedderUnavailableReason(embedder.data)}).
        </p>
      )}
      <ul id={listId} role="listbox" aria-label="Resultados" className={styles.list}>
        {shown.length ? (
          <li role="presentation">
            <ul role="group" aria-label="Filtrar" className={styles.group}>
              {shown.map((command, index) => (
                <li
                  key={command.href}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === current}
                  className={styles.option}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => open(index)}
                >
                  {command.label}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
        {hits.map((hit, at) => {
          const index = shown.length + at;
          return (
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
              ) : hit.semantic ? (
                <small>Relacionado por significado</small>
              ) : null}
            </li>
          );
        })}
      </ul>
    </>
  );
};

/**
 * Global search across every object type, opened with Ctrl/⌘+K (docs/adr/0011 §5). `commands`
 * are the current screen's «Filtrar» commands, listed before the results (closure-roadmap T31).
 */
export const SearchPalette = ({
  scope,
  commands = [],
}: {
  scope: string;
  commands?: readonly PaletteCommand[];
}) => {
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState('');
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSeed('');
        setOpen(true);
      }
    };
    const onSearch = (event: Event) => {
      setSeed(event instanceof CustomEvent && typeof event.detail === 'string' ? event.detail : '');
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener(SEARCH_EVENT, onSearch);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener(SEARCH_EVENT, onSearch);
    };
  }, []);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={styles.trigger}
          aria-haspopup="dialog"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Icon name="search" />
          <span className={styles.label}>Buscar</span>
          <kbd>Ctrl K</kbd>
        </button>
      </DialogTrigger>
      <DialogContent
        className={styles.dialog}
        overlayClassName={styles.backdrop}
        aria-modal="true"
        aria-describedby={undefined}
      >
        <DialogTitle className="visually-hidden">Búsqueda global</DialogTitle>
        <Results
          scope={scope}
          initialText={seed}
          commands={commands}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
};
