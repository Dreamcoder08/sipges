import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { z } from 'zod';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { login, providersQuery } from './api.ts';
import styles from './LoginPage.module.css';

const OTP_PATTERN = '[0-9]{6}';

/** Reasons the API gives in `/login?google=…` when a Google sign-in is refused (ADR 0010). */
export const GoogleSignInError = z.enum(['cancelled', 'expired', 'failed', 'not_linked']);
export type GoogleSignInError = z.infer<typeof GoogleSignInError>;

const GOOGLE_ERRORS: Record<GoogleSignInError, string> = {
  cancelled: 'Se canceló el ingreso con Google.',
  expired: 'El ingreso con Google caducó. Inténtelo de nuevo.',
  failed: 'Google no confirmó la identidad. Inténtelo de nuevo.',
  not_linked:
    'Esa cuenta de Google no está autorizada en SIPGES. Pida al administrador que la vincule.',
};

/** Sign-in form (app.py POST /login). The OTP is asked only after the server requires it. */
export const LoginPage = ({
  onSignedIn,
  googleError,
}: {
  onSignedIn: () => void | Promise<void>;
  googleError?: GoogleSignInError | undefined;
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [needsOtp, setNeedsOtp] = useState(false);
  const titleId = useId();
  const providers = useQuery(providersQuery);
  const mutation = useMutation({
    mutationFn: login,
    meta: { public: true },
    onSuccess: () => onSignedIn(),
    onError: (error) => {
      if (isApiError(error, 401) && error.detail.includes('autenticación')) setNeedsOtp(true);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate({ username, password, otp });
  };

  const error = mutation.error;
  const message = !error
    ? null
    : isApiError(error)
      ? error.detail
      : 'No se pudo conectar con SIPGES. Revise su conexión.';

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={submit} aria-labelledby={titleId} noValidate>
        <div className={styles.brand} aria-hidden="true">
          S
        </div>
        <h1 id={titleId}>Ingresar a SIPGES</h1>
        <p className={styles.lead}>Sistema Inteligente de Predicción y GEStión Social.</p>
        {message ? <Alert tone="error">{message}</Alert> : null}
        {googleError && !message ? <Alert tone="error">{GOOGLE_ERRORS[googleError]}</Alert> : null}
        {providers.data?.google ? (
          <>
            {/* A full navigation: the API redirects to Google and back (ADR 0010). */}
            <a className={styles.google} href="/auth/google">
              Entrar con Google
            </a>
            <p className={styles.divider}>o con usuario y contraseña</p>
          </>
        ) : null}
        <Field
          label="Usuario"
          name="username"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <Field
          label="Contraseña"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needsOtp ? (
          <Field
            label="Código de autenticación"
            hint="Seis dígitos de su aplicación TOTP."
            name="otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern={OTP_PATTERN}
            maxLength={6}
            required
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
        ) : null}
        <Button type="submit" disabled={mutation.isPending || !username || !password}>
          {mutation.isPending ? 'Ingresando…' : 'Ingresar'}
        </Button>
      </form>
    </main>
  );
};
