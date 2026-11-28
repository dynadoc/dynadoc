# Import report

After an Office file is imported, Dynadoc can say what came through as it
was, what was approximated and what was lost. This page describes the report
every converter produces, so the in-app .xlsx import, the Word converter
(`bin/DocxToHtml`, #142) and the API bridge can all write the same thing and
the app can read any of them.

Code: `src/renderer/src/services/conversion/importFidelity.ts` (types, the
collector, the reader), `xlsxImportFidelity.ts` and `xlsxImport.ts` (the .xlsx
producer), `importFidelityToast.ts` (the panel). Test:
`tests/smoke/xlsx-import-fidelity.test.mjs`.

## Shape (version 1)

```json
{
  "version": 1,
  "source": { "name": "Budget.xlsx", "kind": "xlsx", "sha256": "9f2c..." },
  "unavailable": [],
  "items": [
    { "kind": "formulas", "status": "converted", "count": 12 },
    {
      "kind": "formulas",
      "status": "lost",
      "count": 1,
      "reason": "formulas that read another workbook are replaced by their last value",
      "places": [{ "sheet": "Summary", "cell": "A4" }]
    },
    {
      "kind": "charts",
      "status": "lost",
      "count": 2,
      "reason": "charts are not converted",
      "places": [{ "part": "xl/charts/chart1.xml" }, { "part": "xl/charts/chart2.xml" }]
    }
  ]
}
```

- `version`: 1. A reader refuses any other version (`parseImportFidelityReport`
  returns null) rather than guess.
- `source.kind`: `xlsx`, `xls`, `csv`, `docx` or `pptx`. `sha256` of the bytes
  imported, when the producer can compute it.
- `unavailable`: why the report may be incomplete, one sentence each: a step
  that failed, or a file converted before the import (an `.xls` goes through
  SheetJS first, and what that conversion drops cannot be listed). Empty when
  the report covers the whole file.
- `items`: one entry per kind, status and reason. `count` is the total;
  `places` lists at most 100 of them (`sheet`, `cell`, `part`, whichever
  apply).

## Statuses

- `converted`: in the document as it was in the file.
- `approximated`: shown or computed differently in Dynadoc, and written back as
  it was when the document is exported or saved to the Office format. Example:
  a formula that uses a defined name computes with the name written out, and
  the export writes `=B1*TauxTVA` and the name back.
- `lost`: not in the document, and not in a file exported or saved from it.

A save over the original file asks first when anything is `lost` or the
report is incomplete (`needsSaveConfirmation`). The panel after an import is
shown only when something is approximated or lost, or the report is
incomplete (`hasFidelityLoss`).

## Kinds

`formulas`, `definedNames`, `comments`, `images`, `shapes`, `textBoxes`,
`formControls`, `charts`, `tables`, `dataValidation`, `conditionalFormatting`,
`autoFilter`, `frozenPanes`, `printSettings`, `sparklines`, `slicers`,
`pivotCaches`, `externalLinks`, `protection`, `macros`, `otherParts` (a
package part the producer does not recognise, reported so the save warning
fails safe).

A producer may add a kind. A reader must keep items whose kind it does not
know and show them by their key.

## What the .xlsx import keeps aside

fortune-sheet has no named ranges, array formulas or workbook-level data, so
the import keeps them in extra cell keys, which fortune-sheet keeps through
edits and the saved snapshot:

- `xlsxFormula` and `xlsxNames` on a cell whose formula uses defined names:
  the user's formula and the names it uses;
- `xlsxArray` on the first cell of an array formula: its range;
- `xlsxWorkbook` on the first sheet's A1: every defined name of the workbook
  (print areas and names used only by validation lists or charts included).

The export (`restoreXlsxExport`) writes them back, unless the formula was
edited since. Clearing A1 with Delete removes the kept name list.

## Not done yet

- The report is not stored with the document, so it cannot be opened again
  after the panel is closed.
- The formula bar shows the formula with names written out, and a formula
  typed with a name gives `#NAME?`.
- The Word converter does not produce a report (#142).
