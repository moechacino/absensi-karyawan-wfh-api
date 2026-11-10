import { PassThrough } from 'node:stream';

import { readProvisionInput } from './provision.prompt';

const values = {
  fullName: 'Operator HR',
  email: 'HR@example.test',
  initialPassword: 'Operator-only-password-123',
  divisionCode: 'PEOPLE',
  divisionName: 'People',
  positionCode: 'HRD',
  positionName: 'HR Administrator',
};

function session() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let displayed = '';
  output.on('data', (chunk: Buffer) => {
    displayed += chunk.toString();
  });

  async function answer(prompt: string, value: string) {
    for (let attempt = 0; !displayed.includes(prompt); attempt++) {
      if (attempt > 100) throw new Error('Expected terminal prompt missing');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    input.write(value + '\r');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  return { input, output, answer, displayed: () => displayed };
}

describe('operator-supplied HR provisioning', () => {
  it('collects custom identity/organization and never echoes either password entry', async () => {
    const terminal = session();
    const result = readProvisionInput(terminal.input, terminal.output);
    await terminal.answer('HR full name:', values.fullName);
    await terminal.answer('HR email:', values.email);
    await terminal.answer('Initial password (', values.initialPassword);
    await terminal.answer('Confirm initial password', values.initialPassword);
    await terminal.answer('Division code:', values.divisionCode);
    await terminal.answer('Division name:', values.divisionName);
    await terminal.answer('Position code:', values.positionCode);
    await terminal.answer('Position name:', values.positionName);
    expect(await result).toEqual({ ...values, email: 'hr@example.test' });
    expect(terminal.displayed()).not.toContain(values.initialPassword);
    expect(terminal.input.listenerCount('keypress')).toBe(0);
  });

  it('rejects password mismatch before asking for organization details', async () => {
    const terminal = session();
    const result = readProvisionInput(terminal.input, terminal.output);
    const rejected = expect(result).rejects.toThrow('confirmation');
    await terminal.answer('HR full name:', values.fullName);
    await terminal.answer('HR email:', values.email);
    await terminal.answer('Initial password (', values.initialPassword);
    await terminal.answer('Confirm initial password', 'different-password');
    await rejected;
    expect(terminal.displayed()).not.toContain(values.initialPassword);
    expect(terminal.displayed()).not.toContain('different-password');
    expect(terminal.displayed()).not.toContain('Division code:');
  });

  it('cancels on Ctrl-C without returning data or leaving the reader active', async () => {
    const terminal = session();
    const result = readProvisionInput(terminal.input, terminal.output);
    const rejected = expect(result).rejects.toThrow();
    await terminal.answer('HR full name:', '\u0003');
    await rejected;
    expect(terminal.input.listenerCount('keypress')).toBe(0);
  });

  it('retains bounded JSON stdin for scripted deployment', async () => {
    const input = new PassThrough();
    const result = readProvisionInput(input, new PassThrough());
    input.end(JSON.stringify(values));
    expect((await result).email).toBe('hr@example.test');
  });

  it('rejects oversized or malformed piped data', async () => {
    for (const text of ['not-json', 'x'.repeat(16385)]) {
      const input = new PassThrough();
      const result = readProvisionInput(input, new PassThrough());
      const rejected = expect(result).rejects.toThrow();
      input.end(text);
      await rejected;
    }
  });

  it('refuses to display interactive input through redirected stdout', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    await expect(readProvisionInput(input, new PassThrough())).rejects.toThrow(
      'private terminal',
    );
  });
});
