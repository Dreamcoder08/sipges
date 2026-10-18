/**
 * INGEMMET's legend for the mining cadastre (SERV_CATASTRO_MINERO layer 0, field LEYENDA), with
 * the outline colours its own renderer publishes so the map reads like the official viewer.
 */
export const LEGEND: Readonly<Record<string, { label: string; color: [number, number, number] }>> =
  {
    TITULADO: { label: 'Concesión titulada', color: [105, 105, 255] },
    TRAMITE: { label: 'Petitorio en trámite', color: [56, 168, 0] },
    EXTINGUIDO: { label: 'Concesión extinguida', color: [105, 105, 105] },
    OTROS: { label: 'Planta de beneficio o cantera', color: [240, 194, 105] },
    BLOQUEADO: { label: 'Bloqueado', color: [85, 200, 0] },
    CONSENTIDO: { label: 'Con resolución de extinción sin consentir', color: [170, 102, 205] },
  };
const UNKNOWN: { label: string; color: [number, number, number] } = {
  label: 'Sin leyenda oficial',
  color: [90, 102, 115],
};
export const legendOf = (value: string) => LEGEND[value] ?? UNKNOWN;
