import { parseRpcConfig } from './rpc.config';

const credential = 'rpc-test-only-secret-with-at-least-32-bytes';
const valid = { ATTENDANCE_RPC_CREDENTIAL: credential };

describe('attendance RPC configuration', () => {
  it('uses a separate loopback port and finite deadline', () => {
    expect(parseRpcConfig(valid)).toEqual({
      host: '127.0.0.1',
      port: 4001,
      deadlineMs: 5000,
      serviceCredential: credential,
    });
    expect(parseRpcConfig({ ...valid, ATTENDANCE_RPC_HOST: '::1' }).host).toBe(
      '::1',
    );
  });

  it.each(['0.0.0.0', 'localhost', '192.168.1.1', '::', ''])(
    'rejects non-loopback binding %p',
    (host) => {
      expect(() =>
        parseRpcConfig({ ...valid, ATTENDANCE_RPC_HOST: host }),
      ).toThrow('ATTENDANCE_RPC_HOST');
    },
  );

  it.each(['', '0', '01', '-1', '65536', '4.1', ' 4001'])(
    'rejects invalid ports %p',
    (port) => {
      expect(() =>
        parseRpcConfig({ ...valid, ATTENDANCE_RPC_PORT: port }),
      ).toThrow('ATTENDANCE_RPC_PORT');
    },
  );

  it.each(['0', '99', '60001', 'Infinity'])(
    'rejects invalid deadlines %p',
    (deadline) => {
      expect(() =>
        parseRpcConfig({ ...valid, ATTENDANCE_RPC_DEADLINE_MS: deadline }),
      ).toThrow('ATTENDANCE_RPC_DEADLINE_MS');
    },
  );

  it.each([
    '',
    'short-secret-marker',
    'REPLACE_WITH_A_RANDOM_SECRET_OF_32_BYTES',
    'a'.repeat(257),
  ])('rejects secrets without exposing their value', (secret) => {
    try {
      parseRpcConfig({ ATTENDANCE_RPC_CREDENTIAL: secret });
      throw new Error('Expected configuration rejection');
    } catch (error) {
      expect((error as Error).message).toContain('ATTENDANCE_RPC_CREDENTIAL');

      if (secret) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  it('requires an independent service credential', () => {
    expect(() => parseRpcConfig({ ...valid, JWT_SECRET: credential })).toThrow(
      'must differ',
    );
  });
});
