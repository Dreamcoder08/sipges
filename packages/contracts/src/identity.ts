import { z } from 'zod';

export const Role = z.enum(['admin', 'analista', 'coordinador', 'consulta']);
export type Role = z.infer<typeof Role>;

/** POST /login form fields (app.py:266). */
export const LoginForm = z.object({
  username: z.string(),
  password: z.string(),
  otp: z.string().default(''),
});
export type LoginForm = z.infer<typeof LoginForm>;

export const LoginResponse = z.object({ ok: z.literal(true), name: z.string(), role: Role });
export type LoginResponse = z.infer<typeof LoginResponse>;

/** GET /system/auth/me — `active` stays numeric (1) for parity with the SQLite row. */
export const Me = z
  .object({ username: z.string(), full_name: z.string(), role: Role, active: z.literal(1) })
  .nullable();
export type Me = z.infer<typeof Me>;

/** POST /system/auth/accounts body (app.py AccountIn). */
export const AccountCreate = z.object({
  username: z.string(),
  full_name: z.string(),
  password: z.string(),
  role: z.string().default('consulta'),
});
export type AccountCreate = z.infer<typeof AccountCreate>;

export const AccountCreated = z.object({ ok: z.literal(true), username: z.string(), role: Role });

export const AccountSummary = z.object({
  username: z.string(),
  full_name: z.string(),
  role: Role,
  active: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string(),
  /** Google address linked for "Entrar con Google" (ADR 0010), or null. */
  google_email: z.string().nullable(),
});
export type AccountSummary = z.infer<typeof AccountSummary>;

export const TotpSetupResponse = z.object({
  secret: z.string(),
  otpauth_uri: z.string(),
  instruction: z.string(),
});

export const TotpEnableRequest = z.object({ code: z.string() });

/** GET /system/auth/providers: which optional sign-in methods this installation offers. */
export const AuthProviders = z.object({ google: z.boolean() });
export type AuthProviders = z.infer<typeof AuthProviders>;

/** POST /system/auth/accounts/:username/google — an empty address unlinks Google. */
export const GoogleLinkRequest = z.object({ email: z.string() });
export type GoogleLinkRequest = z.infer<typeof GoogleLinkRequest>;

export const GoogleLinked = z.object({
  ok: z.literal(true),
  username: z.string(),
  google_email: z.string().nullable(),
});

export const OkResponse = z.object({ ok: z.literal(true) });

/**
 * One of the caller's own active sessions (GET /system/auth/sessions). `id` is opaque: derived
 * from the stored hash, never the token or the hash itself. SIPGES records no device or address.
 */
export const SessionSummary = z.object({
  id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  method: z.enum(['password', 'google']),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const SessionList = z.object({ sessions: z.array(SessionSummary) });
export type SessionList = z.infer<typeof SessionList>;

/** DELETE /system/auth/sessions/:id — `current` means this device was signed out. */
export const SessionEnded = z.object({ ok: z.literal(true), current: z.boolean() });
export type SessionEnded = z.infer<typeof SessionEnded>;

/** POST /system/auth/sessions/revoke-others — how many other sessions ended. */
export const SessionsRevoked = z.object({ ok: z.literal(true), count: z.number().int() });
export type SessionsRevoked = z.infer<typeof SessionsRevoked>;
