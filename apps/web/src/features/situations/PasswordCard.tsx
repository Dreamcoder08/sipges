import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { isApiError, request } from '../../shared/api/client.ts';
import { providersQuery } from '../../shared/api/providers.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { useFormErrors } from '../../shared/ui/form-errors.tsx';
import styles from './Situations.module.css';

const PATH = '/system/auth/password';
const MISMATCH = 'Las contraseñas nuevas no coinciden.';
const CHANGED = 'Contraseña cambiada. Se cerraron las sesiones abiertas en otros dispositivos.';

type Problem = { readonly field: 'current' | 'next' | 'again' | 'form'; readonly text: string };

/**
 * «Cambiar contraseña» in Cuenta: the current password, the new one twice. The server applies
 * the policy and closes every other session; its answer is shown next to the field it concerns.
 * Offered only where the API has the route, so the form never fails by construction.
 */
export const PasswordCard = ({ scope, onChanged }: { scope: string; onChanged: () => void }) => {
  // Only the Go API changes a password, and says so in /system/auth/providers; the TypeScript API
  // still serving cloud production does not, so the form is never offered where it would fail.
  const providers = useQuery(providersQuery);
  return providers.data?.password_change === true ? (
    <PasswordForm scope={scope} onChanged={onChanged} />
  ) : null;
};

const PasswordForm = ({ scope, onChanged }: { scope: string; onChanged: () => void }) => {
  const base = useId();
  const ids = { current: `${base}-current`, next: `${base}-next`, again: `${base}-again` };
  const [values, setValues] = useState({ current: '', next: '', again: '' });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState(false);
  const formErrors = useFormErrors();
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!problem) return;
    if (problem.field === 'form') alertRef.current?.focus();
    else document.getElementById(`${base}-${problem.field}`)?.focus();
  }, [problem, base]);

  const change = useMutation({
    mutationFn: (body: { current_password: string; new_password: string }) =>
      request(PATH, { scope, method: 'POST', body: { json: body } }),
    onMutate: () => {
      setProblem(null);
      setDone(false);
    },
    onSuccess: () => {
      setValues({ current: '', next: '', again: '' });
      setDone(true);
      onChanged();
    },
    onError: (error) => {
      // 401 is handled by the query client: the person is sent to sign in again.
      if (isApiError(error, 401)) return;
      const text = errorDetail(error);
      if (isApiError(error, 400)) setProblem({ field: 'current', text });
      else if (isApiError(error, 422)) setProblem({ field: 'next', text });
      else setProblem({ field: 'form', text });
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDone(false);
    if (!formErrors.validate(event.currentTarget)) {
      setProblem(null);
      return;
    }
    if (values.next !== values.again) {
      setProblem({ field: 'again', text: MISMATCH });
      return;
    }
    change.mutate({ current_password: values.current, new_password: values.next });
  };

  const edit = (field: keyof typeof values) => (event: FormEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setValues((current) => ({ ...current, [field]: value }));
    formErrors.recheck(event.currentTarget);
    if (problem?.field === field || (problem?.field === 'again' && field === 'next'))
      setProblem(null);
  };
  const errorFor = (field: keyof typeof values) =>
    formErrors.messageFor(ids[field]) ?? (problem?.field === field ? problem.text : undefined);

  return (
    <Card eyebrow="Seguridad" title="Cambiar contraseña">
      <form noValidate onSubmit={submit} className={styles.form}>
        <Field
          id={ids.current}
          label="Contraseña actual"
          type="password"
          name="current-password"
          autoComplete="current-password"
          required
          value={values.current}
          onChange={edit('current')}
          error={errorFor('current')}
        />
        <Field
          id={ids.next}
          label="Contraseña nueva"
          hint="Entre 12 y 128 caracteres. Al cambiarla se cierran las demás sesiones."
          type="password"
          name="new-password"
          autoComplete="new-password"
          required
          value={values.next}
          onChange={edit('next')}
          error={errorFor('next')}
        />
        <Field
          id={ids.again}
          label="Repita la contraseña nueva"
          type="password"
          name="new-password-again"
          autoComplete="new-password"
          required
          value={values.again}
          onChange={edit('again')}
          error={errorFor('again')}
        />
        <div>
          <Button type="submit" disabled={change.isPending}>
            {change.isPending ? 'Cambiando…' : 'Cambiar contraseña'}
          </Button>
        </div>
      </form>
      {problem?.field === 'form' ? (
        <Alert tone="error" ref={alertRef}>
          {problem.text}
        </Alert>
      ) : null}
      {done ? <Alert tone="success">{CHANGED}</Alert> : null}
    </Card>
  );
};
