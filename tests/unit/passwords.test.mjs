import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../server/passwords.ts';

test(
  'a password hash accepts the original password',
  async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('wrong password', hash), false);
  }
);
test(
  'the same password produces independent salted hashes',
  async () => {
    const first = await hashPassword('DemoRoom2026!');
    const second = await hashPassword('DemoRoom2026!');
    assert.notEqual(first, second);
  }
);
test(
  'malformed or unsupported password hashes are rejected',
  async () => {
    for (const hash of ['', 'plain:password', 'scrypt-v1:abcd:1234', 'scrypt-v2:abc:123']) {
      assert.equal(await verifyPassword('anything', hash), false);
    }
  }
);
test(
  'a password is not silently trimmed',
  async () => {
    const hash = await hashPassword(' a long passphrase ');
    assert.equal(await verifyPassword('a long passphrase', hash), false);
  }
);
