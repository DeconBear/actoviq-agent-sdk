import { createAgentSdk, loadDefaultActoviqSettings } from 'actoviq-agent-sdk';

await loadDefaultActoviqSettings();
const sdk = await createAgentSdk();

try {
  const session = await sdk.createSession({ title: 'Example Session' });

  await session.send('Remember that the codename for this project is Sparrow.');
  const reply = await session.send('What is the codename for this project?');

  console.log('Session:', session.id);
  console.log('Reply:', reply.text);
} finally {
  await sdk.close();
}
