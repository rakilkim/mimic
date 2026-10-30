import { getStore } from '@netlify/blobs';
import { handleGameRequest } from '../../src/game-service.mjs';

const ROOMS_STORE = 'mimic-party-rooms';

export default async function game(request: Request): Promise<Response> {
  const store = getStore({ name: ROOMS_STORE, consistency: 'strong' });
  return handleGameRequest(request, store);
}
