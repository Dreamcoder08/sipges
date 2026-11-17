/**
 * Every keyboard shortcut of the app, in one list (chat-first-ui T14). The shortcuts sheet
 * (Ctrl+/) renders it, and the commands that show their shortcut in place (the sidebar toggle,
 * the account menu) read their keys from here, so a hint can never disagree with the sheet.
 * A shortcut added anywhere in the app is added here too.
 */

/** The platform's command key: ⌘ on Apple devices, Ctrl elsewhere. Handlers accept both. */
export const MOD = 'Mod';

/** One combination, key by key: `[MOD, 'K']`. */
type Combo = readonly string[];

export type Shortcut = {
  /** Alternatives, shown joined by «o»: `[['J'], ['↓']]`. */
  keys: readonly Combo[];
  label: string;
};

export type ShortcutGroup = { title: string; items: readonly Shortcut[] };

/** Shortcuts that work on every screen; their commands show them in place. */
export const GLOBAL_SHORTCUTS = {
  newQuestion: {
    keys: [[MOD, 'Mayús', 'O']],
    label: 'Nueva pregunta: una conversación nueva en Inicio',
  },
  search: { keys: [[MOD, 'K']], label: 'Buscar en todo el proyecto' },
  sidebar: { keys: [[MOD, 'B']], label: 'Mostrar u ocultar la barra lateral (pantallas anchas)' },
  settings: { keys: [[MOD, ',']], label: 'Abrir Configuración' },
  shortcuts: { keys: [[MOD, '/']], label: 'Ver los atajos de teclado' },
  close: { keys: [['Esc']], label: 'Cerrar el diálogo, el menú o el panel abierto' },
} as const satisfies Record<string, Shortcut>;

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  { title: 'En toda la aplicación', items: Object.values(GLOBAL_SHORTCUTS) },
  {
    title: 'Inicio',
    items: [
      { keys: [['Enter']], label: 'Enviar la pregunta' },
      { keys: [['Mayús', 'Enter']], label: 'Escribir una nueva línea' },
      { keys: [['Esc']], label: 'Borrar la pregunta, o detener la respuesta en curso' },
      { keys: [['↑']], label: 'Recuperar la última pregunta (con la caja vacía)' },
    ],
  },
  {
    title: 'Búsqueda',
    items: [
      { keys: [['↑'], ['↓']], label: 'Moverte entre los resultados' },
      { keys: [['Enter']], label: 'Abrir el resultado elegido' },
    ],
  },
  {
    title: 'Bandeja',
    items: [
      { keys: [['J'], ['↓']], label: 'Ir al siguiente pendiente' },
      { keys: [['K'], ['↑']], label: 'Volver al pendiente anterior' },
      { keys: [['Enter']], label: 'Abrir el detalle' },
      { keys: [['A']], label: 'Aprobar' },
      { keys: [['R']], label: 'Rechazar' },
      { keys: [['Esc']], label: 'Cerrar el detalle' },
    ],
  },
  {
    title: 'Registros',
    items: [
      { keys: [['↑'], ['↓']], label: 'Moverte entre las filas' },
      { keys: [['Inicio'], ['Fin']], label: 'Ir a la primera o a la última fila' },
      { keys: [[MOD, 'rueda']], label: 'Acercar o alejar el mapa de actores' },
    ],
  },
  {
    title: 'Territorio',
    items: [
      {
        keys: [
          ['Mayús', 'Enter'],
          ['Mayús', 'clic'],
        ],
        label: 'Ampliar el rango de meses',
      },
    ],
  },
  {
    title: 'Menús',
    items: [
      { keys: [['↑'], ['↓']], label: 'Moverte entre las opciones' },
      { keys: [['Inicio'], ['Fin']], label: 'Ir a la primera o a la última opción' },
    ],
  },
];

const apple = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');

/** «Ctrl+K», or «⌘+K» on Apple devices. */
export const comboText = (combo: Combo) =>
  combo.map((key) => (key === MOD ? (apple() ? '⌘' : 'Ctrl') : key)).join('+');

/** The first combination of a shortcut, for a hint next to its command. */
export const shortcutText = (shortcut: Shortcut) => comboText(shortcut.keys[0] ?? []);

/** Key names as `aria-keyshortcuts` spells them (UI Events `key` values). */
const ARIA_KEYS: Readonly<Record<string, string>> = { Mayús: 'Shift' };

/** `aria-keyshortcuts` of a command key shortcut: both Control and Meta work. */
export const ariaShortcut = (shortcut: Shortcut) => {
  const combo = shortcut.keys[0] ?? [];
  const rest = combo
    .filter((key) => key !== MOD)
    .map((key) => ARIA_KEYS[key] ?? key)
    .join('+');
  return combo.includes(MOD) ? `Control+${rest} Meta+${rest}` : rest;
};
