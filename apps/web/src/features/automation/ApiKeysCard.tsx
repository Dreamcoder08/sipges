import { ApiKeyCreated, ApiKeyOut, type ApiKeyIn } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import styles from './AutomationPage.module.css';

const Ok = z.object({ ok: z.literal(true) });

const date = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—';

/** Machine access for AI agents (MCP) and inbound integrations (ADR 0014 §6-7). */
export const ApiKeysCard = ({ scope }: { scope: string }) => {
  const client = useQueryClient();
  const keys = useQuery({
    queryKey: ['automation', scope, 'api-keys'],
    queryFn: ({ signal }) =>
      requestJson('/system/integrations/api-keys', ApiKeyOut.array(), { scope, signal }),
  });
  const [form, setForm] = useState<ApiKeyIn>({ name: '', access: 'read', clearance: 'limited' });
  const [token, setToken] = useState('');
  const mutation = useMutation({
    mutationFn: async (operation: { kind: 'create' } | { kind: 'revoke'; id: number }) => {
      if (operation.kind === 'create') {
        const created = await requestJson('/system/integrations/api-keys', ApiKeyCreated, {
          scope,
          method: 'POST',
          body: { json: form },
        });
        setToken(created.token);
        setForm({ name: '', access: 'read', clearance: 'limited' });
        return;
      }
      setToken('');
      await requestJson(`/system/integrations/api-keys/${operation.id}`, Ok, {
        scope,
        method: 'DELETE',
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['automation', scope, 'api-keys'] }),
  });
  const endpoint = `${window.location.origin}/mcp`;
  const busy = mutation.isPending;

  return (
    <Card title="Agentes de IA e integraciones (MCP)">
      <p>
        Conecta Claude, ChatGPT, Copilot, Gemini u otros agentes compatibles con el Model Context
        Protocol a <code>{endpoint}</code> usando una clave de API. Las claves de escritura permiten
        además crear registros y vínculos, y alimentar SIPGES desde n8n, Zapier o Make.
      </p>
      {mutation.error && <Alert tone="error">{errorDetail(mutation.error)}</Alert>}
      {token && (
        <Alert tone="success">
          <p>Copia la clave ahora; no volverá a mostrarse:</p>
          <code className={styles.token}>{token}</code>
          <p>
            En el cliente MCP usa la URL <code>{endpoint}</code> con la cabecera{' '}
            <code>Authorization: Bearer &lt;clave&gt;</code>.
          </p>
        </Alert>
      )}
      <QueryState query={keys} label="las claves">
        {(rows) =>
          rows.length === 0 ? (
            <p>No hay claves todavía.</p>
          ) : (
            <ul className={styles.list}>
              {rows.map((key) => (
                <li key={key.id} className={styles.item}>
                  <div>
                    <strong>{key.name}</strong>{' '}
                    <span className={key.revoked_at ? styles.off : styles.on}>
                      {key.revoked_at ? 'Revocada' : 'Activa'}
                    </span>
                    <p>
                      {key.access === 'write' ? 'Lectura y escritura' : 'Solo lectura'} ·{' '}
                      {key.clearance === 'full' ? 've restringidos' : 'sin restringidos'} · mscli_
                      {key.prefix}… · último uso {date(key.last_used_at)}
                    </p>
                  </div>
                  {!key.revoked_at && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Revocar clave ${key.name}`}
                      onClick={() => mutation.mutate({ kind: 'revoke', id: key.id })}
                    >
                      Revocar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate({ kind: 'create' });
        }}
      >
        <fieldset disabled={busy}>
          <legend>Nueva clave de API</legend>
          <Field
            label="Nombre de la clave"
            required
            maxLength={80}
            value={form.name}
            hint="Identifica al agente o sistema; aparece como autor en el historial."
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <label>
            Permisos
            <select
              value={form.access}
              onChange={(e) => setForm({ ...form, access: e.target.value as ApiKeyIn['access'] })}
            >
              <option value="read">Solo lectura</option>
              <option value="write">Lectura y escritura</option>
            </select>
          </label>
          <label>
            Registros restringidos
            <select
              value={form.clearance}
              onChange={(e) =>
                setForm({ ...form, clearance: e.target.value as ApiKeyIn['clearance'] })
              }
            >
              <option value="limited">No los ve</option>
              <option value="full">Los ve</option>
            </select>
          </label>
          <Button type="submit">Crear clave</Button>
        </fieldset>
      </form>
    </Card>
  );
};
