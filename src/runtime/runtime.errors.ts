export class RuntimeConfigurationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid runtime configuration: ${issues.join('; ')}.`);
    this.name = 'RuntimeConfigurationError';
  }
}

export class RuntimeDependencyError extends Error {
  constructor(dependency: 'mysql' | 'storage') {
    super(
      dependency === 'mysql'
        ? 'Database connection failed. Check DB_* settings and MySQL availability.'
        : 'Local storage is unavailable. Check STORAGE_ROOT and directory permissions.',
    );
    this.name = 'RuntimeDependencyError';
  }
}
