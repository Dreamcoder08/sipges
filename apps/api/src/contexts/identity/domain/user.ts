import { type Result, err, ok } from '@mascli/kernel';

export const ROLES = ['admin', 'analista', 'coordinador', 'consulta'] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (value: string): value is Role =>
  (ROLES as readonly string[]).includes(value);

export const PASSWORD_MIN = 12;
/** Upper bound keeps hashing cost bounded (ADR 0004). */
export const PASSWORD_MAX = 256;
const FULL_NAME_MAX = 120;
const USERNAME_PATTERN = /^[a-z0-9_.-]{3,40}$/;

/** Authenticated principal as exposed by the API (`active` stays numeric for contract parity). */
export type Identity = {
  readonly username: string;
  readonly fullName: string;
  readonly role: Role;
};

/** Principal resolved from a session, plus whether its second factor is enrolled (ADR 0009). */
export type SessionIdentity = Identity & { readonly mfaEnabled: boolean };

export type NewAccount = {
  readonly username: string;
  readonly fullName: string;
  readonly password: string;
  readonly role: Role;
};

export const normalizeUsername = (raw: string) => raw.trim().toLowerCase();

/** Length in Unicode code points, like Python len() (UTF-16 length would count astral characters twice). */
const codePoints = (text: string) => [...text].length;

/** Validation rules and messages of app.py:298-302, plus the ADR 0004 maximum length. */
export const validateNewAccount = (input: {
  username: string;
  fullName: string;
  password: string;
  role: string;
}): Result<NewAccount, string> => {
  if (!USERNAME_PATTERN.test(input.username)) return err('Usuario inválido');
  if (!isRole(input.role)) return err('Rol no válido');
  if (codePoints(input.password) < PASSWORD_MIN)
    return err('Contraseña demasiado corta: mínimo 12 caracteres');
  if (codePoints(input.password) > PASSWORD_MAX)
    return err('Contraseña demasiado larga: máximo 256 caracteres');
  return ok({
    username: input.username,
    fullName: input.fullName.slice(0, FULL_NAME_MAX),
    password: input.password,
    role: input.role,
  });
};

const GOOGLE_EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A Google address an administrator links to an account; compared in lower case (ADR 0010). */
export const normalizeGoogleEmail = (raw: string): Result<string, string> => {
  const email = raw.trim().toLowerCase();
  // PostgreSQL text cannot hold NUL.
  if (email.length > GOOGLE_EMAIL_MAX || email.includes('\u0000') || !EMAIL_PATTERN.test(email))
    return err('Correo de Google inválido');
  return ok(email);
};
