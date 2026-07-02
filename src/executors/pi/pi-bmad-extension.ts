/**
 * Resolves the pi-bmad extension file loaded into headless stage processes.
 *
 * The pipeline treats `pi` as an opaque binary, so the pi-bmad extension is
 * injected explicitly via `-e <path>`. Resolution order follows the repo's
 * config idiom (explicit option, then environment, then a sane default):
 *
 * 1. `explicitPath` option (per-invocation configuration).
 * 2. `PI_BMAD_PIPELINE_EXTENSION_PATH` environment variable.
 * 3. `require.resolve("pi-bmad/extension")` — the installed dependency's
 *    published `./extension` export.
 * 4. `../pi-bmad/extensions/pi-bmad.ts` relative to the fallback root — the
 *    sibling-checkout layout used in development.
 *
 * @packageDocumentation
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

/** Environment variable overriding the pi-bmad extension file path. */
export const PI_BMAD_EXTENSION_PATH_ENV_VAR = "PI_BMAD_PIPELINE_EXTENSION_PATH" as const;

/** Module specifier of pi-bmad's published extension export. */
export const PI_BMAD_EXTENSION_MODULE_SPECIFIER = "pi-bmad/extension" as const;

/** Sibling-checkout fallback path, resolved against the fallback root. */
export const DEFAULT_PI_BMAD_EXTENSION_FALLBACK_PATH = "../pi-bmad/extensions/pi-bmad.ts" as const;

/** Options for resolving the pi-bmad extension path. */
export interface ResolvePiBmadExtensionPathOptions {
  /** Explicit extension file path; wins over every other source. */
  readonly explicitPath?: string;

  /** Environment map consulted for the override variable. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Module resolver used for the published export. Defaults to require.resolve. */
  readonly resolveModule?: (specifier: string) => string;

  /** Root the sibling-checkout fallback is resolved against. Defaults to process.cwd(). */
  readonly fallbackRoot?: string;
}

const defaultResolveModule = (specifier: string): string =>
  createRequire(import.meta.url).resolve(specifier);

/**
 * Resolves the pi-bmad extension file path for headless stage spawns.
 *
 * @param options - Optional explicit path, environment, resolver, and fallback root.
 *
 * @returns Extension file path to pass to `pi -e`.
 *
 * @throws RangeError When an explicit path is provided but blank.
 *
 * @example
 * ```ts
 * const extensionPath = resolvePiBmadExtensionPath();
 * ```
 */
export function resolvePiBmadExtensionPath(
  options: ResolvePiBmadExtensionPathOptions = {},
): string {
  return (
    explicitExtensionPath(options.explicitPath) ??
    envExtensionPath(options.env ?? process.env) ??
    installedOrSiblingExtensionPath(options)
  );
}

const explicitExtensionPath = (explicitPath: string | undefined): string | undefined => {
  if (explicitPath === undefined) {
    return undefined;
  }
  if (explicitPath.trim().length === 0) {
    throw new RangeError("explicitPath must not be blank.");
  }
  return explicitPath;
};

const envExtensionPath = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const envPath = env[PI_BMAD_EXTENSION_PATH_ENV_VAR];
  return envPath !== undefined && envPath.trim().length > 0 ? envPath : undefined;
};

const installedOrSiblingExtensionPath = (options: ResolvePiBmadExtensionPathOptions): string => {
  const resolveModule = options.resolveModule ?? defaultResolveModule;
  try {
    return resolveModule(PI_BMAD_EXTENSION_MODULE_SPECIFIER);
  } catch {
    return resolve(options.fallbackRoot ?? process.cwd(), DEFAULT_PI_BMAD_EXTENSION_FALLBACK_PATH);
  }
};
