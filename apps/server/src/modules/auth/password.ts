import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1); fine on a Raspberry Pi 5.
// algorithm 2 = Argon2id (the package's `Algorithm` is an ambient const enum we can't import).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Verified against when the email is unknown, so response time doesn't reveal which emails exist. */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('not-a-real-password-just-burning-time');
  return dummyHash;
}
