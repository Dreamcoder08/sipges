// Conflict-risk prediction (docs/adr/0031): pure domain of the Analytics context.
export {
  type IrsaPoint,
  type RiskAlert,
  type RiskInput,
  type RiskRecord,
  RISK_MODULES,
  TERRITORIAL_ALERT_MODULE,
  indexSignals,
} from './signals.ts';
export { FACTORS, type Factor, type FactorId, assertNoLeakage, featuresAt } from './features.ts';
export {
  type Backtest,
  type ConflictRiskReport,
  HORIZONS,
  type Prediction,
  conflictRisk,
} from './predict.ts';
