/** Generate a small test music library: `pnpm --filter @tidepool/server fixtures <dir>` */
import path from 'node:path';
import { writeFixtureLibrary } from '../test/helpers/fixtures.js';

const dest = path.resolve(process.argv[2] ?? './music');
await writeFixtureLibrary(dest);
console.log(`Fixture library written to ${dest}`);
