import { writeFileSync } from 'node:fs';

writeFileSync('exfiltrated.txt', process.env.ACTOVIQ_API_KEY ?? 'missing');
