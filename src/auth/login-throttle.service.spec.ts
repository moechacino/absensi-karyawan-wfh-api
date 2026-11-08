import { LoginThrottle } from './login-throttle.service';

describe('LoginThrottle', () => {
  let time = 0;

  it('limits account/IP attempts and allows attempts after the window', () => {
    const throttle = new LoginThrottle({ now: () => new Date(time) });

    for (let i = 0; i < 10; i++) {
      throttle.check('127.0.0.1', 'one@example.test');
    }

    expect(() => throttle.check('127.0.0.1', 'one@example.test')).toThrow(
      'Too many',
    );
    expect(() => throttle.check('127.0.0.2', 'one@example.test')).not.toThrow();
    time = 60000;
    expect(() => throttle.check('127.0.0.1', 'one@example.test')).not.toThrow();
  });

  it('limits attempts across rotating emails from the same IP', () => {
    const throttle = new LoginThrottle({ now: () => new Date(time) });

    for (let i = 0; i < 30; i++) {
      throttle.check('127.0.0.1', `${i}@example.test`);
    }

    expect(() => throttle.check('127.0.0.1', 'another@example.test')).toThrow(
      'Too many',
    );
  });
});
