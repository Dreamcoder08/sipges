import {
  type CurrentScope,
  GrantCreate,
  GrantRevoke,
  ScopeCreate,
  type ScopeSummary,
  SelectProjectForm,
} from '@sipges/contracts';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { SCOPE_COOKIE, SESSION_COOKIE, setAuthCookie } from '../../../platform/http/cookies.ts';
import type { AppEnv } from '../../../platform/http/env.ts';
import { escapeHtml } from '../../../platform/http/html.ts';
import { parseForm, parseJson } from '../../../platform/http/validation.ts';
import { type IdentityService, SESSION_SECONDS } from '../../identity/application/index.ts';
import { type TenancyService, type TenantSummary, formatScope } from '../application/index.ts';

const CREATE_ERRORS = {
  forbidden: [403, 'Administrador requerido'],
  invalid_ids: [422, 'IDs inválidos'],
  reserved: [409, 'Proyecto reservado'],
  user_missing: [404, 'Usuario no existe'],
  exists: [409, 'Proyecto existente'],
} as const;

const GRANT_ERRORS = {
  forbidden: [403, 'Forbidden'],
  user_missing: [404, 'Usuario inexistente'],
  tenant_missing: [404, 'Proyecto inexistente'],
  grant_missing: [404, 'Acceso inexistente'],
} as const;

const toSummary = (t: TenantSummary): ScopeSummary => ({
  company_id: t.companyId,
  project_id: t.projectId,
  label: t.label,
});

/** Same markup as app.py select_project_page, with every value HTML-escaped. */
const selectProjectPage = (tenants: readonly TenantSummary[]) => {
  const options = tenants
    .map((t) => {
      const scope = formatScope(t);
      return `<option value="${escapeHtml(scope)}">${escapeHtml(t.label)} (${escapeHtml(scope)})</option>`;
    })
    .join('');
  return (
    '<html lang="es"><meta charset="utf-8"><title>Seleccionar proyecto SIPGES</title>' +
    '<body style="font:18px system-ui;max-width:600px;margin:10vh auto"><h1>Selecciona tu proyecto autorizado</h1>' +
    '<form method="post" action="/select-project"><select name="scope" style="padding:12px;width:100%">' +
    options +
    '</select><p><button style="padding:12px">Entrar al proyecto</button></p></form></body></html>'
  );
};

export const tenancyRoutes = (deps: {
  tenancy: TenancyService;
  identity: IdentityService;
  cookieSecure: boolean;
}) => {
  const { tenancy, identity, cookieSecure } = deps;

  return (
    new Hono<AppEnv>()
      // Public route: authenticates itself so anonymous visitors are redirected, not rejected.
      .get('/select-project', async (c) => {
        const principal = await identity.authenticate(getCookie(c, SESSION_COOKIE));
        if (!principal) return c.redirect('/login', 303);
        return c.html(selectProjectPage(await tenancy.listGranted(principal.username)));
      })

      .post('/select-project', async (c) => {
        const principal = await identity.authenticate(getCookie(c, SESSION_COOKIE));
        if (!principal) return c.json({ detail: 'Unauthorized' }, 401);
        const form = await parseForm(c, SelectProjectForm);
        if (!form.ok) return form.response;
        if (!(await tenancy.isGranted(principal.username, form.value.scope))) {
          return c.json({ detail: 'Proyecto no autorizado' }, 403);
        }
        setAuthCookie(c, SCOPE_COOKIE, form.value.scope, cookieSecure, SESSION_SECONDS);
        return c.redirect('/', 303);
      })

      .get('/system/export', async (c) => {
        const result = await tenancy.exportData(c.get('identity'), c.get('scope'));
        if (!result.ok) return c.json({ detail: 'Requiere rol administrador' }, 403);
        c.header('Content-Disposition', 'attachment; filename="sipges-tenant.json"');
        c.header('Content-Type', 'application/json; charset=UTF-8');
        return c.body(JSON.stringify(result.value), 200);
      })

      .get('/system/auth/current-scope', (c) => {
        const scope = c.get('scope');
        return c.json({
          company_id: scope.companyId,
          project_id: scope.projectId,
          scope: formatScope(scope),
        } satisfies CurrentScope);
      })

      .get('/system/auth/scopes', async (c) => {
        const tenants = await tenancy.listGranted(c.get('identity').username);
        return c.json(tenants.map(toSummary));
      })

      .post('/system/auth/scopes', async (c) => {
        const body = await parseJson(c, ScopeCreate);
        if (!body.ok) return body.response;
        const { company_id: companyId, project_id: projectId, label, username } = body.value;
        const result = await tenancy.createTenant(c.get('identity'), {
          companyId,
          projectId,
          label,
          username,
        });
        if (!result.ok) {
          const [status, detail] = CREATE_ERRORS[result.error];
          return c.json({ detail }, status);
        }
        return c.json({ ok: true, scope: result.value });
      })

      .delete('/system/auth/grants', async (c) => {
        const body = await parseJson(c, GrantRevoke);
        if (!body.ok) return body.response;
        const { username, company_id: companyId, project_id: projectId } = body.value;
        const result = await tenancy.revoke(c.get('identity'), { username, companyId, projectId });
        if (!result.ok) {
          const [status, detail] = GRANT_ERRORS[result.error];
          return c.json({ detail }, status);
        }
        return c.json({ ok: true });
      })

      .post('/system/auth/grants', async (c) => {
        const body = await parseJson(c, GrantCreate);
        if (!body.ok) return body.response;
        const { username, company_id: companyId, project_id: projectId } = body.value;
        const result = await tenancy.grant(c.get('identity'), { username, companyId, projectId });
        if (!result.ok) {
          const [status, detail] = GRANT_ERRORS[result.error];
          return c.json({ detail }, status);
        }
        return c.json({ ok: true });
      })
  );
};
