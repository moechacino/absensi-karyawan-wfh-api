import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export async function preparePrivateStorage(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checkPrivateStorage(root);
}

export async function checkPrivateStorage(root: string): Promise<void> {
  const info = await lstat(root);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error(
      'Storage must be an owner-only directory owned by this service identity.',
    );
  }

  let parent = dirname(await realpath(root));

  for (;;) {
    const info = await lstat(parent);

    if ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
      throw new Error(
        'Storage ancestors must not be group/world-writable without the sticky bit.',
      );
    }

    const next = dirname(parent);

    if (next === parent) {
      break;
    }

    parent = next;
  }

  await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
  const path = join(root, `.startup-${randomUUID()}`);
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.writeFile('storage-check');
    await handle.sync();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
