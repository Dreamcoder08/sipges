import { describe, expect, it } from 'vitest';
import { declaredParameterTypes } from '../../src/platform/database/declared-types.ts';

const OID = { text: 25, int4: 23, int8: 20, bool: 16, timestamptz: 1184 } as const;

describe('declaredParameterTypes', () => {
  it('reads the scalar type each parameter is cast to when its value matches', () => {
    expect(
      declaredParameterTypes(
        'SELECT 1 WHERE a = $1::text AND b > $2::timestamptz AND c = $3::integer AND d = $4::boolean AND e = $5::bigint',
        ['token', new Date(0), 7, true, 9],
      ),
    ).toEqual([OID.text, OID.timestamptz, OID.int4, OID.bool, OID.int8]);
  });

  it('declares a null parameter with its cast type', () => {
    expect(declaredParameterTypes('SELECT $1::text', [null])).toEqual([OID.text]);
  });

  it('leaves a parameter undeclared when any use is bare, differently cast or an array', () => {
    expect(
      declaredParameterTypes('SELECT $1::text, $1, $2::text, $2::integer, $3::text[], $4', [
        'a',
        'b',
        ['c'],
        'd',
      ]),
    ).toEqual([0, 0, 0, 0]);
  });

  it('leaves a parameter undeclared when its value does not match the cast', () => {
    expect(
      declaredParameterTypes('SELECT $1::timestamptz, $2::integer, $3::integer, $4::boolean', [
        '2026-11-02',
        '7',
        1.5,
        'true',
      ]),
    ).toEqual([0, 0, 0, 0]);
  });

  it('ignores json and casts on the result of another cast', () => {
    expect(declaredParameterTypes('SELECT $1::jsonb, $2::text::jsonb', ['{}', '{}'])).toEqual([
      0,
      OID.text,
    ]);
  });

  it('does not take $1 from $10', () => {
    expect(
      declaredParameterTypes('SELECT $10::integer', [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
        'h',
        'i',
        10,
      ]),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, OID.int4]);
  });
});
