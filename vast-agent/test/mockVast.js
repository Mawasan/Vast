import { createServer } from "node:http";

/**
 * A stand-in for the Vast.ai API, implementing exactly the endpoints the agent
 * uses. Tests run the real tool code against this, so template edits and the
 * destroy flow are exercised end to end without touching a real account.
 */
export function startMockVast({ templates = [], instances = [] } = {}) {
  const state = {
    templates: structuredClone(templates),
    instances: structuredClone(instances),
    requests: [],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    state.requests.push({ method: req.method, path: url.pathname, body });

    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.headers.authorization !== "Bearer test-key") {
      return send(401, { error: "bad auth" });
    }

    if (url.pathname === "/api/v0/users/current") return send(200, { id: 42, username: "tester" });

    if (url.pathname === "/api/v0/secrets/") {
      return send(200, { secrets: { HF_TOKEN: "should-never-be-returned" } });
    }

    if (url.pathname === "/api/v0/template/") {
      if (req.method === "GET") {
        const filters = JSON.parse(url.searchParams.get("select_filters") ?? "{}");
        let rows = state.templates;
        if (filters.hash_id?.eq) rows = rows.filter((t) => t.hash_id === filters.hash_id.eq);
        else if (filters.id?.eq !== undefined) rows = rows.filter((t) => t.id === filters.id.eq);
        else if (filters.creator_id?.eq !== undefined)
          rows = rows.filter((t) => t.creator_id === filters.creator_id.eq);
        return send(200, { templates: rows });
      }
      if (req.method === "PUT") {
        const idx = state.templates.findIndex((t) => t.hash_id === body.hash_id);
        if (idx === -1) return send(404, { error: "no such template" });
        state.templates[idx] = { ...state.templates[idx], ...body };
        return send(200, { success: true, template: state.templates[idx] });
      }
      if (req.method === "POST") {
        const created = { ...body, id: 900 + state.templates.length, hash_id: `new-hash-${state.templates.length}`, creator_id: 42 };
        state.templates.push(created);
        return send(200, { success: true, template: created });
      }
      if (req.method === "DELETE") {
        state.templates = state.templates.filter(
          (t) => t.hash_id !== body.hash_id && t.id !== body.template_id
        );
        return send(200, { success: true });
      }
    }

    if (url.pathname === "/api/v1/instances/") {
      return send(200, { instances: state.instances });
    }

    const instanceMatch = url.pathname.match(/^\/api\/v0\/instances\/(\d+)\/$/);
    if (instanceMatch) {
      const id = Number(instanceMatch[1]);
      if (req.method === "GET") {
        const found = state.instances.find((i) => i.id === id) ?? null;
        return send(200, { instances: found });
      }
      if (req.method === "DELETE") {
        state.instances = state.instances.filter((i) => i.id !== id);
        return send(200, { success: true, msg: "destroyed" });
      }
    }

    send(404, { error: "unhandled", path: url.pathname, method: req.method });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
