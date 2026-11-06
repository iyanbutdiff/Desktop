const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const DATABASE_FILE = path.join(DATA_DIR, "store.sqlite");
const MENU_CATALOG_FILE = path.join(ROOT, "menu-catalog.json");
const MENU_PHOTO_DIR = path.join(DATA_DIR, "menu-photos");
const sessions = new Map();
let database;

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

function readStore() {
  if (!database) throw new Error("The store database has not been initialized.");

  const users = database.prepare(`
    SELECT id, name, email, password_salt, password_hash, role, created_at
    FROM users
  `).all().map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    passwordSalt: user.password_salt,
    passwordHash: user.password_hash,
    role: user.role,
    createdAt: user.created_at,
  }));
  const categories = database.prepare("SELECT name FROM categories ORDER BY name").all()
    .map((category) => category.name);
  const menu = database.prepare(`
    SELECT menu_items.id, menu_items.name, categories.name AS category,
      menu_items.subcategory, menu_items.description, menu_items.price,
      menu_items.available, menu_items.photo_url, menu_items.photo_alt_text
    FROM menu_items
    JOIN categories ON categories.id = menu_items.category_id
    ORDER BY menu_items.menu_position, menu_items.rowid
  `).all().map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    subcategory: item.subcategory,
    description: item.description,
    price: item.price,
    available: Boolean(item.available),
    photoUrl: item.photo_url,
    photoAltText: item.photo_alt_text,
  }));
  const orders = database.prepare(`
    SELECT id, customer_id, customer_name, customer_email, total,
      payment_method, gcash_reference, payment_status, status, created_at
    FROM orders ORDER BY created_at DESC, rowid DESC
  `).all().map((order) => ({
    id: order.id,
    customerId: order.customer_id,
    customerName: order.customer_name,
    customerEmail: order.customer_email,
    total: order.total,
    paymentMethod: order.payment_method,
    gcashReference: order.gcash_reference,
    paymentStatus: order.payment_status,
    status: order.status,
    createdAt: order.created_at,
    items: [],
  }));
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  for (const item of database.prepare(`
    SELECT order_id, item_id, name, description, unit_price, quantity
    FROM order_items ORDER BY order_id, position
  `).all()) {
    ordersById.get(item.order_id)?.items.push({
      id: item.item_id,
      name: item.name,
      description: item.description,
      unitPrice: item.unit_price,
      quantity: item.quantity,
    });
  }
  const metadata = database.prepare("SELECT value FROM app_metadata WHERE key = 'menu_catalog_version'").get();

  return {
    users,
    menu,
    orders,
    categories,
    menuCatalogVersion: metadata ? Number(metadata.value) : 0,
  };
}

function writeStore(store) {
  if (!database) throw new Error("The store database has not been initialized.");

  const categoryNames = new Map();
  for (const name of [
    ...(Array.isArray(store.categories) ? store.categories : []),
    ...store.menu.map((item) => item.category || "Other"),
  ]) {
    if (typeof name === "string" && name.trim()) {
      const trimmedName = name.trim();
      categoryNames.set(trimmedName.toLocaleLowerCase(), trimmedName);
    }
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DELETE FROM order_items;
      DELETE FROM orders;
      DELETE FROM menu_items;
      DELETE FROM users;
      DELETE FROM categories;
    `);
    const insertCategory = database.prepare("INSERT INTO categories (name) VALUES (?)");
    for (const name of categoryNames.values()) insertCategory.run(name);
    const categoryIds = new Map(database.prepare("SELECT id, name FROM categories").all()
      .map((category) => [category.name.toLocaleLowerCase(), category.id]));

    const insertUser = database.prepare(`
      INSERT INTO users (id, name, email, password_salt, password_hash, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const user of store.users) {
      insertUser.run(
        user.id, user.name, user.email, user.passwordSalt, user.passwordHash, user.role, user.createdAt,
      );
    }

    const insertMenuItem = database.prepare(`
      INSERT INTO menu_items (
        id, name, category_id, subcategory, description, price, available, photo_url, photo_alt_text, menu_position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [position, item] of store.menu.entries()) {
      const categoryName = (item.category || "Other").trim();
      const categoryId = categoryIds.get(categoryName.toLocaleLowerCase());
      if (!categoryId) throw new Error(`Menu category "${categoryName}" is not available.`);
      insertMenuItem.run(
        item.id,
        item.name,
        categoryId,
        item.subcategory || "",
        item.description || "",
        item.price,
        item.available ? 1 : 0,
        item.photoUrl || null,
        item.photoAltText || item.name,
        position,
      );
    }

    const insertOrder = database.prepare(`
      INSERT INTO orders (
        id, customer_id, customer_name, customer_email, total, payment_method,
        gcash_reference, payment_status, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOrderItem = database.prepare(`
      INSERT INTO order_items (
        order_id, position, item_id, name, description, unit_price, quantity
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const order of store.orders) {
      insertOrder.run(
        order.id,
        order.customerId,
        order.customerName,
        order.customerEmail,
        order.total,
        order.paymentMethod,
        order.gcashReference || "",
        order.paymentStatus,
        order.status,
        order.createdAt,
      );
      order.items.forEach((item, position) => {
        insertOrderItem.run(
          order.id, position, item.id, item.name, item.description || "", item.unitPrice, item.quantity,
        );
      });
    }

    database.prepare(`
      INSERT INTO app_metadata (key, value) VALUES ('menu_catalog_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(store.menuCatalogVersion || 0));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function initializeDatabase() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  database = new DatabaseSync(DATABASE_FILE);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    );
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      subcategory TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL,
      available INTEGER NOT NULL,
      photo_url TEXT,
      photo_alt_text TEXT NOT NULL,
      menu_position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      gcash_reference TEXT NOT NULL DEFAULT '',
      payment_status TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      PRIMARY KEY (order_id, position)
    );
  `);

  const imported = database.prepare(
    "SELECT value FROM app_metadata WHERE key = 'legacy_json_imported'",
  ).get();
  if (imported) return;

  let initialStore = { users: [], menu: [], orders: [] };
  try {
    initialStore = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    !initialStore ||
    !Array.isArray(initialStore.users) ||
    !Array.isArray(initialStore.menu) ||
    !Array.isArray(initialStore.orders)
  ) {
    throw new Error("Stored data has an invalid structure.");
  }
  writeStore(initialStore);
  database.prepare(
    "INSERT INTO app_metadata (key, value) VALUES ('legacy_json_imported', '1')",
  ).run();
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
    category: item.category || "Other",
    subcategory: item.subcategory || "",
    description: item.description,
    price: item.price,
    available: item.available,
    photoUrl: item.photoUrl || null,
    photoAltText: item.photoAltText || item.name,
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
  if (!validText(body.category, 40)) return "Enter a category (up to 40 characters).";
  if (body.subcategory !== undefined &&
    (typeof body.subcategory !== "string" || body.subcategory.trim().length > 40)) {
    return "Subcategory must be 40 characters or fewer.";
  }
  if (typeof body.description !== "string" || body.description.trim().length > 240) {
    return "Description must be 240 characters or fewer.";
  }
  if (body.photoAltText !== undefined &&
    (typeof body.photoAltText !== "string" || body.photoAltText.trim().length > 160)) {
    return "Photo alt text must be 160 characters or fewer.";
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
      { menu: store.menu.filter((item) => item.available).map((item) => publicMenuItem(item)) },
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

  if (request.method === "GET" && pathname === "/api/admin/categories") {
    if (!requireRole(request, response, "admin")) return;
    const store = await readStore();
    jsonResponse(response, 200, { categories: store.categories });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/categories") {
    if (!requireRole(request, response, "admin")) return;
    const body = await readJson(request);
    if (!validText(body.name, 40)) {
      sendError(response, 400, "Enter a category name (up to 40 characters).");
      return;
    }
    const result = await updateStore((store) => {
      const name = body.name.trim();
      const existing = store.categories.find(
        (category) => category.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (existing) return { category: existing, created: false };
      store.categories.push(name);
      return { category: name, created: true };
    });
    jsonResponse(response, result.created ? 201 : 200, result);
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
        const category = store.categories.find(
          (name) => name.toLocaleLowerCase() === body.category.trim().toLocaleLowerCase(),
        );
        if (!category) {
          return { error: "Choose an existing category or create a new one.", statusCode: 400 };
        }
        const newItem = {
          id: randomBytes(12).toString("hex"),
          name: body.name.trim(),
          category,
          subcategory: (body.subcategory || "").trim(),
          description: body.description.trim(),
          price: Number(Number(body.price).toFixed(2)),
          available: body.available,
          photoUrl,
          photoAltText: body.photoAltText?.trim() || body.name.trim(),
        };
        store.menu.push(newItem);
        return { item: newItem };
      });
    } catch (error) {
      await removeMenuPhoto(photoUrl);
      throw error;
    }
    if (item.error) {
      await removeMenuPhoto(photoUrl);
      sendError(response, item.statusCode, item.error);
      return;
    }
    jsonResponse(response, 201, item);
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
        const category = store.categories.find(
          (name) => name.toLocaleLowerCase() === body.category.trim().toLocaleLowerCase(),
        );
        if (!category) {
          return { error: "Choose an existing category or create a new one.", statusCode: 400 };
        }
        previousPhotoUrl = item.photoUrl;
        Object.assign(item, {
          name: body.name.trim(),
          category,
          subcategory: (body.subcategory || "").trim(),
          description: body.description.trim(),
          price: Number(Number(body.price).toFixed(2)),
          available: body.available,
          photoAltText: body.photoAltText?.trim() || body.name.trim(),
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
          description: item.description || "",
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

function groupCatalogItem(item) {
  const originalCategory = item.category || "Other";
  const name = item.name.trim().toLowerCase();
  const description = (item.description || "").trim().toLowerCase();

  if (originalCategory === "Fried Chicken") {
    if (name.includes("rice bowl") || name.includes("with rice")) {
      return { category: "Rice Meals", subcategory: "Chicken Rice Meals" };
    }
    if (name.includes("mini fried")) return { category: originalCategory, subcategory: "Mini Fried Chicken" };
    return { category: originalCategory, subcategory: "Fried Chicken" };
  }
  if (originalCategory === "Rice Meals") {
    if (name.startsWith("sisig")) {
      return {
        category: "Rice Meals",
        subcategory: name.includes("sharing") ? "Sisig Sharing" : "Sisig Meals",
      };
    }
    return { category: "Rice Meals", subcategory: "Special Rice Meals" };
  }
  if (originalCategory === "Sisig Rice Meals" || originalCategory === "Rice Meal Specials") {
    return {
      category: "Rice Meals",
      subcategory: name.includes("sisig")
        ? name.includes("sharing") ? "Sisig Sharing" : "Sisig Meals"
        : "Special Rice Meals",
    };
  }
  if (originalCategory === "Drinks") {
    return {
      category: "Soda & Juices",
      subcategory: name.includes("soda pop") ? "Soda Pop (16 oz)" : "Juices (16 oz)",
    };
  }
  if (["Iced Coffee", "Hot Coffee"].includes(originalCategory)) {
    return { category: "Coffee", subcategory: originalCategory };
  }
  if (["Iced Milk", "Hot Milk"].includes(originalCategory)) {
    return { category: "Milk Drinks", subcategory: originalCategory };
  }
  if (originalCategory === "Frappes") {
    return { category: "Frappe", subcategory: "Frappes" };
  }
  if (originalCategory === "Matcha") {
    return { category: "Matcha & Tea", subcategory: "Matcha" };
  }
  if (originalCategory === "Coffee, Tea & Matcha") {
    if (item.subcategory === "Frappes") return { category: "Frappe", subcategory: "Frappes" };
    if (item.subcategory === "Matcha") return { category: "Matcha & Tea", subcategory: "Matcha" };
    if (item.subcategory === "Iced Milk" || item.subcategory === "Hot Milk") {
      return { category: "Milk Drinks", subcategory: item.subcategory };
    }
    return { category: "Coffee", subcategory: item.subcategory || "Coffee" };
  }
  if (originalCategory === "Desserts") {
    return {
      category: originalCategory,
      subcategory: name.includes("croffle") ? "Croffles" : "Premium Ube Halo-Halo",
    };
  }
  if (originalCategory === "Pasta") {
    return { category: originalCategory, subcategory: "Pasta" };
  }
  if (originalCategory === "Kimchi Series") {
    return {
      category: originalCategory,
      subcategory: name.includes("ramen") ? "Kimchi Ramen" : "Kimchi Stew",
    };
  }
  if (originalCategory === "Appetizers") {
    return {
      category: originalCategory,
      subcategory: name.includes("fries") ? "French Fries" : "Nachos Overload",
    };
  }
  if (originalCategory === "Other" &&
    (name.includes("americano") || /coffee|tea|matcha/.test(description))) {
    return { category: "Coffee", subcategory: "Coffee" };
  }
  return { category: originalCategory, subcategory: item.subcategory || "" };
}

async function initializeMenuCatalog() {
  await initializeDatabase();
  const store = await readStore();
  if (store.menuCatalogVersion >= 9) return;

  const catalog = JSON.parse(await fs.readFile(MENU_CATALOG_FILE, "utf8"));
  if (!Array.isArray(catalog.items)) {
    throw new Error("The default menu catalog has an invalid structure.");
  }
  for (const item of store.menu) {
    Object.assign(item, groupCatalogItem(item));
    item.photoAltText ||= item.name;
  }
  const catalogKey = (item, category = item.category) => JSON.stringify([
    category.trim().toLowerCase(),
    item.name.trim().toLowerCase(),
    (item.description || "").trim().toLowerCase(),
    Number(item.price),
  ]);
  const duplicateIds = new Set();
  for (const item of catalog.items) {
    const groups = groupCatalogItem(item);
    const matches = store.menu.filter((existing) =>
      catalogKey(existing) === catalogKey(item, groups.category),
    );
    if (matches.length) {
      const keep = matches.find((existing) => existing.photoUrl) || matches[0];
      Object.assign(keep, groups);
      keep.photoAltText ||= keep.name;
      for (const duplicate of matches) {
        if (duplicate !== keep) duplicateIds.add(duplicate.id);
      }
      continue;
    }
    store.menu.push({
      id: randomBytes(12).toString("hex"),
      name: item.name,
      ...groups,
      description: item.description || "",
      price: item.price,
      available: true,
      photoAltText: item.name,
    });
  }
  store.menu = store.menu.filter((item) => !duplicateIds.has(item.id));
  store.categories = store.categories.filter((category) =>
    !["Coffee, Tea & Matcha", "Sisig Rice Meals", "Rice Meal Specials"].includes(category),
  );
  store.menuCatalogVersion = 9;
  await writeStore(store);
}

initializeMenuCatalog().then(() => {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Suarez Farms ordering system is available at http://127.0.0.1:${PORT}`);
  });
}).catch((error) => {
  console.error("Could not initialize the menu catalog:", error);
  process.exitCode = 1;
});
