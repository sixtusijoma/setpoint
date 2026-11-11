import { serveHandler } from '../../../src/server/edge.ts';
import { runtimeEnv } from '../../../src/server/env.ts';
import { handleTick } from '../../../src/server/http.ts';
import { createRestDb } from '../../../src/server/restDb.ts';

serveHandler(async (request) => handleTick(request, { db: createRestDb(), env: await runtimeEnv() }));
