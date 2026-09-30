import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SYSTEM_PROJECT_NAME,
  isReservedProjectName,
  excludeSystemProject,
  assertProjectNameAllowed,
} from '../../src/system/reservedProjectName';
import { ProjectManager } from '../../src/core/projectManager';
import { CapyError, ERROR_CODES } from '../../src/types/index';

describe('reservedProjectName', () => {
  it('is case-insensitive and trims', () => {
    for (const candidate of ['_system', '_System', '_SYSTEM', ' _system ', '\t_system\n']) {
      expect(isReservedProjectName(candidate)).toBe(true);
    }
    for (const candidate of ['system', 'my-system', '_systems', '__system', '']) {
      expect(isReservedProjectName(candidate)).toBe(false);
    }
  });

  it('assertProjectNameAllowed throws a typed PROJECT_NAME_RESERVED error only for the reserved name', () => {
    expect(() => assertProjectNameAllowed('my-project')).not.toThrow();
    expect(() => assertProjectNameAllowed('_system')).toThrow();
    try {
      assertProjectNameAllowed('_System');
    } catch (err) {
      expect(err).toBeInstanceOf(CapyError);
      expect((err as CapyError).code).toBe(ERROR_CODES.PROJECT_NAME_RESERVED);
    }
  });

  it('excludeSystemProject drops only the reserved-name entry, case-insensitively, from a listing', () => {
    const projects = [
      { id: '1', name: 'alpha' },
      { id: '2', name: '_system' },
      { id: '3', name: 'beta' },
      { id: '4', name: '_System' },
    ];
    expect(excludeSystemProject(projects).map((p) => p.id)).toEqual(['1', '3']);
  });

  it('excludeSystemProject is a no-op when there is nothing reserved to drop', () => {
    const projects = [{ id: '1', name: 'alpha' }, { id: '2', name: 'beta' }];
    expect(excludeSystemProject(projects)).toEqual(projects);
  });
});

describe('ProjectManager.getDefaultProjectName never suggests the reserved name', () => {
  it('a folder literally named "_system" does not default to it', () => {
    const parent = mkdtempSync(join(tmpdir(), 'capy-reserved-name-test-'));
    const dir = join(parent, SYSTEM_PROJECT_NAME);
    require('fs').mkdirSync(dir);
    try {
      const pm = new ProjectManager(dir);
      const defaultName = pm.getDefaultProjectName();
      expect(isReservedProjectName(defaultName)).toBe(false);
      expect(defaultName).toBe('my-project');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('a folder named "_System" (mixed case) also does not default to the reserved name', () => {
    const parent = mkdtempSync(join(tmpdir(), 'capy-reserved-name-test-'));
    const dir = join(parent, '_System');
    require('fs').mkdirSync(dir);
    try {
      const pm = new ProjectManager(dir);
      expect(isReservedProjectName(pm.getDefaultProjectName())).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('an ordinary folder name is unaffected', () => {
    const parent = mkdtempSync(join(tmpdir(), 'capy-reserved-name-test-'));
    const dir = join(parent, 'My Cool Project');
    require('fs').mkdirSync(dir);
    try {
      const pm = new ProjectManager(dir);
      expect(pm.getDefaultProjectName()).toBe('my-cool-project');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
