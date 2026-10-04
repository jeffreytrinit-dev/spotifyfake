import type { FastifyInstance } from 'fastify';
import { UpdateUserSettingsSchema, type UserSettingsDto } from '@tidepool/shared';
import type { Db } from '../../db.js';
import { parse } from '../../lib/validate.js';
import { currentUser } from '../auth/plugin.js';
import { getSettings, toSettingsDto } from './settings.js';

export async function userRoutes(app: FastifyInstance, { db }: { db: Db }): Promise<void> {
  app.get('/me/settings', async (req): Promise<UserSettingsDto> => {
    return toSettingsDto(await getSettings(db, currentUser(req).id));
  });

  app.patch('/me/settings', async (req): Promise<UserSettingsDto> => {
    const user = currentUser(req);
    const patch = parse(UpdateUserSettingsSchema, req.body ?? {});
    await getSettings(db, user.id);
    // exactOptionalPropertyTypes: drop keys that are present-but-undefined.
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return toSettingsDto(await db.userSettings.update({ where: { userId: user.id }, data }));
  });
}
