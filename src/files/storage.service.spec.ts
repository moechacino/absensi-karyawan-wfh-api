import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageService } from './storage.service';
import { fileConfig } from '../../test/file-fixture';

describe('StorageService', () => {
  let root: string;
  let storage: StorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wfh-files-unit-'));
    storage = new StorageService(fileConfig(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes private immutable bytes, validates size, opens and deletes them', async () => {
    const key = randomUUID() + '.png';
    await storage.put(key, Buffer.from('bytes'));
    expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
    await expect(storage.put(key, Buffer.from('other'))).rejects.toThrow();
    const handle = await storage.open(key, 5);
    expect(await handle.readFile()).toEqual(Buffer.from('bytes'));
    await handle.close();
    await expect(storage.open(key, 6)).rejects.toMatchObject({
      code: 'FILE_CONTENT_UNAVAILABLE',
    });
    await storage.delete(key);
    await storage.delete(key);
    await expect(storage.open(key, 5)).rejects.toThrow();
  });

  it('reads bounded attested bytes and rejects oversized, missing or mismatched objects', async () => {
    const key = randomUUID() + '.png';
    await storage.put(key, Buffer.from('bytes'));
    await expect(storage.read(key, 5)).resolves.toEqual(Buffer.from('bytes'));

    for (const size of [0, -1, 1.5, 5242881]) {
      await expect(storage.read(key, size)).rejects.toMatchObject({
        code: 'INVALID_FILE',
      });
    }

    await expect(storage.read(key, 4)).rejects.toMatchObject({
      code: 'FILE_CONTENT_UNAVAILABLE',
    });
    await expect(storage.read(randomUUID() + '.png', 5)).rejects.toMatchObject({
      code: 'FILE_CONTENT_UNAVAILABLE',
    });
  });

  it('blocks traversal, symlink reads, and symlink storage roots', async () => {
    const key = randomUUID() + '.png';
    await writeFile(join(root, 'private'), 'private');
    await symlink(join(root, 'private'), join(root, key));
    await expect(storage.open('../private', 7)).rejects.toThrow();
    await expect(storage.open(key, 7)).rejects.toThrow();
    const linkedRoot = root + '-link';
    await symlink(root, linkedRoot);

    try {
      await expect(
        new StorageService(fileConfig(linkedRoot)).put(
          randomUUID() + '.png',
          Buffer.from('x'),
        ),
      ).rejects.toThrow();
    } finally {
      await rm(linkedRoot);
    }
  });
});
