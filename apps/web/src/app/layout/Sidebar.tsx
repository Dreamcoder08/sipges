import { useId, type ReactNode } from 'react';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { useRecents } from '../../shared/lib/recents.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { DESTINATIONS, destinationFor } from '../navigation.ts';
import shell from './AppShell.module.css';
import { NavLink } from './NavLink.tsx';
import { SidebarAccount } from './SidebarAccount.tsx';
import styles from './Sidebar.module.css';

/**
 * Sidebar of wide screens (docs/adr/0015): brand, project and search on top, then the
 * five destinations (Bandeja counts the unread avisos, functional-closure S9), Integraciones and the last screens opened («Recientes»), and the account
 * menu at the foot. A destination is current on its hub and on the old screens it absorbs.
 * Every other tool of the shell lives here too, so the top bar keeps the title only. Phones and
 * tablets show the same sidebar inside the menu drawer (`inDrawer`), whose header names it.
 */
export const Sidebar = ({
  pathname,
  projectLabel,
  projectSwitcher,
  search,
  unread = 0,
  inDrawer = false,
}: {
  pathname: string;
  projectLabel: string;
  projectSwitcher: ReactNode;
  search?: ReactNode;
  /** Unread avisos, counted on the Bandeja link whose Avisos tab lists them. */
  unread?: number;
  inDrawer?: boolean;
}) => {
  const ids = useId();
  const recents = useRecents();

  return (
    <aside className={styles.sidebar} data-drawer={inDrawer}>
      {inDrawer ? null : (
        <div className={styles.brand} title="Sistema Inteligente de Predicción y GEStión Social">
          <span className={shell.mark} aria-hidden="true">
            S
          </span>
          <span>
            <b>SIPGES</b>
            <small>Gestión socioambiental</small>
          </span>
        </div>
      )}
      <div className={styles.project}>{projectSwitcher}</div>
      <div className={styles.tools}>
        {search ? <div className={styles.search}>{search}</div> : null}
      </div>
      <nav aria-label="Secciones" className={styles.nav}>
        <ul>
          {DESTINATIONS.map((hub) => (
            <li key={hub.path}>
              <NavLink
                path={hub.path}
                className={styles.link}
                current={destinationFor(pathname)?.path === hub.path}
                {...(hub.path === '/bandeja' && unread > 0 ? { describedBy: `${ids}-unread` } : {})}
              >
                {hub.path === '/bandeja' && unread > 0 ? (
                  <>
                    <span className={styles.count} data-unread="" aria-hidden="true">
                      {unread > 99 ? '99+' : unread}
                    </span>
                    <span id={`${ids}-unread`} hidden>
                      {`${unread} ${unread === 1 ? 'aviso' : 'avisos'} sin leer`}
                    </span>
                  </>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
        <ul className={styles.apart}>
          <li>
            <NavLink
              path="/integraciones"
              className={styles.link}
              current={pathname === '/integraciones' || pathname === '/automatizaciones'}
            />
          </li>
        </ul>
        {recents.length > 0 ? (
          <section aria-labelledby={`${ids}-recents`}>
            <p id={`${ids}-recents`} className={styles.groupLabel}>
              Recientes
            </p>
            <ul>
              {recents.map((recent) => (
                <li key={recent.href}>
                  <InternalLink href={recent.href} className={`${styles.link} ${styles.small}`}>
                    <Icon name="clock" className={shell.icon} />
                    <span className={shell.text}>{recent.label}</span>
                  </InternalLink>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </nav>
      <SidebarAccount pathname={pathname} projectLabel={projectLabel} />
    </aside>
  );
};
