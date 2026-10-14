import { accountDisplayName } from '../../shared/ui/account-name.ts';
import {
  AccountCreated,
  AccountList,
  AuthorizedScopeList,
  GoogleLinked,
  OkResponse,
  Role,
  ScopeCreated,
  TotpEnabled,
  TotpSetupResponse,
} from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { downloadFile } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './AdministrationPage.module.css';

type Access = { username: string; company_id: string; project_id: string };
type Confirmation = { kind: 'deactivate'; username: string } | { kind: 'revoke'; access: Access };
type Operation =
  | {
      kind: 'account';
      body: { username: string; full_name: string; password: string; role: string };
    }
  | { kind: 'scope'; body: Access & { label: string } }
  | { kind: 'grant'; body: Access }
  | { kind: 'google'; username: string; email: string }
  | Confirmation
  | { kind: 'setup' }
  | { kind: 'enable'; code: string }
  | { kind: 'export' };
const emptyAccount = { username: '', full_name: '', password: '', role: 'consulta' };
const emptyAccess = { username: '', company_id: '', project_id: '' };
const emptyGoogle = { username: '', email: '' };

/** Identity administration uses account APIs; project grants remain explicitly tenant-bound. */
export const AdministrationPage = ({ scope, projectLabel, role, username }: FeatureContext) => {
  const cache = useQueryClient();
  const mounted = useRef(true);
  const operationLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const admin = role === 'admin';
  const canMfa = admin || role === 'analista';
  const [account, setAccount] = useState(emptyAccount);
  const [tenant, setTenant] = useState({ ...emptyAccess, label: '' });
  const [access, setAccess] = useState(emptyAccess);
  const [googleLink, setGoogleLink] = useState(emptyGoogle);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [totp, setTotp] = useState<{
    secret: string;
    otpauth_uri: string;
    instruction: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [notice, setNotice] = useState('');
  const accounts = useQuery({
    queryKey: ['administration', scope, 'accounts'],
    enabled: admin,
    queryFn: ({ signal }) => requestJson('/system/auth/accounts', AccountList, { scope, signal }),
  });
  const scopes = useQuery({
    queryKey: ['administration', scope, 'scopes'],
    enabled: admin,
    queryFn: ({ signal }) =>
      requestJson('/system/auth/scopes', AuthorizedScopeList, { scope, signal }),
  });
  const mutation = useMutation({
    mutationFn: async (operation: Operation) => {
      const options = { scope, method: 'POST' as const };
      switch (operation.kind) {
        case 'account':
          await requestJson('/system/auth/accounts', AccountCreated, {
            ...options,
            body: { json: operation.body },
          });
          return 'Cuenta creada.';
        case 'scope':
          await requestJson('/system/auth/scopes', ScopeCreated, {
            ...options,
            body: { json: operation.body },
          });
          return 'Proyecto creado con acceso inicial.';
        case 'grant':
          await requestJson('/system/auth/grants', OkResponse, {
            ...options,
            body: { json: operation.body },
          });
          return 'Acceso concedido.';
        case 'google': {
          const linked = await requestJson(
            `/system/auth/accounts/${encodeURIComponent(operation.username)}/google`,
            GoogleLinked,
            { ...options, body: { json: { email: operation.email } } },
          );
          return linked.google_email
            ? `${linked.username} ya puede entrar con Google (${linked.google_email}).`
            : `Se quitó el ingreso con Google de ${linked.username}.`;
        }
        case 'deactivate':
          await requestJson(
            `/system/auth/accounts/${encodeURIComponent(operation.username)}/deactivate`,
            OkResponse,
            options,
          );
          return 'Cuenta desactivada y sesiones revocadas.';
        case 'revoke':
          await requestJson('/system/auth/grants', OkResponse, {
            scope,
            method: 'DELETE',
            body: { json: operation.access },
          });
          return 'Acceso revocado.';
        case 'setup':
          return requestJson('/system/auth/totp/setup', TotpSetupResponse, options);
        case 'enable':
          await requestJson('/system/auth/totp/enable', TotpEnabled, {
            ...options,
            body: { json: { code: operation.code } },
          });
          return 'MFA activado.';
        case 'export':
          await downloadFile(scope, '/system/export', 'mascli-tenant.json');
          return 'Exportación descargada.';
      }
    },
    onSettled: () => {
      operationLock.current = false;
    },
    onSuccess: async (result, operation) => {
      if (!mounted.current) return;
      setConfirmation(null);
      if (typeof result === 'string') setNotice(result);
      else {
        setTotp(result);
        setNotice('');
      }
      if (operation.kind === 'account') setAccount(emptyAccount);
      if (operation.kind === 'scope') setTenant({ ...emptyAccess, label: '' });
      if (operation.kind === 'google') setGoogleLink(emptyGoogle);
      if (operation.kind === 'enable') {
        setTotp(null);
        setCode('');
        setMfaEnabled(true);
      }
      if (operation.kind === 'deactivate' && operation.username.trim().toLowerCase() === username) {
        cache.clear();
        window.location.assign('/login');
        return;
      }
      if (
        operation.kind === 'revoke' &&
        operation.access.username.trim().toLowerCase() === username &&
        `${operation.access.company_id}/${operation.access.project_id}` === scope
      ) {
        cache.clear();
        window.location.assign('/proyecto');
        return;
      }
      await cache.invalidateQueries({ queryKey: ['administration', scope] });
      if (operation.kind === 'scope' || operation.kind === 'grant' || operation.kind === 'revoke')
        await cache.invalidateQueries({ predicate: (query) => query.queryKey.includes('scopes') });
    },
  });
  const busy = mutation.isPending;
  const run = (operation: Operation) => {
    if (operationLock.current) return;
    operationLock.current = true;
    setNotice('');
    mutation.mutate(operation);
  };
  return (
    <div className={styles.page}>
      <p>
        Proyecto activo: <strong>{projectLabel}</strong> ({scope}). Los cambios de identidad y
        accesos requieren autorización del servidor.
      </p>
      {notice && <Alert tone="success">{notice}</Alert>}
      {mutation.error && <Alert tone="error">{errorDetail(mutation.error)}</Alert>}
      {!admin && <Alert tone="info">Administración restringida al rol administrador.</Alert>}
      {admin && (
        <>
          <Card title="Cuentas de identidad">
            <QueryState query={accounts} label="cuentas">
              {(rows) =>
                rows.length ? (
                  <div className={styles.scroll}>
                    <table>
                      <thead>
                        <tr>
                          <th>Usuario</th>
                          <th>Nombre</th>
                          <th>Rol</th>
                          <th>Google</th>
                          <th>Estado</th>
                          <th>Acción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.username}>
                            <td>{row.username}</td>
                            <td>{accountDisplayName(row.full_name)}</td>
                            <td>{row.role}</td>
                            <td>{row.google_email ?? '—'}</td>
                            <td>{row.active ? 'Activa' : 'Inactiva'}</td>
                            <td>
                              {row.active === 1 && (
                                <Button
                                  variant="secondary"
                                  disabled={busy || !!confirmation}
                                  onClick={() =>
                                    setConfirmation({ kind: 'deactivate', username: row.username })
                                  }
                                  aria-label={`Desactivar ${row.username}`}
                                >
                                  Desactivar
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No hay cuentas.</p>
                )
              }
            </QueryState>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                run({ kind: 'account', body: { ...account } });
              }}
            >
              <fieldset disabled={busy || !!confirmation}>
                <legend>Crear cuenta</legend>
                <Field
                  label="Usuario nuevo"
                  required
                  autoComplete="off"
                  value={account.username}
                  onChange={(event) => setAccount({ ...account, username: event.target.value })}
                />
                <Field
                  label="Nombre completo"
                  required
                  value={account.full_name}
                  onChange={(event) => setAccount({ ...account, full_name: event.target.value })}
                />
                <Field
                  label="Contraseña inicial"
                  required
                  type="password"
                  minLength={12}
                  autoComplete="new-password"
                  value={account.password}
                  onChange={(event) => setAccount({ ...account, password: event.target.value })}
                  hint="La política de contraseñas se valida en el servidor."
                />
                <label>
                  Rol de la cuenta
                  <select
                    value={account.role}
                    onChange={(event) => setAccount({ ...account, role: event.target.value })}
                  >
                    {Role.options.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <Button type="submit">Crear cuenta</Button>
              </fieldset>
            </form>
          </Card>
          <Card title="Entrar con Google">
            <p>
              Vincula el correo de Google de una cuenta existente para que entre sin contraseña.
              Solo los correos vinculados aquí pueden ingresar; deja el correo vacío para quitar el
              vínculo.
            </p>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                run({ kind: 'google', ...googleLink });
              }}
            >
              <fieldset disabled={busy || !!confirmation}>
                <legend>Vincular cuenta de Google</legend>
                <Field
                  label="Usuario a vincular"
                  required
                  autoComplete="off"
                  value={googleLink.username}
                  onChange={(event) =>
                    setGoogleLink({ ...googleLink, username: event.target.value })
                  }
                />
                <Field
                  label="Correo de Google"
                  type="email"
                  autoComplete="off"
                  value={googleLink.email}
                  onChange={(event) => setGoogleLink({ ...googleLink, email: event.target.value })}
                />
                <Button type="submit">Guardar vínculo</Button>
              </fieldset>
            </form>
          </Card>
          <Card title="Proyectos autorizados">
            <p>
              Este catálogo muestra los proyectos concedidos a tu cuenta. El servidor no expone un
              catálogo global ni una lista de accesos de otros usuarios.
            </p>
            <QueryState query={scopes} label="proyectos">
              {(rows) => (
                <ul>
                  {rows.map((row) => (
                    <li key={`${row.company_id}/${row.project_id}`}>
                      {row.label} ({row.company_id}/{row.project_id})
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                run({ kind: 'scope', body: { ...tenant } });
              }}
            >
              <fieldset disabled={busy || !!confirmation}>
                <legend>Crear proyecto</legend>
                <Field
                  label="Empresa nueva"
                  required
                  value={tenant.company_id}
                  onChange={(event) => setTenant({ ...tenant, company_id: event.target.value })}
                />
                <Field
                  label="Proyecto nuevo"
                  required
                  value={tenant.project_id}
                  onChange={(event) => setTenant({ ...tenant, project_id: event.target.value })}
                />
                <Field
                  label="Nombre del proyecto"
                  required
                  value={tenant.label}
                  onChange={(event) => setTenant({ ...tenant, label: event.target.value })}
                />
                <Field
                  label="Usuario con acceso inicial"
                  required
                  value={tenant.username}
                  onChange={(event) => setTenant({ ...tenant, username: event.target.value })}
                />
                <Button type="submit">Crear proyecto</Button>
              </fieldset>
            </form>
          </Card>
          <Card title="Conceder o revocar acceso">
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                run({ kind: 'grant', body: { ...access } });
              }}
            >
              <fieldset disabled={busy || !!confirmation}>
                <legend>Acceso explícito</legend>
                <Field
                  label="Usuario del acceso"
                  required
                  value={access.username}
                  onChange={(event) => setAccess({ ...access, username: event.target.value })}
                />
                <Field
                  label="Empresa del acceso"
                  required
                  value={access.company_id}
                  onChange={(event) => setAccess({ ...access, company_id: event.target.value })}
                />
                <Field
                  label="Proyecto del acceso"
                  required
                  value={access.project_id}
                  onChange={(event) => setAccess({ ...access, project_id: event.target.value })}
                />
                <div className={styles.actions}>
                  <Button type="submit">Conceder acceso</Button>
                  <Button
                    variant="secondary"
                    disabled={!access.username || !access.company_id || !access.project_id}
                    onClick={() => setConfirmation({ kind: 'revoke', access: { ...access } })}
                  >
                    Revocar acceso
                  </Button>
                </div>
              </fieldset>
            </form>
          </Card>
          {confirmation && (
            <Card title="Confirmación requerida">
              <p>
                {confirmation.kind === 'deactivate'
                  ? `Desactivar ${confirmation.username} revoca todas sus sesiones. El servidor protege al último administrador.`
                  : `Revocar el acceso de ${confirmation.access.username} a ${confirmation.access.company_id}/${confirmation.access.project_id}.`}
              </p>
              <div className={styles.actions}>
                <Button disabled={busy} onClick={() => run(confirmation)}>
                  {confirmation.kind === 'deactivate'
                    ? 'Confirmar desactivación'
                    : 'Confirmar revocación'}
                </Button>
                <Button disabled={busy} variant="secondary" onClick={() => setConfirmation(null)}>
                  Cancelar
                </Button>
              </div>
            </Card>
          )}
          <Card title="Exportación del proyecto">
            <p>
              Exporta exclusivamente el proyecto activo {scope}; el servidor excluye credenciales.
            </p>
            <Button disabled={busy || !!confirmation} onClick={() => run({ kind: 'export' })}>
              Exportar JSON del proyecto
            </Button>
          </Card>
        </>
      )}
      <Card title="Mi autenticación multifactor">
        <p>
          La configuración pertenece a tu cuenta ({username}). Conserva el secreto únicamente en tu
          aplicación autenticadora.
        </p>
        {!canMfa ? (
          <p>Tu rol actual no permite configurar MFA mediante este endpoint.</p>
        ) : (
          <>
            {!totp && !mfaEnabled && (
              <Button disabled={busy || !!confirmation} onClick={() => run({ kind: 'setup' })}>
                Configurar mi MFA
              </Button>
            )}
            {totp && (
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  run({ kind: 'enable', code });
                }}
              >
                <fieldset disabled={busy || !!confirmation}>
                  <legend>Confirmar configuración TOTP</legend>
                  <p>{totp.instruction}</p>
                  <p>
                    Secreto: <code>{totp.secret}</code>
                  </p>
                  <details>
                    <summary>URI para la aplicación autenticadora</summary>
                    <code className={styles.uri}>{totp.otpauth_uri}</code>
                  </details>
                  <Field
                    label="Código TOTP"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button type="submit">Activar MFA</Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setTotp(null);
                      setCode('');
                    }}
                  >
                    Ocultar secreto
                  </Button>
                </fieldset>
              </form>
            )}
          </>
        )}
      </Card>
    </div>
  );
};
