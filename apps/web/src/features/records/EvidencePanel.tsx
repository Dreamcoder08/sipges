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
  uploadAttachment,
} from './evidence-api.ts';
import type { RecordModule } from './modules.ts';
import styles from './Records.module.css';

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
                    </small>
                    <small>SHA-256: {item.sha256}</small>
                    {item.notes ? <p>{item.notes}</p> : null}
                  </div>
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
                PDF, Office, CSV, TXT o imagen. El servidor comprueba formato y tamaño.
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
