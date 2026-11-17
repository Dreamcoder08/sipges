import { useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { DesktopUpdateNotice } from '../../features/desktop-update/index.ts';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import { recordVisit } from '../../shared/lib/recents.ts';
import { titleFor, visitFor } from '../navigation.ts';
import styles from './AppShell.module.css';
import { ShortcutsSheet } from './ShortcutsSheet.tsx';
import { Sidebar } from './Sidebar.tsx';
import { GLOBAL_SHORTCUTS, ariaShortcut, shortcutText } from './shortcuts.ts';
import { readSidebarHidden, storeSidebarHidden } from './sidebar-preference.ts';

/**
 * Layout of every signed-in screen (docs/adr/0015): skip link, navigation, page heading and
 * main region. Focus moves to the heading after each navigation so screen readers announce it.
 * Wide screens keep a persistent sidebar, which holds the project, search, bell and account,
 * and a top bar with the title only. Phones and tablets show the same sidebar in a drawer that a
 * menu button opens, as ChatGPT and Claude mobile do: the top bar holds the button and the title
 * and there is no bottom bar (addendum 2026-11-01).
 *
 * On wide screens the sidebar hides entirely, with no icon rail, from a button in its header or
 * with Ctrl/⌘+B (chat-first-ui T12); the button that brings it back waits at the top left of the
 * content, and the choice is kept on the device (`sidebar-preference.ts`).
 */
export const AppShell = ({
  projectLabel,
  projectKey = projectLabel,
  projectSwitcher,
  search,
  unread = 0,
  live,
  title: titleOverride,
  children,
}: {
  projectLabel: string;
  /** The page's name when the address alone cannot tell it (a page that does not exist). */
  title?: string | undefined;
  /** Stable id of the active project (its scope); the label changes once the project list loads. */
  projectKey?: string;
  projectSwitcher: ReactNode;
  search?: ReactNode;
  /** Unread avisos: the sidebar bell counts them and, on phones, the closed menu button signals them. */
  unread?: number;
  live?: ReactNode;
  children: ReactNode;
}) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const compact = useMediaQuery(COMPACT_QUERY);
  const [drawer, setDrawer] = useState(false);
  // «revealed» is «shown» after a toggle, so only that entrance animates, not every page load.
  const [sidebarState, setSidebarState] = useState<'shown' | 'hidden' | 'revealed'>(() =>
    readSidebarHidden() ? 'hidden' : 'shown',
  );
  const hidden = !compact && sidebarState === 'hidden';
  const sidebarId = useId();
  const hideButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const [shortcuts, setShortcuts] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const title = titleOverride ?? titleFor(pathname, searchStr);
  const first = useRef(true);
  // Any navigation (a new search string included) or a completed project switch closes the drawer,
  // and so does leaving the compact layout, so it never reappears open when the window narrows.
  const place = `${pathname}?${searchStr}|${projectKey}|${compact}`;
  const [shown, setShown] = useState(place);
  if (shown !== place) {
    setShown(place);
    if (drawer) setDrawer(false);
  }

  useEffect(() => {
    document.title = `${title} | SIPGES`;
  }, [title]);

  // Focus follows a new screen, not a new section or tab of the same one.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [pathname]);

  useEffect(() => {
    const visit = visitFor(pathname, searchStr);
    if (visit) recordVisit(projectKey ?? '', visit);
  }, [pathname, searchStr, projectKey]);

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

  // Focus follows the toggle only when it would otherwise be lost: it sat in the part that goes
  // away (the sidebar, or the show button) or nowhere. Typing in the composer keeps its place.
  const toggleSidebar = () => {
    const next = sidebarState === 'hidden' ? 'revealed' : 'hidden';
    const leaving = next === 'hidden' ? document.getElementById(sidebarId) : showButton.current;
    const active = document.activeElement;
    refocus.current = !active || active === document.body || Boolean(leaving?.contains(active));
    storeSidebarHidden(next === 'hidden');
    setSidebarState(next);
  };
  const toggleRef = useRef(toggleSidebar);
  useLayoutEffect(() => {
    toggleRef.current = toggleSidebar;
  });

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (sidebarState === 'hidden' ? showButton : hideButton).current?.focus();
  }, [sidebarState]);

  // Ctrl+B / ⌘+B, wide screens only. Plain fields have no use for it, so it works while typing
  // there; rich text keeps it for bold, and an open dialog keeps the keyboard.
  useEffect(() => {
    if (compact) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || !(event.ctrlKey || event.metaKey)) return;
      if (event.altKey || event.shiftKey || richText(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      toggleRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [compact]);

  // Ctrl+/ / ⌘+/ opens the shortcuts sheet on every layout, and closes it again. Another open
  // dialog keeps the keyboard. On Spanish keyboards «/» is Mayús+7, so Shift is allowed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (!shortcuts && document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      setShortcuts(!shortcuts);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcuts]);

  // From the drawer's account menu the drawer closes first, so only one sheet holds focus.
  const openShortcuts = () => {
    setDrawer(false);
    setShortcuts(true);
  };

  const toggleProps = (label: string) => ({
    type: 'button' as const,
    className: styles.toggle,
    'aria-label': label,
    title: `${label} · ${shortcutText(GLOBAL_SHORTCUTS.sidebar)}`,
    'aria-keyshortcuts': ariaShortcut(GLOBAL_SHORTCUTS.sidebar),
    'aria-controls': sidebarId,
    'aria-expanded': !hidden,
    onClick: toggleSidebar,
  });

  const sidebar = (
    <Sidebar
      id={sidebarId}
      hidden={hidden}
      toggle={
        compact ? undefined : (
          <button ref={hideButton} {...toggleProps('Ocultar barra lateral')}>
            <Icon name="sidebar" />
          </button>
        )
      }
      pathname={pathname}
      projectLabel={projectLabel}
      projectKey={projectKey ?? ''}
      projectSwitcher={projectSwitcher}
      search={search}
      unread={unread}
      inDrawer={compact}
      onShortcuts={openShortcuts}
    />
  );
  // On wide screens the sidebar already shows the project and the active screen,
  // so the title stays only as the focus target and outline for assistive tech.
  const h1 = (
    <h1 ref={heading} tabIndex={-1} className={compact ? undefined : 'visually-hidden'}>
      {title}
    </h1>
  );

  return (
    <div
      className={styles.shell}
      data-compact={compact}
      data-sidebar={compact ? undefined : sidebarState}
    >
      <a className={styles.skip} href="#contenido">
        Saltar al contenido principal
      </a>
      {compact ? null : sidebar}
      <div className={styles.body}>
        {compact ? (
          <header ref={topbar} className={styles.topbar}>
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
                {unread > 0 ? `, ${unread} ${unread === 1 ? 'aviso' : 'avisos'} sin leer` : ''}
              </span>
            </button>
            <div className={styles.compactTitle}>{h1}</div>
          </header>
        ) : (
          <>
            {hidden ? (
              <div className={styles.reveal}>
                <button ref={showButton} {...toggleProps('Mostrar barra lateral')}>
                  <Icon name="sidebar" />
                </button>
              </div>
            ) : null}
            {h1}
          </>
        )}
        {live}
        {/* Desktop app only: the notice renders nothing in the cloud and development builds. */}
        <DesktopUpdateNotice scope={projectKey} />
        <main id="contenido" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
      {compact ? (
        <Sheet open={drawer} onClose={() => setDrawer(false)} title="Menú" side="start">
          {sidebar}
        </Sheet>
      ) : null}
      <ShortcutsSheet open={shortcuts} onClose={() => setShortcuts(false)} />
    </div>
  );
};

/** Rich text editors use Ctrl+B for bold; plain inputs and textareas do not. */
const richText = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest('[contenteditable=""], [contenteditable="true"]'));
