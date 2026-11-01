import { useId, useState, type ReactNode } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import { PINNED_PATHS, SIDEBAR_SECTIONS, groupLabelFor } from '../navigation.ts';
import shell from './AppShell.module.css';
import { NavLink } from './NavLink.tsx';
import { SidebarAccount } from './SidebarAccount.tsx';
import styles from './Sidebar.module.css';

/**
 * Sidebar of wide screens (docs/adr/0015): brand, project, search and inbox on top, then the
 * pinned screens and three collapsible sections, and the account menu at the foot. Only the
 * section that owns the current screen starts open, and a pinned screen is not listed again in
 * its section. Every other tool of the shell lives here too, so the top bar keeps the title only.
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
  const current = groupLabelFor(pathname);
  // Manual opens and closes last until the person moves to another section.
  const [manual, setManual] = useState<Readonly<Record<string, boolean>>>({});
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setManual({});
  }
  const isOpen = (label: string) => manual[label] ?? label === current;

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
        <section aria-labelledby={`${ids}-pinned`}>
          <p id={`${ids}-pinned`} className={styles.groupLabel}>
            Fijados
          </p>
          <ul>
            {PINNED_PATHS.map((path) => (
              <li key={path}>
                <NavLink path={path} className={styles.link} />
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby={`${ids}-sections`}>
          <p id={`${ids}-sections`} className={styles.groupLabel}>
            Secciones
          </p>
          <div className={styles.sections}>
            {SIDEBAR_SECTIONS.map((group, index) => {
              const open = isOpen(group.label);
              const panel = `${ids}-panel-${index}`;
              return (
                <div key={group.label}>
                  <button
                    type="button"
                    className={styles.toggle}
                    aria-expanded={open}
                    aria-controls={panel}
                    onClick={() => setManual({ ...manual, [group.label]: !open })}
                  >
                    <span className={styles.name}>{group.label}</span>{' '}
                    <span className={styles.count}>
                      {group.paths.length}
                      <span className="visually-hidden"> pantallas</span>
                    </span>
                    <Icon name="chevronRight" className={styles.chevron} />
                  </button>
                  <div id={panel} className={styles.panel} hidden={!open}>
                    <ul>
                      {group.paths.map((path) => (
                        <li key={path}>
                          <NavLink path={path} className={styles.link} />
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </nav>
      <SidebarAccount pathname={pathname} projectLabel={projectLabel} />
    </aside>
  );
};
