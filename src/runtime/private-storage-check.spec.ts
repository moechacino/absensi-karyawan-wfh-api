import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkPrivateStorage,
  preparePrivateStorage,
} from './private-storage-check';

describe('private storage startup check', () => {
  let parent: string;
  let root: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'wfh-storage-check-'));
    root = join(parent, 'files');
  });

  afterEach(async () => {
    await chmod(parent, 0o700);
    await rm(parent, { recursive: true, force: true });
  });

  it('creates private storage and leaves no probe bytes after a durable write check', async () => {
    await preparePrivateStorage(root);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual([]);
    await checkPrivateStorage(root);
  });

  it('refuses broad existing root permissions without silently repairing them', async () => {
    await mkdir(root, { mode: 0o755 });
    await expect(preparePrivateStorage(root)).rejects.toThrow('owner-only');
    expect((await lstat(root)).mode & 0o777).toBe(0o755);
  });

  it('refuses symlink roots', async () => {
    const target = join(parent, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    await expect(preparePrivateStorage(root)).rejects.toThrow('owner-only');
  });

  it.each([0o770, 0o777])(
    'refuses an ancestor writable by other identities (%s)',
    async (mode) => {
      await mkdir(root, { mode: 0o700 });
      await chmod(parent, mode);
      await expect(checkPrivateStorage(root)).rejects.toThrow('ancestors');
    },
  );

  it('refuses a file in place of the storage directory', async () => {
    await writeFile(root, 'disk unavailable', { mode: 0o600 });
    await expect(preparePrivateStorage(root)).rejects.toThrow();
  });
});
