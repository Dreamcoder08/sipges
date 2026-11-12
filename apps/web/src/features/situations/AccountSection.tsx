import {
  type Role,
  SessionEnded,
  SessionList,
  type SessionSummary,
  SessionsRevoked,
} from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { isApiError, requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { formatDateTime } from '../../shared/lib/text.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './AccountSection.module.css';

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin: 'Administración',
  analista: 'Analista',
  coordinador: 'Coordinación',
  consulta: 'Consulta',
};

const METHOD_LABELS: Readonly<Record<SessionSummary['method'], string>> = {
  password: 'Contraseña',
  google: 'Google',
};

const sessionsKey = (scope: string) => ['auth-sessions', scope] as const;

/** Spanish agreement for «N sesiones» in the dialog and the notice. */
const othersWarning = (count: number) =>
  count === 1
    ? 'Se cerrará 1 sesión abierta en otro dispositivo.'
    : `Se cerrarán ${String(count)} sesiones abiertas en otros dispositivos.`;
const othersEnded = (count: number) =>
  count === 1
    ? 'Se cerró 1 sesión en otro dispositivo.'
    : `Se cerraron ${String(count)} sesiones en otros dispositivos.`;

type Pending =
  { readonly kind: 'one'; readonly session: SessionSummary } | { readonly kind: 'others' };

type Notice = { readonly tone: 'success' | 'info'; readonly text: string };

/**
 * Cuenta (compact-sidebar S7): who is signed in and where. SIPGES records no device or address,
 * so a session is told apart by when it started and how. This device is signed out from the
 * account menu; here the person ends the others, one by one or all at once, after confirming.
 */
export const AccountSection = ({
  scope,
  username,
  fullName,
  role,
}: {
  scope: string;
  username: string;
  fullName: string;
  role: Role;
}) => {
  const cache = useQueryClient();
  const sessions = useQuery({
    queryKey: sessionsKey(scope),
    queryFn: ({ signal }) => requestJson('/system/auth/sessions', SessionList, { scope, signal }),
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const reload = () => cache.invalidateQueries({ queryKey: sessionsKey(scope) });
  const end = useMutation({
    mutationFn: async (target: Pending): Promise<string> => {
      if (target.kind === 'one') {
        await requestJson(`/system/auth/sessions/${target.session.id}`, SessionEnded, {
          scope,
          method: 'DELETE',
        });
        return 'Sesión cerrada.';
      }
      const revoked = await requestJson('/system/auth/sessions/revoke-others', SessionsRevoked, {
        scope,
        method: 'POST',
      });
      return othersEnded(revoked.count);
    },
    onMutate: () => setNotice(null),
    onSuccess: async (text) => {
      setPending(null);
      setNotice({ tone: 'success', text });
      await reload();
    },
    onError: async (error, target) => {
      // The row was stale: that session already ended elsewhere. Drop it instead of keeping a
      // dialog about a session that no longer exists.
      if (target.kind !== 'one' || !isApiError(error, 404)) return;
      setPending(null);
      setNotice({ tone: 'info', text: 'Esa sesión ya estaba cerrada.' });
      await reload();
    },
  });
  const ask = (target: Pending) => {
    end.reset();
    setPending(target);
  };

  return (
    <>
      <Card eyebrow="Usuario" title="Cuenta">
        <dl className={styles.identity}>
          <div>
            <dt>Nombre</dt>
            <dd>{fullName}</dd>
          </div>
          <div>
            <dt>Usuario</dt>
            <dd>{username}</dd>
          </div>
          <div>
            <dt>Rol</dt>
            <dd>{ROLE_LABELS[role]}</dd>
          </div>
        </dl>
      </Card>
      <Card eyebrow="Seguridad" title="Sesiones activas">
        <p className={styles.note}>
          Cada inicio de sesión abierto con su cuenta. Si no reconoce alguno, ciérrelo y cambie su
          contraseña. Para salir de este dispositivo use «Cerrar sesión» en el menú de su cuenta.
        </p>
        <QueryState query={sessions} label="las sesiones activas">
          {(data) => {
            const others = data.sessions.filter((s) => !s.current);
            return (
              <>
                <ul className={styles.sessions} aria-label="Sesiones activas">
                  {data.sessions.map((s) => {
                    const started = formatDateTime(new Date(s.created_at));
                    return (
                      <li key={s.id} className={styles.session}>
                        <div className={styles.details}>
                          <p className={styles.title}>
                            {s.current ? (
                              <span className={styles.current}>Este dispositivo</span>
                            ) : null}
                            Iniciada {started}
                          </p>
                          <p className={styles.meta}>
                            {METHOD_LABELS[s.method]} · vence{' '}
                            {formatDateTime(new Date(s.expires_at))}
                          </p>
                        </div>
                        {s.current ? null : (
                          <Button
                            variant="secondary"
                            size="sm"
                            aria-label={`Cerrar sesión iniciada ${started}`}
                            onClick={() => ask({ kind: 'one', session: s })}
                          >
                            Cerrar
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {others.length === 0 ? (
                  <p className={styles.note}>
                    {data.sessions.length === 0
                      ? 'No hay sesiones activas.'
                      : 'No hay otras sesiones abiertas.'}
                  </p>
                ) : (
                  <Button variant="danger" onClick={() => ask({ kind: 'others' })}>
                    Cerrar sesión en todos los demás
                  </Button>
                )}
                {pending ? (
                  <ConfirmDialog
                    title={
                      pending.kind === 'one'
                        ? 'Cerrar esta sesión'
                        : 'Cerrar sesión en todos los demás dispositivos'
                    }
                    confirmLabel={
                      pending.kind === 'one' ? 'Cerrar sesión' : 'Cerrar las demás sesiones'
                    }
                    pendingLabel="Cerrando…"
                    pending={end.isPending}
                    error={end.isError ? errorDetail(end.error) : null}
                    onConfirm={() => end.mutate(pending)}
                    onCancel={() => setPending(null)}
                  >
                    {pending.kind === 'one'
                      ? `Se cerrará la sesión iniciada ${formatDateTime(
                          new Date(pending.session.created_at),
                        )}. Quien la use tendrá que volver a iniciar sesión.`
                      : `${othersWarning(others.length)} Este dispositivo sigue conectado.`}
                  </ConfirmDialog>
                ) : null}
              </>
            );
          }}
        </QueryState>
        {notice ? <Alert tone={notice.tone}>{notice.text}</Alert> : null}
      </Card>
    </>
  );
};
