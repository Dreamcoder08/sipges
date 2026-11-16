import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useState } from 'react';
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

/**
 * Both APIs answer exactly this (401) when the account needs its second factor and the code is
 * missing or wrong; every other sign-in failure has another text.
 */
const OTP_ANSWER = 'Código de autenticación inválido';

const isOtpAnswer = (error: unknown) => isApiError(error, 401) && error.detail === OTP_ANSWER;

/** What the form shows for a failed attempt: the server's words, or a connection problem. */
const errorMessage = (error: unknown): string | null => {
  if (!error) return null;
  if (isApiError(error)) return error.detail;
  return 'No se pudo conectar con SIPGES. Revise su conexión.';
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
  const otpId = useId();
  const providers = useQuery(providersQuery);
  const mutation = useMutation({
    mutationFn: login,
    meta: { public: true },
    onSuccess: () => onSignedIn(),
    onError: (error) => {
      if (isOtpAnswer(error)) setNeedsOtp(true);
    },
  });

  // When the code field appears, focus it: screen readers then announce what to type next.
  useEffect(() => {
    if (needsOtp) document.getElementById(otpId)?.focus();
  }, [needsOtp, otpId]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate({ username, password, otp });
  };

  const error = mutation.error;
  // An attempt without a code that gets the code answer is the request for one, not an error.
  const asksForCode = isOtpAnswer(error) && !mutation.variables?.otp;
  const message = asksForCode ? null : errorMessage(error);

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={submit} aria-labelledby={titleId} noValidate>
        <div className={styles.brand} aria-hidden="true">
          S
        </div>
        <h1 id={titleId}>Ingresar a SIPGES</h1>
        <p className={styles.lead}>Sistema Inteligente de Predicción y GEStión Social.</p>
        {message ? <Alert tone="error">{message}</Alert> : null}
        {asksForCode ? (
          <Alert tone="info">
            Ingrese el código de seis dígitos de su aplicación de autenticación.
          </Alert>
        ) : null}
        {googleError && !message && !asksForCode ? (
          <Alert tone="error">{GOOGLE_ERRORS[googleError]}</Alert>
        ) : null}
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
            id={otpId}
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
