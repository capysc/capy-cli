/**
 * `buildDeployKeepFromHashes` / `foldDeployKeep` (CAP-704): the batch deploy keeps only the hashes
 * of the values it pushed, and must write exactly the keep.lock `buildDeployKeep` writes from the
 * values themselves.
 */
import { describe, test, expect } from 'bun:test';
import { buildDeployKeep, buildDeployKeepFromHashes, foldDeployKeep, hashValue } from '../../src/deploy/keepGate';
import { serializeKeep } from '../../src/files/fileManager';
import { dokployTarget, serverKeepFor } from '../helpers/batchDeployWorld';
import { deliveryFor } from '../../src/deploy/deliveryRecord';

const AT = '2026-10-04T10:00:00.000Z';
const values = { API_KEY: 'value-one', DB_URL: 'value-two' };
const hashes = { API_KEY: hashValue(values.API_KEY), DB_URL: hashValue(values.DB_URL) };
const target = dokployTarget('api');
const { delivery } = deliveryFor(target, { id: 'dokploy' }, undefined, false, hashes);
const base = serverKeepFor('pA', 'staging');

describe('the hash-only fold writes the same keep.lock as the value fold', () => {
  test('with a delivery', () => {
    const fromValues = buildDeployKeep(base, values, target.vars, 'staging', delivery, AT);
    const fromHashes = buildDeployKeepFromHashes(base, hashes, target.vars, 'staging', delivery, AT);
    expect(fromHashes).toEqual(fromValues);
    expect(fromHashes.changed).toBe(true);
  });

  test('without a delivery, and a variable with no hash is skipped like one with no value', () => {
    const fromValues = buildDeployKeep(base, { API_KEY: values.API_KEY }, target.vars, 'staging', undefined, AT);
    const fromHashes = buildDeployKeepFromHashes(base, { API_KEY: hashes.API_KEY }, target.vars, 'staging', undefined, AT);
    expect(fromHashes).toEqual(fromValues);
  });

  test('foldDeployKeep is the keep itself, and serializes to the same text', () => {
    const keep = foldDeployKeep(base, hashes, target.vars, 'staging', delivery, AT);
    expect(serializeKeep(keep)).toBe(buildDeployKeepFromHashes(base, hashes, target.vars, 'staging', delivery, AT).content);
    // The base is never modified.
    expect(JSON.stringify(base)).toBe(JSON.stringify(serverKeepFor('pA', 'staging')));
  });
});
