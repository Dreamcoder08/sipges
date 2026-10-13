/** Shared domain types of the Indicators & IRSA context. */

export type IndicatorMeta = {
  readonly code: string;
  readonly name: string;
  readonly definition: string;
};

/** Inclusive `[low, high]` IRSA band, keyed by band name in evaluation order. */
export type Thresholds = Readonly<Record<string, readonly [number, number]>>;

/** data/irsa_config.json shape; unknown keys are preserved. */
export type IrsaConfig = {
  readonly weights: Readonly<Record<string, number>>;
  readonly thresholds: Thresholds;
  readonly contributions: Readonly<Record<string, number>>;
  readonly [key: string]: unknown;
};
