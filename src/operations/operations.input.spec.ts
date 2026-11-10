import { operationsCommand, provisionInput } from './operations.input';

const provisionFixture = {
  fullName: ' First HRD ',
  email: ' FIRST@example.test ',
  initialPassword: 'Fictional-password-123',
  divisionCode: 'OPS',
  divisionName: 'Operations',
  positionCode: 'HRD',
  positionName: 'Human resources',
};

describe('operations input', () => {
  it('normalizes account identity without trimming the password', () => {
    const input = provisionInput({
      ...provisionFixture,
      initialPassword: ' Fictional-password-123 ',
    });
    expect(input.fullName).toBe('First HRD');
    expect(input.email).toBe('first@example.test');
    expect(input.initialPassword).toBe(' Fictional-password-123 ');
  });

  it.each([
    null,
    [],
    {},
    { ...provisionFixture, extra: true },
    { ...provisionFixture, email: 'invalid' },
    { ...provisionFixture, initialPassword: 123 },
    { ...provisionFixture, initialPassword: 'x'.repeat(7) },
    { ...provisionFixture, initialPassword: 'x'.repeat(129) },
    { ...provisionFixture, divisionCode: ' ' },
    { ...provisionFixture, positionName: ' ' },
  ])('rejects invalid provisioning input %j', (input) => {
    expect(() => provisionInput(input)).toThrow();
  });

  it('counts Unicode password code points', () => {
    expect(() =>
      provisionInput({
        ...provisionFixture,
        initialPassword: '😀'.repeat(7),
      }),
    ).toThrow();
    expect(
      provisionInput({
        ...provisionFixture,
        initialPassword: '😀'.repeat(8),
      }).initialPassword,
    ).toBe('😀'.repeat(8));
  });

  it.each([
    ['provision-first-hrd', '--confirm-empty-installation'],
    ['seed-development', '--confirm-fictional-data'],
    ['cleanup-receipts', '1'],
    ['cleanup-receipts', '1000'],
  ])('accepts an explicit command %s %s', (...args) => {
    expect(operationsCommand(args).command).toBe(args[0]);
  });

  it.each([
    [],
    ['provision-first-hrd'],
    ['seed-development'],
    ['seed-development', '--confirm-empty-installation'],
    ['cleanup-receipts', '0'],
    ['cleanup-receipts', '1001'],
    ['cleanup-receipts', '01'],
    ['cleanup-receipts', '1', 'extra'],
    ['reset-all'],
  ])('rejects missing confirmations or unbounded cleanup %j', (...args) => {
    expect(() => operationsCommand(args)).toThrow();
  });
});
