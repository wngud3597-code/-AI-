/**
 * Integration seam for the eventual bundled userscript. Phase A-D does not
 * replace the baseline v4 script or enable autonomous play.
 */
export interface UserscriptBootstrapOptions {
  readonly enabledByDefault: false;
}

export function bootstrapUserscript(options: UserscriptBootstrapOptions): void {
  if (options.enabledByDefault !== false) throw new Error('Unvalidated autonomous startup is disabled');
}
