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

/** Where the Vercel plan's schema is published (`capy deploy vercel --discover`). */
export const VERCEL_PLAN_SCHEMA_REF = { command: 'capy help --json', pointer: '/schemas/deploy_vercel_plan' } as const;

/**
 * The plan `capy deploy vercel --discover --plan <file>` reads: the same shape as the Dokploy plan, with the
 * service named by the `service_id` of a Vercel environment (project + environment) from the discovery facts,
 * and `git_branch` the project's production branch (the deploy PR base). IDs and names only.
 */
export const DEPLOY_VERCEL_PLAN_SCHEMA = {
  ...DEPLOY_DOKPLOY_PLAN_SCHEMA,
  title: 'capy deploy vercel --discover plan', // COPY-FLAG
  properties: {
    ...DEPLOY_DOKPLOY_PLAN_SCHEMA.properties,
    entries: {
      ...DEPLOY_DOKPLOY_PLAN_SCHEMA.properties.entries,
      items: {
        ...DEPLOY_DOKPLOY_PLAN_SCHEMA.properties.entries.items,
        properties: {
          ...DEPLOY_DOKPLOY_PLAN_SCHEMA.properties.entries.items.properties,
          service_id: { type: 'string', minLength: 1, description: 'Vercel environment id from the discovery facts (a project plus one of its environments)' }, // COPY-FLAG
          git_branch: { type: 'string', minLength: 1, description: 'git branch the Vercel project deploys from (the CI deploy PR base)' }, // COPY-FLAG
        },
      },
    },
  },
} as const;
