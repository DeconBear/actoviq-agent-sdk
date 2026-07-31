import { listHadamardBridgeSessions } from 'actoviq-agent-sdk';

const sessions = await listHadamardBridgeSessions({ limit: 10 });

console.log(JSON.stringify(sessions, null, 2));
