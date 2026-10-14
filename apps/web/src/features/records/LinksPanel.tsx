import type { OntologyCatalog, RecordLinks } from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { InternalLink, objectHref } from '../../shared/lib/navigation.tsx';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import { recordsQuery } from './api.ts';
import { presentText } from './model.ts';
import { MODULES, type RecordModule } from './modules.ts';
import { catalogQuery, createLink, deleteLink, linksQuery } from './ontology-api.ts';
import styles from './Records.module.css';

type LinkOption = {
  key: string;
  linkType: string;
  direction: 'out' | 'in';
  label: string;
  modules: RecordModule[];
};

const isRecordModule = (value: string): value is RecordModule => Object.hasOwn(MODULES, value);

const allModules = () => Object.keys(MODULES).filter(isRecordModule);

/** Link types this record can take part in, read in its own direction. */
export const linkOptions = (catalog: OntologyCatalog, module: string): LinkOption[] => {
  const options: LinkOption[] = [];
  const accepts = (allowed: string[] | null) => allowed === null || allowed.includes(module);
  const candidates = (allowed: string[] | null) =>
    allowed === null ? allModules() : allowed.filter(isRecordModule);
  for (const type of catalog.link_types) {
    if (accepts(type.sources)) {
      options.push({
        key: `${type.id}:out`,
        linkType: type.id,
        direction: 'out',
        label: type.label,
        modules: candidates(type.targets),
      });
    }
    if (!type.symmetric && accepts(type.targets)) {
      options.push({
        key: `${type.id}:in`,
        linkType: type.id,
        direction: 'in',
        label: type.inverse_label,
        modules: candidates(type.sources),
      });
    }
  }
  return options.filter((option) => option.modules.length > 0);
};

const errorText = (error: unknown) =>
  isApiError(error) ? error.detail : 'No se pudo completar la operación.';

const LinkForm = ({
  module,
  id,
  scope,
  catalog,
}: {
  module: RecordModule;
  id: string;
  scope: string;
  catalog: OntologyCatalog;
}) => {
  const formId = useId();
  const client = useQueryClient();
  const options = linkOptions(catalog, module);
  const [optionKey, setOptionKey] = useState(options[0]?.key ?? '');
  const option = options.find((o) => o.key === optionKey) ?? options[0];
  const [targetModule, setTargetModule] = useState<RecordModule | ''>('');
  const effectiveModule =
    targetModule && option?.modules.includes(targetModule) ? targetModule : option?.modules[0];
  const [targetId, setTargetId] = useState('');
  const [note, setNote] = useState('');
  const candidates = useQuery({
    ...recordsQuery(effectiveModule ?? 'actores', scope, ''),
    enabled: effectiveModule !== undefined,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!option || !effectiveModule) throw new Error('Seleccione el vínculo');
      const self = { module, id };
      const other = { module: effectiveModule, id: targetId };
      return createLink(scope, {
        link_type: option.linkType,
        source: option.direction === 'out' ? self : other,
        target: option.direction === 'out' ? other : self,
        note,
      });
    },
    onSuccess: async () => {
      setTargetId('');
      setNote('');
      await client.invalidateQueries({ queryKey: ['records', scope] });
    },
  });
  if (!option || !effectiveModule) return null;
  const titleField = MODULES[effectiveModule].titleField;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (targetId) save.mutate();
  };
  return (
    <form className={styles.linkForm} onSubmit={submit} aria-label="Nuevo vínculo">
      {save.error ? <Alert tone="error">{errorText(save.error)}</Alert> : null}
      {save.isSuccess ? <Alert tone="success">Vínculo guardado.</Alert> : null}
      <label htmlFor={`${formId}-type`}>Este registro…</label>
      <select
        id={`${formId}-type`}
        value={option.key}
        onChange={(event) => {
          setOptionKey(event.target.value);
          setTargetId('');
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <label htmlFor={`${formId}-module`}>Tipo de registro</label>
      <select
        id={`${formId}-module`}
        value={effectiveModule}
        onChange={(event) => {
          if (isRecordModule(event.target.value)) setTargetModule(event.target.value);
          setTargetId('');
        }}
      >
        {option.modules.map((m) => (
          <option key={m} value={m}>
            {MODULES[m].label}
          </option>
        ))}
      </select>
      <label htmlFor={`${formId}-target`}>Registro</label>
      <select
        id={`${formId}-target`}
        value={targetId}
        required
        onChange={(event) => setTargetId(event.target.value)}
      >
        <option value="">{candidates.isPending ? 'Cargando…' : 'Seleccione…'}</option>
        {(candidates.data ?? [])
          .filter((record) => !(effectiveModule === module && record._id === id))
          .map((record) => (
            <option key={record._id} value={record._id}>
              {presentText(String(record[titleField] ?? '') || record._id)} ({record._id})
            </option>
          ))}
      </select>
      <label htmlFor={`${formId}-note`}>Nota (opcional)</label>
      <input
        id={`${formId}-note`}
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
      />
      <Button type="submit" disabled={!targetId || save.isPending}>
        Vincular
      </Button>
    </form>
  );
};

const LinkItem = ({
  link,
  writable,
  pending,
  onDelete,
}: {
  link: RecordLinks['links'][number];
  writable: boolean;
  pending: boolean;
  onDelete: (id: number) => void;
}) => (
  <li>
    <div>
      <span className={styles.linkLabel}>{link.label}</span>{' '}
      <InternalLink href={objectHref(link.other.module, link.other.id)}>
        {presentText(link.other.title)}
      </InternalLink>{' '}
      <small>
        {link.other.type_label}
        {link.edge.inferred ? ` · inferido del campo ${link.edge.via ?? ''}` : ''}
        {link.edge.note ? ` · ${link.edge.note}` : ''}
      </small>
    </div>
    {writable && link.edge.id !== null ? (
      <Button
        variant="ghost"
        disabled={pending}
        onClick={() => link.edge.id !== null && onDelete(link.edge.id)}
        aria-label={`Quitar vínculo con ${link.other.title}`}
      >
        Quitar
      </Button>
    ) : null}
  </li>
);

/** Typed links of one record, explicit and inferred (docs/adr/0011 §2-3). */
export const LinksPanel = ({
  module,
  id,
  scope,
  writable,
}: {
  module: RecordModule;
  id: string;
  scope: string;
  writable: boolean;
}) => {
  const client = useQueryClient();
  const links = useQuery(linksQuery(module, id, scope));
  const catalog = useQuery(catalogQuery);
  const remove = useMutation({
    mutationFn: (linkId: number) => deleteLink(scope, linkId),
    onSuccess: () => client.invalidateQueries({ queryKey: ['records', scope] }),
  });
  return (
    <section className={styles.evidence} aria-labelledby={`links-${id}`}>
      <h4 id={`links-${id}`}>Vínculos</h4>
      {remove.error ? <Alert tone="error">{errorText(remove.error)}</Alert> : null}
      <QueryState query={links} label="los vínculos">
        {(data) =>
          data.links.length ? (
            <ul className={styles.attachments}>
              {data.links.map((link) => (
                <LinkItem
                  key={`${link.edge.link_type}/${link.edge.source.module}/${link.edge.source.id}/${link.edge.target.module}/${link.edge.target.id}`}
                  link={link}
                  writable={writable}
                  pending={remove.isPending}
                  onDelete={(linkId) => remove.mutate(linkId)}
                />
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>Sin vínculos registrados.</p>
          )
        }
      </QueryState>
      {writable && catalog.data ? (
        <LinkForm module={module} id={id} scope={scope} catalog={catalog.data} />
      ) : null}
    </section>
  );
};
