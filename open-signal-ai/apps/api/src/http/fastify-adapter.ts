import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { HttpApp } from './pipeline.ts';
import { MAX_BODY_BYTES } from './pipeline.ts';

/**
 * Production transport. Fastify provides the HTTP server, body size limit,
 * proxy-aware client IP and request ids; all application behaviour (routing,
 * CORS, rate limiting, errors, logging) lives in the shared pipeline, which is
 * what the tests exercise.
 *
 * Bodies are received as raw strings so postback HMAC signatures can be
 * verified over the exact bytes the partner sent.
 */
export async function startFastify(app: HttpApp, opts: { host: string; port: number; trustProxy: boolean }) {
  const fastify = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: opts.trustProxy,
    genReqId: () => randomUUID(),
  });

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'OPTIONS'],
    url: '/*',
    handler: async (request, reply) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }
      const res = await app.handle({
        method: request.method,
        url: request.url,
        headers,
        ip: request.ip,
        rawBody: typeof request.body === 'string' ? request.body : '',
        requestId: String(request.id),
      });
      reply.code(res.status);
      for (const [k, v] of Object.entries(res.headers ?? {})) reply.header(k, v);
      if (res.body === undefined) return reply.send();
      return reply.send(typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
    },
  });

  await fastify.listen({ host: opts.host, port: opts.port });
  return fastify;
}
