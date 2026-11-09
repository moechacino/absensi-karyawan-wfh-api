import { EmptyCheckInPipe } from './empty-check-in.pipe';

describe('EmptyCheckInPipe', () => {
  it('accepts no client-supplied business fields', () => {
    expect(new EmptyCheckInPipe().transform({})).toEqual({});
  });

  it.each([
    null,
    [],
    'body',
    { employeeId: 'other' },
    { checkInAt: 'client-time' },
    { status: 'ON_TIME' },
    { contextToken: 'unused' },
  ])(
    'rejects client-controlled identity/time/status or malformed input %j',
    (input) => {
      expect(() => new EmptyCheckInPipe().transform(input)).toThrow(
        'only the photo',
      );
    },
  );
});
