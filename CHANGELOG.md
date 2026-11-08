# Changelog

## 0.1.0

- First release: live Swagger UI and reference layouts for OpenAPI 3.1, 3.0 and Swagger 2.0 (YAML and JSON).
- External and local `$ref` across files, read from the workspace only, with a list of refs that cannot be loaded.
- Updates while typing and when a referenced file is saved. Several previews at once.
- Problem list with file and line, also in the Problems panel.
- Large specs parse in a background thread; the reference layout draws one operation at a time.
- No network: remote refs only after a click, Try it out off by default.
- Rating ask (once, after a few files on different days), support links and related Zovo tools.
