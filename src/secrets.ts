const SECRET_COMMAND =
  /(^|[|;&]\s*)(printenv|env)\b|\.env\b|\b(secret|secrets|credential|credentials|password|token|keychain|netrc|id_rsa|private[_-]?key)\b/i;
const SECRET_OUTPUT =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(aws_secret_access_key|api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*\S|:\/\/[^\s:@/]+:[^\s:@/]+@/i;

export function looksSecret(command: string, output: string): boolean {
  return SECRET_COMMAND.test(command) || SECRET_OUTPUT.test(output);
}
