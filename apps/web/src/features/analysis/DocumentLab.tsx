import {
  DocumentAnalysisResponse,
  DocumentComparisonResponse,
  DocumentReviewImportResponse,
} from '@mascli/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { requestJson } from '../../shared/api/client.ts';
import { downloadFile } from '../../shared/api/download.ts';
import type { FeatureContext } from '../../shared/api/feature-context.ts';
import { errorDetail } from '../../shared/api/feedback.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { Card } from '../../shared/ui/Card.tsx';
import { Field } from '../../shared/ui/Field.tsx';
import { Limitations } from './ReportParts.tsx';
import { ReviewInbox } from './ReviewInbox.tsx';
import styles from './Analysis.module.css';

const fileForm = (projectId: string, files: Record<string, File>) => {
  const form = new FormData();
  form.set('project_id', projectId);
  for (const [name, file] of Object.entries(files)) form.set(name, file);
  return form;
};
const allowedFiles = '.pdf,.docx,.txt,.md';
export const DocumentLab = (context: FeatureContext) => {
  const [file, setFile] = useState<File | undefined>();
  const [first, setFirst] = useState<File | undefined>();
  const [second, setSecond] = useState<File | undefined>();
  const [imported, setImported] = useState<Set<string>>(() => new Set());
  const client = useQueryClient();
  const readingLock = useRef(false);
  const compareLock = useRef(false);
  const writable = context.role === 'admin' || context.role === 'analista';
  const analyze = useMutation({
    mutationFn: (selected: File) =>
      requestJson('/system/document-lab/analyze', DocumentAnalysisResponse, {
        scope: context.scope,
        method: 'POST',
        body: { multipart: fileForm(context.projectId, { file: selected }) },
      }),
  });
  const report = useMutation({
    mutationFn: (selected: File) =>
      downloadFile(
        context.scope,
        '/system/document-lab/report.docx',
        'MASCLI_RC20_Lectura_Documental.docx',
        { method: 'POST', body: { multipart: fileForm(context.projectId, { file: selected }) } },
      ),
  });
  const importing = useMutation({
    mutationFn: (result: DocumentAnalysisResponse) =>
      requestJson('/system/document-lab/review/import', DocumentReviewImportResponse, {
        scope: context.scope,
        method: 'POST',
        body: {
          json: {
            project_id: context.projectId,
            filename: result.filename,
            sha256: result.sha256,
            items: result.items,
          },
        },
      }),
    onSuccess: async (_, result) => {
      setImported((previous) => new Set([...previous, result.sha256]));
      await client.invalidateQueries({ queryKey: ['document-review', context.scope] });
    },
  });
  const compare = useMutation({
    mutationFn: (selected: { a: File; b: File }) =>
      requestJson('/system/document-lab/compare', DocumentComparisonResponse, {
        scope: context.scope,
        method: 'POST',
        body: {
          multipart: fileForm(context.projectId, { file_a: selected.a, file_b: selected.b }),
        },
      }),
  });
  const busy = analyze.isPending || report.isPending || importing.isPending;
  const read = async (kind: 'analyze' | 'report' | 'import') => {
    if (readingLock.current || !file) return;
    const result = analyze.data;
    if (
      kind === 'import' &&
      (!writable ||
        !result ||
        result.project_id !== context.projectId ||
        imported.has(result.sha256) ||
        result.items.length === 0)
    )
      return;
    readingLock.current = true;
    try {
      if (kind === 'analyze') {
        importing.reset();
        await analyze.mutateAsync(file);
      } else if (kind === 'report') await report.mutateAsync(file);
      else if (result) await importing.mutateAsync(result);
    } catch {
      /* Keep selected files and display the mutation failure. */
    } finally {
      readingLock.current = false;
    }
  };
  const compareFiles = async () => {
    if (compareLock.current || !first || !second) return;
    compareLock.current = true;
    try {
      await compare.mutateAsync({ a: first, b: second });
    } catch {
      /* Error rendered below. */
    } finally {
      compareLock.current = false;
    }
  };
  return (
    <div className={styles.page}>
      <Card title="Laboratorio documental">
        <p>
          Lectura local de PDF, DOCX, TXT y Markdown. Los fragmentos son candidatos no verificados;
          no se registran como hechos ni modifican IRSA. Los archivos originales no se almacenan.
        </p>
        <p className={styles.muted}>
          Suba documentos autorizados para {context.projectLabel}. PDF escaneado necesita OCR
          externo; máximo 100 páginas.
        </p>
        <div className={styles.form}>
          <Field
            label="Documento para lectura"
            type="file"
            accept={allowedFiles}
            disabled={busy}
            onChange={(event) => {
              if (readingLock.current) return;
              setFile(event.target.files?.[0]);
              analyze.reset();
              report.reset();
              importing.reset();
            }}
          />
        </div>
        <div className={styles.actions}>
          <Button disabled={!file || busy} onClick={() => void read('analyze')}>
            {analyze.isPending ? 'Analizando…' : 'Analizar documento'}
          </Button>
          <Button variant="secondary" disabled={!file || busy} onClick={() => void read('report')}>
            {report.isPending ? 'Preparando informe…' : 'Descargar lectura documental'}
          </Button>
        </div>
        {analyze.error ? <Alert tone="error">{errorDetail(analyze.error)}</Alert> : null}
        {report.error ? <Alert tone="error">{errorDetail(report.error)}</Alert> : null}
        {analyze.data && !analyze.error ? (
          <div>
            <p>
              {analyze.data.filename} · {analyze.data.text_sections} secciones ·{' '}
              {analyze.data.items.length} candidatos
            </p>
            <p>{analyze.data.method}</p>
            <p className={styles.muted}>SHA-256: {analyze.data.sha256}</p>
            {analyze.data.items.map((item) => (
              <article className={styles.item} key={item.id}>
                <h4>
                  {item.id}: {item.tema}
                </h4>
                <p>{item.ubicacion}</p>
                <p>{item.fragmento}</p>
                <p>Términos: {item.terminos.join(', ')}</p>
                <p>{item.accion_sugerida}</p>
                <p>{item.estado}</p>
              </article>
            ))}
            {analyze.data.items.length === 0 ? (
              <p>No se detectaron candidatos léxicos en este documento.</p>
            ) : null}
            {analyze.data.recommendations.map((item, i) => (
              <p key={i}>
                {item.tema}: {item.accion} ({item.hallazgos_candidatos} candidatos)
              </p>
            ))}
            <Limitations items={analyze.data.limitations} />
            {writable ? (
              <div className={styles.actions}>
                <Button
                  disabled={
                    busy ||
                    !analyze.data.items.length ||
                    imported.has(analyze.data.sha256) ||
                    analyze.data.project_id !== context.projectId
                  }
                  onClick={() => void read('import')}
                >
                  {importing.isPending ? 'Importando…' : 'Enviar candidatos a revisión'}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        {importing.error ? <Alert tone="error">{errorDetail(importing.error)}</Alert> : null}
        {importing.data ? <Alert tone="success">{importing.data.message}</Alert> : null}
      </Card>
      <Card title="Comparación documental">
        <p>
          Coincidencia léxica entre dos documentos; no prueba acuerdos, contradicciones ni identidad
          de personas.
        </p>
        <div className={styles.form}>
          <Field
            label="Primer documento"
            type="file"
            accept={allowedFiles}
            disabled={compare.isPending}
            onChange={(event) => {
              if (compareLock.current) return;
              setFirst(event.target.files?.[0]);
              compare.reset();
            }}
          />
          <Field
            label="Segundo documento"
            type="file"
            accept={allowedFiles}
            disabled={compare.isPending}
            onChange={(event) => {
              if (compareLock.current) return;
              setSecond(event.target.files?.[0]);
              compare.reset();
            }}
          />
        </div>
        <div className={styles.actions}>
          <Button
            disabled={!first || !second || compare.isPending}
            onClick={() => void compareFiles()}
          >
            {compare.isPending ? 'Comparando…' : 'Comparar documentos'}
          </Button>
        </div>
        {compare.error ? <Alert tone="error">{errorDetail(compare.error)}</Alert> : null}
        {compare.data && !compare.error ? (
          <div>
            <p>{compare.data.documents.map((document) => document.filename).join(' ↔ ')}</p>
            <p>{compare.data.method}</p>
            <p>
              {compare.data.total_candidatos} pares candidatos; se muestran{' '}
              {compare.data.comparaciones.length}.
            </p>
            {compare.data.comparaciones.map((item, i) => (
              <article key={i} className={styles.item}>
                <h4>{item.tema}</h4>
                <p>
                  {item.a.ubicacion}: {item.a.fragmento}
                </p>
                <p>
                  {item.b.ubicacion}: {item.b.fragmento}
                </p>
                <p>Términos compartidos: {item.terminos_comunes.join(', ')}</p>
                <p>
                  Coincidencia léxica: {item.coincidencia_lexica}. {item.tipo}
                </p>
                <Alert tone="info">{item.advertencia}</Alert>
              </article>
            ))}
            <Limitations items={compare.data.limitations} />
          </div>
        ) : null}
      </Card>
      <ReviewInbox {...context} />
    </div>
  );
};
