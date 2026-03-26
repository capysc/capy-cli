import inquirer from 'inquirer';

import {
  ChangeSet,
  ConflictVariable,
  EnvVariable,
  UserDecisions
} from '../types/index';

export class PromptEngine {
  async promptForProjectName(defaultName: string): Promise<string> {
    const { projectName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'projectName',
        message: `📁 Project name (default: "${defaultName}"):`,
        default: defaultName,
        validate: (input: string) => {
          if (!input || input.trim().length === 0) {
            return 'Project name cannot be empty';
          }
          if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
            return 'Project name can only contain letters, numbers, hyphens, and underscores';
          }
          return true;
        }
      }
    ]);

    return projectName;
  }

  async promptForChanges(changeSet: ChangeSet): Promise<UserDecisions> {
    const decisions: UserDecisions = {
      pushVariables: [],
      pullVariables: [],
      keepLocal: [],
      keepRemote: [],
      deleteLocal: [],
      deleteRemote: []
    };

    // Prompt for new local variables
    if (changeSet.newLocal.length > 0) {
      console.log('\n⚠ Found ' + changeSet.newLocal.length + ' new local variable(s):');
      this.displayVariableTable(changeSet.newLocal);

      const { pushAll } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'pushAll',
          message: 'Push all local variables to capy?',
          default: false
        }
      ]);

      if (pushAll) {
        decisions.pushVariables = changeSet.newLocal.map(v => v.name);
        console.log(`✓ Will push all ${changeSet.newLocal.length} local variables`);
      } else {
        for (const variable of changeSet.newLocal) {
          const { push } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'push',
              message: `${variable.name}: Push to capy?`,
              default: false
            }
          ]);

          if (push) {
            decisions.pushVariables.push(variable.name);
            console.log(`✓ Will push ${variable.name}`);
          } else {
            console.log(`⚠ Will keep ${variable.name} local only`);
          }
        }
      }
    }

    // Prompt for new remote variables
    if (changeSet.newRemote.length > 0) {
      console.log('\n⚠ Found ' + changeSet.newRemote.length + ' new remote variable(s):');
      this.displayVariableTable(changeSet.newRemote);

      const { pullAll } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'pullAll',
          message: 'Pull all remote variables?',
          default: true
        }
      ]);

      if (pullAll) {
        decisions.pullVariables = changeSet.newRemote.map(v => v.name);
        console.log(`✓ Will pull all ${changeSet.newRemote.length} remote variables`);
      } else {
        for (const variable of changeSet.newRemote) {
          const { pull } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'pull',
              message: `Pull ${variable.name}?`,
              default: true
            }
          ]);

          if (pull) {
            decisions.pullVariables.push(variable.name);
          }
        }
      }
    }

    // Prompt for deleted variables
    if (changeSet.deleted.length > 0) {
      console.log('\n🗑️  Found ' + changeSet.deleted.length + ' deleted variable(s) on remote:');
      this.displayDeletedVariableTable(changeSet.deleted);

      const { batchAction } = await inquirer.prompt([
        {
          type: 'list',
          name: 'batchAction',
          message: 'How would you like to handle these deleted variables?',
          choices: [
            { name: 'Delete all from local .env', value: 'delete_all' },
            { name: 'Push local variables to remote', value: 'restore_all' },
            { name: 'Decide individually', value: 'individual' }
          ],
          default: 'delete_all'
        }
      ]);

      if (batchAction === 'delete_all') {
        decisions.deleteLocal = changeSet.deleted.map(v => v.name);
        console.log(`✓ Will delete all ${changeSet.deleted.length} variables from local`);
      } else if (batchAction === 'restore_all') {
        decisions.pushVariables.push(...changeSet.deleted.map(v => v.name));
        console.log(`✓ Will restore all ${changeSet.deleted.length} variables to keep`);
      } else {
        for (const variable of changeSet.deleted) {
          const { action } = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: `${variable.name} was deleted remotely. What would you like to do?`,
              choices: [
                { name: 'Delete from local', value: 'delete' },
                { name: 'Restore to keep', value: 'restore' },
                { name: 'Keep local only', value: 'keep' }
              ],
              default: 'delete'
            }
          ]);

          if (action === 'delete') {
            decisions.deleteLocal.push(variable.name);
            console.log(`✓ Will delete ${variable.name} from local`);
          } else if (action === 'restore') {
            decisions.pushVariables.push(variable.name);
            console.log(`✓ Will restore ${variable.name} to keep`);
          } else {
            console.log(`⚠ Will keep ${variable.name} locally (out of sync with remote)`);
          }
        }
      }
    }

    // Prompt for locally deleted variables
    if (changeSet.deletedLocal.length > 0) {
      console.log('\n🗑️  Found ' + changeSet.deletedLocal.length + ' variable(s) deleted locally:');
      this.displayLocallyDeletedVariableTable(changeSet.deletedLocal);

      const { batchAction } = await inquirer.prompt([
        {
          type: 'list',
          name: 'batchAction',
          message: 'These variables exist remotely but were deleted locally. What would you like to do?',
          choices: [
            { name: 'Delete all from remote (push deletion)', value: 'delete_all' },
            { name: 'Restore all to local', value: 'restore_all' },
            { name: 'Decide individually', value: 'individual' }
          ],
          default: 'delete_all'
        }
      ]);

      if (batchAction === 'delete_all') {
        decisions.deleteRemote = changeSet.deletedLocal.map(v => v.name);
        console.log(`✓ Will delete all ${changeSet.deletedLocal.length} variables from remote`);
      } else if (batchAction === 'restore_all') {
        decisions.pullVariables.push(...changeSet.deletedLocal.map(v => v.name));
        console.log(`✓ Will restore all ${changeSet.deletedLocal.length} variables to local`);
      } else {
        for (const variable of changeSet.deletedLocal) {
          const { action } = await inquirer.prompt([
            {
              type: 'list',
              name: 'action',
              message: `${variable.name} was deleted locally. What would you like to do?`,
              choices: [
                { name: 'Delete from remote (push deletion)', value: 'delete' },
                { name: 'Restore to local', value: 'restore' },
                { name: 'Keep remote only', value: 'keep' }
              ],
              default: 'delete'
            }
          ]);

          if (action === 'delete') {
            decisions.deleteRemote.push(variable.name);
            console.log(`✓ Will delete ${variable.name} from remote`);
          } else if (action === 'restore') {
            decisions.pullVariables.push(variable.name);
            console.log(`✓ Will restore ${variable.name} to local`);
          } else {
            console.log(`⚠ Will keep ${variable.name} on remote only`);
          }
        }
      }
    }

    // Prompt for conflicts — Phase 1: resolve local vs remote for each
    if (changeSet.conflicts.length > 0) {
      console.log('\n⚠ Found ' + changeSet.conflicts.length + ' conflict(s):');
      this.displayConflictTable(changeSet.conflicts);

      if (changeSet.conflicts.length > 1) {
        const { bulkChoice } = await inquirer.prompt([{
          type: 'list',
          name: 'bulkChoice',
          message: 'Resolve conflicts:',
          choices: [
            { name: 'Use all local', value: 'all_local' },
            { name: 'Use all remote', value: 'all_remote' },
            { name: 'Resolve individually', value: 'individual' },
          ]
        }]);

        if (bulkChoice === 'all_local') {
          decisions.keepLocal.push(...changeSet.conflicts.map(c => c.name));
        } else if (bulkChoice === 'all_remote') {
          decisions.keepRemote.push(...changeSet.conflicts.map(c => c.name));
        } else {
          for (const conflict of changeSet.conflicts) {
            const { resolution } = await inquirer.prompt([{
              type: 'list',
              name: 'resolution',
              message: `${conflict.name}:`,
              choices: [
                { name: `Use local (${this.applySnippetObfuscation(conflict.localValue)})`, value: 'local' },
                { name: `Use remote (${this.applySnippetObfuscation(conflict.remoteValue)})`, value: 'remote' },
              ]
            }]);
            if (resolution === 'local') {
              decisions.keepLocal.push(conflict.name);
            } else {
              decisions.keepRemote.push(conflict.name);
            }
          }
        }
      } else {
        const conflict = changeSet.conflicts[0];
        const { resolution } = await inquirer.prompt([{
          type: 'list',
          name: 'resolution',
          message: `${conflict.name}:`,
          choices: [
            { name: `Use local (${this.applySnippetObfuscation(conflict.localValue)})`, value: 'local' },
            { name: `Use remote (${this.applySnippetObfuscation(conflict.remoteValue)})`, value: 'remote' },
          ]
        }]);
        if (resolution === 'local') {
          decisions.keepLocal.push(conflict.name);
        } else {
          decisions.keepRemote.push(conflict.name);
        }
      }

      // Phase 2: for variables kept local, decide which to push
      if (decisions.keepLocal.length > 0) {
        console.log(`\n${decisions.keepLocal.length} variable(s) kept local. Push to capy?`);

        if (decisions.keepLocal.length === 1) {
          const varName = decisions.keepLocal[0];
          const { push } = await inquirer.prompt([{
            type: 'confirm',
            name: 'push',
            message: `Push ${varName} to capy?`,
            default: true
          }]);
          if (push) {
            decisions.pushVariables.push(varName);
          }
        } else {
          const { pushChoice } = await inquirer.prompt([{
            type: 'list',
            name: 'pushChoice',
            message: 'Push local values to capy?',
            choices: [
              { name: 'Push all', value: 'all' },
              { name: 'Choose individually', value: 'individual' },
              { name: 'Push none', value: 'none' },
            ]
          }]);

          if (pushChoice === 'all') {
            decisions.pushVariables.push(...decisions.keepLocal);
          } else if (pushChoice === 'individual') {
            for (const varName of decisions.keepLocal) {
              const { push } = await inquirer.prompt([{
                type: 'confirm',
                name: 'push',
                message: `Push ${varName}?`,
                default: true
              }]);
              if (push) {
                decisions.pushVariables.push(varName);
              }
            }
          }
        }
      }
    }

    return decisions;
  }

  async confirmSync(decisions: UserDecisions): Promise<boolean> {
    // Count the number of different types of changes
    const changeTypes = [
      decisions.pushVariables.length > 0,
      decisions.pullVariables.length > 0,
      decisions.keepLocal.length > 0,
      decisions.keepRemote.length > 0,
      decisions.deleteLocal.length > 0,
      decisions.deleteRemote.length > 0
    ].filter(Boolean).length;

    // If no changes or only single type of change, auto-confirm
    if (changeTypes <= 1) {
      return true;
    }

    // Show summary for multiple types of changes
    console.log('\n' + '📋 Summary of changes:');

    if (decisions.pushVariables.length > 0) {
      console.log(`✓ Push ${decisions.pushVariables.length} variable(s) to keep`);
    }

    if (decisions.pullVariables.length > 0) {
      console.log(`✓ Pull ${decisions.pullVariables.length} variable(s) from keep`);
    }

    if (decisions.deleteLocal.length > 0) {
      console.log(`✓ Delete ${decisions.deleteLocal.length} variable(s) from local .env`);
    }

    if (decisions.deleteRemote.length > 0) {
      console.log(`✓ Delete ${decisions.deleteRemote.length} variable(s) from remote`);
    }

    if (decisions.keepLocal.length > 0) {
      console.log(`✓ Keep ${decisions.keepLocal.length} local value(s)`);
    }

    if (decisions.keepRemote.length > 0) {
      console.log(`✓ Use ${decisions.keepRemote.length} remote value(s)`);
    }

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Apply these changes?',
        default: true
      }
    ]);

    return confirm;
  }

  private displayVariableTable(variables: EnvVariable[], mode: 'normal' | 'deleted' = 'normal'): void {
    // Pre-calculate all display values to determine column widths
    const displayData = variables.map(variable => {
      // Truncate variable name if needed (24 char limit)
      const displayName = this.truncateVariableName(variable.name);

      // Apply snippet formatting for all values - ALWAYS obfuscate to prevent leaking secrets
      const baseValue = this.applySnippetObfuscation(variable.value);

      const isNew = variable.source === 'local' || variable.source === 'remote';
      const isDeleted = mode === 'deleted';
      let displayValue: string;

      if (isDeleted) {
        displayValue = baseValue + ' (TO DELETE)';
      } else if (isNew) {
        displayValue = baseValue + ' (NEW)';
      } else {
        displayValue = baseValue;
      }

      return {
        name: displayName,
        displayValue,
        baseValue,
        isNew,
        isDeleted,
        variable
      };
    });

    // Calculate column widths: longest content + 3 padding
    const maxNameLength = Math.max(
      ...displayData.map(d => d.name.length),
      'Variable'.length
    ) + 3;
    const maxValueLength = Math.max(
      ...displayData.map(d => d.displayValue.length),
      'Value'.length
    ) + 3;

    // Draw table
    console.log('┌' + '─'.repeat(maxNameLength + 2) + '┬' + '─'.repeat(maxValueLength + 2) + '┐');
    console.log('│ ' + 'Variable'.padEnd(maxNameLength) + ' │ ' + 'Value'.padEnd(maxValueLength) + ' │');
    console.log('├' + '─'.repeat(maxNameLength + 2) + '┼' + '─'.repeat(maxValueLength + 2) + '┤');

    for (const data of displayData) {
      let finalDisplayText: string;
      let visualLength: number;

      if (data.isDeleted) {
        // Apply red coloring for deleted items
        const coloredValue = this.colorText(data.baseValue, 'red');
        finalDisplayText = coloredValue + ' (TO DELETE)';
        // Visual length is the length without ANSI codes
        visualLength = data.displayValue.length; // This is baseValue + ' (TO DELETE)' length
      } else if (data.isNew) {
        // Apply coloring for new items
        const coloredValue = this.colorText(data.baseValue, 'green');
        finalDisplayText = coloredValue + ' (NEW)';
        // Visual length is the length without ANSI codes
        visualLength = data.displayValue.length; // This is baseValue + ' (NEW)' length
      } else {
        finalDisplayText = data.displayValue;
        visualLength = data.displayValue.length;
      }

      // Calculate padding needed to reach maxValueLength
      const paddingNeeded = Math.max(0, maxValueLength - visualLength);
      const padding = ' '.repeat(paddingNeeded);

      console.log(
        '│ ' +
        data.name.padEnd(maxNameLength) +
        ' │ ' +
        finalDisplayText + padding +
        ' │'
      );
    }

    console.log('└' + '─'.repeat(maxNameLength + 2) + '┴' + '─'.repeat(maxValueLength + 2) + '┘');
  }

  private displayConflictTable(conflicts: ConflictVariable[]): void {
    // Pre-calculate all display values to determine column widths
    const displayData = conflicts.map(conflict => {
      // Truncate variable name if needed (24 char limit)
      const displayName = this.truncateVariableName(conflict.name);

      const { localDisplay, remoteDisplay } = this.createConflictDisplay(
        conflict.localValue,
        conflict.remoteValue,
        999 // Pass large number since we're calculating exact widths
      );

      // Add (NEW) label if local has different resource_id
      const localDisplayWithLabel = conflict.isNew
        ? localDisplay + ' (NEW)'
        : localDisplay;

      return {
        name: displayName,
        localDisplay,
        localDisplayWithLabel,
        remoteDisplay,
        isNew: conflict.isNew || false
      };
    });

    // Calculate column widths: longest content + 3 padding
    const maxNameLength = Math.max(
      ...displayData.map(d => d.name.length),
      'Variable'.length
    ) + 3;
    const maxLocalLength = Math.max(
      ...displayData.map(d => d.localDisplayWithLabel.length),
      'Local Value'.length
    ) + 3;
    const maxRemoteLength = Math.max(
      ...displayData.map(d => d.remoteDisplay.length),
      'Remote Value'.length
    ) + 3;

    // Draw table
    console.log('┌' + '─'.repeat(maxNameLength + 2) + '┬' + '─'.repeat(maxLocalLength + 2) + '┬' + '─'.repeat(maxRemoteLength + 2) + '┐');
    console.log(
      '│ ' + 'Variable'.padEnd(maxNameLength) +
      ' │ ' + 'Local Value'.padEnd(maxLocalLength) +
      ' │ ' + 'Remote Value'.padEnd(maxRemoteLength) +
      ' │'
    );
    console.log('├' + '─'.repeat(maxNameLength + 2) + '┼' + '─'.repeat(maxLocalLength + 2) + '┼' + '─'.repeat(maxRemoteLength + 2) + '┤');

    for (const data of displayData) {
      // Apply green coloring if isNew
      let finalLocalDisplay: string;
      let visualLocalLength: number;

      if (data.isNew) {
        // Apply green color to base value
        const coloredValue = this.colorText(data.localDisplay, 'green');
        finalLocalDisplay = coloredValue + ' (NEW)';
        visualLocalLength = data.localDisplayWithLabel.length; // Length without ANSI codes
      } else {
        finalLocalDisplay = data.localDisplay;
        visualLocalLength = data.localDisplay.length;
      }

      // Calculate padding for local column
      const localPaddingNeeded = Math.max(0, maxLocalLength - visualLocalLength);
      const localPadding = ' '.repeat(localPaddingNeeded);

      console.log(
        '│ ' +
        data.name.padEnd(maxNameLength) +
        ' │ ' +
        finalLocalDisplay + localPadding +
        ' │ ' +
        data.remoteDisplay.padEnd(maxRemoteLength) +
        ' │'
      );
    }

    console.log('└' + '─'.repeat(maxNameLength + 2) + '┴' + '─'.repeat(maxLocalLength + 2) + '┴' + '─'.repeat(maxRemoteLength + 2) + '┘');
  }

  private displayLocallyDeletedVariableTable(variables: EnvVariable[]): void {
    // Pre-calculate all display values to determine column widths
    const displayData = variables.map(variable => {
      // Truncate variable name if needed (24 char limit)
      const displayName = this.truncateVariableName(variable.name);

      // Local is always "DELETED" in red
      const localDisplay = 'DELETED';

      // Always apply snippet obfuscation to remote values
      const remoteDisplay = this.applySnippetObfuscation(variable.value);

      return {
        name: displayName,
        localDisplay,
        remoteDisplay
      };
    });

    // Calculate column widths: longest content + 3 padding
    const maxNameLength = Math.max(
      ...displayData.map(d => d.name.length),
      'Variable'.length
    ) + 3;
    const maxLocalLength = Math.max(
      'DELETED'.length,
      'Local Value'.length
    ) + 3;
    const maxRemoteLength = Math.max(
      ...displayData.map(d => d.remoteDisplay.length),
      'Remote Value'.length
    ) + 3;

    // Draw table
    console.log('┌' + '─'.repeat(maxNameLength + 2) + '┬' + '─'.repeat(maxLocalLength + 2) + '┬' + '─'.repeat(maxRemoteLength + 2) + '┐');
    console.log(
      '│ ' + 'Variable'.padEnd(maxNameLength) +
      ' │ ' + 'Local Value'.padEnd(maxLocalLength) +
      ' │ ' + 'Remote Value'.padEnd(maxRemoteLength) +
      ' │'
    );
    console.log('├' + '─'.repeat(maxNameLength + 2) + '┼' + '─'.repeat(maxLocalLength + 2) + '┼' + '─'.repeat(maxRemoteLength + 2) + '┤');

    for (const data of displayData) {
      // Color "DELETED" in red
      const coloredLocal = this.colorText(data.localDisplay, 'red');
      const localPadding = ' '.repeat(Math.max(0, maxLocalLength - data.localDisplay.length));

      console.log(
        '│ ' +
        data.name.padEnd(maxNameLength) +
        ' │ ' +
        coloredLocal + localPadding +
        ' │ ' +
        data.remoteDisplay.padEnd(maxRemoteLength) +
        ' │'
      );
    }

    console.log('└' + '─'.repeat(maxNameLength + 2) + '┴' + '─'.repeat(maxLocalLength + 2) + '┴' + '─'.repeat(maxRemoteLength + 2) + '┘');
  }

  private displayDeletedVariableTable(variables: EnvVariable[]): void {
    // Pre-calculate all display values to determine column widths
    const displayData = variables.map(variable => {
      // Truncate variable name if needed (24 char limit)
      const displayName = this.truncateVariableName(variable.name);

      // Always apply snippet obfuscation to local values
      const localDisplay = this.applySnippetObfuscation(variable.value);

      // Remote is always "DELETED" in red
      const remoteDisplay = 'DELETED';

      return {
        name: displayName,
        localDisplay,
        remoteDisplay
      };
    });

    // Calculate column widths: longest content + 3 padding
    const maxNameLength = Math.max(
      ...displayData.map(d => d.name.length),
      'Variable'.length
    ) + 3;
    const maxLocalLength = Math.max(
      ...displayData.map(d => d.localDisplay.length),
      'Local Value'.length
    ) + 3;
    const maxRemoteLength = Math.max(
      'DELETED'.length,
      'Remote Value'.length
    ) + 3;

    // Draw table
    console.log('┌' + '─'.repeat(maxNameLength + 2) + '┬' + '─'.repeat(maxLocalLength + 2) + '┬' + '─'.repeat(maxRemoteLength + 2) + '┐');
    console.log(
      '│ ' + 'Variable'.padEnd(maxNameLength) +
      ' │ ' + 'Local Value'.padEnd(maxLocalLength) +
      ' │ ' + 'Remote Value'.padEnd(maxRemoteLength) +
      ' │'
    );
    console.log('├' + '─'.repeat(maxNameLength + 2) + '┼' + '─'.repeat(maxLocalLength + 2) + '┼' + '─'.repeat(maxRemoteLength + 2) + '┤');

    for (const data of displayData) {
      // Color "DELETED" in red
      const coloredRemote = this.colorText(data.remoteDisplay, 'red');
      const remotePadding = ' '.repeat(Math.max(0, maxRemoteLength - data.remoteDisplay.length));

      console.log(
        '│ ' +
        data.name.padEnd(maxNameLength) +
        ' │ ' +
        data.localDisplay.padEnd(maxLocalLength) +
        ' │ ' +
        coloredRemote + remotePadding +
        ' │'
      );
    }

    console.log('└' + '─'.repeat(maxNameLength + 2) + '┴' + '─'.repeat(maxLocalLength + 2) + '┴' + '─'.repeat(maxRemoteLength + 2) + '┘');
  }

  private truncateValue(value: string, maxLength: number = 40): string {
    if (value.length <= maxLength) {
      return value;
    }
    return value.substring(0, maxLength - 3) + '...';
  }

  /**
   * Creates snippet display for conflict values (same obfuscation for both to enable fair comparison)
   */
  private createConflictDisplay(localValue: string, remoteValue: string, maxLength: number): {
    localDisplay: string;
    remoteDisplay: string;
  } {
    // Both local and remote values use same obfuscation algorithm for fair comparison
    return {
      localDisplay: this.applySnippetObfuscation(localValue),
      remoteDisplay: this.applySnippetObfuscation(remoteValue)
    };
  }

  /**
   * Truncate variable names longer than 24 characters
   */
  private truncateVariableName(name: string): string {
    if (name.length <= 24) {
      return name;
    }
    // For names >24 chars: show first 12 chars + ... + last 12 chars
    const firstPart = name.slice(0, 12);
    const lastPart = name.slice(-12);
    return `${firstPart}...${lastPart}`;
  }

  /**
   * Creates snippet display for local variables (always applies snippet logic for 16+ chars)
   */
  private createLocalValueSnippet(value: string): string {
    // For local values >16 chars: show first 3 chars + ... + last 13 chars
    const firstPart = value.slice(0, 3);
    const lastPart = value.slice(-13);
    return `${firstPart}...${lastPart}`;
  }

  /**
   * Creates a snippet-enhanced display for values (same logic as FileManager)
   */
  private createValueSnippet(value: string, maxLength: number): string {
    // If it fits, show as-is
    if (value.length <= maxLength) {
      return value;
    }

    const valueLength = value.length;

    if (valueLength <= 4) {
      // ≤4 chars: ...X (last 1 char)
      const snippet = value.slice(-1);
      return `...${snippet}`;
    } else if (valueLength <= 8) {
      // ≤8 chars: X...X (first 1 char, last 1 char)
      const firstSnippet = value.slice(0, 1);
      const lastSnippet = value.slice(-1);
      return `${firstSnippet}...${lastSnippet}`;
    } else if (valueLength <= 16) {
      // 9-16 chars: X...XXX (first 1 char, last 3 chars)
      const firstSnippet = value.slice(0, 1);
      const lastSnippet = value.slice(-3);
      return `${firstSnippet}...${lastSnippet}`;
    } else if (valueLength <= 24) {
      // 16-24 chars: XX...XXXXXX (first 2...last 6)
      const firstSnippet = value.slice(0, 2);
      const lastSnippet = value.slice(-6);
      return `${firstSnippet}...${lastSnippet}`;
    } else {
      // >24 chars: XXXX...XXXXXX (first 4...last 6)
      const firstSnippet = value.slice(0, 4);
      const lastSnippet = value.slice(-6);
      return `${firstSnippet}...${lastSnippet}`;
    }
  }

  /**
   * Strip capy: prefix (and optional resource_id) from value if present
   */
  private stripResourceIdPrefix(value: string): string {
    if (value.startsWith('capy:')) {
      const parts = value.split(':');
      if (parts.length >= 3) {
        // Format: capy:{resource_id}:{encrypted_value}
        return parts.slice(2).join(':');
      }
      // Format: capy:{base64_data} (GCM format)
      return parts.slice(1).join(':');
    }
    return value;
  }

  /**
   * Apply snippet obfuscation to encrypted values (ALWAYS obfuscate, regardless of length)
   */
  private applySnippetObfuscation(value: string): string {
    // Strip resource_id prefix before obfuscation
    const valueWithoutPrefix = this.stripResourceIdPrefix(value);
    const valueLength = valueWithoutPrefix.length;

    if (valueLength <= 4) {
      // ≤4 chars: ...X (last 1 char)
      const snippet = valueWithoutPrefix.slice(-1);
      return `...${snippet}`;
    } else if (valueLength <= 8) {
      // ≤8 chars: X...X (first 1 char, last 1 char)
      const firstSnippet = valueWithoutPrefix.slice(0, 1);
      const lastSnippet = valueWithoutPrefix.slice(-1);
      return `${firstSnippet}...${lastSnippet}`;
    } else if (valueLength <= 16) {
      // 9-16 chars: X...XXX (first 1 char, last 3 chars)
      const firstSnippet = valueWithoutPrefix.slice(0, 1);
      const lastSnippet = valueWithoutPrefix.slice(-3);
      return `${firstSnippet}...${lastSnippet}`;
    } else if (valueLength <= 24) {
      // 16-24 chars: XX...XXXXXX (first 2...last 6)
      const firstSnippet = valueWithoutPrefix.slice(0, 2);
      const lastSnippet = valueWithoutPrefix.slice(-6);
      return `${firstSnippet}...${lastSnippet}`;
    } else {
      // >24 chars: XXXX...XXXXXX (first 4...last 6)
      const firstSnippet = valueWithoutPrefix.slice(0, 4);
      const lastSnippet = valueWithoutPrefix.slice(-6);
      return `${firstSnippet}...${lastSnippet}`;
    }
  }

  displaySuccess(message: string): void {
    console.log('✓ ' + message);
  }

  displayError(message: string): void {
    console.log('❌ ' + message);
  }

  displayWarning(message: string): void {
    console.log('⚠ ' + message);
  }

  displayInfo(message: string): void {
    console.log('ℹ ' + message);
  }

  /**
   * Add color to text using ANSI codes
   */
  private colorText(text: string, color: 'green' | 'red' | 'yellow'): string {
    const colors = {
      green: '\x1b[32m',
      red: '\x1b[31m',
      yellow: '\x1b[33m'
    };
    const reset = '\x1b[0m';
    return colors[color] + text + reset;
  }
}
