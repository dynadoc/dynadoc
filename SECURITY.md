# Security Policy

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security
vulnerability.**

Report it privately through
[GitHub Private Security Advisories](https://github.com/dynadoc/dynadoc/security/advisories/new).

Please include:

- a description of the issue;
- the steps to reproduce it, and the commit SHA you reproduced it on;
- the impact you believe it has;
- a suggested fix, if you have one.

### What to expect

|                                    |                                                            |
| ---------------------------------- | ---------------------------------------------------------- |
| Acknowledgement                    | within 5 business days                                     |
| Initial assessment                 | within 10 business days                                    |
| Fix for a confirmed critical issue | we aim for 30 days, and will tell you if we cannot meet it |

We will keep you informed while the advisory is open, and credit you in it
unless you ask us not to.

Please give us a reasonable chance to ship a fix before disclosing publicly.

## Supported versions

Only the current `main` branch receives security fixes. This repository has no
tagged releases yet, so please report against a commit SHA rather than a
version number.

## Scope

In scope:

- Electron process configuration — `contextIsolation`, `nodeIntegration`,
  `sandbox`, `webSecurity`, the Content Security Policy, and anything reachable
  from document content.
- The preload surface and the IPC handlers it exposes.
- Authentication, session handling and token storage in the client.
- Sealed document (`.sddoc`) encryption and access control, as implemented in
  the client.
- Dependency vulnerabilities that are reachable from client code.

Out of scope:

- **The server side.** The API bridge is a separate, closed-source component.
  It is outside this repository's trust boundary; report issues you believe are
  server-side through the same advisory form and say so, and we will route them.
- Vulnerabilities in vendored third-party libraries that are unmodified here —
  report those upstream, and tell us so we can pick up the fix.
- Findings with no security impact: style, performance, or crashes that are not
  exploitable.
- Reports produced solely by an automated scanner, with no analysis of
  reachability in this codebase.

## Known posture

The Electron hardening work on this client is in progress and tracked
internally. If you are looking at the main process and preload configuration
and it surprises you, you are probably right; a report that explains a concrete
exploitation path is still useful to us and will be treated as in scope.

## Known dependency advisories

`npm audit` still reports these. They have no drop-in fix and are accepted
until the work below lands; the `Security` workflow gates on `critical` only
because of them.

| Dependency               | Severity | Why it is not fixed yet                                                                                                                                               |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron` 40.x          | high     | Out of support; the fix is a major upgrade (45.x) that needs manual validation of native modules, signing and auto-update. Dependabot will not propose it.            |
| `xlsx` 0.18.5            | high     | Reachable: parses user-supplied spreadsheets. The fixed release is only published on cdn.sheetjs.com, not on npm.                                                     |
| `dree` → `minimatch` 10  | moderate | ReDoS in glob matching. `dree` is not imported anywhere in the client; it should be removed rather than overridden, since minimatch 11 dropped the `makeRe` it calls. |
| `katex`, `mermaid`       | low      | Fixed only in a major release.                                                                                                                                        |
| `electron-builder` chain | moderate | Build-time only, not reachable from the client.                                                                                                                       |

### `xlsx` (SheetJS)

`xlsx` is only used to read files the user opens or imports, in
`ReactSpreadsheetFileViewer.tsx` (opening a spreadsheet) and
`spreadsheetExchange.service.ts` (importing into a sheet). It is reached in
two cases: converting a legacy `.xls` file to `.xlsx` before
`@corbe30/fortune-excel` reads it, and a values-only fallback when
fortune-excel (exceljs) fails on an `.xlsx` or `.csv` file. Exports go through
fortune-excel and exceljs, not `xlsx`. A crafted file can therefore reach the
prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9)
advisories.

exceljs cannot replace it: it is already the primary parser, and it cannot
read `.xls`. The fix is SheetJS's own 0.20.3 build, which keeps the same API:

```sh
npm install --save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

`npm ci` then downloads it from `cdn.sheetjs.com`, so that host must be
reachable from CI, the web image build and contributors' machines first.
