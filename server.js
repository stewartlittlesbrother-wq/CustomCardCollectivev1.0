const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 8766);
const projectCardsPath = path.join(root, "data", "cards", "custom-project-cards.json");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function normalizeProjectCardPayload(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.cards)
      ? payload.cards
      : Object.values(payload || {});
  const cards = {};

  source.forEach(card => {
    if (!card || typeof card !== "object") return;
    const key = String(card.cardNumber || card.id || "").trim();
    if (!key) return;
    cards[key] = {
      ...card,
      id: card.id || key,
      cardNumber: card.cardNumber || key,
      imported: card.imported !== false,
      updatedAt: new Date().toISOString()
    };
  });

  return cards;
}

async function handleProjectCardsApi(request, response) {
  if (request.method === "GET") {
    fs.readFile(projectCardsPath, "utf8", (error, data) => {
      if (error) {
        sendJson(response, 200, {});
        return;
      }

      try {
        sendJson(response, 200, JSON.parse(data || "{}"));
      } catch {
        sendJson(response, 200, {});
      }
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await readRequestBody(request);
      const cards = normalizeProjectCardPayload(JSON.parse(body || "{}"));
      fs.mkdirSync(path.dirname(projectCardsPath), { recursive: true });
      const tempPath = `${projectCardsPath}.tmp`;
      fs.writeFileSync(tempPath, `${JSON.stringify(cards, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, projectCardsPath);
      sendJson(response, 200, { ok: true, count: Object.keys(cards).length });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(response, 405, { ok: false, error: "Method not allowed" });
}

http.createServer((request, response) => {
  const cleanUrl = decodeURIComponent(request.url.split("?")[0]);

  if (cleanUrl === "/api/project-cards") {
    handleProjectCardsApi(request, response);
    return;
  }

  const requested = cleanUrl === "/" ? "index.html" : cleanUrl.replace(/^\/+/, "");
  const file = path.resolve(root, requested);

  if (!file.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    // Always revalidate. Without this the browser happily serves stale JS/CSS
    // (ES module imports in particular carry no ?v= cache-buster), so code
    // changes appear not to take effect until a hard refresh.
    response.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    response.end(data);
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`Grand Line Deckbuilder running at http://0.0.0.0:${port}`);
});

