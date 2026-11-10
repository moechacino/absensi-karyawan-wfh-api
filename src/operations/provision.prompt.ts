import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';

import { provisionInput } from './operations.input';
import type { ProvisionInput } from './operations.input';

type TerminalInput = Readable & { isTTY?: boolean };
type TerminalOutput = Writable & { isTTY?: boolean };

export async function readProvisionInput(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout,
): Promise<ProvisionInput> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;

      if (size > 16384) {
        throw new Error('Provisioning input exceeds 16 KiB.');
      }

      chunks.push(bytes);
    }

    return provisionInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }

  if (!output.isTTY) {
    throw new Error('Interactive provisioning needs a private terminal.');
  }

  let hidden = false;
  const terminal = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!hidden) output.write(chunk);
      callback();
    },
  });
  const reader = createInterface({
    input,
    output: terminal,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  reader.on('SIGINT', () => abort.abort());
  reader.on('close', () => abort.abort());

  const ask = async (label: string, secret = false): Promise<string> => {
    hidden = secret;

    try {
      if (secret) output.write(label);
      return await reader.question(secret ? '' : label, {
        signal: abort.signal,
      });
    } finally {
      hidden = false;
      if (secret) output.write('\n');
    }
  };

  try {
    const fullName = await ask('HR full name: ');
    const email = await ask('HR email: ');
    const initialPassword = await ask(
      'Initial password (8–128 characters, hidden): ',
      true,
    );
    const confirmation = await ask('Confirm initial password (hidden): ', true);

    if (confirmation !== initialPassword) {
      throw new Error('Initial password confirmation does not match.');
    }

    const divisionCode = await ask('Division code: ');
    const divisionName = await ask('Division name: ');
    const positionCode = await ask('Position code: ');
    const positionName = await ask('Position name: ');

    return provisionInput({
      fullName,
      email,
      initialPassword,
      divisionCode,
      divisionName,
      positionCode,
      positionName,
    });
  } finally {
    reader.close();
    terminal.end();
  }
}
