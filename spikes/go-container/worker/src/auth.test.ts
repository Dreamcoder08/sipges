import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { test } from "node:test";

import { isAuthorized } from "./auth.ts";

const equal = (a: ArrayBufferView, b: ArrayBufferView) =>
  timingSafeEqual(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

const cases: Array<{ name: string; header: string | null; token: string | undefined; want: boolean }> = [
  { name: "matching bearer token", header: "Bearer s3cret", token: "s3cret", want: true },
  { name: "wrong token", header: "Bearer nope", token: "s3cret", want: false },
  { name: "different length", header: "Bearer s3cret-longer", token: "s3cret", want: false },
  { name: "missing header", header: null, token: "s3cret", want: false },
  { name: "not a bearer scheme", header: "Basic s3cret", token: "s3cret", want: false },
  { name: "token not configured fails closed", header: "Bearer ", token: undefined, want: false },
  { name: "empty configured token fails closed", header: "Bearer ", token: "", want: false },
];

for (const c of cases) {
  test(c.name, () => {
    assert.equal(isAuthorized(c.header, c.token, equal), c.want);
  });
}
