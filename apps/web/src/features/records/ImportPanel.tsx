import type { ImportReport } from '@mascli/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useId, useState } from 'react';
import { isApiError } from '../../shared/api/client.ts';
import { parseCsv } from '../../shared/lib/csv.ts';
import { Alert } from '../../shared/ui/Alert.tsx';
import { Button } from '../../shared/ui/Button.tsx';
import { importRecords } from './api.ts';
import { MODULES, type RecordModule } from './modules.ts';
import styles from './Records.module.css';

const IGNORE = '';
const MAX_BYTES = 5 * 1024 * 1024;

const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** Suggests the field for each column by its key, label or alias. */
export const suggestMapping = (module: RecordModule, headers: readonly string[]) => {
  const fields = MODULES[module].fields;
  return headers.map((header) => {
    const wanted = normalize(header);
    const field = fields.find((f) =>
      [f.key, f.label, ...(f.aliases ?? [])].some((name) => normalize(name) === wanted),
    );
    return field?.key ?? IGNORE;
  });
};

/** Spreadsheet (CSV) import with column mapping, preview and all-or-nothing apply. */
export const ImportPanel = ({
  module,
  scope,
  onClose,
}: {
  module: RecordModule;
  scope: string;
  onClose: () => void;
}) => {
  const ids = useId();
  const client = useQueryClient();
  const [file, setFile] = useState<{ name: string; header: string[]; rows: string[][] } | null>(
    null,
  );
  const [mapping, setMapping] = useState<string[]>([]);
  const [readError, setReadError] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const fields = MODULES[module].fields;

  const mappedRows = () =>
    (file?.rows ?? []).map((cells) => {
      const row: Record<string, string> = {};
      mapping.forEach((field, index) => {
        if (field) row[field] = cells[index] ?? '';
      });
      return row;
    });

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      importRecords(module, scope, {
        rows: mappedRows(),
        dry_run: dryRun,
        source: file?.name ?? '',
      }),
    onSuccess: async (result) => {
      setReport(result);
      if (result.applied) await client.invalidateQueries({ queryKey: ['records', scope] });
    },
  });

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    setReport(null);
    setReadError('');
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (selected.size > MAX_BYTES) {
      setReadError('El archivo supera 5 MB.');
      return;
    }
    const [header = [], ...rows] = parseCsv(await selected.text());
    if (header.length === 0 || rows.length === 0) {
      setReadError('El archivo no tiene encabezados y filas.');
      return;
    }
    setFile({ name: selected.name, header, rows });
    setMapping(suggestMapping(module, header));
  };

  const mappedCount = mapping.filter(Boolean).length;
  return (
    <section className={styles.importPanel} aria-labelledby={`${ids}-title`}>
      <h4 id={`${ids}-title`}>Importar desde CSV</h4>
      <p className={styles.muted}>
        Las celdas vacías no borran datos. Si una fila trae un código existente, se actualiza ese
        registro; si hay cualquier error, no se importa nada.
      </p>
      <label htmlFor={`${ids}-file`}>Archivo CSV (coma, punto y coma o tabulador)</label>
      <input
        id={`${ids}-file`}
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => void choose(e)}
      />
      {readError ? <Alert tone="error">{readError}</Alert> : null}
      {file ? (
        <>
          <p>
            {file.rows.length} filas en <strong>{file.name}</strong>. Asigna cada columna a un
            campo:
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Columna</th>
                  <th scope="col">Campo de MASCLI</th>
                  <th scope="col">Ejemplo</th>
                </tr>
              </thead>
              <tbody>
                {file.header.map((header, index) => (
                  <tr key={`${index}-${header}`}>
                    <th scope="row">{header}</th>
                    <td>
                      <select
                        aria-label={`Campo para ${header}`}
                        value={mapping[index] ?? IGNORE}
                        onChange={(event) => {
                          const next = [...mapping];
                          next[index] = event.target.value;
                          setMapping(next);
                          setReport(null);
                        }}
                      >
                        <option value={IGNORE}>— No importar —</option>
                        {fields.map((field) => (
                          <option key={field.key} value={field.key}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{file.rows[0]?.[index] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={run.isPending || mappedCount === 0}
              onClick={() => run.mutate(true)}
            >
              Revisar importación
            </Button>
            <Button
              disabled={
                run.isPending ||
                !report ||
                report.applied ||
                report.problems.length > 0 ||
                report.created + report.updated === 0
              }
              onClick={() => run.mutate(false)}
            >
              Importar
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </>
      ) : null}
      {run.error ? (
        <Alert tone="error">
          {isApiError(run.error) ? run.error.detail : 'No se pudo importar.'}
        </Alert>
      ) : null}
      {report ? (
        report.problems.length ? (
          <Alert tone="error">
            {report.problems.length} fila(s) con problemas; no se importó nada.
            <ul>
              {report.problems.slice(0, 20).map((problem) => (
                <li key={`${problem.row}-${problem.message}`}>
                  Fila {problem.row}: {problem.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : (
          <Alert tone="success">
            {report.applied ? 'Importación completada' : 'Listo para importar'}: {report.created}{' '}
            nuevos y {report.updated} actualizados.
          </Alert>
        )
      ) : null}
    </section>
  );
};
