import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  legacyStoredNameSafe,
  mapAction,
  mapActionLog,
  mapAlert,
  mapAttachment,
  mapRecord,
  mapSnapshot,
  mapTenant,
  mapUser,
  objectKeyFor,
  parseLegacyTimestamp,
  recordFingerprint,
  scopeDigest,
  setChecksum,
} from '../../src/tools/migrate-legacy/domain/mapping.ts';
import { moduleForSlug } from '../../src/contexts/records/application/index.ts';
import { legacyPasswordHash, scopeDirectory } from '../support/legacy-fixture.ts';

const user = (overrides: Record<string, unknown> = {}) => ({
  username: 'legacy.user',
  full_name: 'Usuario Sintetico',
  password_hash: legacyPasswordHash('synthetic-password-123'),
  role: 'analista',
  active: 1,
  created_at: '2026-10-01T09:00:00',
  totp_secret: null,
  totp_enabled: 0,
  ...overrides,
});

describe('legacy mapping', () => {
  it('reads naive legacy timestamps as UTC and accepts explicit offsets', () => {
    expect(parseLegacyTimestamp('2026-10-01T09:00:00')?.toISOString()).toBe(
      '2026-10-01T09:00:00.000Z',
    );
    expect(parseLegacyTimestamp('2026-10-01 09:00:00')?.toISOString()).toBe(
      '2026-10-01T09:00:00.000Z',
    );
    expect(parseLegacyTimestamp('2026-10-01T09:00:00-05:00')?.toISOString()).toBe(
      '2026-10-01T14:00:00.000Z',
    );
    expect(parseLegacyTimestamp('no es fecha')).toBeNull();
    expect(parseLegacyTimestamp(null)).toBeNull();
  });

  it('accepts legacy PBKDF2 hashes and rejects anything else', () => {
    expect(mapUser(user()).ok).toBe(true);
    const migrated = mapUser(user());
    expect(migrated.ok && migrated.value.passwordHash.startsWith('pbkdf2_sha256$310000$')).toBe(
      true,
    );
    const argon = mapUser(user({ password_hash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def' }));
    expect(argon.ok).toBe(false);
    expect(!argon.ok && argon.error).toBe('user_password_hash_invalid');
    const role = mapUser(user({ role: 'superadmin' }));
    expect(!role.ok && role.error).toBe('user_role_invalid');
    const nul = mapUser(user({ username: 'bad\u0000name' }));
    expect(!nul.ok && nul.error).toBe('user_username_invalid');
  });

  it('keeps unknown payload fields and refuses payloads PostgreSQL cannot store', () => {
    const payload = { ID_Evento: 'EV-1', Campo_Desconocido: { anidado: [1, 2] } };
    const mapped = mapRecord({
      module: 'Eventos',
      record_id: 'EV-1',
      payload: JSON.stringify(payload),
      created_at: '2026-10-01T09:00:00',
      updated_at: '2026-10-02T09:00:00',
    });
    expect(mapped.ok && mapped.value.payload).toEqual(payload);

    const broken = mapRecord({
      module: 'Eventos',
      record_id: 'EV-2',
      payload: '{not json',
      created_at: '2026-10-01T09:00:00',
      updated_at: '2026-10-01T09:00:00',
    });
    expect(!broken.ok && broken.error).toBe('record_payload_invalid');

    const nul = mapRecord({
      module: 'Eventos',
      record_id: 'EV-3',
      payload: JSON.stringify({ Nota: 'con\u0000nul' }),
      created_at: '2026-10-01T09:00:00',
      updated_at: '2026-10-01T09:00:00',
    });
    expect(!nul.ok && nul.error).toBe('record_payload_invalid');

    const list = mapRecord({
      module: 'Eventos',
      record_id: 'EV-4',
      payload: '[1,2,3]',
      created_at: '2026-10-01T09:00:00',
      updated_at: '2026-10-01T09:00:00',
    });
    expect(!list.ok && list.error).toBe('record_payload_invalid');
  });

  it('maps the legacy module slug to the stored module name of the foreign key', () => {
    const row = {
      id: 'ADJ-1',
      stored_name: 'abc_evidencia.txt',
      original_name: 'evidencia.txt',
      content_type: null,
      size_bytes: 10,
      sha256: null,
      linked_module: 'Eventos',
      linked_record_id: 'EV-1',
      created_at: '2026-10-01T09:00:00',
    };
    const mapped = mapAttachment(row, { tenantId: 'SIPGES/PRJ-SECHURA', moduleForSlug });
    expect(mapped.ok && mapped.value.recordModule).toBe('Eventos');
    expect(mapped.ok && mapped.value.linkedModule).toBe('eventos');
    expect(mapped.ok && mapped.value.contentType).toBe('application/octet-stream');
    expect(mapped.ok && mapped.value.projectId).toBe('PRJ-SECHURA');

    const unknown = mapAttachment(
      { ...row, linked_module: 'inexistente' },
      {
        tenantId: 'SIPGES/PRJ-SECHURA',
        moduleForSlug,
      },
    );
    expect(!unknown.ok && unknown.error).toBe('attachment_module_unknown');
  });

  it('derives object keys the storage adapters accept', () => {
    const tenant = 'ACME/PRJ-NORTE';
    expect(scopeDigest(tenant)).toBe(scopeDirectory(tenant));
    const plain = objectKeyFor(tenant, 'deadbeef_informe.pdf');
    expect(plain).toEqual({ key: `${scopeDigest(tenant)}/deadbeef_informe.pdf`, sanitized: false });
    const odd = objectKeyFor(tenant, 'informe con espacios y ñ.pdf');
    expect(odd.sanitized).toBe(true);
    expect(odd.key).toMatch(/^[0-9a-f]{24}\/[A-Za-z0-9._-]+$/);
    // Deterministic, so a repeated run addresses the same object.
    expect(objectKeyFor(tenant, 'informe con espacios y ñ.pdf')).toEqual(odd);
  });

  it('checksums records independently of order and key order', () => {
    const a = recordFingerprint('Eventos', 'EV-1', { b: 2, a: 1 });
    const b = recordFingerprint('Eventos', 'EV-2', { a: 1 });
    expect(setChecksum([a, b])).toBe(setChecksum([b, a]));
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(setChecksum([a])).not.toBe(setChecksum([b]));
  });

  it('reports any output text PostgreSQL cannot store instead of failing on insert', () => {
    const nul = 'con\u0000nul';
    const attachment = {
      id: 'ADJ-1',
      stored_name: 'abc_evidencia.txt',
      size_bytes: 10,
      linked_module: 'eventos',
      linked_record_id: 'EV-1',
      created_at: '2026-10-01T09:00:00',
    };
    const deps = { tenantId: 'SIPGES/PRJ-SECHURA', moduleForSlug };
    expect(mapAttachment(attachment, deps).ok).toBe(true);
    for (const field of [
      'original_name',
      'content_type',
      'document_type',
      'author',
      'verification',
      'notes',
      'project_id',
      'project_name',
      'linked_record_id',
    ]) {
      const mapped = mapAttachment({ ...attachment, [field]: nul }, deps);
      expect(!mapped.ok && mapped.error, field).toBe('attachment_row_invalid');
    }

    const action = {
      id: 'ACC-1',
      alert_id: 'DIG-1',
      due_date: '2026-11-15',
      status: 'Pendiente',
      progress: 0,
      created_at: '2026-10-01T09:00:00',
      updated_at: '2026-10-01T09:00:00',
    };
    expect(mapAction(action).ok).toBe(true);
    const description = mapAction({ ...action, description: nul });
    expect(!description.ok && description.error).toBe('action_row_invalid');

    const log = {
      id: 'LOG-1',
      action_id: 'ACC-1',
      status: 'Pendiente',
      progress: 0,
      created_at: '2026-10-01T09:00:00',
    };
    expect(mapActionLog(log).ok).toBe(true);
    for (const field of ['status', 'note', 'evidence_url']) {
      const mapped = mapActionLog({ ...log, [field]: nul });
      expect(!mapped.ok && mapped.error, field).toBe('action_log_row_invalid');
    }

    const snapshot = {
      ts: '2026-10-01T09:00:00',
      irsa: 42.5,
      level: 'Amarillo',
      scores: '{"G":40}',
    };
    expect(mapSnapshot(snapshot).ok).toBe(true);
    for (const field of ['config_version', 'note']) {
      const mapped = mapSnapshot({ ...snapshot, [field]: nul });
      expect(!mapped.ok && mapped.error, field).toBe('snapshot_row_invalid');
    }

    expect(mapTenant({ companyId: 'ACME', projectId: 'PRJ-1', label: 'Norte' }).ok).toBe(true);
    const label = mapTenant({ companyId: 'ACME', projectId: 'PRJ-1', label: nul });
    expect(!label.ok && label.error).toBe('tenant_row_invalid');
  });

  it('rejects alerts whose JSON columns or review date app.py could not read', () => {
    const alert = {
      id: 'DIG-1',
      created_at: '2026-10-01T09:00:00',
      status: 'Corroborado',
      sha256: 'a'.repeat(64),
      themes_json: '[{"tema":"agua"}]',
      signals_json: '[]',
      suggestions_json: '["verificar"]',
      reviewed_at: '2026-10-02T09:00:00',
    };
    const mapped = mapAlert(alert);
    expect(mapped.ok && mapped.value.themes).toEqual([{ tema: 'agua' }]);
    expect(mapped.ok && mapped.value.reviewedAt?.toISOString()).toBe('2026-10-02T09:00:00.000Z');
    expect(mapAlert({ ...alert, reviewed_at: null }).ok).toBe(true);
    for (const broken of [
      { themes_json: '{not json' },
      { signals_json: null },
      { suggestions_json: JSON.stringify(['con\u0000nul']) },
      { reviewed_at: 'ayer' },
    ]) {
      const result = mapAlert({ ...alert, ...broken });
      expect(!result.ok && result.error, Object.keys(broken)[0]).toBe('alert_row_invalid');
    }
  });

  it('only accepts stored names that stay inside one upload folder', () => {
    expect(legacyStoredNameSafe(`${'0'.repeat(32)}_informe.pdf`)).toBe(true);
    expect(legacyStoredNameSafe('perdido_archivo.txt')).toBe(true);
    for (const name of ['', '.', '..', '../x.pdf', 'abc/x.pdf', 'abc\\x.pdf', 'a\u0000b']) {
      expect(legacyStoredNameSafe(name), name).toBe(false);
    }
    const escaped = mapAttachment(
      {
        id: 'ADJ-1',
        stored_name: `${'0'.repeat(24)}/${'1'.repeat(32)}_otro.pdf`,
        size_bytes: 10,
        linked_module: 'eventos',
        linked_record_id: 'EV-1',
        created_at: '2026-10-01T09:00:00',
      },
      { tenantId: 'SIPGES/PRJ-SECHURA', moduleForSlug },
    );
    expect(!escaped.ok && escaped.error).toBe('attachment_stored_name_unsafe');
  });
});

describe('parseLegacyTimestamp with NUL', () => {
  it('refuses the value instead of reading its prefix', () => {
    expect(parseLegacyTimestamp('2026-01-02T03:04:05\u0000zzz')).toBeNull();
    expect(parseLegacyTimestamp(new TextEncoder().encode('2026-01-02\u0000zzz'))).toBeNull();
  });
});
