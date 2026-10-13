import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { SCREENS, titleFor } from '../navigation.ts';
import styles from './AppShell.module.css';

/**
 * Layout of every signed-in screen: skip link, navigation landmark, page heading and main
 * region. Focus moves to the heading after each navigation so screen readers announce it.
 */
export const AppShell = ({
  projectLabel,
  projectSwitcher,
  userMenu,
  children,
}: {
  projectLabel: string;
  projectSwitcher: ReactNode;
  userMenu: ReactNode;
  children: ReactNode;
}) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const navId = useId();
  const title = titleFor(pathname);
  const first = useRef(true);

  useEffect(() => {
    document.title = `${title} | MASCLI`;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [pathname, title]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menuOpen]);

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#contenido">
        Saltar al contenido principal
      </a>
      <aside className={styles.sidebar} data-open={menuOpen}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            M
          </span>
          <span>
            <b>MASCLI</b>
            <small>Gestión socioambiental</small>
          </span>
        </div>
        <p className={styles.project}>{projectLabel}</p>
        <nav id={navId} aria-label="Secciones">
          <ul>
            {SCREENS.map((screen) => (
              <li key={screen.path}>
                <Link
                  to={screen.path}
                  className={styles.link}
                  activeOptions={{ exact: true }}
                  onClick={() => setMenuOpen(false)}
                  activeProps={{
                    className: `${styles.link} ${styles.active}`,
                    'aria-current': 'page',
                  }}
                >
                  {screen.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className={styles.body}>
        <header className={styles.topbar}>
          <button
            type="button"
            className={styles.menuButton}
            aria-controls={navId}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
            <span className="visually-hidden">{menuOpen ? 'Cerrar menú' : 'Abrir menú'}</span>
          </button>
          <div className={styles.heading}>
            <p className={styles.eyebrow}>Sistema inteligente de alerta temprana</p>
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
          </div>
          <div className={styles.tools}>
            {projectSwitcher}
            {userMenu}
          </div>
        </header>
        <main id="contenido" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
};
