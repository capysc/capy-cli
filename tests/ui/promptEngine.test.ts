import { jest } from '@jest/globals';
import inquirer from 'inquirer';
import { PromptEngine } from '../../src/ui/promptEngine';

// Mock inquirer
jest.mock('inquirer');
const mockInquirer = inquirer as jest.Mocked<typeof inquirer>;

describe('PromptEngine', () => {
  let promptEngine: PromptEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    promptEngine = new PromptEngine();
  });

  describe('promptForProjectName', () => {
    test('should prompt for project name with default', async () => {
      mockInquirer.prompt.mockResolvedValue({ projectName: 'my-project' });

      const result = await promptEngine.promptForProjectName('default-project');

      expect(mockInquirer.prompt).toHaveBeenCalledWith([
        {
          type: 'input',
          name: 'projectName',
          message: '📁 Project name (default: "default-project"):',
          default: 'default-project',
          validate: expect.any(Function)
        }
      ]);
      
      expect(result).toBe('my-project');
    });

    test('should validate project name input', async () => {
      mockInquirer.prompt.mockResolvedValue({ projectName: 'valid-project' });

      await promptEngine.promptForProjectName('default');

      const validateFn = (mockInquirer.prompt as any).mock.calls[0][0][0].validate;

      // Test empty input
      expect(validateFn('')).toBe('Project name cannot be empty');
      expect(validateFn('   ')).toBe('Project name cannot be empty');

      // Test invalid characters
      expect(validateFn('project with spaces')).toBe('Project name can only contain letters, numbers, hyphens, and underscores');
      expect(validateFn('project@special')).toBe('Project name can only contain letters, numbers, hyphens, and underscores');

      // Test valid inputs
      expect(validateFn('valid-project')).toBe(true);
      expect(validateFn('valid_project')).toBe(true);
      expect(validateFn('ValidProject123')).toBe(true);
      expect(validateFn('valid-project_123')).toBe(true);
    });
  });

  describe('promptForChanges', () => {
    const mockChangeSet = {
      newLocal: [
        { name: 'LOCAL_VAR1', value: 'local_value1', source: 'local' as const, encrypted: false },
        { name: 'LOCAL_VAR2', value: 'local_value2', source: 'local' as const, encrypted: false }
      ],
      newRemote: [
        { name: 'REMOTE_VAR1', value: 'remote_value1', source: 'remote' as const, encrypted: false },
        { name: 'REMOTE_VAR2', value: 'remote_value2', source: 'remote' as const, encrypted: false }
      ],
      conflicts: [
        { name: 'CONFLICT_VAR', localValue: 'local_conflict', remoteValue: 'remote_conflict' }
      ],
      unchanged: [],
        deleted: [],
        deletedLocal: []
    };

    beforeEach(() => {
      // Mock console.log to prevent output during tests
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      (console.log as jest.Mock).mockRestore();
    });

    test('should handle new local variables', async () => {
      const changeSet = {
        newLocal: [{ name: 'NEW_LOCAL', value: 'local_val', source: 'local' as const, encrypted: false }],
        newRemote: [],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      // First prompt asks "Push all?", second asks for individual variable
      mockInquirer.prompt
        .mockResolvedValueOnce({ pushAll: false })  // Don't push all
        .mockResolvedValueOnce({ push: true });      // Push this one

      const spyDisplayTable = jest.spyOn(promptEngine as any, 'displayVariableTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(changeSet);

      expect(spyDisplayTable).toHaveBeenCalledWith(changeSet.newLocal);
      expect(result.pushVariables).toEqual(['NEW_LOCAL']);

      spyDisplayTable.mockRestore();
    });

    test('should handle new remote variables with pull all option', async () => {
      const changeSet = {
        newLocal: [],
        newRemote: [
          { name: 'REMOTE1', value: 'val1', source: 'remote' as const, encrypted: false },
          { name: 'REMOTE2', value: 'val2', source: 'remote' as const, encrypted: false }
        ],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      mockInquirer.prompt.mockResolvedValueOnce({ pullAll: true });

      const spyDisplayTable = jest.spyOn(promptEngine as any, 'displayVariableTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(changeSet);

      // Test that the prompt was called correctly and basic functionality works
      expect(mockInquirer.prompt).toHaveBeenCalledWith([
        {
          type: 'confirm',
          name: 'pullAll',
          message: 'Pull all remote variables?',
          default: true
        }
      ]);

      spyDisplayTable.mockRestore();
    });

    test('should handle new remote variables with individual selection', async () => {
      const changeSet = {
        newLocal: [],
        newRemote: [
          { name: 'REMOTE1', value: 'val1', source: 'remote' as const, encrypted: false },
          { name: 'REMOTE2', value: 'val2', source: 'remote' as const, encrypted: false }
        ],
        conflicts: [],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      mockInquirer.prompt
        .mockResolvedValueOnce({ pullAll: false })
        .mockResolvedValueOnce({ pull: true })
        .mockResolvedValueOnce({ pull: false });

      const spyDisplayTable = jest.spyOn(promptEngine as any, 'displayVariableTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(changeSet);

      expect(result.pullVariables).toEqual(['REMOTE1']);

      spyDisplayTable.mockRestore();
    });

    test('should handle conflicts with local resolution', async () => {
      const changeSet = {
        newLocal: [],
        newRemote: [],
        conflicts: [{ name: 'CONFLICT_VAR', localValue: 'local_val', remoteValue: 'remote_val' }],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      // Phase 1: resolve as local, Phase 2: push
      mockInquirer.prompt
        .mockResolvedValueOnce({ resolution: 'local' })
        .mockResolvedValueOnce({ push: true });

      const spyDisplayConflictTable = jest.spyOn(promptEngine as any, 'displayConflictTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(changeSet);

      expect(result.keepLocal).toEqual(['CONFLICT_VAR']);
      expect(result.pushVariables).toEqual(['CONFLICT_VAR']);

      spyDisplayConflictTable.mockRestore();
    });

    test('should handle conflicts with remote resolution', async () => {
      const changeSet = {
        newLocal: [],
        newRemote: [],
        conflicts: [{ name: 'CONFLICT_VAR', localValue: 'local_val', remoteValue: 'remote_val' }],
        unchanged: [],
        deleted: [],
        deletedLocal: []
      };

      mockInquirer.prompt.mockResolvedValueOnce({ resolution: 'remote' });

      const spyDisplayConflictTable = jest.spyOn(promptEngine as any, 'displayConflictTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(changeSet);

      expect(result.keepRemote).toEqual(['CONFLICT_VAR']);

      spyDisplayConflictTable.mockRestore();
    });

    test('should handle complex scenario with all change types', async () => {
      mockInquirer.prompt
        // New local variables - asks "Push all?" first, then individual
        .mockResolvedValueOnce({ pushAll: false })
        .mockResolvedValueOnce({ push: true })    // LOCAL_VAR1
        .mockResolvedValueOnce({ push: false })   // LOCAL_VAR2
        // New remote variables - asks "Pull all?" first, then individual
        .mockResolvedValueOnce({ pullAll: false })
        .mockResolvedValueOnce({ pull: true })    // REMOTE_VAR1
        .mockResolvedValueOnce({ pull: false })   // REMOTE_VAR2
        // Conflicts - resolution choice, then push choice if local
        .mockResolvedValueOnce({ resolution: 'local' })
        .mockResolvedValueOnce({ pushLocal: false });

      const spyDisplayVariableTable = jest.spyOn(promptEngine as any, 'displayVariableTable').mockImplementation(() => {});
      const spyDisplayConflictTable = jest.spyOn(promptEngine as any, 'displayConflictTable').mockImplementation(() => {});

      const result = await promptEngine.promptForChanges(mockChangeSet);

      expect(result).toEqual({
        pushVariables: ['LOCAL_VAR1'],
        pullVariables: ['REMOTE_VAR1'],
        keepLocal: ['CONFLICT_VAR'],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      });

      spyDisplayVariableTable.mockRestore();
      spyDisplayConflictTable.mockRestore();
    });
  });

  describe('confirmSync', () => {
    test('should display summary and confirm sync', async () => {
      const decisions = {
        pushVariables: ['VAR1', 'VAR2'],
        pullVariables: ['VAR3'],
        keepLocal: ['VAR4'],
        keepRemote: ['VAR5'],
        deleteLocal: [],
      deleteRemote: []
      };

      mockInquirer.prompt.mockResolvedValue({ confirm: true });

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await promptEngine.confirmSync(decisions);

      expect(consoleSpy).toHaveBeenCalledWith('\n' + 'Summary of changes:');
      expect(consoleSpy).toHaveBeenCalledWith('- Push 2 variable(s) to keep');
      expect(consoleSpy).toHaveBeenCalledWith('- Pull 1 variable(s) from keep');
      expect(consoleSpy).toHaveBeenCalledWith('- Keep 1 local value(s)');
      expect(consoleSpy).toHaveBeenCalledWith('- Use 1 remote value(s)');

      expect(mockInquirer.prompt).toHaveBeenCalledWith([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Apply these changes?',
          default: true
        }
      ]);

      expect(result).toBe(true);

      consoleSpy.mockRestore();
    });

    test('should handle empty decisions', async () => {
      const decisions = {
        pushVariables: [],
        pullVariables: [],
        keepLocal: [],
        keepRemote: [],
        deleteLocal: [],
      deleteRemote: []
      };

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const result = await promptEngine.confirmSync(decisions);

      // Empty decisions have changeTypes = 0, so auto-confirm without showing summary
      expect(consoleSpy).not.toHaveBeenCalledWith('\n' + 'Summary of changes:');
      expect(result).toBe(true);  // Auto-confirms when changeTypes <= 1

      consoleSpy.mockRestore();
    });
  });

  describe('displayVariableTable', () => {
    test('should display variable table correctly', () => {
      const variables = [
        { name: 'SHORT_VAR', value: 'short' },
        { name: 'VERY_LONG_VARIABLE_NAME', value: 'This is a very long value that should be truncated when displayed' }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      (promptEngine as any).displayVariableTable(variables);

      expect(consoleSpy).toHaveBeenCalled();
      
      // Verify table structure is logged
      const calls = consoleSpy.mock.calls.map(call => call[0]);
      expect(calls.some((call: string) => call.includes('┌'))).toBe(true); // Top border
      expect(calls.some((call: string) => call.includes('Variable'))).toBe(true); // Header
      expect(calls.some((call: string) => call.includes('SHORT_VAR'))).toBe(true); // Data
      expect(calls.some((call: string) => call.includes('└'))).toBe(true); // Bottom border

      consoleSpy.mockRestore();
    });
  });

  describe('displayConflictTable', () => {
    test('should display conflict table correctly', () => {
      const conflicts = [
        { name: 'CONFLICT_VAR', localValue: 'local_value', remoteValue: 'remote_value' }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      (promptEngine as any).displayConflictTable(conflicts);

      expect(consoleSpy).toHaveBeenCalled();
      
      // Verify table structure is logged
      const calls = consoleSpy.mock.calls.map(call => call[0]);
      expect(calls.some((call: string) => call.includes('┌'))).toBe(true); // Top border
      expect(calls.some((call: string) => call.includes('Variable'))).toBe(true); // Header
      expect(calls.some((call: string) => call.includes('Local Value'))).toBe(true); // Header
      expect(calls.some((call: string) => call.includes('Remote Value'))).toBe(true); // Header
      expect(calls.some((call: string) => call.includes('CONFLICT_VAR'))).toBe(true); // Data

      consoleSpy.mockRestore();
    });
  });

  describe('truncateValue', () => {
    test('should truncate long values', () => {
      const longValue = 'This is a very long value that exceeds the maximum length and should be truncated';
      const result = (promptEngine as any).truncateValue(longValue, 20);
      
      expect(result).toBe('This is a very lo...');
      expect(result.length).toBe(20);
    });

    test('should not truncate short values', () => {
      const shortValue = 'short';
      const result = (promptEngine as any).truncateValue(shortValue, 20);
      
      expect(result).toBe('short');
    });

    test('should use default max length of 40', () => {
      const longValue = 'This is a very long value that exceeds forty characters in length';
      const result = (promptEngine as any).truncateValue(longValue);
      
      expect(result).toBe('This is a very long value that exceed...');
      expect(result.length).toBe(40);
    });
  });

  describe('Variable Name Truncation', () => {
    describe('truncateVariableName', () => {
      test('should not truncate names <= 24 characters', () => {
        const shortName = 'SHORT_VAR';
        const exactName = 'EXACTLY_24_CHAR_VARIABLE';
        
        expect((promptEngine as any).truncateVariableName(shortName)).toBe('SHORT_VAR');
        expect((promptEngine as any).truncateVariableName(exactName)).toBe('EXACTLY_24_CHAR_VARIABLE');
        expect(exactName.length).toBe(24); // Verify test data
      });

      test('should truncate names > 24 characters using first 12 + ... + last 12', () => {
        const longName = 'EXTREMELY_LONG_VARIABLE_NAME_THAT_EXCEEDS_LIMIT';
        const result = (promptEngine as any).truncateVariableName(longName);
        
        expect(result).toBe('EXTREMELY_LO...XCEEDS_LIMIT');
        expect(result.length).toBe(27); // 12 + 3 + 12
        expect(result.startsWith('EXTREMELY_LO')).toBe(true);
        expect(result.endsWith('XCEEDS_LIMIT')).toBe(true);
        expect(result.includes('...')).toBe(true);
      });

      test('should handle very long variable names correctly', () => {
        const veryLongName = 'SUPER_DUPER_EXTREMELY_LONG_VARIABLE_NAME_THAT_GOES_ON_AND_ON_FOR_TESTING_PURPOSES';
        const result = (promptEngine as any).truncateVariableName(veryLongName);
        
        expect(result).toBe('SUPER_DUPER_...ING_PURPOSES');
        expect(result.length).toBe(27);
        expect(result.slice(0, 12)).toBe('SUPER_DUPER_');
        expect(result.slice(-12)).toBe('ING_PURPOSES');
      });
    });
  });

  describe('Local Value Snippet Formatting', () => {
    describe('createLocalValueSnippet', () => {
      test('should truncate local values > 16 characters using first 3 + ... + last 13', () => {
        const shortValue = 'short_value'; // 11 chars - should not be processed by this method
        const longValue = 'this_is_a_very_long_value_for_testing';
        
        const result = (promptEngine as any).createLocalValueSnippet(longValue);
        
        expect(result).toBe('thi...e_for_testing');
        expect(result.length).toBe(19); // 3 + 3 + 13
        expect(result.startsWith('thi')).toBe(true);
        expect(result.endsWith('e_for_testing')).toBe(true);
        expect(result.includes('...')).toBe(true);
      });

      test('should handle very long local values correctly', () => {
        const veryLongValue = 'this_is_an_extremely_long_value_that_should_trigger_the_local_truncation_algorithm_with_first_three_and_last_thirteen_characters';
        const result = (promptEngine as any).createLocalValueSnippet(veryLongValue);
        
        expect(result).toBe('thi...en_characters');
        expect(result.length).toBe(19);
        expect(result.slice(0, 3)).toBe('thi');
        expect(result.slice(-13)).toBe('en_characters');
      });
    });
  });

  describe('Encrypted Value Obfuscation', () => {
    describe('applySnippetObfuscation', () => {
      test('should obfuscate values <= 4 characters with ...X pattern', () => {
        expect((promptEngine as any).applySnippetObfuscation('a')).toBe('...a');
        expect((promptEngine as any).applySnippetObfuscation('ab')).toBe('...b');
        expect((promptEngine as any).applySnippetObfuscation('abc')).toBe('...c');
        expect((promptEngine as any).applySnippetObfuscation('abcd')).toBe('...d');
      });

      test('should obfuscate values 5-8 characters with X...X pattern', () => {
        expect((promptEngine as any).applySnippetObfuscation('abcde')).toBe('a...e');
        expect((promptEngine as any).applySnippetObfuscation('abcdef')).toBe('a...f');
        expect((promptEngine as any).applySnippetObfuscation('abcdefg')).toBe('a...g');
        expect((promptEngine as any).applySnippetObfuscation('abcdefgh')).toBe('a...h');
      });

      test('should obfuscate values 9-16 characters with X...XXX pattern', () => {
        expect((promptEngine as any).applySnippetObfuscation('abcdefghi')).toBe('a...ghi');
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijkl')).toBe('a...jkl');
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnop')).toBe('a...nop');
      });

      test('should obfuscate values 17-24 characters with XX...XXXXXX pattern', () => {
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnopq')).toBe('ab...lmnopq');
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnopqrst')).toBe('ab...opqrst');
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnopqrstuvwx')).toBe('ab...stuvwx');
      });

      test('should obfuscate values > 24 characters with XXXX...XXXXXX pattern', () => {
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnopqrstuvwxy')).toBe('abcd...tuvwxy');
        expect((promptEngine as any).applySnippetObfuscation('abcdefghijklmnopqrstuvwxyz1234')).toBe('abcd...yz1234');
        expect((promptEngine as any).applySnippetObfuscation('very_long_encrypted_value_for_testing_obfuscation')).toBe('very...cation');
      });

      test('should strip capy: prefix before obfuscating GCM-encrypted values', () => {
        // GCM format: capy:{base64_data} — prefix should be stripped so
        // the masked output shows base64 fingerprint chars, not "capy"
        const gcmValue = 'capy:DKj8f2lQm+abc123def456ghi789==';
        const stripped = 'DKj8f2lQm+abc123def456ghi789==';
        // stripped is 31 chars → XXXX...XXXXXX pattern
        expect((promptEngine as any).applySnippetObfuscation(gcmValue)).toBe('DKj8...i789==');
        // Verify it matches what we'd get from the stripped value directly
        expect((promptEngine as any).applySnippetObfuscation(gcmValue))
          .toBe((promptEngine as any).applySnippetObfuscation(stripped));
      });

      test('should strip capy:{resource_id}: prefix before obfuscating legacy values', () => {
        // Legacy format: capy:{resource_id}:{encrypted_value}
        const legacyValue = 'capy:res_123:abcdefghijklmnopqrstuvwxyz';
        const stripped = 'abcdefghijklmnopqrstuvwxyz';
        // stripped is 26 chars → XXXX...XXXXXX pattern
        expect((promptEngine as any).applySnippetObfuscation(legacyValue)).toBe('abcd...uvwxyz');
        expect((promptEngine as any).applySnippetObfuscation(legacyValue))
          .toBe((promptEngine as any).applySnippetObfuscation(stripped));
      });

      test('should handle short GCM values after prefix stripping', () => {
        // Short base64 after stripping capy: prefix
        expect((promptEngine as any).applySnippetObfuscation('capy:abc')).toBe('...c');
        expect((promptEngine as any).applySnippetObfuscation('capy:abcdefgh')).toBe('a...h');
      });
    });
  });

  describe('Conflict Display Logic', () => {
    describe('createConflictDisplay', () => {
      test('should use same obfuscation for both local and remote values', () => {
        const localValue = 'local_conflict_value';
        const remoteValue = 'remote_conflict_value';
        
        const result = (promptEngine as any).createConflictDisplay(localValue, remoteValue, 30);
        
        // Both should use applySnippetObfuscation (XX...XXXXXX for 17-24 char values)
        expect(result.localDisplay).toBe('lo..._value');
        expect(result.remoteDisplay).toBe('re..._value');
      });

      test('should handle short conflict values', () => {
        const shortLocal = 'abc';
        const shortRemote = 'xyz';
        
        const result = (promptEngine as any).createConflictDisplay(shortLocal, shortRemote, 30);
        
        // Short values should use ...X pattern
        expect(result.localDisplay).toBe('...c');
        expect(result.remoteDisplay).toBe('...z');
      });

      test('should handle very long conflict values', () => {
        const longLocal = 'this_is_a_very_long_local_conflict_value';
        const longRemote = 'this_is_a_very_long_remote_conflict_value';
        
        const result = (promptEngine as any).createConflictDisplay(longLocal, longRemote, 50);
        
        // Very long values should use XXXX...XXXXXX pattern  
        expect(result.localDisplay).toBe('this..._value');
        expect(result.remoteDisplay).toBe('this..._value');
      });
    });
  });

  describe('Dynamic Table Sizing', () => {
    test('should calculate column widths based on content + 3 padding', () => {
      const variables = [
        { name: 'A', value: 'x', source: 'local' as const, encrypted: false },
        { name: 'VERY_LONG_VARIABLE_NAME', value: 'short', source: 'local' as const, encrypted: false }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      (promptEngine as any).displayVariableTable(variables);

      const calls = consoleSpy.mock.calls.map(call => call[0]);
      
      // Find the table border to check column sizing
      const topBorder = calls.find(call => call.includes('┌'));
      expect(topBorder).toBeDefined();
      
      // Should have dynamic sizing based on longest variable name + 3
      // VERY_LONG_VARIABLE_NAME = 23 chars + 3 = 26 total width for name column
      expect(topBorder.includes('─'.repeat(26))).toBe(true);
      
      consoleSpy.mockRestore();
    });

    test('should handle ANSI color codes in padding calculation', () => {
      const variables = [
        { name: 'TEST_VAR', value: 'test_value', source: 'local' as const, encrypted: false }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      (promptEngine as any).displayVariableTable(variables);

      const calls = consoleSpy.mock.calls.map(call => call[0]);
      
      // Find data row and verify alignment
      const dataRow = calls.find(call => call.includes('TEST_VAR') && call.includes('(NEW)'));
      expect(dataRow).toBeDefined();
      
      // Should end with proper border character despite ANSI codes
      expect(dataRow.endsWith(' │')).toBe(true);
      
      consoleSpy.mockRestore();
    });
  });

  describe('Integration: Variable Table Display', () => {
    test('should properly format mixed variable names and values', () => {
      const variables = [
        { name: 'SHORT', value: 'a', source: 'local' as const, encrypted: false },
        { name: 'MEDIUM_LENGTH_VARIABLE_NAME', value: 'medium_value_here_for_test', source: 'local' as const, encrypted: false },
        { name: 'EXTREMELY_LONG_VARIABLE_NAME_THAT_EXCEEDS_LIMIT', value: 'y', source: 'local' as const, encrypted: false }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      (promptEngine as any).displayVariableTable(variables);

      const calls = consoleSpy.mock.calls.map(call => call[0]);
      
      // Check basic table structure exists
      const hasTopBorder = calls.some(call => call.includes('┌'));
      const hasBottomBorder = calls.some(call => call.includes('└'));
      const hasVariableHeader = calls.some(call => call.includes('Variable'));
      
      expect(hasTopBorder).toBe(true);
      expect(hasBottomBorder).toBe(true);
      expect(hasVariableHeader).toBe(true);
      
      // Check that variable names appear (regardless of truncation)
      const hasShortVar = calls.some(call => call.includes('SHORT'));
      // MEDIUM_LENGTH_VARIABLE_NAME may be truncated, so check for just 'MEDIUM'
      const hasMediumVar = calls.some(call => call.includes('MEDIUM'));
      const hasLongVar = calls.some(call => call.includes('EXTREMELY'));
      
      expect(hasShortVar).toBe(true);
      expect(hasMediumVar).toBe(true);
      expect(hasLongVar).toBe(true);
      
      consoleSpy.mockRestore();
    });
  });

  describe('Integration: Conflict Table Display', () => {
    test('should properly format conflict table with consistent obfuscation', () => {
      const conflicts = [
        { name: 'SHORT_CONFLICT_VAR', localValue: 'local_value_here', remoteValue: 'remote_value_here' },
        { name: 'EXTREMELY_LONG_CONFLICT_VARIABLE_NAME_FOR_TESTING', localValue: 'x', remoteValue: 'y' }
      ];

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      (promptEngine as any).displayConflictTable(conflicts);

      const calls = consoleSpy.mock.calls.map(call => call[0]);
      
      // Check basic table structure exists
      const hasTopBorder = calls.some(call => call.includes('┌'));
      const hasBottomBorder = calls.some(call => call.includes('└'));
      const hasVariableHeader = calls.some(call => call.includes('Variable'));
      const hasLocalHeader = calls.some(call => call.includes('Local Value'));
      const hasRemoteHeader = calls.some(call => call.includes('Remote Value'));
      
      expect(hasTopBorder).toBe(true);
      expect(hasBottomBorder).toBe(true);
      expect(hasVariableHeader).toBe(true);
      expect(hasLocalHeader).toBe(true);
      expect(hasRemoteHeader).toBe(true);
      
      // Check that variable names appear in some form
      const hasShortConflict = calls.some(call => call.includes('SHORT_CONFLICT'));
      const hasLongConflict = calls.some(call => call.includes('EXTREMELY'));
      
      expect(hasShortConflict).toBe(true);
      expect(hasLongConflict).toBe(true);
      
      consoleSpy.mockRestore();
    });
  });

  describe('display methods', () => {
    let consoleSpy: any;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    test('displaySuccess should log success message', () => {
      promptEngine.displaySuccess('Test success message');
      expect(consoleSpy).toHaveBeenCalledWith('Test success message');
    });

    test('displayError should log error message', () => {
      promptEngine.displayError('Test error message');
      expect(consoleSpy).toHaveBeenCalledWith('Test error message');
    });

    test('displayWarning should log warning message', () => {
      promptEngine.displayWarning('Test warning message');
      expect(consoleSpy).toHaveBeenCalledWith('Test warning message');
    });

    test('displayInfo should log info message', () => {
      promptEngine.displayInfo('Test info message');
      expect(consoleSpy).toHaveBeenCalledWith('ℹ Test info message');
    });
  });
});
