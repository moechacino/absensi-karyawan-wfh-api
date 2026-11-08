import { JwtService } from '@nestjs/jwt';
import { parseRuntimeConfig } from '../runtime/runtime.config';
import { AccessTokenService } from './access-token.service';

const testConfig = parseRuntimeConfig({
  NODE_ENV: 'test',
  DB_HOST: 'localhost',
  DB_NAME: 'unused_test',
  DB_USERNAME: 'unused',
  DB_PASSWORD: 'unused',
  JWT_SECRET: 'test-signing-secret-at-least-32-bytes',
  JWT_ISSUER: 'test-api',
  JWT_AUDIENCE: 'test-web',
  STORAGE_ROOT: '../private-files',
});
const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'HRD' as const,
};

describe('AccessTokenService', () => {
  let time: Date;
  const clock = { now: () => new Date(time) };
  const jwt = new JwtService();
  const tokens = new AccessTokenService(jwt, clock, testConfig);

  beforeEach(() => {
    time = new Date('2026-11-08T01:00:00Z');
  });

  it('issues one-hour role claims and expires exactly at the boundary without a database', async () => {
    const grant = await tokens.issue(actor);
    expect(grant.expiresIn).toBe(3600);
    expect(grant.expiresAt).toBe('2026-11-08T02:00:00.000Z');
    await expect(tokens.verify(grant.accessToken)).resolves.toEqual(actor);
    time = new Date('2026-11-08T02:00:00Z');
    await expect(tokens.verify(grant.accessToken)).rejects.toMatchObject({
      code: 'TOKEN_EXPIRED',
    });
  });

  it.each([
    { purpose: 'preview' },
    { role: 'ADMIN' },
    { role: ['HRD'] },
    { status: 'INACTIVE' },
    { sub: 'invalid' },
    { jti: 'invalid' },
    { exp: 1794103200 + 10 },
    { iat: 1794099601 },
    { iss: 'other' },
    { aud: 'other' },
  ])('rejects signed but invalid access claims: %p', async (override) => {
    const grant = await tokens.issue(actor);
    const payload = jwt.decode<Record<string, unknown>>(grant.accessToken);
    const token = await jwt.signAsync(
      { ...payload, ...override },
      { secret: testConfig.jwt.secret, algorithm: 'HS256' },
    );
    await expect(tokens.verify(token)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects a different signature and signing algorithm', async () => {
    const grant = await tokens.issue(actor);
    const payload = jwt.decode(grant.accessToken);

    for (const options of [
      { secret: 'other-secret', algorithm: 'HS256' as const },
      { secret: testConfig.jwt.secret, algorithm: 'HS384' as const },
    ]) {
      await expect(
        tokens.verify(await jwt.signAsync(payload, options)),
      ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    }
  });
});
