import type { Attachment } from '@mascli/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { QueryState } from '../../shared/ui/QueryState.tsx';
import {
  ACCEPTED_FILES,
  attachmentsQuery,
  downloadAttachment,
  imageDataUrl,
  previewQuery,
  uploadAttachment,
} from './evidence-api.ts';

import type { RecordModule } from './modules.ts';
import styles from './Records.module.css';

/** Evidence uploaded by the synthetic academic case (`demo:seed`) carries this marker. */
const isDemoEvidence = (note: string) => /\bmascli-academic-v1:DEMO-F-\d{2}$/.test(note);

const errorText = (error: unknown) =>
  isApiError(error)
    ? error.detail
    : error instanceof Error
      ? error.message
      : 'No se pudo completar la operación.';
export const EvidencePanel = ({
  module,
  id,
  scope,
  writable,
  onBusyChange,
}: {
  module: RecordModule;
  id: string;
  scope: string;
  writable: boolean;
  onBusyChange: (pending: boolean) => void;
}) => {
  const query = attachmentsQuery(module, id, scope);
  const attachments = useQuery(query);
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [metadata, setMetadata] = useState({
    documentType: 'Reporte / evidencia',
    author: '',
    verification: 'E - No verificada',
    notes: '',
  });
  const upload = useMutation({
    mutationFn: (selected: File) => uploadAttachment(module, id, scope, selected, metadata),
    onMutate: () => onBusyChange(true),
    onSettled: () => onBusyChange(false),
    onSuccess: async () => {
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      await Promise.all([
        client.invalidateQueries({ queryKey: query.queryKey }),
        client.invalidateQueries({ queryKey: ['records', scope] }),
      ]);
    },
  });
  const download = useMutation({
    mutationFn: async (attachment: Attachment) => {
      const blob = await downloadAttachment(attachment.id, scope);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.original_name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  return (
    <section className={styles.evidence} aria-labelledby={`evidence-${id}`}>
      <h4 id={`evidence-${id}`}>Evidencias vinculadas</h4>
      {upload.isSuccess ? <Alert tone="success">Evidencia guardada.</Alert> : null}
      {upload.error || download.error ? (
        <Alert tone="error">{errorText(upload.error ?? download.error)}</Alert>
      ) : null}
      <QueryState query={attachments} label="las evidencias">
        {(items) =>
          items.length ? (
            <ul className={styles.attachments}>
              {items.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>{item.original_name}</strong>
                    <small>
                      {(item.size_bytes / 1024).toFixed(1)} KB · {item.document_type} ·{' '}
                      {item.verification}
                      {item.author ? ` · ${item.author}` : ''} · {item.created_at.slice(0, 10)}
                      {isDemoEvidence(item.notes) ? ' · Demostración (sintético)' : ''}
                    </small>
                    <small>SHA-256: {item.sha256}</small>
                    {item.notes ? <p>{item.notes}</p> : null}
                  </div>
                  <Button
                    variant="secondary"
                    aria-expanded={viewing === item.id}
                    aria-label={`Ver contenido de ${item.original_name}`}
                    onClick={() => setViewing((current) => (current === item.id ? null : item.id))}
                  >
                    {viewing === item.id ? 'Ocultar contenido' : 'Ver contenido'}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={download.isPending}
                    aria-label={`Descargar ${item.original_name}`}
                    onClick={() => {
                      download.reset();
                      download.mutate(item);
                    }}
                  >
                    Descargar
                  </Button>
                  {viewing === item.id ? <EvidenceViewer attachment={item} scope={scope} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>No hay evidencias vinculadas.</p>
          )
        }
      </QueryState>
      {attachments.error ? (
        <Button variant="secondary" onClick={() => void attachments.refetch()}>
          Reintentar evidencias
        </Button>
      ) : null}
      {writable ? (
        <form
          className={styles.form}
          aria-label="Añadir evidencia"
          onSubmit={(event) => {
            event.preventDefault();
            if (file) upload.mutate(file);
          }}
        >
          <fieldset disabled={upload.isPending} className={styles.fields}>
            <legend className="visually-hidden">Datos de la evidencia</legend>
            <div className={`${styles.field} ${styles.wide}`}>
              <label htmlFor={`upload-${id}`}>Archivo de evidencia</label>
              <input
                ref={fileInput}
                id={`upload-${id}`}
                type="file"
                accept={ACCEPTED_FILES}
                aria-required="true"
                aria-describedby={`upload-hint-${id}`}
                onChange={(event) => {
                  upload.reset();
                  setFile(event.target.files?.[0] ?? null);
                }}
              />
              <small id={`upload-hint-${id}`}>
                PDF, Office, CSV, TXT o imagen. Hasta 3 MiB por archivo; 4 MiB por envío.
              </small>
            </div>
            <Field
              label="Tipo de documento"
              value={metadata.documentType}
              maxLength={120}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, documentType: event.target.value }))
              }
            />
            <Field
              label="Autor de la evidencia"
              value={metadata.author}
              maxLength={160}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, author: event.target.value }))
              }
            />
            <Field
              label="Verificación de la evidencia"
              value={metadata.verification}
              maxLength={80}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, verification: event.target.value }))
              }
            />
            <Field
              label="Notas de la evidencia"
              value={metadata.notes}
              maxLength={1000}
              onChange={(event) =>
                setMetadata((current) => ({ ...current, notes: event.target.value }))
              }
            />
          </fieldset>
          <div>
            <Button type="submit" disabled={!file || upload.isPending}>
              {upload.isPending ? 'Subiendo…' : 'Subir evidencia'}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
};

const PREVIEW_MESSAGES = {
  no_text:
    'El archivo está almacenado, pero no contiene texto legible (por ejemplo, un PDF escaneado). Descárguelo para revisarlo.',
  too_long: 'El PDF supera las 60 páginas que muestra el visor. Descárguelo para leerlo completo.',
  unsupported:
    'Este formato (Word 97-2003 u hoja de cálculo) no tiene visor en la aplicación. Descárguelo para abrirlo.',
} as const;

/** In-app reader of one stored evidence file: its text, or the image itself. */
const EvidenceViewer = ({ attachment, scope }: { attachment: Attachment; scope: string }) => {
  const preview = useQuery(previewQuery(attachment.id, scope));
  const image = useQuery({
    queryKey: ['evidence', scope, 'image', attachment.id],
    queryFn: () => imageDataUrl(attachment.id, scope),
    enabled: preview.data?.kind === 'image',
    staleTime: Infinity,
  });
  return (
    <section className={styles.viewer} aria-label={`Contenido de ${attachment.original_name}`}>
      <QueryState query={preview} label="el contenido del archivo">
        {(data) =>
          data.kind === 'text' ? (
            <>
              {data.pages.map((page, index) => (
                <article key={index}>
                  {data.format === 'pdf' ? <h5>Página {index + 1}</h5> : null}
                  <pre>{page}</pre>
                </article>
              ))}
              {data.truncated ? (
                <p className={styles.muted}>
                  El visor muestra el comienzo del documento. Descárguelo para leerlo completo.
                </p>
              ) : null}
            </>
          ) : data.kind === 'image' ? (
            <QueryState query={image} label="la imagen">
              {(src) => <img src={src} alt={attachment.original_name} className={styles.image} />}
            </QueryState>
          ) : (
            <p>{PREVIEW_MESSAGES[data.kind]}</p>
          )
        }
      </QueryState>
    </section>
  );
};
