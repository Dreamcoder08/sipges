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
 * Sidebar of wide screens (docs/adr/0015): brand, project, search and inbox on top, then the
 * five destinations, Integraciones and the last screens opened («Recientes»), and the account
 * menu at the foot. A destination is current on its hub and on the old screens it absorbs.
 * Every other tool of the shell lives here too, so the top bar keeps the title only.
 */
export const Sidebar = ({
  pathname,
  projectLabel,
  projectSwitcher,
  search,
  notifications,
}: {
  pathname: string;
  projectLabel: string;
  projectSwitcher: ReactNode;
  search?: ReactNode;
  notifications?: ReactNode;
}) => {
  const ids = useId();
  const recents = useRecents();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand} title="Sistema Inteligente de Predicción y GEStión Social">
        <span className={shell.mark} aria-hidden="true">
          S
        </span>
        <span>
          <b>SIPGES</b>
          <small>Gestión socioambiental</small>
        </span>
      </div>
      <div className={styles.project}>{projectSwitcher}</div>
      <div className={styles.tools}>
        {search ? <div className={styles.search}>{search}</div> : null}
        {notifications ? <div className={styles.bell}>{notifications}</div> : null}
      </div>
      <nav aria-label="Secciones" className={styles.nav}>
        <ul>
          {DESTINATIONS.map((hub) => (
            <li key={hub.path}>
              <NavLink
                path={hub.path}
                className={styles.link}
                current={destinationFor(pathname)?.path === hub.path}
              />
            </li>
          ))}
        </ul>
        <ul className={styles.apart}>
          <li>
            <NavLink
              path="/automatizaciones"
              label="Integraciones"
              icon="plug"
              className={styles.link}
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
