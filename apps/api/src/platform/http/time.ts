/** Wire format for timestamps: ISO 8601 UTC without fractional seconds (docs/migration). */
export const isoSeconds = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
