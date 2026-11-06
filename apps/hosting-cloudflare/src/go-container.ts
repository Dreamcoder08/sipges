import { Container } from '@cloudflare/containers';
import { GO_SLEEP_AFTER, goContainerEnv } from './go-routes.ts';

/**
 * The Go backend (apps/api-go) as a Cloudflare Container, bound as GO_BACKEND and placed in ENAM
 * by its constraint (wrangler.jsonc, wrangler.go.jsonc).
 */
export class GoBackend extends Container {
  override defaultPort = 8080;
  override sleepAfter = GO_SLEEP_AFTER;

  constructor(
    ctx: ConstructorParameters<typeof Container>[0],
    env: Readonly<Record<string, unknown>>,
  ) {
    super(ctx, env);
    this.envVars = goContainerEnv(env);
  }
}
