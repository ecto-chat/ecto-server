const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateInviteCode(length = 8): string {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CHARS[values[i]! % CHARS.length];
  }
  return code;
}
