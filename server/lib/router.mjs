/**
 * A very small router: a method, a pattern, a handler.
 *
 * Patterns use `:name` segments (`/ticket/:id/reply`) and match a single segment each. There
 * are no wildcards, no regular expressions and no middleware stack, because this application
 * has about twenty routes and every one of them is better read as a literal path.
 *
 * Params arrive decoded. A segment that fails to decode makes the route not match, so a
 * malformed percent-escape is a 404 rather than a 500.
 */
export function createRouter() {
  const routes = [];

  const compile = (pattern) => {
    const parts = pattern.split('/').filter(Boolean);
    return {
      parts,
      params: parts.filter((p) => p.startsWith(':')).map((p) => p.slice(1)),
    };
  };

  const add = (method, pattern, handler) => {
    routes.push({ method, pattern, ...compile(pattern), handler });
  };

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),

    /**
     * Find a handler for a request.
     *
     * Returns `{ handler, params }`, or `{ allowed }` when the path exists under a different
     * method — that distinction is what lets the server answer 405 instead of 404, which is
     * the difference between "you got the URL wrong" and "you got the verb wrong".
     */
    match(method, pathname) {
      const segments = pathname.split('/').filter(Boolean);
      const allowed = new Set();

      for (const route of routes) {
        if (route.parts.length !== segments.length) continue;

        const params = {};
        let matched = true;
        for (let i = 0; i < route.parts.length; i += 1) {
          const part = route.parts[i];
          if (part.startsWith(':')) {
            try {
              params[part.slice(1)] = decodeURIComponent(segments[i]);
            } catch {
              matched = false;
              break;
            }
          } else if (part !== segments[i]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;

        if (route.method === method) return { handler: route.handler, params };
        allowed.add(route.method);
      }

      return allowed.size ? { allowed: [...allowed] } : null;
    },
  };
}
