import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  mapAttachment,
  mapRecord,
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
    const mapped = mapAttachment(row, { tenantId: 'MASCLI/PRJ-SECHURA', moduleForSlug });
    expect(mapped.ok && mapped.value.recordModule).toBe('Eventos');
    expect(mapped.ok && mapped.value.linkedModule).toBe('eventos');
    expect(mapped.ok && mapped.value.contentType).toBe('application/octet-stream');
    expect(mapped.ok && mapped.value.projectId).toBe('PRJ-SECHURA');

    const unknown = mapAttachment(
      { ...row, linked_module: 'inexistente' },
      {
        tenantId: 'MASCLI/PRJ-SECHURA',
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
});
