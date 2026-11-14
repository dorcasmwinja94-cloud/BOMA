// Express 4 does not catch errors thrown inside async route handlers:
// the request would hang and, as an unhandled rejection, crash Node.
// Wrap handlers registered on routers so rejections flow to the JSON error handler.
//
// Note: express 4 keeps the router HTTP-verb methods on an internal prototype
// object shared by all routers (Router.prototype.get is undefined), so patch
// Object.getPrototypeOf(Router()) rather than Router.prototype.
import { Router } from "express";

const sharedProto = Object.getPrototypeOf(Router()) as any;

const wrap = (fn: any) => {
  if (typeof fn !== "function") return fn; // leave paths/other args untouched
  return (req: any, res: any, next: any) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (e) {
      next(e);
    }
  };
};

for (const method of ["get", "post", "put", "patch", "delete", "all"] as const) {
  const original = sharedProto[method];
  if (typeof original !== "function") continue;
  sharedProto[method] = function patched(this: any, ...args: any[]) {
    // First argument is the path/pattern; the rest are handlers (or nested
    // handler arrays). Error-handling middleware is registered with `.use`,
    // which we deliberately do not touch — it has (err, req, res, next) arity.
    const [head, ...rest] = args;
    return original.call(this, head, ...rest.map((h: any) => (Array.isArray(h) ? h.map(wrap) : wrap(h))));
  };
}
