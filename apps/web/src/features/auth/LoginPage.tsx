import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { login } from './api.ts';
import styles from './LoginPage.module.css';

const OTP_PATTERN = '[0-9]{6}';

/** Sign-in form (app.py POST /login). The OTP is asked only after the server requires it. */
export const LoginPage = ({ onSignedIn }: { onSignedIn: () => void | Promise<void> }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [needsOtp, setNeedsOtp] = useState(false);
  const titleId = useId();
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
      : 'No se pudo conectar con MASCLI. Revise su conexión.';

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={submit} aria-labelledby={titleId} noValidate>
        <div className={styles.brand} aria-hidden="true">
          M
        </div>
        <h1 id={titleId}>Ingresar a MASCLI</h1>
        <p className={styles.lead}>
          Gestión del riesgo socioambiental con evidencia y validación humana.
        </p>
        {message ? <Alert tone="error">{message}</Alert> : null}
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
