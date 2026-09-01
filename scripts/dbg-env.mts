import fs from 'node:fs';
import { parseEnvFile } from '../src/config.js';

const raw = fs.readFileSync(new URL('../config.env', import.meta.url), 'utf8');
const parsed = parseEnvFile(raw);
console.log('CTI_BOT =', JSON.stringify(parsed.CTI_BOT));
console.log('CTI_BOT_DSH_APP_ID =', JSON.stringify(parsed.CTI_BOT_DSH_APP_ID));
