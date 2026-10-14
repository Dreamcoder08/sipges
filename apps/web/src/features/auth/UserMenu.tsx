import { accountDisplayName } from '../../shared/ui/account-name.ts';
import type { Me } from '@mascli/contracts';
import { useMutation } from '@tanstack/react-query';
import { Button } from '../../shared/ui/Button.tsx';
import { logout } from './api.ts';
import styles from './UserMenu.module.css';

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

/** Signed-in user and sign-out; the name comes from the session, never from the bundle. */
export const UserMenu = ({
  me,
  onSignedOut,
}: {
  me: NonNullable<Me>;
  onSignedOut: () => void | Promise<void>;
}) => {
  const mutation = useMutation({
    mutationFn: logout,
    meta: { public: true },
    onSettled: () => onSignedOut(),
  });
  return (
    <div className={styles.menu}>
      <span className={styles.avatar} aria-hidden="true">
        {initials(accountDisplayName(me.full_name)) || '?'}
      </span>
      <span className={styles.copy}>
        <b>{accountDisplayName(me.full_name)}</b>
        <span>{ROLE_LABELS[me.role]}</span>
      </span>
      <Button variant="ghost" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        Salir
      </Button>
    </div>
  );
};
