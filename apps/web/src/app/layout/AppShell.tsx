import { useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import { recordVisit } from '../../shared/lib/recents.ts';
import { titleFor, visitFor } from '../navigation.ts';
import styles from './AppShell.module.css';
import { Sidebar } from './Sidebar.tsx';

/**
 * Layout of every signed-in screen (docs/adr/0015): skip link, navigation, page heading and
 * main region. Focus moves to the heading after each navigation so screen readers announce it.
 * Wide screens keep a persistent sidebar, which holds the project, search, inbox and account,
 * and a top bar with the title only. Phones and tablets show the same sidebar in a drawer that a
 * menu button opens, as ChatGPT and Claude mobile do: the top bar holds the button and the title
 * and there is no bottom bar (addendum 2026-11-01).
 */
export const AppShell = ({
  projectLabel,
  projectSwitcher,
  search,
  notifications,
  unread = 0,
  live,
  children,
}: {
  projectLabel: string;
  projectSwitcher: ReactNode;
  search?: ReactNode;
  notifications?: ReactNode;
  /** Unread notifications; on phones the closed menu button signals them. */
  unread?: number;
  live?: ReactNode;
  children: ReactNode;
}) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const compact = useMediaQuery(COMPACT_QUERY);
  const [drawer, setDrawer] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const title = titleFor(pathname);
  const first = useRef(true);
  // Any navigation (a new search string included) or a completed project switch closes the drawer.
  const place = `${pathname}?${searchStr}|${projectLabel}`;
  const [shown, setShown] = useState(place);
  if (shown !== place) {
    setShown(place);
    if (drawer) setDrawer(false);
  }

  useEffect(() => {
    document.title = `${title} | SIPGES`;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [pathname, title]);

  useEffect(() => {
    const visit = visitFor(pathname, searchStr);
    if (visit) recordVisit(visit);
  }, [pathname, searchStr]);

  // Focused fields scroll clear of the sticky top bar (scroll-padding in global.css).
  useEffect(() => {
    const bar = topbar.current;
    if (!bar || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement.style;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      // A root style write can reflow the observed bar and trigger WebKit's resize loop.
      frame = requestAnimationFrame(() => {
        frame = undefined;
        root.setProperty('--topbar-height', `${bar.offsetHeight}px`);
      });
    });
    observer.observe(bar);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeProperty('--topbar-height');
    };
  }, [compact]);

  const sidebar = (
    <Sidebar
      pathname={pathname}
      projectLabel={projectLabel}
      projectSwitcher={projectSwitcher}
      search={search}
      notifications={notifications}
      inDrawer={compact}
    />
  );
  const h1 = (
    <h1 ref={heading} tabIndex={-1}>
      {title}
    </h1>
  );

  return (
    <div className={styles.shell} data-compact={compact}>
      <a className={styles.skip} href="#contenido">
        Saltar al contenido principal
      </a>
      {compact ? null : sidebar}
      <div className={styles.body}>
        <header ref={topbar} className={styles.topbar}>
          {compact ? (
            <>
              <button
                type="button"
                className={styles.menu}
                aria-haspopup="dialog"
                aria-expanded={drawer}
                onClick={() => setDrawer(true)}
              >
                <Icon name="menu" />
                {unread > 0 ? <span className={styles.unread} data-unread="" /> : null}
                <span className="visually-hidden">
                  Abrir menú
                  {unread > 0
                    ? `, ${unread} ${unread === 1 ? 'notificación' : 'notificaciones'} sin leer`
                    : ''}
                </span>
              </button>
              <div className={styles.compactTitle}>{h1}</div>
            </>
          ) : (
            <div className={styles.heading}>
              <p className={styles.eyebrow}>{projectLabel}</p>
              {h1}
            </div>
          )}
        </header>
        {live}
        <main id="contenido" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
      {compact ? (
        <Sheet open={drawer} onClose={() => setDrawer(false)} title="Menú" side="start">
          {sidebar}
        </Sheet>
      ) : null}
    </div>
  );
};
