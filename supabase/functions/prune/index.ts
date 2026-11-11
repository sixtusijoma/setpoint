import { serveHandler } from '../../../src/server/edge.ts';
import { runtimeEnv } from '../../../src/server/env.ts';
import { handlePrune } from '../../../src/server/http.ts';
import { createRestDb } from '../../../src/server/restDb.ts';

serveHandler(async (request) => handlePrune(request, { db: createRestDb(), env: await runtimeEnv() }));
