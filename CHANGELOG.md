# Changelog

## 0.2.0

- Now an editor: lint with readable rules (Spectral OpenAPI rule names) in the Problems panel, also with the preview closed. Quick fixes add a missing operationId, summary or description, remove an unused component, fix a $ref that points nowhere, or turn a rule off. A .spectral.yaml sets rule severities.
- IntelliSense for 2.0, 3.0 and 3.1 keys and values, $ref completion across files, go to definition, hover, rename a schema with every $ref to it, and an outline.
- The preview follows the cursor, and a click on an operation or schema in the preview moves the cursor to its line. Both layouts.
- Convert Swagger 2.0 to OpenAPI 3.0 and 3.0 to 3.1, bundle a split spec into one file, and compare versions (breaking-change report against a git ref or a file). Every change opens as a diff first.
- Mock server on 127.0.0.1 and client code for an operation in 10 languages.
- Try it out sends only to hosts on openapiViewer.tryItOutAllowedHosts (local hosts by default) and only after you confirm.
- New name: Swagger Editor & OpenAPI Editing (Lint, Spec Preview, 3.1). The extension id is the same.
- Rating ask v2.1, support links with Rate first, related tools (Load Testing, HAR Viewer).
- Hover, go to definition and rename do not read a file through a symlink that leads out of the workspace (the preview already refused it).

## 0.1.1

- Marketplace tags: the keyword "$ref" was removed, because the Marketplace does not accept a tag that starts with "$". No other change.

## 0.1.0

- First release: live Swagger UI and reference layouts for OpenAPI 3.1, 3.0 and Swagger 2.0 (YAML and JSON).
- External and local `$ref` across files, read from the workspace only, with a list of refs that cannot be loaded.
- Updates while typing and when a referenced file is saved. Several previews at once.
- Problem list with file and line, also in the Problems panel.
- Large specs parse in a background thread; the reference layout draws one operation at a time.
- No network: remote refs only after a click, Try it out off by default.
- Rating ask (once, after a few files on different days), support links and related Zovo tools.
