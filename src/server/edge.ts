export function serveHandler(handler: (request: Request) => Promise<Response>): void {
  const deno = (globalThis as { Deno?: { serve: (handle: (request: Request) => Promise<Response>) => void } }).Deno;
  if (!deno) {
    throw new Error('This file runs on the Supabase edge runtime.');
  }
  deno.serve(handler);
}
