/**
 * The plan file `capy deploy dokploy --discover --plan <file>` reads, as a JSON
 * Schema. Published in `capy help --json` under `schemas.deploy_dokploy_plan`
 * (see `core/cliHelpDoc.ts`), which is where `--discover`'s `plan_schema_ref`
 * points.
 *
 * IDs and names only: a plan never carries a value.
 */

/** Where the schema is published: a pointer into the `capy help --json` document. */
export const PLAN_SCHEMA_REF = { command: 'capy help --json', pointer: '/schemas/deploy_dokploy_plan' } as const;

export const DEPLOY_DOKPLOY_PLAN_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'capy deploy dokploy --discover plan',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'entries'],
  properties: {
    version: { const: 1 },
    entries: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['project_id', 'branch', 'service_id', 'git_branch', 'vars'],
        properties: {
          project_id: { type: 'string', minLength: 1, description: 'Capy project id' }, // COPY-FLAG
          branch: { type: 'string', minLength: 1, description: 'Capy branch the target ships from' }, // COPY-FLAG
          service_id: { type: 'string', minLength: 1, description: 'Dokploy application or compose service id' }, // COPY-FLAG
          git_branch: { type: 'string', minLength: 1, description: 'git branch the Dokploy service tracks (the CI deploy PR base)' }, // COPY-FLAG
          vars: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
            description: 'Variable names the target delivers; each must exist on the Capy branch', // COPY-FLAG
          },
        },
      },
    },
  },
} as const;
