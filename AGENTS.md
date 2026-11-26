# Working on capy-cli

## Every CLI change needs an agent path

Capy is run by people at a terminal and by coding agents with no terminal. Every change that adds or changes a terminal question must also add the agent path in the same pull request:

- **An elicitation:** in agent mode (`--json`, `--non-tty`, or no terminal), the question is not prompted. The command refuses with a coded JSON answer, exits 3, and carries an `elicitation` (`confirm` or `form`, see `src/ui/elicitation.ts`). It asks the terminal's question word for word, with the same choices.
- **An answer flag:** the elicitation's `answer.yes` or `answer.rerun` is the same command with a flag that answers the question. If no flag answers it yet, add one.
- **Descriptions:** give the question and each choice a short description saying what happens, because agents' question tools show them.
- **No silent defaults:** if a question can't be asked, the command must not answer it for the human.
- **Docs:** update `ELICITATION_HELP` in `src/ui/elicitation.ts`, then regenerate `docs/cli-reference.md` with `npm run docs:cli`.
- **Tests:** test the agent path as well as the terminal path.

Secret values are the exception. A variable's value, a system key, a recovery phrase or a passphrase is never asked through an agent. Those go to Keep's screens instead.

The full rule and the list of prompts that still lack an agent path are in the onboarding v2 spec, section 3l (Elicitation parity, CAP-909).
