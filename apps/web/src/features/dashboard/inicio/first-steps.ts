import type { AccountSummary, RecordsSummary, Role } from '@sipges/contracts';

/** One step of Inicio's «Primeros pasos»: done only when the API data says so. */
export type FirstStep = {
  key: 'records' | 'team';
  title: string;
  line: string;
  href: string;
  action: string;
  done: boolean;
};

/** Who may load records: the same rule as Registros (features/records/model.ts canWriteRecords). */
export const loadsRecords = (role: Role) => role === 'admin' || role === 'analista';
/** Who may give the team access: accounts and grants are the administrator's. */
export const managesAccounts = (role: Role) => role === 'admin';

/**
 * The steps this role can act on, each read from data the app already has: the project's record
 * counts and, for an administrator, the installation's accounts. Another active account is the
 * signal for the team step; the account list does not say which projects each one may open.
 */
export const firstSteps = ({
  role,
  username,
  counts,
  accounts,
}: {
  role: Role;
  username: string;
  counts: RecordsSummary['counts'] | undefined;
  accounts: readonly AccountSummary[] | undefined;
}): FirstStep[] => {
  const steps: FirstStep[] = [];
  if (loadsRecords(role) && counts)
    steps.push({
      key: 'records',
      title: 'Cargue los primeros registros',
      line: 'Cárguelos con «Importar» o cree el primero con «Nuevo registro».',
      href: '/registros',
      action: 'Ir a Registros',
      done: Object.values(counts).some((count) => count > 0),
    });
  if (managesAccounts(role) && accounts)
    steps.push({
      key: 'team',
      title: 'Dé acceso a su equipo',
      line: 'Cree una cuenta para cada persona y autorícela en este proyecto.',
      href: '/administracion',
      action: 'Abrir Administración',
      done: accounts.some((account) => account.active === 1 && account.username !== username),
    });
  return steps;
};
