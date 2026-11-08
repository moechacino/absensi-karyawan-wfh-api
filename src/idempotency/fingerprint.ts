import { createHash } from 'node:crypto';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface FileDigest {
  field: string;
  sha256: string;
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) {
    throw new Error('JSON nesting exceeds the supported limit.');
  }

  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return (
      '[' +
      Array.from(value, (item) => canonicalJson(item, depth + 1)).join(',') +
      ']'
    );
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonicalJson((value as Record<string, unknown>)[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  }

  throw new Error('Only finite plain JSON values are supported.');
}

export function digestFile(field: string, bytes: Uint8Array): FileDigest {
  return { field, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function fingerprint(
  input: JsonObject,
  files: readonly FileDigest[] = [],
  resourceId?: string,
): string {
  const names = new Set<string>();
  const sorted = files
    .map((file) => {
      if (
        !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(file.field) ||
        names.has(file.field) ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        throw new Error('Invalid or duplicate file digest.');
      }

      names.add(file.field);
      return { field: file.field, sha256: file.sha256 };
    })
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return createHash('sha256')
    .update(
      canonicalJson({ input, files: sorted, resourceId: resourceId ?? null }),
    )
    .digest('hex');
}

export function publicReceipt(body: unknown): JsonObject {
  const check = (value: Json): void => {
    if (Array.isArray(value)) {
      value.forEach(check);
      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (
          /password|secret|token|authorization|initialcredentials|objectkey|storagekey|localpath|privatekey/i.test(
            key.replace(/[^a-z]/gi, ''),
          )
        ) {
          throw new Error('Secret-bearing results cannot be cached.');
        }

        check(item);
      }
    }
  };

  const result = JSON.parse(canonicalJson(body)) as JsonObject;

  if (result === null || Array.isArray(result) || typeof result !== 'object') {
    throw new Error('Receipt must be a JSON object.');
  }

  check(result);
  return result;
}
