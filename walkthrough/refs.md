# Split specs

A `$ref` such as `paths/pets.yaml` or `../schemas/pet.yaml#/Pet` is read from your workspace. Files outside the workspace are not read.

- Save a referenced file and the preview updates.
- A ref that cannot be loaded is listed in Problems with the reason.
- `http(s)` refs load only after you click Load remote refs for that file.
