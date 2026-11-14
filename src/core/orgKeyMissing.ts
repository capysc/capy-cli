/** What setup says when the person belongs to an organization but this device holds none of its keys. Shared by the terminal and agent paths of bare `capy`. */
export function orgKeyMissingMessage(orgName: string): string {
  return `You have access to "${orgName}" but no encryption key on this device.\n\n` +
    '  Ask your org owner for an invite code, then run:\n\n' +
    '    capy redeem <code>\n\n' +
    '  This will securely transfer the shared encryption key to your device.';
}
