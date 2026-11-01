import { Link, useRouterState } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { COMPACT_QUERY, useMediaQuery } from '../../shared/lib/media.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import {
  MOBILE_TABS,
  MORE_GROUPS,
  NAV_GROUPS,
  SCREEN_ICONS,
  labelFor,
  projectParts,
  titleFor,
} from '../navigation.ts';
import styles from './AppShell.module.css';

const MORE_PATHS: ReadonlySet<string> = new Set(MORE_GROUPS.flatMap((group) => group.paths));

/** A navigation link with its icon; the current screen is marked for styles and assistive tech. */
const NavLink = ({
  path,
  className,
  onNavigate,
  children,
}: {
  path: keyof typeof SCREEN_ICONS;
  className: string | undefined;
  onNavigate?: () => void;
  children?: ReactNode;
}) => (
  <Link
    to={path}
    className={className}
    activeOptions={{ exact: true }}
    onClick={onNavigate}
    activeProps={{ 'aria-current': 'page' }}
  >
    <Icon name={SCREEN_ICONS[path]} className={styles.icon} />
    <span className={styles.text}>{labelFor(path)}</span>
    {children}
  </Link>
);

/**
 * Layout of every signed-in screen (docs/adr/0015): skip link, navigation, page heading and
 * main region. Focus moves to the heading after each navigation so screen readers announce it.
 * Wide screens keep a persistent sidebar and a tool bar. Phones and tablets get a context bar
 * (project, search, account), the title under it, a five-item bottom bar and sheets for the
 * project selector and the remaining sections.
 */
export const AppShell = ({
  projectLabel,
  projectSwitcher,
  account,
  search,
  notifications,
  live,
  children,
}: {
  projectLabel: string;
  projectSwitcher: ReactNode;
  account: ReactNode;
  search?: ReactNode;
  /** Desktop bell; on phones the inbox lives in the account sheet. */
  notifications?: ReactNode;
  live?: ReactNode;
  children: ReactNode;
}) => {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const compact = useMediaQuery(COMPACT_QUERY);
  const [sheet, setSheet] = useState<'project' | 'more' | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const topbar = useRef<HTMLElement>(null);
  const title = titleFor(pathname);
  const first = useRef(true);
  const project = projectParts(projectLabel);
  const inMore = MORE_PATHS.has(pathname);
  // A completed project switch closes the project sheet.
  const [shownLabel, setShownLabel] = useState(projectLabel);
  if (shownLabel !== projectLabel) {
    setShownLabel(projectLabel);
    if (sheet === 'project') setSheet(null);
  }

  useEffect(() => {
    document.title = `${title} | SIPGES`;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [pathname, title]);

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

  const close = () => setSheet(null);
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
      {compact ? null : (
        <aside className={styles.sidebar}>
          <div className={styles.brand} title="Sistema Inteligente de Predicción y GEStión Social">
            <span className={styles.mark} aria-hidden="true">
              S
            </span>
            <span>
              <b>SIPGES</b>
              <small>Gestión socioambiental</small>
            </span>
          </div>
          <nav aria-label="Secciones">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className={styles.group}>
                <p className={styles.groupLabel} aria-hidden="true">
                  {group.label}
                </p>
                <ul>
                  {group.paths.map((path) => (
                    <li key={path}>
                      <NavLink path={path} className={styles.link} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
      )}
      <div className={styles.body}>
        <header ref={topbar} className={styles.topbar}>
          {compact ? (
            <>
              <button
                type="button"
                className={styles.context}
                aria-haspopup="dialog"
                aria-expanded={sheet === 'project'}
                aria-label={`Proyecto ${projectLabel}. Cambiar de proyecto`}
                onClick={() => setSheet('project')}
              >
                <span className={styles.mark} aria-hidden="true">
                  S
                </span>
                <span className={styles.contextText}>
                  <b>{project.name}</b>
                  <small>{project.detail}</small>
                </span>
                <Icon name="chevronDown" className={styles.chevron} />
              </button>
              <div className={styles.actions}>
                {search}
                {account}
              </div>
            </>
          ) : (
            <>
              <div className={styles.heading}>
                <p className={styles.eyebrow}>{projectLabel}</p>
                {h1}
              </div>
              <div className={styles.tools}>
                {search}
                {notifications}
                {projectSwitcher}
                {account}
              </div>
            </>
          )}
        </header>
        {compact ? <div className={styles.titleRow}>{h1}</div> : null}
        {live}
        <main id="contenido" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
      {compact ? (
        <>
          <nav aria-label="Navegación principal" className={styles.tabbar}>
            <ul>
              {MOBILE_TABS.map((tab) => (
                <li key={tab.path}>
                  <Link
                    to={tab.path}
                    className={styles.tab}
                    activeOptions={{ exact: true }}
                    activeProps={{ 'aria-current': 'page' }}
                  >
                    <span className={styles.pill}>
                      <Icon name={SCREEN_ICONS[tab.path]} />
                    </span>
                    {tab.label}
                  </Link>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className={styles.tab}
                  data-active={inMore}
                  aria-haspopup="dialog"
                  aria-expanded={sheet === 'more'}
                  onClick={() => setSheet('more')}
                >
                  <span className={styles.pill}>
                    <Icon name="grid" />
                  </span>
                  Más
                  {inMore ? (
                    <span className="visually-hidden">, sección actual: {labelFor(pathname)}</span>
                  ) : null}
                </button>
              </li>
            </ul>
          </nav>
          <Sheet open={sheet === 'project'} onClose={close} title="Cambiar de proyecto">
            {projectSwitcher}
          </Sheet>
          <Sheet open={sheet === 'more'} onClose={close} title="Más secciones">
            <nav aria-label="Secciones" className={styles.more}>
              {MORE_GROUPS.map((group) => (
                <section key={group.label} className={styles.moreGroup}>
                  <h3>{group.label}</h3>
                  <ul>
                    {group.paths.map((path) => (
                      <li key={path}>
                        <NavLink path={path} className={styles.row} onNavigate={close}>
                          <Icon name="chevronRight" className={styles.rowChevron} />
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
          </Sheet>
        </>
      ) : null}
    </div>
  );
};
