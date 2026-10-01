/**
 * Typed access to the release-engineering scripts. They are plain ES modules (so they run with
 * `node scripts/<name>.mjs` and no build step) and are loaded here at run time.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(__dirname, '..', '..', '..');

export type LicenseStatus = 'allowed' | 'copyleft' | 'unknown' | 'missing';

export interface LicensesModule {
  ALLOWED_LICENSES: string[];
  classifyLicense(expression: unknown): { status: LicenseStatus; ids: string[] };
  declaredLicense(manifest: Record<string, unknown>): string | undefined;
  normalizeText(text: string): string;
  groupByText(
    entries: { name: string; version: string; text: string }[],
  ): { text: string; members: { name: string; version: string }[] }[];
  packageOfPath(file: string): { name: string; dir: string } | undefined;
  renderNotices(entries: NoticeEntry[]): string;
  resolveRuntimePackages(
    appRoot: string,
    target?: { platform: string; arch: string; libc?: string },
  ): Promise<
    { name: string; version: string; dir?: string; platformBinary: boolean; parent?: string }[]
  >;
}

export interface NoticeEntry {
  name: string;
  version: string;
  license?: string;
  distribution: string;
  text: string;
  thirdPartyNotices: string[];
}

export interface IconsModule {
  PNG_SIZES: number[];
  ICO_SIZES: number[];
  ICNS_TYPES: [string, number][];
  readPngHeader(data: Buffer): {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
  };
  encodeIco(images: { size: number; data: Buffer }[]): Buffer;
  encodeIcns(images: { size: number; data: Buffer }[]): Buffer;
  decodeIco(
    data: Buffer,
  ): { width: number; height: number; bitsPerPixel: number; image: Buffer }[];
  decodeIcns(data: Buffer): { type: string; image: Buffer }[];
}

export interface PackageOptions {
  platform: string;
  arch: string;
  out: string;
  skipBuild: boolean;
  smoke: boolean;
  smokeNoSandbox: boolean;
  zip: boolean;
  electronZipDir: string | undefined;
  bundleId: string;
}

export interface PackageModule {
  EXECUTABLE_NAME: string;
  parseArgs(argv: string[], host?: { platform: string; arch: string }): PackageOptions;
  shouldShip(
    packageName: string,
    rel: string,
    isDirectory: boolean,
    target: { platform: string; arch: string },
  ): boolean;
  watcherBinaryName(target: { platform: string; arch: string }, libc?: string): string;
  sha256File(file: string): Promise<string>;
  createZip(folder: string, zipPath: string, hostPlatform?: string): Promise<void>;
  verifyLayout(options: {
    resourcesDir: string;
    target: { platform: string; arch: string };
    executable: string;
  }): Promise<string[]>;
}

export interface DevModule {
  parseDevArgs(argv: string[]): {
    out: string;
    userDataDir: string;
    debugPort: number | undefined;
    appArgs: string[];
  };
  classifyChange(files: string[]): 'restart' | 'reload' | 'none';
}

async function load<T>(name: string): Promise<T> {
  const url = pathToFileURL(path.join(repoRoot, 'scripts', name)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

export const loadLicenses = () => load<LicensesModule>('licenses.mjs');
export const loadIcons = () => load<IconsModule>('make-icons.mjs');
export const loadPackage = () => load<PackageModule>('package.mjs');
export const loadDev = () => load<DevModule>('dev.mjs');
