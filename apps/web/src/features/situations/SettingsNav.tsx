import type { MouseEvent } from 'react';
import { SECTION_LABELS, type SettingsSection, settingsHref } from './sections.ts';
import styles from './SettingsPage.module.css';

/** A plain left click stays in the app; a new tab or window keeps the browser's default. */
const inApp = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Section list of Configuración, like Claude's settings: real links (Tab and Enter, new tab,
 * shareable `?seccion=`), the current one marked with `aria-current`.
 */
export const SettingsNav = ({
  current,
  onSection,
}: {
  current: SettingsSection;
  onSection: (section: SettingsSection) => void;
}) => (
  <nav aria-label="Secciones de Configuración" className={styles.nav}>
    {/* Wide screens hide the shell's h1, so this is the page's visible title there; phones show
        «Configuración · …» in the top bar and drop it (functional-10 T13). */}
    <h2 className={styles.title}>Configuración</h2>
    <ul className={styles.list}>
      {(Object.keys(SECTION_LABELS) as SettingsSection[]).map((section) => (
        <li key={section}>
          <a
            className={styles.link}
            href={settingsHref(section)}
            aria-current={section === current ? 'page' : undefined}
            onClick={(event) => {
              if (!inApp(event)) return;
              event.preventDefault();
              onSection(section);
            }}
          >
            {SECTION_LABELS[section]}
          </a>
        </li>
      ))}
    </ul>
  </nav>
);
