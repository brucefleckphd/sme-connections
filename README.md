# SME Connections

Public, code-only repository for the network-first SME Connections mock dashboard.

## Data is intentionally excluded

This repository contains application code, a standard-library workbook builder, regression tests, and the vendored vis-network library with its licenses. It contains no physician dataset, source workbook, screenshots, or saved browser evidence.

Real physician names and attributes must remain in approved internal storage. Repository visibility does not authorize uploading internal data. Do not force-add ignored data or evidence files.

## Run locally

Obtain the source workbook through an approved internal channel. Build the local dataset before opening the dashboard.

```sh
python3 build/build_data.py /approved/local/path/Global-CP-Advocates-Reformatted.xlsx
```

The workbook argument names your existing file. The builder writes ignored `data/graph.js`. Then double-click `index.html` in a modern browser. The dashboard itself needs no server, Python, installation, or internet once that local data has been built.

Python 3.8 or later is needed only for rebuilding data. The builder uses the standard library.

## Dashboard

- Network-first workspace in the Cook palette.
- Four overview relationship layers, visible filters, reset, zoom, fit, and navigation history.
- Full physician briefings with source engagement evidence and paths to starred physicians.
- Independent browser star storage in `smeConnections.alternative.myNetwork`.
- Clearly marked fictional competitor trials enabled by default, with a complete hide toggle.
- Recorded routes within three physician hops take precedence over shorter fictional routes.
- Exploratory investigator, speaker, and advisory candidate lists with reasons and explicit limits.
- Runtime assets are local and outbound connections are blocked by content security policy.

The overview is a bounded sample, not the whole network. Shared institution or study records show overlap, not proof that physicians know each other. VISTA participation does not establish career stage. Scenario lists do not qualify sites, establish speaker suitability, or optimize an advisory panel.

## Test

The workbook-based tests use the original source workbook locally. No physician name is hardcoded into the committed tests. Test output and screenshots remain ignored.

```sh
SME_XLSX=/approved/local/path/workbook.xlsx python3 -m unittest discover -s tests
node --check app.js
```

Browser tests additionally require Node, Playwright, installed Chrome, and a prebuilt local `data/graph.js`. These are development requirements, not dashboard runtime requirements.

```sh
SME_PLAYWRIGHT=/path/to/node_modules/playwright node tests/browser_tests.cjs
```

Set `SME_BROWSER` to your installed Chrome path if it is not `/usr/bin/google-chrome`. Set `TMPDIR` to an approved local scratch directory. Browser tests use `file://` with browser offline mode, reject HTTP and HTTPS, and save internal-only evidence under ignored `verification/`.

## Moving to another machine

Clone this repository, transfer the workbook using an approved internal method, and run the builder with the local workbook path. Alternatively, copy a complete working runtime folder through an approved internal channel. Do not transfer the dataset through GitHub.

## Presentation gates

Linux Chrome and offline copied-folder operation have been tested. Actual Mac and browser rehearsal remains required. Governance approval for the real-name presentation audience is a separate requirement.

## Version preservation

This repository publishes the new network-first alternative only. The original v1.1 and complete working alternative remain saved separately on the originating machine.

## Library license

Vendored vis-network retains its MIT and Apache-2.0 license files in `vendor/`. This repository does not grant rights to distribute internal source data.
