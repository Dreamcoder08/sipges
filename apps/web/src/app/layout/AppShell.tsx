import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { NAV_GROUPS, SCREENS, titleFor } from '../navigation.ts';
import styles from './AppShell.module.css';

/** Below this width the sidebar becomes a drawer opened from the top bar (AppShell.module.css). */
const DRAWER_QUERY = '(max-width: 60rem)';

const LABELS: ReadonlyMap<string, string> = new Map(SCREENS.map((s) => [s.path, s.label]));

/**
 * Layout of every signed-in screen: skip link, navigation landmark, page heading and main
 * region. Focus moves to the heading after each navigation so screen readers announce it.
 * On small screens the navigation is a drawer under the sticky top bar: opening it moves focus
 * to the current section, locks the page scroll and makes the content inert; Escape, the
 * backdrop or the toggle close it.
 */
export const AppShell = ({
  projectLabel,
  projectSwitcher,
  userMenu,
  search,
  children,
}: {
  projectLabel: string;
  search?: ReactNode;
  projectSwitcher: ReactNode;
  userMenu: ReactNode;
  children: ReactNode;
}) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);
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

  // The drawer starts below the sticky top bar, and focused fields scroll clear of it
  // (scroll-padding in global.css); its height changes as its tools wrap.
  useEffect(() => {
    const bar = topbar.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() =>
      root.setProperty('--topbar-height', `${bar.offsetHeight}px`),
    );
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.removeProperty('--topbar-height');
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const current = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    (current ?? nav.current?.querySelector<HTMLElement>('a'))?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      toggle.current?.focus();
    };
    const drawer = window.matchMedia?.(DRAWER_QUERY);
    const resize = () => {
      if (!drawer?.matches) setMenuOpen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', close);
    drawer?.addEventListener('change', resize);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', close);
      drawer?.removeEventListener('change', resize);
    };
  }, [menuOpen]);

  return (
    <div className={styles.shell} data-menu-open={menuOpen}>
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
        <nav ref={nav} id={navId} aria-label="Secciones">
          {NAV_GROUPS.map((group) => (
            <div key={group.label} className={styles.group}>
              <p className={styles.groupLabel} aria-hidden="true">
                {group.label}
              </p>
              <ul>
                {group.paths.map((path) => (
                  <li key={path}>
                    <Link
                      to={path}
                      className={styles.link}
                      activeOptions={{ exact: true }}
                      onClick={() => setMenuOpen(false)}
                      activeProps={{
                        className: `${styles.link} ${styles.active}`,
                        'aria-current': 'page',
                      }}
                    >
                      {LABELS.get(path)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className={styles.scrim} aria-hidden="true" onClick={() => setMenuOpen(false)} />
      <div className={styles.body}>
        <header ref={topbar} className={styles.topbar}>
          <button
            ref={toggle}
            type="button"
            className={styles.menuButton}
            aria-controls={navId}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className={styles.burger} aria-hidden="true">
              <span />
            </span>
            <span className="visually-hidden">{menuOpen ? 'Cerrar menú' : 'Abrir menú'}</span>
          </button>
          <div className={styles.heading}>
            <p className={styles.eyebrow}>Sistema inteligente de alerta temprana</p>
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
          </div>
          <div className={styles.tools}>
            {search}
            {projectSwitcher}
            {userMenu}
          </div>
        </header>
        <main id="contenido" className={styles.main} tabIndex={-1} inert={menuOpen}>
          {children}
        </main>
      </div>
    </div>
  );
};
