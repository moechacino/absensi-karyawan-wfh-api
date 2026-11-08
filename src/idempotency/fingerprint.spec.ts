import {
  canonicalJson,
  digestFile,
  fingerprint,
  publicReceipt,
} from './fingerprint';

describe('idempotency inputs and nonsecret receipts', () => {
  it('ignores object and multipart part ordering, retaining values and image bytes', () => {
    const photo = digestFile('photo', Buffer.from('original bytes'));
    const other = digestFile('other', Buffer.from('other bytes'));
    expect(
      fingerprint({ expectedVersion: 1, removePhoto: false }, [photo, other]),
    ).toBe(
      fingerprint({ removePhoto: false, expectedVersion: 1 }, [other, photo]),
    );
    expect(fingerprint({ value: 1 }, [photo])).not.toBe(
      fingerprint({ value: 1 }, [
        digestFile('photo', Buffer.from('changed bytes')),
      ]),
    );
    expect(fingerprint({ value: 1 }, [], 'one')).not.toBe(
      fingerprint({ value: 1 }, [], 'two'),
    );
  });
  it('preserves meaningful differences and rejects duplicate file fields', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(fingerprint({ value: false })).not.toBe(
      fingerprint({ value: 'false' }),
    );
    const photo = digestFile('photo', Buffer.from('a'));
    expect(() => fingerprint({}, [photo, photo])).toThrow('duplicate');
  });
  it.each([undefined, NaN, Infinity, new Date(), 1n])(
    'rejects non-JSON values: %p',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow();
    },
  );
  it('caches only plain public receipts and rejects secret/internal fields recursively', () => {
    const original = { employeeId: 'example', nested: { version: 1 } };
    const receipt = publicReceipt(original);
    expect(receipt).toEqual(original);
    expect(receipt).not.toBe(original);
    for (const key of [
      'password',
      'password_hash',
      'accessToken',
      'initialCredentials',
      'authorization',
      'objectKey',
      'localPath',
    ])
      expect(() =>
        publicReceipt({ nested: { [key]: 'private-marker' } }),
      ).toThrow('cannot be cached');
    expect(() => publicReceipt(null)).toThrow();
  });
});
