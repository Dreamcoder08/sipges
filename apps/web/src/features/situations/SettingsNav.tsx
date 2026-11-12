import type { MouseEvent } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import { type SettingsSection, settingsHref } from './sections.ts';
import styles from './SettingsPage.module.css';

export const SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  cuenta: 'Cuenta',
  apariencia: 'Apariencia',
  proyecto: 'Proyecto',
  privacidad: 'Privacidad y datos',
  notificaciones: 'Notificaciones',
};

const INTEGRATIONS_HREF = '/integraciones';

/** A plain left click stays in the app; a new tab or window keeps the browser's default. */
const inApp = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Section list of Configuración, like Claude's settings: real links (Tab and Enter, new tab,
 * shareable `?seccion=`), the current one marked with `aria-current`. Integraciones is its own
 * screen, so it is a link out, set apart from the sections.
 */
export const SettingsNav = ({
  current,
  onSection,
  onNavigate,
}: {
  current: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onNavigate?: ((href: string) => void) | undefined;
}) => (
  <nav aria-label="Secciones de Configuración" className={styles.nav}>
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
      <li className={styles.apart}>
        <a
          className={styles.link}
          href={INTEGRATIONS_HREF}
          onClick={(event) => {
            if (!onNavigate || !inApp(event)) return;
            event.preventDefault();
            onNavigate(INTEGRATIONS_HREF);
          }}
        >
          Integraciones
          <Icon name="chevronRight" className={styles.out} />
        </a>
      </li>
    </ul>
  </nav>
);
