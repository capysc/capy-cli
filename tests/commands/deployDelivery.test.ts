import { describe, test, expect, mock } from 'bun:test';
import {
  LETTER_FIRST_NAME_PLATFORMS,
  deliveryPlanFor,
  fetchDeliveryInstructions,
  terminalDeliveryLines,
} from '../../src/commands/deployTokenCommand';
import { generateDeployHtml } from '../../src/ui/deployPage/html';

// A platform whose variable names must start with a letter (Netlify documents this: a key's first
// character must be a letter, and `_KEY1` is its own example of an invalid key) cannot hold an
// underscore-led name. It is delivered the same random per-deploy key under SECRETS_BLOB + PROJECT_KEY.

const BLOB = 'QkxPQg==';
const KEY = 'ab'.repeat(32);

describe('deliveryPlanFor', () => {
  test('the letter-first list is just netlify today', () => {
    expect(LETTER_FIRST_NAME_PLATFORMS).toEqual(['netlify']);
  });

  test('netlify: the older names, and instructions requested without the query', () => {
    expect(deliveryPlanFor('netlify')).toEqual({
      blobName: 'SECRETS_BLOB',
      keyName: 'PROJECT_KEY',
      instructionsGeneration: undefined,
    });
  });

  test.each(['vercel', 'github-actions', 'fly', 'other', 'unknown-platform'])(
    '%s: the new names, and instructions requested for deploy_key',
    (platform) => {
      expect(deliveryPlanFor(platform)).toEqual({
        blobName: '_SECRETS_BLOB',
        keyName: '_DEPLOY_KEY',
        instructionsGeneration: 'deploy_key',
      });
    },
  );
});

describe('fetchDeliveryInstructions', () => {
  const fakeService = () => {
    const fetchDeployInstructions = mock(async (platform: string, _generation?: 'deploy_key' | 'project_key') => ({
      platform,
      markdown: 'md',
    }));
    return { service: { fetchDeployInstructions }, calls: () => fetchDeployInstructions.mock.calls };
  };

  test('netlify asks WITHOUT the credential_generation query (argument absent, not null or empty)', async () => {
    const { service, calls } = fakeService();
    await fetchDeliveryInstructions(service, 'netlify');
    expect(calls()).toHaveLength(1);
    expect(calls()[0][0]).toBe('netlify');
    expect(calls()[0][1]).toBeUndefined();
  });

  test('any other platform asks for deploy_key', async () => {
    const { service, calls } = fakeService();
    await fetchDeliveryInstructions(service, 'vercel');
    expect(calls()[0]).toEqual(['vercel', 'deploy_key']);
  });
});

describe('what the walkthrough shows', () => {
  const html = (platform: string) => {
    const plan = deliveryPlanFor(platform);
    return generateDeployHtml(BLOB, KEY, platform, platform, 'instructions', [plan.blobName, plan.keyName]);
  };

  test('netlify page labels the two values SECRETS_BLOB and PROJECT_KEY, and never the underscore names', () => {
    const page = html('netlify');
    expect(page).toContain('>SECRETS_BLOB</label>');
    expect(page).toContain('>PROJECT_KEY</label>');
    expect(page).not.toContain('_DEPLOY_KEY');
    expect(page).not.toContain('>_SECRETS_BLOB<');
    expect(page).toContain(KEY);
  });

  test('other platforms label them _SECRETS_BLOB and _DEPLOY_KEY', () => {
    const page = html('vercel');
    expect(page).toContain('>_SECRETS_BLOB</label>');
    expect(page).toContain('>_DEPLOY_KEY</label>');
    expect(page).not.toContain('>PROJECT_KEY<');
  });

  test('the page defaults to the new names', () => {
    expect(generateDeployHtml(BLOB, KEY, 'X', 'other', 'md')).toContain('>_DEPLOY_KEY</label>');
  });

  test('the terminal fallback prints each value under the names of its platform', () => {
    const netlify = terminalDeliveryLines(deliveryPlanFor('netlify'), BLOB, KEY, 'Netlify');
    expect(netlify).toContain('  SECRETS_BLOB:');
    expect(netlify).toContain('  PROJECT_KEY:');
    expect(netlify).toContain(`  ${KEY}`);
    expect(netlify.join('\n')).not.toContain('_DEPLOY_KEY');

    const vercel = terminalDeliveryLines(deliveryPlanFor('vercel'), BLOB, KEY, 'Vercel');
    expect(vercel).toContain('  _SECRETS_BLOB:');
    expect(vercel).toContain('  _DEPLOY_KEY:');
  });
});
