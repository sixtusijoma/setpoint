export function redactSecrets(text: string, secrets: string[]): string {
  let next = text;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    next = next.split(secret).join('[redacted]');
  }
  return next;
}
