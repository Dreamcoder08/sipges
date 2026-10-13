// Operator commands run on the server with the same MASCLI_* environment as the API.
//   node src/admin-cli.ts reset-mfa <username>
// Recovers an account (including the last administrator) whose authenticator was lost; the
// HTTP route refuses self-reset, so this is the only path for a sole admin (ADR 0009).
import { createSqlIdentityStore } from './contexts/identity/infrastructure/sql-identity-store.ts';
import { normalizeUsername } from './contexts/identity/domain/user.ts';
import { loadConfig } from './platform/config.ts';
import { loadMigrations, migrate } from './platform/database/migrator.ts';
import { openDatabase } from './platform/database/open.ts';

const USAGE = 'Uso: node src/admin-cli.ts reset-mfa <usuario>';

export const runAdminCommand = async (
  args: readonly string[],
  deps: { store: Pick<ReturnType<typeof createSqlIdentityStore>, 'resetTotp'> },
): Promise<{ code: number; message: string }> => {
  const [command, rawUsername] = args;
  if (command !== 'reset-mfa' || !rawUsername || args.length !== 2) {
    return { code: 2, message: USAGE };
  }
  const username = normalizeUsername(rawUsername);
  const result = await deps.store.resetTotp(username);
  return result === 'reset'
    ? {
        code: 0,
        message: `MFA restablecido para ${username}; registrará un autenticador nuevo al ingresar.`,
      }
    : { code: 1, message: `Usuario inexistente: ${username}` };
};

if (import.meta.main) {
  const config = loadConfig(process.env);
  const database = await openDatabase(config);
  try {
    await migrate(database.sql, await loadMigrations());
    const { code, message } = await runAdminCommand(process.argv.slice(2), {
      store: createSqlIdentityStore(database.sql),
    });
    (code === 0 ? console.info : console.error)(message);
    process.exitCode = code;
  } finally {
    await database.close();
  }
}
