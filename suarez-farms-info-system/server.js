const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const MENU_PHOTO_DIR = path.join(DATA_DIR, "menu-photos");
const sessions = new Map();

function loadEnvironment() {
  let file;
  try {
    file = require("node:fs").readFileSync(path.join(ROOT, ".env"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = "";
  }

  for (const line of file.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (match && !Object.hasOwn(process.env, match[1])) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

loadEnvironment();

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "adminsuarez";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = Number(process.env.PORT || 3000);

if (!ADMIN_PASSWORD) {
  throw new Error("Set ADMIN_PASSWORD in .env before starting the server.");
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

if (ADMIN_PASSWORD === "admin") {
  console.warn("Warning: change the default admin password before deployment.");
}

const adminSalt = randomBytes(16);
const adminPasswordHash = scryptSync(ADMIN_PASSWORD, adminSalt, 64);

function jsonResponse(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  jsonResponse(response, statusCode, { error: message });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object.");
    error.statusCode = 400;
    throw error;
  }
  return body;
}

async function readStore() {
  try {
    const content = await fs.readFile(DATA_FILE, "utf8");
    const store = JSON.parse(content);
    if (
      !Array.isArray(store.users) ||
      !Array.isArray(store.menu) ||
      !Array.isArray(store.orders)
    ) {
      throw new Error("Stored data has an invalid structure.");
    }
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const initialStore = { users: [], menu: [], orders: [] };
    await writeStore(initialStore);
    return initialStore;
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporaryFile, DATA_FILE);
}

let storeMutationQueue = Promise.resolve();

function updateStore(mutator) {
  const operation = storeMutationQueue.then(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await writeStore(store);
    return result;
  });
  storeMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function safeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

function readCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value !== undefined),
  );
}

function getSession(request) {
  const token = readCookies(request).sf_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function setSession(response, user) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { user: safeUser(user), expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  response.setHeader(
    "Set-Cookie",
    `sf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
  );
}

function requireRole(request, response, role) {
  const session = getSession(request);
  if (!session) {
    sendError(response, 401, "Please sign in to continue.");
    return null;
  }
  if (session.user.role !== role) {
    sendError(response, 403, "You do not have permission to do that.");
    return null;
  }
  return session.user;
}

function validText(value, maximumLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximumLength;
}

function validEmail(value) {
  return typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicMenuItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    available: item.available,
    photoUrl: item.photoUrl || null,
  };
}

function parseMenuPhoto(photo) {
  if (photo === undefined || photo === null || photo === "") return null;
  if (typeof photo !== "string") return "Choose a valid JPG, PNG or WebP image.";
  const match = photo.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return "Choose a valid JPG, PNG or WebP image.";

  const content = Buffer.from(match[2], "base64");
  if (!content.length || content.length > 5 * 1024 * 1024 || content.toString("base64") !== match[2]) {
    return "Menu photos must be no larger than 5 MB.";
  }
  const validSignature = {
    jpeg: content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff,
    png: content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    webp: content.length >= 12 && content.toString("ascii", 0, 4) === "RIFF" &&
      content.toString("ascii", 8, 12) === "WEBP",
  }[match[1]];
  if (!validSignature) return "The selected file does not match its image type.";
  return {
    content,
    extension: match[1] === "jpeg" ? "jpg" : match[1],
  };
}

async function saveMenuPhoto(photo) {
  const parsed = parseMenuPhoto(photo);
  if (typeof parsed === "string") {
    const error = new Error(parsed);
    error.statusCode = 400;
    throw error;
  }
  if (!parsed) return null;
  const filename = `${randomBytes(16).toString("hex")}.${parsed.extension}`;
  await fs.mkdir(MENU_PHOTO_DIR, { recursive: true });
  await fs.writeFile(path.join(MENU_PHOTO_DIR, filename), parsed.content, { flag: "wx" });
  return `/uploads/${filename}`;
}

async function removeMenuPhoto(photoUrl) {
  const match = typeof photoUrl === "string" &&
    photoUrl.match(/^\/uploads\/([a-f0-9]{32}\.(?:jpg|png|webp))$/);
  if (!match) return;
  try {
    await fs.unlink(path.join(MENU_PHOTO_DIR, match[1]));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function validateMenuItem(body) {
  const price = Number(body.price);
  if (!validText(body.name, 80)) return "Enter an item name (up to 80 characters).";
  if (typeof body.description !== "string" || body.description.trim().length > 240) {
    return "Description must be 240 characters or fewer.";
  }
  if (!Number.isFinite(price) || price <= 0 || price > 100000) {
    return "Enter a price greater than 0 and no more than 100,000.";
  }
  if (Math.round(price * 100) !== price * 100) {
    return "Price can have at most two decimal places.";
  }
  if (typeof body.available !== "boolean") return "Choose whether the item is available.";
  if (body.removePhoto !== undefined && typeof body.removePhoto !== "boolean") {
    return "Choose whether to remove the current photo.";
  }
  if (body.removePhoto && body.photo) return "Choose a new photo or remove the current one, not both.";
  const photoError = parseMenuPhoto(body.photo);
  if (typeof photoError === "string") return photoError;
  return null;
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  }[extension];
}

async function serveStatic(pathname, response) {
  const files = {
    "/": path.join(ROOT, "index.html"),
    "/index.html": path.join(ROOT, "index.html"),
    "/styles.css": path.join(ROOT, "styles.css"),
    "/script.js": path.join(ROOT, "script.js"),
  };
  let filePath = files[pathname];
  if (!filePath && /^\/assets\/(?:menu\/)?[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(pathname)) {
    filePath = path.join(ROOT, pathname.slice(1));
  }
  const uploadMatch = pathname.match(/^\/uploads\/([a-f0-9]{32}\.(?:jpg|png|webp))$/);
  if (!filePath && uploadMatch) filePath = path.join(MENU_PHOTO_DIR, uploadMatch[1]);
  if (!filePath) {
    sendError(response, 404, "Page not found.");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendError(response, 404, "File not found.");
      return;
    }
    throw error;
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  const { pathname } = url;

  if (!pathname.startsWith("/api/")) {
    if (request.method !== "GET") {
      sendError(response, 405, "Method not allowed.");
      return;
    }
    await serveStatic(pathname, response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/session") {
    const session = getSession(request);
    jsonResponse(response, 200, { user: session ? session.user : null });
    return;
  }

  if (request.method === "GET" && pathname === "/api/menu") {
    const store = await readStore();
    jsonResponse(
      response,
      200,
      { menu: store.menu.filter((item) => item.available).map(publicMenuItem) },
    );
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/register") {
    const body = await readJson(request);
    if (!validText(body.name, 80)) {
      sendError(response, 400, "Enter your name (up to 80 characters).");
      return;
    }
    if (!validEmail(body.email)) {
      sendError(response, 400, "Enter a valid email address.");
      return;
    }
    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
      sendError(response, 400, "Password must be between 8 and 128 characters.");
      return;
    }

    const email = body.email.trim().toLowerCase();
    const result = await updateStore((store) => {
      if (store.users.some((user) => user.email === email)) {
        return { error: "An account with that email already exists.", statusCode: 409 };
      }
      const salt = randomBytes(16);
      const user = {
        id: randomBytes(16).toString("hex"),
        name: body.name.trim(),
        email,
        passwordSalt: salt.toString("hex"),
        passwordHash: scryptSync(body.password, salt, 64).toString("hex"),
        role: "customer",
        createdAt: new Date().toISOString(),
      };
      store.users.push(user);
      return { user };
    });
    if (result.error) {
      sendError(response, result.statusCode, result.error);
      return;
    }
    setSession(response, result.user);
    jsonResponse(response, 201, { user: safeUser(result.user) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(request);
    if (body.role === "admin") {
      if (
        body.username !== ADMIN_USERNAME ||
        typeof body.password !== "string" ||
        !timingSafeEqual(
          scryptSync(body.password, adminSalt, 64),
          adminPasswordHash,
        )
      ) {
        sendError(response, 401, "Incorrect admin username or password.");
        return;
      }
      const admin = { id: "admin", name: "Suarez Farms Admin", role: "admin" };
      setSession(response, admin);
      jsonResponse(response, 200, { user: safeUser(admin) });
      return;
    }

    if (body.role !== "customer" || !validEmail(body.email) || typeof body.password !== "string") {
      sendError(response, 400, "Enter your account email and password.");
      return;
    }
    const store = await readStore();
    const email = body.email.trim().toLowerCase();
    const user = store.users.find((candidate) => candidate.email === email);
    const salt = user ? Buffer.from(user.passwordSalt, "hex") : Buffer.alloc(16);
    const expectedHash = user ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
    const submittedHash = scryptSync(body.password, salt, 64);
    if (!user || !timingSafeEqual(submittedHash, expectedHash)) {
      sendError(response, 401, "Incorrect email or password.");
      return;
    }
    setSession(response, user);
    jsonResponse(response, 200, { user: safeUser(user) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    response.setHeader("Set-Cookie", "sf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/menu") {
    if (!requireRole(request, response, "admin")) return;
    const store = await readStore();
    jsonResponse(response, 200, { menu: store.menu.map(publicMenuItem) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/menu") {
    if (!requireRole(request, response, "admin")) return;
    const body = await readJson(request);
    const error = validateMenuItem(body);
    if (error || body.removePhoto) {
      sendError(response, 400, error || "A new menu item cannot remove an existing photo.");
      return;
    }
    const photoUrl = await saveMenuPhoto(body.photo);
    let item;
    try {
      item = await updateStore((store) => {
        const newItem = {
          id: randomBytes(12).toString("hex"),
          name: body.name.trim(),
          description: body.description.trim(),
          price: Number(Number(body.price).toFixed(2)),
          available: body.available,
          photoUrl,
        };
        store.menu.push(newItem);
        return newItem;
      });
    } catch (error) {
      await removeMenuPhoto(photoUrl);
      throw error;
    }
    jsonResponse(response, 201, { item });
    return;
  }

  const menuItemMatch = pathname.match(/^\/api\/admin\/menu\/([a-f0-9]{24})$/);
  if (menuItemMatch && request.method === "PUT") {
    if (!requireRole(request, response, "admin")) return;
    const body = await readJson(request);
    const error = validateMenuItem(body);
    if (error) {
      sendError(response, 400, error);
      return;
    }
    const photoUrl = await saveMenuPhoto(body.photo);
    let previousPhotoUrl;
    let result;
    try {
      result = await updateStore((store) => {
        const item = store.menu.find((candidate) => candidate.id === menuItemMatch[1]);
        if (!item) return { error: "Menu item not found.", statusCode: 404 };
        previousPhotoUrl = item.photoUrl;
        Object.assign(item, {
          name: body.name.trim(),
          description: body.description.trim(),
          price: Number(Number(body.price).toFixed(2)),
          available: body.available,
        });
        if (photoUrl) item.photoUrl = photoUrl;
        else if (body.removePhoto) delete item.photoUrl;
        return { item };
      });
    } catch (error) {
      await removeMenuPhoto(photoUrl);
      throw error;
    }
    if (result.error) {
      await removeMenuPhoto(photoUrl);
      sendError(response, result.statusCode, result.error);
      return;
    }
    if (photoUrl || body.removePhoto) await removeMenuPhoto(previousPhotoUrl);
    jsonResponse(response, 200, { item: result.item });
    return;
  }

  if (menuItemMatch && request.method === "DELETE") {
    if (!requireRole(request, response, "admin")) return;
    const result = await updateStore((store) => {
      const index = store.menu.findIndex((item) => item.id === menuItemMatch[1]);
      if (index < 0) return { error: "Menu item not found.", statusCode: 404 };
      const [item] = store.menu.splice(index, 1);
      return { ok: true, photoUrl: item.photoUrl };
    });
    if (result.error) {
      sendError(response, result.statusCode, result.error);
      return;
    }
    await removeMenuPhoto(result.photoUrl);
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/orders/mine") {
    const customer = requireRole(request, response, "customer");
    if (!customer) return;
    const store = await readStore();
    const orders = store.orders.filter((order) => order.customerId === customer.id);
    jsonResponse(response, 200, { orders });
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders") {
    const customer = requireRole(request, response, "customer");
    if (!customer) return;
    const body = await readJson(request);
    if (body.paymentMethod !== "gcash") {
      sendError(response, 400, "GCash is the required payment method.");
      return;
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
      sendError(response, 400, "Add at least one menu item to your order.");
      return;
    }
    if (body.gcashReference !== undefined &&
      (typeof body.gcashReference !== "string" || body.gcashReference.length > 80)) {
      sendError(response, 400, "GCash reference must be 80 characters or fewer.");
      return;
    }
    if (body.items.some((item) => !item || typeof item.id !== "string" ||
      !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) {
      sendError(response, 400, "Each order item needs a valid quantity from 1 to 20.");
      return;
    }

    const result = await updateStore((store) => {
      const orderItems = [];
      for (const requested of body.items) {
        const item = store.menu.find((candidate) =>
          candidate.id === requested.id && candidate.available,
        );
        if (!item) {
          return { error: "An item in your cart is no longer available.", statusCode: 400 };
        }
        orderItems.push({
          id: item.id,
          name: item.name,
          unitPrice: item.price,
          quantity: requested.quantity,
        });
      }
      const totalInCents = orderItems.reduce(
        (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
        0,
      );
      const order = {
        id: randomBytes(8).toString("hex").toUpperCase(),
        customerId: customer.id,
        customerName: customer.name,
        customerEmail: customer.email,
        items: orderItems,
        total: totalInCents / 100,
        paymentMethod: "gcash",
        gcashReference: (body.gcashReference || "").trim(),
        paymentStatus: "pending",
        status: "received",
        createdAt: new Date().toISOString(),
      };
      store.orders.unshift(order);
      return { order };
    });
    if (result.error) {
      sendError(response, result.statusCode, result.error);
      return;
    }
    jsonResponse(response, 201, { order: result.order });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/orders") {
    if (!requireRole(request, response, "admin")) return;
    const store = await readStore();
    jsonResponse(response, 200, { orders: store.orders });
    return;
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([A-F0-9]{16})$/);
  if (orderMatch && request.method === "PATCH") {
    if (!requireRole(request, response, "admin")) return;
    const body = await readJson(request);
    const validStatuses = ["received", "preparing", "ready", "completed", "cancelled"];
    if (body.status !== undefined && !validStatuses.includes(body.status)) {
      sendError(response, 400, "Choose a valid order status.");
      return;
    }
    if (body.paymentStatus !== undefined && !["pending", "paid"].includes(body.paymentStatus)) {
      sendError(response, 400, "Choose a valid payment status.");
      return;
    }
    const result = await updateStore((store) => {
      const order = store.orders.find((candidate) => candidate.id === orderMatch[1]);
      if (!order) return { error: "Order not found.", statusCode: 404 };
      if (body.status !== undefined) order.status = body.status;
      if (body.paymentStatus !== undefined) order.paymentStatus = body.paymentStatus;
      return { order };
    });
    if (result.error) {
      sendError(response, result.statusCode, result.error);
      return;
    }
    jsonResponse(response, 200, { order: result.order });
    return;
  }

  sendError(response, 404, "API endpoint not found.");
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    if (error.statusCode) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    console.error("Request failed:", error);
    sendError(response, 500, "An unexpected server error occurred.");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Suarez Farms ordering system is available at http://127.0.0.1:${PORT}`);
});
