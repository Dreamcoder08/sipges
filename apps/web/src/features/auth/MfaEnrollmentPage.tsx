import { TotpSetupResponse, TotpEnabled } from '@sipges/contracts';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';

/** Enrollment deliberately needs neither a project grant nor an administrative role. */
export const MfaEnrollmentPage = ({
  onEnabled,
  onSignOut,
}: {
  onEnabled: () => Promise<void>;
  onSignOut: () => Promise<void>;
}) => {
  const [code, setCode] = useState('');
  const lock = useRef(false);
  const setup = useMutation({
    mutationFn: () => requestJson('/system/auth/totp/setup', TotpSetupResponse, { method: 'POST' }),
  });
  const enable = useMutation({
    mutationFn: (value: string) =>
      requestJson('/system/auth/totp/enable', TotpEnabled, {
        method: 'POST',
        body: { json: { code: value } },
      }),
    onSuccess: async () => {
      setCode('');
      setup.reset();
      await onEnabled();
    },
  });
  const busy = setup.isPending || enable.isPending;
  const run = async (kind: 'setup' | 'enable') => {
    if (lock.current) return;
    lock.current = true;
    try {
      if (kind === 'setup') await setup.mutateAsync();
      else await enable.mutateAsync(code);
    } catch {
      /* Error displayed below. */
    } finally {
      lock.current = false;
    }
  };
  return (
    <main style={{ maxWidth: '36rem', margin: '3rem auto', padding: '1rem' }}>
      <h1>Configurar autenticación multifactor</h1>
      <p>
        Antes de acceder al proyecto, añade tu cuenta a una aplicación autenticadora y confirma un
        código de seis dígitos.
      </p>
      <Card title="Mi autenticador">
        {!setup.data ? (
          <Button disabled={busy} onClick={() => void run('setup')}>
            Preparar autenticador
          </Button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void run('enable');
            }}
          >
            <fieldset disabled={busy}>
              <legend>Confirmar autenticador</legend>
              <p>Introduce esta clave en tu aplicación autenticadora. Consérvala en privado.</p>
              <code>{setup.data.secret}</code>
              <details>
                <summary>URI de configuración manual</summary>
                <code style={{ overflowWrap: 'anywhere' }}>{setup.data.otpauth_uri}</code>
              </details>
              <Field
                label="Código del autenticador"
                required
                pattern="[0-9]{6}"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              />
              <Button type="submit" disabled={busy || code.length !== 6}>
                Activar y continuar
              </Button>
            </fieldset>
          </form>
        )}
        {setup.error ? <Alert tone="error">{errorDetail(setup.error)}</Alert> : null}
        {enable.error ? <Alert tone="error">{errorDetail(enable.error)}</Alert> : null}
        <Button variant="secondary" disabled={busy} onClick={() => void onSignOut()}>
          Cerrar sesión
        </Button>
      </Card>
    </main>
  );
};
