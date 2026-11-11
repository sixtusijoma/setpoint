import { serveHandler } from '../../../src/server/edge.ts';
import { runtimeEnv } from '../../../src/server/env.ts';
import { handleMcpRequest } from '../../../src/server/http.ts';
import { createRestDb } from '../../../src/server/restDb.ts';

serveHandler((request) => handleMcpRequest(request, { db: createRestDb(), env: runtimeEnv() }));
