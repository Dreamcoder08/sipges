import { type MouseEvent, type ReactNode, useId } from 'react';
import { INICIO_HREF, useSharedThread } from '../../features/dashboard/index.ts';
import { InternalLink } from '../../shared/lib/navigation.tsx';
import { useRecents } from '../../shared/lib/recents.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { AVISOS_HREF, DESTINATIONS, destinationFor } from '../navigation.ts';
import shell from './AppShell.module.css';
import { NavLink } from './NavLink.tsx';
import { GLOBAL_SHORTCUTS, ariaShortcut, shortcutText } from './shortcuts.ts';
import { SidebarAccount } from './SidebarAccount.tsx';
import styles from './Sidebar.module.css';

/** A plain left click: the others keep the link's own behaviour (a new tab or window). */
const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Sidebar of wide screens (docs/adr/0015), in the order of chat-first-ui T13 (built in T19):
 * «Nueva pregunta» first, then search and the bell (it opens Bandeja › Avisos and counts the
 * unread ones, functional-closure S9), the five destinations and Integraciones, then this
 * session's questions under «Conversaciones» while a conversation exists, or the last screens
 * opened («Recientes») otherwise, then the conversations saved in this browser («Anteriores», T11),
 * and the project and the account menu at the foot. A
 * destination is current on its hub and on the old screens it absorbs. Every other tool of the
 * shell lives here too, so the top bar keeps the title only. Phones and tablets show the same
 * sidebar inside the menu drawer (`inDrawer`), whose header names it.
 */
export const Sidebar = ({
  id,
  hidden = false,
  toggle,
  pathname,
  projectLabel,
  projectKey,
  projectSwitcher,
  search,
  unread = 0,
  inDrawer = false,
  onShortcuts,
  onPick,
}: {
  id?: string;
  /** Wide screens only: the person hid it (chat-first-ui T12); it leaves no rail behind. */
  hidden?: boolean;
  /** The button that hides it, at the end of the brand row. */
  toggle?: ReactNode;
  pathname: string;
  projectLabel: string;
  /** Scope of the active project: «Recientes» are kept per project. */
  projectKey: string;
  projectSwitcher: ReactNode;
  search?: ReactNode;
  /** Unread avisos, counted on the bell that opens Bandeja › Avisos. */
  unread?: number;
  inDrawer?: boolean;
  /** Opens the shortcuts sheet from the account menu. */
  onShortcuts?: () => void;
  /** «Nueva pregunta» or a question was chosen: the drawer closes even when Inicio stays. */
  onPick?: () => void;
}) => {
  const ids = useId();
  const recents = useRecents(projectKey);
  const shared = useSharedThread();
  const questions = shared?.thread.turns ?? [];
  // Earlier conversations kept in this browser for the person and project (chat-first-ui T11).
  const saved = shared?.thread.saved ?? [];
  const fresh = GLOBAL_SHORTCUTS.newQuestion;
  // Without the shell's conversation (a test rendering the sidebar alone) the links just navigate.
  const pick = (action: () => void) => (event: MouseEvent) => {
    if (!shared || !plainClick(event)) return;
    event.preventDefault();
    onPick?.();
    action();
  };

  return (
    <aside id={id} hidden={hidden} className={styles.sidebar} data-drawer={inDrawer}>
      {inDrawer ? null : (
        <div className={styles.brand} title="Sistema Inteligente de Predicción y GEStión Social">
          <span className={shell.mark} aria-hidden="true">
            S
          </span>
          <span className={styles.name}>
            <b>SIPGES</b>
            <small>Gestión socioambiental</small>
          </span>
          {toggle}
        </div>
      )}
      <a
        href={INICIO_HREF}
        className={`${styles.link} ${styles.fresh}`}
        title={`Nueva pregunta · ${shortcutText(fresh)}`}
        aria-keyshortcuts={ariaShortcut(fresh)}
        onClick={pick(() => shared?.newQuestion())}
      >
        <Icon name="plus" className={shell.icon} />
        <span className={shell.text}>Nueva pregunta</span>
        <kbd className={styles.hint} aria-hidden="true">
          {shortcutText(fresh)}
        </kbd>
      </a>
      <div className={styles.tools}>
        {search ? <div className={styles.search}>{search}</div> : null}
        <InternalLink
          href={AVISOS_HREF}
          className={styles.bell}
          aria-label={
            unread > 0
              ? `Notificaciones, ${unread} ${unread === 1 ? 'aviso' : 'avisos'} sin leer`
              : 'Notificaciones'
          }
        >
          <Icon name="bell" />
          {unread > 0 ? (
            <span className={styles.count} data-unread="" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </InternalLink>
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
              path="/integraciones"
              className={styles.link}
              current={pathname === '/integraciones' || pathname === '/automatizaciones'}
            />
          </li>
        </ul>
        {questions.length > 0 ? (
          <section aria-labelledby={`${ids}-conversations`}>
            <p id={`${ids}-conversations`} className={styles.groupLabel}>
              Conversaciones
            </p>
            <ul>
              {questions.map((turn) => (
                <li key={turn.id}>
                  <a
                    href={INICIO_HREF}
                    className={`${styles.link} ${styles.small}`}
                    title={turn.question}
                    onClick={pick(() => shared?.showTurn(turn.id))}
                  >
                    <span className={`${shell.text} ${styles.question}`}>{turn.question}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : recents.length > 0 ? (
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
        {saved.length > 0 ? (
          <section aria-labelledby={`${ids}-saved`}>
            <p id={`${ids}-saved`} className={styles.groupLabel}>
              Anteriores
            </p>
            <ul>
              {saved.map((conversation) => {
                const title = conversation.turns[0]?.question ?? '';
                return (
                  <li key={conversation.id} className={styles.savedRow}>
                    <a
                      href={INICIO_HREF}
                      className={`${styles.link} ${styles.small}`}
                      title={title}
                      onClick={pick(() => shared?.openConversation(conversation.id))}
                    >
                      <span className={`${shell.text} ${styles.question}`}>{title}</span>
                    </a>
                    <button
                      type="button"
                      className={styles.forget}
                      aria-label={`Borrar la conversación «${title}»`}
                      onClick={() => shared?.thread.remove(conversation.id)}
                    >
                      <Icon name="close" />
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              className={styles.forgetAll}
              onClick={() => shared?.thread.removeAll()}
            >
              Borrar historial
            </button>
          </section>
        ) : null}
      </nav>
      <div className={styles.project}>{projectSwitcher}</div>
      <SidebarAccount pathname={pathname} projectLabel={projectLabel} onShortcuts={onShortcuts} />
    </aside>
  );
};
