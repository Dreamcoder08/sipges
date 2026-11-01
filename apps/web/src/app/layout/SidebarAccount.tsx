import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { THEME_OPTIONS, setTheme, useThemePreference } from '../../shared/lib/theme.ts';
import { accountDisplayName, accountInitials } from '../../shared/ui/account-name.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { logout, meQuery } from '../../features/auth/index.ts';
import { SYSTEM_PATHS } from '../navigation.ts';
import { NavLink } from './NavLink.tsx';
import styles from './SidebarAccount.module.css';

const ITEMS = '[role^="menuitem"]';

/**
 * Account row at the foot of the wide sidebar (docs/adr/0015). Its menu holds what no longer
 * has a place in the list: the Sistema screens, the appearance choice and sign-out. It follows
 * the menu button pattern: Enter, Space or ArrowDown open it on the first item, ArrowUp on the
 * last; arrows, Home and End move; Escape closes and returns focus to the row.
 */
export const SidebarAccount = ({
  pathname,
  projectLabel,
}: {
  pathname: string;
  projectLabel: string;
}) => {
  const me = useQuery(meQuery).data;
  const client = useQueryClient();
  const router = useRouter();
  const theme = useThemePreference();
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
          <span>Sistema, tema y sesión</span>
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
              <span>{projectLabel}</span>
            </span>
          </div>
          <div role="group" aria-label="Sistema">
            <p className={styles.label} aria-hidden="true">
              Sistema
            </p>
            {SYSTEM_PATHS.map((path) => (
              <NavLink
                key={path}
                path={path}
                className={styles.item}
                role="menuitem"
                tabIndex={-1}
                onNavigate={() => close(false)}
              />
            ))}
          </div>
          <div role="group" aria-label="Tema">
            <p className={styles.label} aria-hidden="true">
              Tema
            </p>
            {THEME_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={theme === option.value}
                tabIndex={-1}
                className={styles.item}
                onClick={() => setTheme(option.value)}
              >
                <span className={styles.dot} aria-hidden="true" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
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
