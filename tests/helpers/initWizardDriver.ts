import { InitWizardSession } from '../../src/ui/initWizardScreen';
import { organizationQuestion, projectNameQuestion, branchChoiceQuestion, encryptQuestion } from '../../src/ui/initWizardQuestions';

/** Drive the immutable session API while browser tests keep their current window. */
export class InitWizardDriver {
  private readonly sessions: Map<'current', InitWizardSession>;
  constructor(options: ConstructorParameters<typeof InitWizardSession>[0]) {
    this.sessions = new Map([['current', new InitWizardSession(options)]]);
  }
  private get current(): InitWizardSession { return this.sessions.get('current')!; }
  record(patch: Parameters<InitWizardSession['record']>[0]): void {
    this.sessions.set('current', this.current.record(patch));
  }
  willBlock(...args: Parameters<InitWizardSession['willBlock']>): void {
    this.sessions.set('current', this.current.willBlock(...args));
  }
  private async ask<T>(question: import('../../src/ui/initWizardQuestions').InitQuestion<T>): Promise<T | null> {
    const answer = await this.current.askQuestion(question);
    this.sessions.set('current', answer.session);
    return answer.value;
  }
  askOrganization(orgs: Parameters<typeof organizationQuestion>[0]) { return this.ask(organizationQuestion(orgs)); }
  askProjectName(name: string) { return this.ask(projectNameQuestion(name)); }
  askBranchChoice() { return this.ask(branchChoiceQuestion()); }
  async askEncrypt(...args: Parameters<typeof encryptQuestion>): Promise<boolean> {
    return (await this.ask(encryptQuestion(...args))) === true;
  }
  finish() { return this.current.finish(); }
  abort(error?: unknown) { return this.current.abort(error); }
  reportEncryptFailure(...args: Parameters<InitWizardSession['reportEncryptFailure']>) { return this.current.reportEncryptFailure(...args); }
}
