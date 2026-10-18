import type {
  AutomationOverview,
  ChannelKind,
  ConditionIn,
  RuleIn,
  RuleOut,
} from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import {
  ACTION_LABELS,
  CHANNEL_FIELDS,
  OPERATOR_LABELS,
  createChannel,
  deleteChannel,
  deleteRule,
  overviewQuery,
  saveRule,
  testChannel,
  tick,
} from './api.ts';
import { RuntimeCard } from './RuntimeCard.tsx';
import { ApiKeysCard } from './ApiKeysCard.tsx';
import { useReveal } from '../../shared/lib/reveal.ts';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.tsx';
import styles from './AutomationPage.module.css';

type Step = RuleIn['steps'][number];

const emptyRule = (): RuleIn => ({
  name: '',
  enabled: true,
  module: 'Alertas',
  actions: ['CREATE'],
  conditions: [],
  steps: [{ kind: 'notify', title: '{modulo} {id}: nuevo registro' }],
});

const ruleInput = (rule: RuleOut): RuleIn => ({
  name: rule.name,
  enabled: rule.enabled,
  module: rule.module,
  actions: rule.actions,
  conditions: rule.conditions,
  steps: rule.steps,
});

const STATUS_LABELS = { pending: 'Pendiente', done: 'Completada', failed: 'Fallida' } as const;

const describeRule = (rule: RuleOut, overview: AutomationOverview) => {
  const source =
    rule.module === '*'
      ? 'cualquier módulo'
      : (overview.sources.find((s) => s.module === rule.module)?.label ?? rule.module);
  const when = rule.actions
    .map((a) => ACTION_LABELS[a] ?? a)
    .join(', ')
    .toLocaleLowerCase('es');
  const conditions = rule.conditions
    .map(
      (c) =>
        `${c.field} ${OPERATOR_LABELS[c.op] ?? c.op}${c.op === 'present' || c.op === 'absent' ? '' : ` «${c.value}»`}`,
    )
    .join(' y ');
  const steps = rule.steps
    .map((s) =>
      s.kind === 'evaluate'
        ? `evaluar narrativa (mínimo ${s.minimum_level})`
        : s.kind === 'notify'
          ? 'aviso en la bandeja'
          : `mensaje a ${overview.channels.find((c) => c.id === s.channel_id)?.name ?? 'canal eliminado'}`,
    )
    .join(' + ');
  return `Cuando hay ${when} en ${source}${conditions ? ` y ${conditions}` : ''}: ${steps}.`;
};

/** Rules that react to project events, the channels they reach and their delivery log (ADR 0014). */
export const AutomationPage = ({ scope, projectLabel, role }: FeatureContext) => {
  const admin = role === 'admin';
  const client = useQueryClient();
  const overview = useQuery({ ...overviewQuery(scope), enabled: admin });
  const [notice, setNotice] = useState('');
  const [rule, setRule] = useState<RuleIn>(emptyRule);
  const [editing, setEditing] = useState<number | null>(null);
  const [channelKind, setChannelKind] = useState<ChannelKind>('webhook');
  const [channelName, setChannelName] = useState('');
  const [settings, setSettings] = useState<Record<string, string>>({});
  // Rules and channels are deleted for good; ask first, as record deletion does.
  const [removing, setRemoving] = useState<{
    kind: 'rule' | 'channel';
    id: number;
    name: string;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: async (run: () => Promise<string>) => run(),
    onMutate: () => setNotice(''),
    onSuccess: (message) => setNotice(message),
    onSettled: () => client.invalidateQueries({ queryKey: ['automation', scope] }),
  });
  const busy = mutation.isPending;
  const confirmRemoval = () => {
    if (!removing) return;
    const target = removing;
    mutation.mutate(
      async () => {
        if (target.kind === 'rule') {
          await deleteRule(scope, target.id);
          return 'Regla eliminada.';
        }
        await deleteChannel(scope, target.id);
        return 'Canal eliminado.';
      },
      { onSuccess: () => setRemoving(null) },
    );
  };
  // Outcomes render at the top and the rule form below the list: bring each into view.
  const outcome = useReveal<HTMLDivElement>(
    notice || (mutation.error ? errorDetail(mutation.error) : ''),
  );
  const ruleForm = useReveal<HTMLLegendElement>(editing === null ? '' : String(editing));

  if (!admin)
    return <Alert tone="info">Las automatizaciones solo las configura el rol administrador.</Alert>;

  const updateCondition = (index: number, patch: Partial<ConditionIn>) =>
    setRule({
      ...rule,
      conditions: rule.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  const updateStep = (index: number, step: Step) =>
    setRule({ ...rule, steps: rule.steps.map((s, i) => (i === index ? step : s)) });

  return (
    <div className={styles.page}>
      <p>
        Reglas que reaccionan solas a lo que ocurre en <strong>{projectLabel || scope}</strong>:
        cuando se crea, cambia o revisa un registro que cumple las condiciones, MASCLI avisa en la
        bandeja y envía mensajes a los canales configurados. Las reglas nuevas solo miran eventos
        posteriores a su creación.
      </p>
      <div ref={outcome} tabIndex={-1} className={styles.outcome}>
        {notice && <Alert tone="success">{notice}</Alert>}
        {mutation.error && <Alert tone="error">{errorDetail(mutation.error)}</Alert>}
      </div>
      <QueryState query={overview} label="las automatizaciones">
        {(data) => (
          <>
            <Card title="Plantilla: narrativa → señal → aviso">
              <p>
                Dos reglas independientes. Carga cada paso, revisa las condiciones y guárdalo. La
                plantilla empieza en pausa.
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setRule({
                    name: 'Evaluar narrativas registradas',
                    enabled: false,
                    module: 'Narrativas',
                    actions: ['CREATE', 'UPDATE'],
                    conditions: [],
                    steps: [{ kind: 'evaluate', title: 'Evaluar {id}', minimum_level: 'Media' }],
                  });
                }}
              >
                1. Preparar evaluación
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setRule({
                    name: 'Avisar señales de prioridad alta',
                    enabled: false,
                    module: 'InteligenciaDigital',
                    actions: ['CREATE'],
                    conditions: [
                      { field: 'level', op: 'eq', value: 'Alta' },
                      { field: 'status', op: 'eq', value: 'Pendiente de verificación' },
                    ],
                    steps: [{ kind: 'notify', title: 'Señal {level}: {territory}' }],
                  });
                }}
              >
                2. Preparar aviso
              </Button>
              <p>
                El segundo paso permite elegir bandeja o canal autorizado. Una señal pendiente
                requiere revisión humana.
              </p>
            </Card>
            <Card
              title="Reglas"
              action={
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    mutation.mutate(async () => {
                      const report = await tick(scope);
                      return `Revisión completada: ${report.scanned} eventos, ${report.delivered} acciones completadas, ${report.retrying} reintentos, ${report.failed} fallidas.`;
                    })
                  }
                >
                  Ejecutar ahora
                </Button>
              }
            >
              {data.rules.length === 0 ? (
                <p>Aún no hay reglas. Crea la primera con el formulario.</p>
              ) : (
                <ul className={styles.list}>
                  {data.rules.map((r) => (
                    <li key={r.id} className={styles.item}>
                      <div>
                        <strong>{r.name}</strong>{' '}
                        <span className={r.enabled ? styles.on : styles.off}>
                          {r.enabled ? 'Activa' : 'En pausa'}
                        </span>
                        <p>{describeRule(r, data)}</p>
                      </div>
                      <div className={styles.actions}>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditing(r.id);
                            setRule(ruleInput(r));
                          }}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            mutation.mutate(async () => {
                              await saveRule(scope, { ...ruleInput(r), enabled: !r.enabled }, r.id);
                              return r.enabled ? 'Regla en pausa.' : 'Regla activada.';
                            })
                          }
                        >
                          {r.enabled ? 'Pausar' : 'Activar'}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Eliminar regla ${r.name}`}
                          onClick={() => setRemoving({ kind: 'rule', id: r.id, name: r.name })}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate(async () => {
                    await saveRule(scope, rule, editing ?? undefined);
                    setRule(emptyRule());
                    setEditing(null);
                    return editing ? 'Regla actualizada.' : 'Regla creada.';
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <legend ref={ruleForm} tabIndex={-1}>
                    {editing ? 'Editar regla' : 'Nueva regla'}
                  </legend>
                  <Field
                    label="Nombre de la regla"
                    required
                    maxLength={80}
                    value={rule.name}
                    onChange={(e) => setRule({ ...rule, name: e.target.value })}
                  />
                  <label>
                    Origen de los eventos
                    <select
                      value={rule.module}
                      onChange={(e) => setRule({ ...rule, module: e.target.value })}
                    >
                      <option value="*">Cualquier módulo</option>
                      {data.sources.map((s) => (
                        <option key={s.module} value={s.module}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    role="group"
                    aria-label="Eventos que disparan la regla"
                    className={styles.checks}
                  >
                    {data.actions.map((action) => (
                      <label key={action} className={styles.check}>
                        <input
                          type="checkbox"
                          checked={rule.actions.includes(action)}
                          onChange={(e) =>
                            setRule({
                              ...rule,
                              actions: e.target.checked
                                ? [...rule.actions, action]
                                : rule.actions.filter((a) => a !== action),
                            })
                          }
                        />
                        {ACTION_LABELS[action] ?? action}
                      </label>
                    ))}
                  </div>
                  {rule.conditions.map((condition, index) => (
                    <div
                      key={index}
                      className={styles.row}
                      role="group"
                      aria-label={`Condición ${index + 1}`}
                    >
                      <Field
                        label="Campo"
                        required
                        value={condition.field}
                        hint="Campo del registro o $marking / $detail. Señales: level, status, score, territory, source_url."
                        onChange={(e) => updateCondition(index, { field: e.target.value })}
                      />
                      <label>
                        Operador
                        <select
                          value={condition.op}
                          onChange={(e) =>
                            updateCondition(index, { op: e.target.value as ConditionIn['op'] })
                          }
                        >
                          {data.operators.map((op) => (
                            <option key={op} value={op}>
                              {OPERATOR_LABELS[op] ?? op}
                            </option>
                          ))}
                        </select>
                      </label>
                      {condition.op !== 'present' && condition.op !== 'absent' && (
                        <Field
                          label="Valor"
                          value={condition.value}
                          onChange={(e) => updateCondition(index, { value: e.target.value })}
                        />
                      )}
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setRule({
                            ...rule,
                            conditions: rule.conditions.filter((_, i) => i !== index),
                          })
                        }
                      >
                        Quitar condición
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    disabled={rule.conditions.length >= 10}
                    onClick={() =>
                      setRule({
                        ...rule,
                        conditions: [...rule.conditions, { field: '', op: 'eq', value: '' }],
                      })
                    }
                  >
                    Añadir condición
                  </Button>
                  {rule.steps.map((step, index) => (
                    <div
                      key={index}
                      className={styles.row}
                      role="group"
                      aria-label={`Acción ${index + 1}`}
                    >
                      <label>
                        Acción
                        <select
                          value={step.kind === 'channel' ? String(step.channel_id) : step.kind}
                          onChange={(e) =>
                            updateStep(
                              index,
                              e.target.value === 'evaluate'
                                ? { kind: 'evaluate', title: step.title, minimum_level: 'Media' }
                                : e.target.value === 'notify'
                                  ? { kind: 'notify', title: step.title }
                                  : {
                                      kind: 'channel',
                                      channel_id: Number(e.target.value),
                                      title: step.title,
                                    },
                            )
                          }
                        >
                          <option value="notify">Aviso en la bandeja de MASCLI</option>
                          {rule.module === 'Narrativas' && (
                            <option value="evaluate">Evaluar narrativa registrada</option>
                          )}
                          {data.channels.map((c) => (
                            <option key={c.id} value={c.id}>
                              Enviar a {c.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {step.kind === 'evaluate' && (
                        <label>
                          Prioridad mínima
                          <select
                            value={step.minimum_level}
                            onChange={(e) =>
                              updateStep(index, {
                                ...step,
                                minimum_level: e.target.value as 'Media' | 'Alta',
                              })
                            }
                          >
                            <option>Media</option>
                            <option>Alta</option>
                          </select>
                        </label>
                      )}
                      <Field
                        label="Título del mensaje"
                        required
                        maxLength={200}
                        value={step.title}
                        hint="Usa {id}, {modulo}, {accion} o {Campo} del registro."
                        onChange={(e) => updateStep(index, { ...step, title: e.target.value })}
                      />
                      {rule.steps.length > 1 && (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setRule({ ...rule, steps: rule.steps.filter((_, i) => i !== index) })
                          }
                        >
                          Quitar acción
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    variant="secondary"
                    disabled={rule.steps.length >= 5}
                    onClick={() =>
                      setRule({
                        ...rule,
                        steps: [...rule.steps, { kind: 'notify', title: '{modulo} {id}' }],
                      })
                    }
                  >
                    Añadir acción
                  </Button>
                  <div className={styles.actions}>
                    <Button type="submit">{editing ? 'Guardar cambios' : 'Crear regla'}</Button>
                    {editing && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setEditing(null);
                          setRule(emptyRule());
                        }}
                      >
                        Cancelar edición
                      </Button>
                    )}
                  </div>
                </fieldset>
              </form>
            </Card>

            <Card title="Canales de salida">
              <p>
                Los secretos se guardan cifrados y nunca vuelven a mostrarse. Solo se aceptan
                destinos https públicos.
              </p>
              {data.channels.length > 0 && (
                <ul className={styles.list}>
                  {data.channels.map((c) => (
                    <li key={c.id} className={styles.item}>
                      <div>
                        <strong>{c.name}</strong>
                        <p>
                          {CHANNEL_FIELDS[c.kind].label} · {c.target_hint}
                        </p>
                      </div>
                      <div className={styles.actions}>
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() =>
                            mutation.mutate(async () => {
                              await testChannel(scope, c.id);
                              return `Mensaje de prueba enviado a ${c.name}.`;
                            })
                          }
                        >
                          Probar
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Eliminar canal ${c.name}`}
                          onClick={() => setRemoving({ kind: 'channel', id: c.id, name: c.name })}
                        >
                          Eliminar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate(async () => {
                    await createChannel(scope, {
                      kind: channelKind,
                      name: channelName,
                      settings,
                    });
                    setChannelName('');
                    setSettings({});
                    return 'Canal creado.';
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <legend>Nuevo canal</legend>
                  <label>
                    Tipo de canal
                    <select
                      value={channelKind}
                      onChange={(e) => {
                        setChannelKind(e.target.value as ChannelKind);
                        setSettings({});
                      }}
                    >
                      {(Object.keys(CHANNEL_FIELDS) as ChannelKind[]).map((kind) => (
                        <option key={kind} value={kind}>
                          {CHANNEL_FIELDS[kind].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field
                    label="Nombre del canal"
                    required
                    maxLength={80}
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                  />
                  {CHANNEL_FIELDS[channelKind].fields.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      required
                      autoComplete="off"
                      type={field.secret ? 'password' : 'text'}
                      {...(field.hint ? { hint: field.hint } : {})}
                      value={settings[field.key] ?? ''}
                      onChange={(e) => setSettings({ ...settings, [field.key]: e.target.value })}
                    />
                  ))}
                  <Button type="submit">Crear canal</Button>
                </fieldset>
              </form>
            </Card>

            <RuntimeCard scope={scope} />
            <ApiKeysCard scope={scope} />

            <Card title="Últimas ejecuciones">
              {data.runs.length === 0 ? (
                <p>Sin ejecuciones todavía.</p>
              ) : (
                <div className={styles.scroll}>
                  <table className={styles.stack}>
                    <thead>
                      <tr>
                        <th>Regla</th>
                        <th>Evento</th>
                        <th>Acción</th>
                        <th>Estado</th>
                        <th>Detalle</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.runs.map((run) => (
                        <tr key={run.id}>
                          <td data-label="Regla">{run.rule_name}</td>
                          <td data-label="Evento">
                            {ACTION_LABELS[run.event.action] ?? run.event.action} ·{' '}
                            {run.event.module} {run.event.record_id ?? ''}
                          </td>
                          <td data-label="Acción">
                            {run.kind === 'evaluate'
                              ? 'Evaluación'
                              : run.kind === 'notify'
                                ? 'Aviso'
                                : 'Canal'}
                          </td>
                          <td data-label="Estado">
                            {STATUS_LABELS[run.status]}
                            {run.attempts > 1 ? ` (${run.attempts} intentos)` : ''}
                          </td>
                          <td data-label="Detalle">{run.last_error || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </QueryState>
      {removing && (
        <ConfirmDialog
          title={removing.kind === 'rule' ? 'Eliminar regla' : 'Eliminar canal'}
          confirmLabel="Confirmar eliminación"
          pendingLabel="Eliminando…"
          pending={busy}
          error={mutation.error ? errorDetail(mutation.error) : null}
          onConfirm={confirmRemoval}
          onCancel={() => {
            mutation.reset();
            setRemoving(null);
          }}
        >
          {removing.kind === 'rule'
            ? `Se eliminará la regla «${removing.name}» y su registro de entregas.`
            : `Se eliminará el canal «${removing.name}» y su secreto cifrado. Si una regla activa lo usa, pausa o edita esa regla antes.`}{' '}
          Esta acción no se puede deshacer.
        </ConfirmDialog>
      )}
    </div>
  );
};
