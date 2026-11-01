import type { IndicatorReportItem } from '@sipges/contracts';
import styles from './Indicators.module.css';
export const IndicatorTable = ({ items }: { items: IndicatorReportItem[] }) => (
  <div className={styles.table} tabIndex={0} role="region" aria-label="Detalle de indicadores">
    <table>
      <caption>Indicadores desagregados</caption>
      <thead>
        <tr>
          <th scope="col">Indicador</th>
          <th scope="col">Puntuación</th>
          <th scope="col">Método y definición</th>
          <th scope="col">Evidencia y confianza</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.code}>
            <th scope="row">
              {item.code} · {item.name}
              <br />
              {item.dimension_label}
            </th>
            <td>
              {item.score === null ? 'No calculable' : item.score.toFixed(2)}
              <br />
              {item.availability}
            </td>
            <td>
              {item.definition}
              <p>{item.method}</p>
            </td>
            <td>
              {item.evidence_count} evidencias · {item.confidence}
              <p>{item.explanation}</p>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    {items.length === 0 ? <p>No hay indicadores disponibles.</p> : null}
  </div>
);
