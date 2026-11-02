import { DocumentReviewBulkResponse } from '@sipges/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson } from '../../shared/api/client.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { ConfirmDialog } from '../../shared/ui/ConfirmDialog.tsx';

/** What a bulk decision covers (functional-closure T26): picked items, a theme or a document. */
export type BulkTarget =
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  | { readonly kind: 'theme'; readonly theme: string }
  | { readonly kind: 'document'; readonly sha256: string; readonly file: string };
export type BulkStatus = 'aceptado_para_revision' | 'descartado';
export type BulkRequest = { readonly target: BulkTarget; readonly status: BulkStatus };

const count = (n: number) => n.toLocaleString('es-PE');

const selector = (target: BulkTarget) =>
  target.kind === 'ids'
    ? { ids: [...target.ids] }
    : target.kind === 'theme'
      ? { theme: target.theme }
      : { source_sha256: target.sha256 };

const scopeText = (target: BulkTarget) =>
  target.kind === 'ids'
    ? 'seleccionados'
    : target.kind === 'theme'
      ? `del tema «${target.theme}»`
      : `del documento «${target.file}»`;

/** The result line the inbox shows after a bulk decision. */
export const bulkOutcome = (result: DocumentReviewBulkResponse) =>
  [
    `Se decidieron ${count(result.decided)} hallazgos y se crearon ${count(
      result.records_created,
    )} registros.`,
    result.skipped ? `${count(result.skipped)} ya estaban decididos y se omitieron.` : '',
    result.remaining
      ? `Quedan ${count(result.remaining)} pendientes: repita la acción para la siguiente tanda.`
      : '',
    result.problems.length ? `Problemas: ${result.problems.join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

const previewText = (request: BulkRequest, preview: DocumentReviewBulkResponse) => {
  if (preview.decided === 0) return 'No hay hallazgos pendientes para decidir.';
  const what = `${count(preview.decided)} hallazgos pendientes ${scopeText(request.target)}`;
  const modules = preview.modules.map((m) => `${m.label} ${count(m.nuevos)}`).join(', ');
  return [
    request.status === 'descartado'
      ? `Se descartarán ${what}. No se crea ni se borra ningún registro.`
      : `Se aprobarán ${what} («Aceptado para revisión») y se crearán ${count(
          preview.records_created,
        )} registros${modules ? `: ${modules}` : ''}.`,
    preview.skipped ? `${count(preview.skipped)} ya estaban decididos y se omiten.` : '',
    preview.remaining
      ? `Quedan ${count(preview.remaining)} para otra tanda (máximo ${count(1000)} por vez).`
      : '',
    'Cada decisión queda en Auditoría con su usuario y se puede cambiar después.',
  ]
    .filter(Boolean)
    .join(' ');
};

/** Confirmation of a bulk decision: shows the dry-run counts per module before writing. */
export const BulkConfirm = ({
  request,
  context,
  onDone,
  onCancel,
}: {
  request: BulkRequest;
  context: FeatureContext;
  onDone: (result: DocumentReviewBulkResponse) => void;
  onCancel: () => void;
}) => {
  const client = useQueryClient();
  const body = { ...selector(request.target), status: request.status };
  const send = (dryRun: boolean) =>
    requestJson('/system/document-lab/review/bulk', DocumentReviewBulkResponse, {
      method: 'POST',
      scope: context.scope,
      body: { json: { ...body, dry_run: dryRun } },
    });
  const preview = useQuery({
    queryKey: ['document-review-bulk-preview', context.scope, body],
    queryFn: () => send(true),
    gcTime: 0,
  });
  const mutation = useMutation({
    mutationFn: () => send(false),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['document-review', context.scope] });
      onDone(result);
    },
  });
  const approve = request.status === 'aceptado_para_revision';
  const ready = preview.data && preview.data.decided > 0;
  return (
    <ConfirmDialog
      title={approve ? 'Aprobar en lote' : 'Descartar en lote'}
      confirmLabel={
        approve
          ? `Aprobar ${count(preview.data?.decided ?? 0)}`
          : `Descartar ${count(preview.data?.decided ?? 0)}`
      }
      pendingLabel="Guardando…"
      pending={mutation.isPending}
      confirmDisabled={!ready}
      error={
        mutation.error
          ? errorDetail(mutation.error)
          : preview.error
            ? errorDetail(preview.error)
            : null
      }
      onConfirm={() => {
        if (ready && !mutation.isPending) mutation.mutate();
      }}
      onCancel={onCancel}
    >
      {preview.data
        ? previewText(request, preview.data)
        : preview.isError
          ? 'No se pudo calcular cuántos hallazgos se decidirán.'
          : 'Calculando cuántos hallazgos se decidirán…'}
    </ConfirmDialog>
  );
};
