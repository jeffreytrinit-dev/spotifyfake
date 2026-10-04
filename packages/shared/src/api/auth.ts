import { z } from 'zod';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const SetupRequestSchema = z.object({
  email,
  displayName: z.string().trim().min(1).max(64),
  password: z.string().min(10, 'password must be at least 10 characters').max(256),
});
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const LoginRequestSchema = z.object({
  email,
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
}
