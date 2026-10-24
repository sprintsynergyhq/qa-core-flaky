/**
 * Build the stable test id.
 *
 * `project` is `default` when it is empty. `file` must already be relative
 * and use forward slashes; the parser does that before calling this.
 */
export function makeTestId(file: string, project: string, titlePath: readonly string[]): string {
  const projectName = project === '' ? 'default' : project;
  return `${file}::${projectName}::${titlePath.join(' > ')}`;
}
