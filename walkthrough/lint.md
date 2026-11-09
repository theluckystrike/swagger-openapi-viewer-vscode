# Lint with rules you can read

Each problem names its rule, for example `operation-operationId` or `oas3-unused-component`, and says what to change.

Quick fixes (Ctrl+. or Cmd+.):

- add a missing `operationId`, `summary` or `description`
- remove an unused component
- replace a `$ref` that points to nothing with the closest existing name
- turn a rule off in `.spectral.yaml`

A `.spectral.yaml` in the workspace folder sets the severity of each rule:

```yaml
extends: ["spectral:oas"]
rules:
  operation-description: off
  info-contact: warn
```
