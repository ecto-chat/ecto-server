import argon2 from 'argon2';
import type { Db } from '../../db/index.js';
import { localUsers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { generateUUIDv7, validateUsername } from 'ecto-shared';
import { ectoError } from '../../utils/errors.js';

export async function registerLocal(
  d: Db,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const usernameError = validateUsername(input.username);
  if (usernameError) {
    throw ectoError('BAD_REQUEST', 1001, usernameError);
  }

  const hash = await argon2.hash(input.password);
  const id = generateUUIDv7();

  await d.insert(localUsers).values({
    id,
    username: input.username,
    passwordHash: hash,
  });

  return { id, username: input.username };
}

export async function loginLocal(
  d: Db,
  input: { username: string; password: string },
): Promise<{ id: string; username: string }> {
  const users = await d
    .select()
    .from(localUsers)
    .where(eq(localUsers.username, input.username));

  if (users.length === 0) {
    throw ectoError('UNAUTHORIZED', 1000, 'Invalid credentials');
  }

  for (const user of users) {
    const valid = await argon2.verify(user.passwordHash, input.password);
    if (valid) return { id: user.id, username: user.username };
  }

  throw ectoError('UNAUTHORIZED', 1000, 'Invalid credentials');
}
