import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { createActoviqBuddyApi } from 'actoviq-agent-sdk';

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'actoviq-buddy-example-'));
const configPath = path.join(tempDir, 'buddy-settings.json');

await writeFile(
  configPath,
  `${JSON.stringify(
    {
      userID: 'buddy-demo-user',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const buddyApi = createActoviqBuddyApi({ configPath });

try {
  let buddy = await buddyApi.get();
  if (!buddy) {
    buddy = await buddyApi.hatch({
      name: 'Orbit',
      personality: 'curious, steady, and quietly encouraging',
    });
  }

  const reaction = await buddyApi.pet();
  const promptContext = await buddyApi.getPromptContext();

  console.log('Buddy:', buddy);
  console.log('Reaction:', reaction);
  console.log('Prompt context:', promptContext);
  console.log('Muted state:', (await buddyApi.state()).muted);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
