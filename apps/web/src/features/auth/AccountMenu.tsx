import { accountDisplayName } from '../../shared/ui/account-name.ts';
import type { Me } from '@mascli/contracts';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
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
 * Account avatar that opens profile, extra sections (the notification inbox on phones) and
 * sign-out (docs/adr/0015). Signing out is the last row of the sheet, never a top-bar button.
 * The name comes from the session, never from the bundle.
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
        aria-label={`Cuenta de ${name}${unread > 0 ? `, ${unread} notificaciones sin leer` : ''}`}
        onClick={() => setOpen(true)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {letters}
          {unread > 0 && <span className={styles.dot} />}
        </span>
        <span className={styles.copy}>
          <b>{name}</b>
          <span>{ROLE_LABELS[me.role]}</span>
        </span>
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
