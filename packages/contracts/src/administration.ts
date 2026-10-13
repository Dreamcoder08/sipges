import { z } from 'zod';
import { AccountSummary } from './identity.ts';
import { ScopeSummary } from './tenancy.ts';

export const AccountList = z.array(AccountSummary);
export const AuthorizedScopeList = z.array(ScopeSummary);
export const ScopeCreated = z.object({ ok: z.literal(true), scope: z.string() });
export const TotpEnabled = z.object({ ok: z.literal(true), totp_enabled: z.literal(true) });
