import { accountDisplayName } from '../../shared/ui/account-name.ts';
import type { Me } from '@sipges/contracts';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { THEME_OPTIONS, setTheme, useThemePreference } from '../../shared/lib/theme.ts';
import { Icon } from '../../shared/ui/Icon.tsx';
import { SegmentedControl } from '../../shared/ui/SegmentedControl.tsx';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import { logout } from './api.ts';
import styles from './AccountMenu.module.css';

const ROLE_LABELS: Readonly<Record<NonNullable<Me>['role'], string>> = {
  admin: 'Administración',
  analista: 'Análisis',
  coordinador: 'Coordinación',
  consulta: 'Consulta',
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

/**
 * Account avatar that opens profile, extra sections (the notification inbox on phones), the
 * appearance choice (docs/adr/0018) and sign-out (docs/adr/0015). Signing out is the last row
 * of the sheet, never a top-bar button. The name comes from the session, never from the bundle.
 */
export const AccountMenu = ({
  me,
  project,
  unread = 0,
  children,
  onSignedOut,
}: {
  me: NonNullable<Me>;
  project: string;
  unread?: number;
  children?: ReactNode;
  onSignedOut: () => void | Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const theme = useThemePreference();
  const mutation = useMutation({
    mutationFn: logout,
    meta: { public: true },
    onSettled: () => onSignedOut(),
  });
  const name = accountDisplayName(me.full_name);
  const letters = initials(name) || '?';
  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {letters}
          {unread > 0 && <span className={styles.dot} />}
        </span>
        <span className={styles.copy}>
          <span className="visually-hidden">Cuenta de </span>
          <b>{name}</b>
          <span>{ROLE_LABELS[me.role]}</span>
        </span>
        {unread > 0 && <span className="visually-hidden">, {unread} notificaciones sin leer</span>}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Cuenta">
        <div className={styles.profile}>
          <span className={`${styles.avatar} ${styles.large}`} aria-hidden="true">
            {letters}
          </span>
          <span className={styles.who}>
            <b>{name}</b>
            <span>
              {ROLE_LABELS[me.role]} · {project}
            </span>
          </span>
        </div>
        {children ? <div className={styles.section}>{children}</div> : null}
        <div className={styles.section}>
          <SegmentedControl
            legend="Apariencia"
            options={THEME_OPTIONS}
            value={theme}
            onChange={setTheme}
          />
        </div>
        <button
          type="button"
          className={styles.signOut}
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          <Icon name="logout" />
          Cerrar sesión
        </button>
      </Sheet>
    </>
  );
};
