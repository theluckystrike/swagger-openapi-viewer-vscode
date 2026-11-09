# Convert, bundle and compare

Right-click in a spec and open the OpenAPI menu.

- Convert Swagger 2.0 to OpenAPI 3.0, and Convert to OpenAPI 3.1: `nullable` becomes a type list, `example` becomes `examples`, and so on.
- Bundle $refs into one file: a spec split over many files becomes one file.
- Compare versions: a list of the changes that can break a client, against a git ref or another file.

Every change opens as a diff first. Nothing is written until you choose Save as or Replace.
