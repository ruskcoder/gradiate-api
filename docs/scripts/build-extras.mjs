/**
 * Derived artifacts built from the generated OpenAPI spec:
 *   public/llms.txt                       plain-text API summary for LLM tools
 *   public/gradexis.postman_collection.json   Postman v2.1 collection
 * Run after build-openapi.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const spec = JSON.parse(fs.readFileSync(path.join(root, 'src/generated/openapi.json'), 'utf8'));
const platforms = spec['x-platforms'];
const operations = spec['x-operations'];

// ---------------------------------------------------------------- llms.txt
const llms = [
  `# ${spec.info.title}`,
  '',
  `> ${spec.info.summary}`,
  '',
  spec.info.description,
  '',
  '## Conventions',
  '',
  '- All routes are POST with a JSON body, mounted per platform: ' + platforms.map((p) => `\`${p.mount}\``).join(', ') + '.',
  '- Body: `{ loginType, loginData, session?, options?, stream? }`.',
  '- Success: `{ success: true, ...data, session }`. Send `session` back on the next call (reused if validated <5 min ago; expired sessions re-login automatically using loginData).',
  '- Errors: `{ success: false, status, message }` with 400/401/404/429/500.',
  '- `stream: true` returns `{"percent","message"}` chunks separated by blank lines, then the final JSON.',
  '- ClassLink 2FA: login returns 200 `{ success:false, mfaRequired, mfaType, icons, session }`; retry with that session and `loginData.clMFA`.',
  '- Full spec: /openapi.json',
  '',
  '## Platforms',
  '',
  ...platforms.flatMap((p) => [
    `### ${p.name} (\`${p.mount}\`)`,
    '',
    p.summary,
    '',
    `Login types: ${p.loginTypes.join(', ')}`,
    '',
    ...p.notes.map((n) => `- ${n}`),
    '',
  ]),
  '## Endpoints',
  '',
  ...operations.map((o) => {
    const on = o.platforms.map((id) => platforms.find((p) => p.id === id).mount + o.path).join(', ');
    return `- **${o.title}** (${on}): ${o.summary}`;
  }),
  '',
].join('\n');

// ---------------------------------------------------------------- Postman
const collection = {
  info: {
    name: spec.info.title,
    description: spec.info.description,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'username', value: '' },
    { key: 'password', value: '' },
  ],
  item: platforms.map((p) => ({
    name: p.name,
    description: p.summary,
    item: Object.entries(spec.paths)
      .filter(([, item]) => item.post['x-platform'] === p.id)
      .map(([route, item]) => {
        const example = structuredClone(item.post.requestBody.content['application/json'].example);
        if (example.loginData) {
          example.loginData.username = '{{username}}';
          example.loginData.password = '{{password}}';
        }
        return {
          name: operations.find((o) => o.key === item.post['x-operation'])?.title ?? route,
          request: {
            method: 'POST',
            description: item.post.description,
            header: [{ key: 'Content-Type', value: 'application/json' }],
            url: { raw: `{{baseUrl}}${route}`, host: ['{{baseUrl}}'], path: route.split('/').filter(Boolean) },
            body: { mode: 'raw', raw: JSON.stringify(example, null, 2), options: { raw: { language: 'json' } } },
          },
        };
      }),
  })),
};

fs.writeFileSync(path.join(root, 'public/llms.txt'), llms);
fs.writeFileSync(path.join(root, 'public/gradexis.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n');
console.log('llms.txt + postman collection written');
