# Packaging

```bash
npm run package
```

`scripts/package.mjs` runs these steps:

1. Builds the app with esbuild into `release/app`.
2. Stages only the production runtime dependencies (`node-pty`, `@parcel/watcher` and what they load) and removes files that never need to ship, such as sources, tests and prebuilds for other platforms.
3. Packages with `@electron/packager` into `release/`.
4. Verifies the layout: the executable, the unpacked native modules, `THIRD_PARTY_NOTICES.md` and `LICENSE`.
5. Smoke-tests the produced executable: the window renders, the bridge answers and a pseudo-terminal starts from the unpacked `node-pty`.
6. Reports the size.

## Options

| Option                              | Meaning                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `--platform <win32\|darwin\|linux>` | Target platform. Default: this machine.                                                   |
| `--arch <x64\|arm64>`               | Target architecture. Default: this machine.                                               |
| `--out <dir>`                       | Output directory. Default: `release`.                                                     |
| `--skip-build`                      | Reuse `<out>/app` from an earlier run.                                                    |
| `--no-smoke`                        | Skip the smoke test. It only runs for the host platform.                                  |
| `--smoke-no-sandbox`                | Launch the smoke test with `--no-sandbox` (Linux CI containers without a setuid sandbox). |
| `--zip`                             | Also create `inc-<version>-<platform>-<arch>.zip` and a `.sha256` file.                   |
| `--electron-zip-dir <dir>`          | Use Electron archives from this directory instead of downloading them.                    |
| `--bundle-id <id>`                  | macOS bundle identifier. Default: `inc.editor`. Set your own for releases.                |

## Naming

The product name is `.inc`, which starts with a dot and is awkward as a file name on some systems, so the executable and the macOS bundle are called `inc`.

## Third-party licenses

`npm run licenses` regenerates `THIRD_PARTY_NOTICES.md` from what the bundler includes and what is staged. `npm run licenses -- --check` fails when the file is out of date. A package whose license is not on the allowlist fails the run.

## Signing

Packages are not signed by this repository. Sign and notarize the output in your own pipeline with your own certificates.
