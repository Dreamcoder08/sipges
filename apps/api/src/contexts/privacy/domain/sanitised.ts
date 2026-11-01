/**
 * What may leave SIPGES for an external model or client (docs/adr/0030). The brand cannot be
 * written by hand: only the egress guard seals a payload, after sanitising and logging it.
 */
declare const sanitisedBrand: unique symbol;

export type SanitisedPayload<T> = T & { readonly [sanitisedBrand]: true };

/** Seals `data` as cleared. Called by the egress guard and nowhere else. */
export const sealPayload = <T>(data: T): SanitisedPayload<T> => data as SanitisedPayload<T>;
