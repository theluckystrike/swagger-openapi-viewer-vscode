'use strict';
// Writes a generated OpenAPI 3.0 spec of about 20,000 lines (300 paths, 600 operations, 150 schemas) for the
// large-file gate. usage: node scripts/make_large.js <out.yaml> [paths]
const fs = require('fs');
const out = process.argv[2];
const N = Number(process.argv[3] || 300);
const L = ['openapi: 3.0.3', 'info:', '  title: Generated Large API', '  version: 1.0.0', '  description: A generated spec with ' + N + ' paths for the large-file test.', 'servers:', '  - url: https://large.example.com/v1', 'paths:'];
for (let i = 0; i < N; i++) {
  const s = 'Item' + (i % 150);
  L.push(`  /resource${i}/{id}:`, '    parameters:', '      - name: id', '        in: path', '        required: true', '        schema:', '          type: string');
  for (const m of ['get', 'put']) {
    L.push(`    ${m}:`, `      tags: [group${i % 25}]`, `      summary: ${m === 'get' ? 'Read' : 'Replace'} resource ${i}`, `      operationId: ${m}Resource${i}`,
      '      parameters:', '        - name: expand', '          in: query', '          description: Related objects to include.', '          schema:', '            type: array', '            items:', '              type: string');
    if (m === 'put') L.push('      requestBody:', '        required: true', '        content:', '          application/json:', '            schema:', `              $ref: '#/components/schemas/${s}'`);
    L.push('      responses:', "        '200':", '          description: OK', '          content:', '            application/json:', '              schema:', `                $ref: '#/components/schemas/${s}'`,
      "        '404':", '          description: Not found', "        '429':", '          description: Too many requests');
  }
}
L.push('components:', '  schemas:');
for (let j = 0; j < 150; j++) {
  L.push(`    Item${j}:`, '      type: object', '      required: [id, name]', '      properties:', '        id:', '          type: string', '          format: uuid', '        name:', '          type: string', '          maxLength: 120',
    '        createdAt:', '          type: string', '          format: date-time', '        count:', '          type: integer', '          minimum: 0', '        tags:', '          type: array', '          items:', '            type: string',
    '        owner:', `          $ref: '#/components/schemas/Item${(j + 1) % 150}'`);
}
fs.writeFileSync(out, L.join('\n') + '\n');
console.log(out, L.length, 'lines', fs.statSync(out).size, 'bytes');
