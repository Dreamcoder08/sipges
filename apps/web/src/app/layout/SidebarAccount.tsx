import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { accountDisplayName, accountInitials } from '../../shared/ui/account-name.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { logout, meQuery } from '../../features/auth/index.ts';
import { SYSTEM_PATHS, iconFor, labelFor } from '../navigation.ts';

const SETTINGS_PATH = '/version-4';
import { NavLink } from './NavLink.tsx';
import styles from './SidebarAccount.module.css';

const ITEMS = '[role^="menuitem"]';

/** Settings shortcut: Ctrl+, or Cmd+, from anywhere except while typing. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Account row at the foot of the wide sidebar (docs/adr/0015). Its menu is short, like the
 * account menus of Claude or ChatGPT: who is signed in, Configuración (which also holds the
 * appearance choice, docs/adr/0018), Administración, Auditoría, help and sign-out. It follows
 * the menu button pattern: Enter, Space or ArrowDown open it on the first item, ArrowUp on the
 * last; arrows, Home and End move; Escape closes and returns focus to the row.
 */
export const SidebarAccount = ({
  pathname,
}: {
  pathname: string;
  /** Still passed by Sidebar; the menu header now shows the username instead. */
  projectLabel?: string;
}) => {
  const me = useQuery(meQuery).data;
  const client = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const start = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const signOut = useMutation({
    mutationFn: logout,
    meta: { public: true },
    onSettled: async () => {
      client.clear();
      await router.navigate({ to: '/login', search: {} });
    },
  });
  const name = accountDisplayName(me?.full_name ?? 'Mi cuenta');
  const letters = accountInitials(name) || '?';

  // Ctrl+, / Cmd+, opens Configuración, the way desktop apps open their settings.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== ',' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (typing(event.target)) return;
      event.preventDefault();
      void router.navigate({ to: SETTINGS_PATH });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];

  // Focus enters the menu when it opens.
  useEffect(() => {
    if (!open) return;
    const all = items();
    (start.current === 'last' ? all.at(-1) : all[0])?.focus();
  }, [open]);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const show = (from: 'first' | 'last') => {
    start.current = from;
    setOpen(true);
  };
  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    show(event.key === 'ArrowUp' ? 'last' : 'first');
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const index = all.findIndex((item) => item === document.activeElement);
    const move = (target: number) => {
      event.preventDefault();
      all[(target + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close(false);
  };

  return (
    <div ref={root} className={styles.account}>
      <button
        ref={trigger}
        type="button"
        className={styles.row}
        data-current={(SYSTEM_PATHS as readonly string[]).includes(pathname)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show('first'))}
        onKeyDown={onTriggerKey}
      >
        <span className={styles.avatar} aria-hidden="true">
          {letters}
        </span>
        <span className={styles.copy}>
          <span className="visually-hidden">Cuenta de </span>
          <b>{name}</b>
          <span>Configuración y sesión</span>
        </span>
        <Icon name="chevronDown" className={styles.chevron} />
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Cuenta"
          className={styles.menu}
          onKeyDown={onMenuKey}
        >
          <div className={styles.head} role="presentation">
            <span className={`${styles.avatar} ${styles.large}`} aria-hidden="true">
              {letters}
            </span>
            <span className={styles.who}>
              <b>{name}</b>
              {me?.username ? <span>{me.username}</span> : null}
            </span>
          </div>
          <Link
            to={SETTINGS_PATH}
            className={styles.item}
            role="menuitem"
            tabIndex={-1}
            aria-keyshortcuts="Control+, Meta+,"
            activeOptions={{ exact: true }}
            activeProps={{ 'aria-current': 'page' }}
            onClick={() => close(false)}
          >
            <Icon name={iconFor(SETTINGS_PATH)} className={styles.icon} />
            <span>{labelFor(SETTINGS_PATH)}</span>
            <kbd className={styles.hint} aria-hidden="true">
              Ctrl+,
            </kbd>
          </Link>
          <NavLink
            path="/administracion"
            className={styles.item}
            role="menuitem"
            tabIndex={-1}
            onNavigate={() => close(false)}
          />
          <NavLink
            path="/auditoria"
            className={styles.item}
            role="menuitem"
            tabIndex={-1}
            onNavigate={() => close(false)}
          />
          <NavLink
            path="/metodologia"
            label="Ayuda y metodología"
            className={styles.item}
            role="menuitem"
            tabIndex={-1}
            onNavigate={() => close(false)}
          />
          <hr className={styles.rule} />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${styles.item} ${styles.danger}`}
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            <Icon name="logout" className={styles.icon} />
            <span>Cerrar sesión</span>
          </button>
        </div>
      ) : null}
    </div>
  );
};
