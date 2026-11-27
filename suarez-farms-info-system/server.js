const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} = require("node:crypto");

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const DATABASE_FILE = path.join(DATA_DIR, "store.sqlite");
const MENU_PHOTO_DIR = path.join(DATA_DIR, "menu-photos");
const ORDER_RECEIPT_DIR = path.join(DATA_DIR, "order-receipts");
const PAYMENT_ASSET_DIR = path.join(DATA_DIR, "payment-assets");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STATE_TABLE = "suarez_farms_state";
const PUBLIC_BUCKET = "suarez-farms-public";
const PRIVATE_BUCKET = "suarez-farms-private";
const lookupAttempts = new Map();
const localSessions = new Map();
let DatabaseSync;
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
  let body = request.body;
  if (body === undefined) {
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
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      const error = new Error("Request body must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  } else if (typeof body === "string" || Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString());
    } catch {
      const error = new Error("Request body must be valid JSON.");
      error.statusCode = 400;
      throw error;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object.");
    error.statusCode = 400;
    throw error;
  }
  return body;
}

function isSupabaseMode() {
  return Boolean(process.env.VERCEL || SUPABASE_URL || SUPABASE_SERVICE_ROLE_KEY);
}

function stateEndpoint(query = "") {
  return `/rest/v1/${STATE_TABLE}${query}`;
}

async function supabaseRequest(endpoint, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the deployment environment.");
  }
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const detail = typeof payload === "string"
      ? payload
      : payload?.message || payload?.error || response.statusText;
    const error = new Error(`Supabase request failed (${response.status}): ${detail}`);
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

function emptyStore() {
  return {
    users: [],
    menu: [],
    orders: [],
    categories: [],
    addons: [
      { id: "espresso-shot", name: "Extra espresso shot", price: 25, available: true },
      { id: "oat-milk", name: "Oat milk", price: 20, available: true },
      { id: "caramel-syrup", name: "Caramel syrup", price: 15, available: true },
      { id: "vanilla-syrup", name: "Vanilla syrup", price: 15, available: true },
      { id: "whipped-cream", name: "Whipped cream", price: 20, available: true },
    ],
    settings: {
      gcash_merchant_name: process.env.GCASH_MERCHANT_NAME || "Suarez Farms",
      gcash_merchant_number: process.env.GCASH_MERCHANT_NUMBER || "",
    },
    sessions: [],
    menuCatalogVersion: 0,
  };
}

function addStoreRevision(store, revision) {
  Object.defineProperty(store, "__revision", {
    configurable: true,
    value: Number(revision),
    writable: true,
  });
  return store;
}

async function readSupabaseStore() {
  const rows = await supabaseRequest(stateEndpoint("?id=eq.main&select=revision,state"));
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("The Supabase state row is missing. Run supabase-schema.sql in the Supabase SQL Editor.");
  }
  const row = rows[0];
  if (!row.state || typeof row.state !== "object" || Array.isArray(row.state)) {
    throw new Error("The Supabase application state has an invalid structure.");
  }
  return addStoreRevision({
    ...emptyStore(),
    ...row.state,
    users: Array.isArray(row.state.users) ? row.state.users : [],
    menu: Array.isArray(row.state.menu) ? row.state.menu : [],
    orders: Array.isArray(row.state.orders) ? row.state.orders : [],
    categories: Array.isArray(row.state.categories) ? row.state.categories : [],
    addons: Array.isArray(row.state.addons) ? row.state.addons : [],
    settings: row.state.settings && typeof row.state.settings === "object"
      ? row.state.settings
      : {},
    sessions: Array.isArray(row.state.sessions) ? row.state.sessions : [],
  }, row.revision);
}

async function writeSupabaseStore(store) {
  const revision = store.__revision;
  if (!Number.isInteger(revision)) {
    throw new Error("Cannot save application state without its Supabase revision.");
  }
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
  store.categories = [...categoryNames.values()];
  const rows = await supabaseRequest(
    stateEndpoint(`?id=eq.main&revision=eq.${revision}&select=revision`),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ revision: revision + 1, state: store }),
    },
  );
  if (!Array.isArray(rows) || rows.length === 0) return false;
  store.__revision = revision + 1;
  return true;
}

async function initializeSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel Environment Variables.");
  }
  const rows = await supabaseRequest(stateEndpoint("?id=eq.main&select=id"));
  if (!Array.isArray(rows) || rows.length === 0) {
    await supabaseRequest(stateEndpoint("?on_conflict=id"), {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify([{ id: "main", revision: 0, state: emptyStore() }]),
    });
  }
  await readSupabaseStore();
}

async function readStore() {
  if (isSupabaseMode()) return readSupabaseStore();
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
      payment_method, gcash_reference, payment_status, status, created_at,
      receipt_path, verified_at
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
    receiptPath: order.receipt_path,
    verifiedAt: order.verified_at,
    items: [],
  }));
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  for (const item of database.prepare(`
    SELECT order_id, item_id, name, description, unit_price, quantity, customizations_json
    FROM order_items ORDER BY order_id, position
  `).all()) {
    ordersById.get(item.order_id)?.items.push({
      id: item.item_id,
      name: item.name,
      description: item.description,
      unitPrice: item.unit_price,
      quantity: item.quantity,
      customizations: JSON.parse(item.customizations_json || "{}"),
    });
  }
  const metadata = database.prepare("SELECT value FROM app_metadata WHERE key = 'menu_catalog_version'").get();
  const addons = database.prepare(
    "SELECT id, name, price, available FROM addons ORDER BY name",
  ).all().map((addon) => ({
    id: addon.id,
    name: addon.name,
    price: addon.price,
    available: Boolean(addon.available),
  }));
  const settings = Object.fromEntries(database.prepare(
    "SELECT key, value FROM store_settings",
  ).all().map((setting) => [setting.key, setting.value]));

  return {
    users,
    menu,
    orders,
    categories,
    addons,
    settings,
    menuCatalogVersion: metadata ? Number(metadata.value) : 0,
  };
}

async function writeStore(store) {
  if (isSupabaseMode()) return writeSupabaseStore(store);
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
        gcash_reference, payment_status, status, created_at, receipt_path, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOrderItem = database.prepare(`
      INSERT INTO order_items (
        order_id, position, item_id, name, description, unit_price, quantity, customizations_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
        order.receiptPath || null,
        order.verifiedAt || null,
      );
      order.items.forEach((item, position) => {
        insertOrderItem.run(
          order.id,
          position,
          item.id,
          item.name,
          item.description || "",
          item.unitPrice,
          item.quantity,
          JSON.stringify(item.customizations || {}),
        );
      });
    }

    database.prepare(`
      INSERT INTO app_metadata (key, value) VALUES ('menu_catalog_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(store.menuCatalogVersion || 0));
    if (store.settings) {
      database.prepare("DELETE FROM store_settings").run();
      const insertSetting = database.prepare(
        "INSERT INTO store_settings (key, value) VALUES (?, ?)",
      );
      for (const [key, value] of Object.entries(store.settings)) {
        insertSetting.run(key, value);
      }
    }
    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function initializeDatabase() {
  if (isSupabaseMode()) {
    await initializeSupabase();
    return;
  }
  ({ DatabaseSync } = require("node:sqlite"));
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
      created_at TEXT NOT NULL,
      receipt_path TEXT,
      verified_at TEXT
    );
    CREATE TABLE IF NOT EXISTS order_items (
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL,
      customizations_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (order_id, position)
    );
    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      price REAL NOT NULL CHECK (price >= 0),
      available INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS store_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const ensureColumn = (table, column, definition) => {
    const existing = database.prepare(`PRAGMA table_info(${table})`).all()
      .some((entry) => entry.name === column);
    if (!existing) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn("orders", "receipt_path", "TEXT");
  ensureColumn("orders", "verified_at", "TEXT");
  ensureColumn("order_items", "customizations_json", "TEXT NOT NULL DEFAULT '{}'");
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_gcash_reference_unique
      ON orders(gcash_reference) WHERE gcash_reference <> '';
    CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders(created_at);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, payment_status);
  `);
  database.prepare(
    "INSERT OR IGNORE INTO store_settings (key, value) VALUES (?, ?)",
  ).run("gcash_merchant_name", process.env.GCASH_MERCHANT_NAME || "Suarez Farms");
  database.prepare(
    "INSERT OR IGNORE INTO store_settings (key, value) VALUES (?, ?)",
  ).run("gcash_merchant_number", process.env.GCASH_MERCHANT_NUMBER || "");
  const addonCount = database.prepare("SELECT COUNT(*) AS count FROM addons").get().count;
  if (addonCount === 0) {
    const insertAddon = database.prepare(
      "INSERT INTO addons (id, name, price, available) VALUES (?, ?, ?, 1)",
    );
    for (const addon of [
      ["espresso-shot", "Extra espresso shot", 25],
      ["oat-milk", "Oat milk", 20],
      ["caramel-syrup", "Caramel syrup", 15],
      ["vanilla-syrup", "Vanilla syrup", 15],
      ["whipped-cream", "Whipped cream", 20],
    ]) insertAddon.run(...addon);
  }

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
  await writeStore(initialStore);
  database.prepare(
    "INSERT INTO app_metadata (key, value) VALUES ('legacy_json_imported', '1')",
  ).run();
}

let storeMutationQueue = Promise.resolve();

function updateStore(mutator) {
  const operation = storeMutationQueue.then(async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const store = await readStore();
      const result = await mutator(store);
      if (await writeStore(store)) return result;
    }
    const error = new Error("The store changed repeatedly while saving. Please retry the request.");
    error.statusCode = 503;
    throw error;
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

async function getSession(request) {
  const token = readCookies(request).sf_session;
  if (!token) return null;
  if (!isSupabaseMode()) {
    const session = localSessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      localSessions.delete(token);
      return null;
    }
    return { token, ...session };
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const store = await readStore();
  const session = store.sessions.find((entry) => entry.tokenHash === tokenHash);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await updateStore((currentStore) => {
      currentStore.sessions = currentStore.sessions.filter(
        (entry) => entry.expiresAt >= Date.now(),
      );
    });
    return null;
  }
  return { token, user: session.user, expiresAt: session.expiresAt };
}

async function setSession(response, user) {
  const token = randomBytes(32).toString("base64url");
  const session = { user: safeUser(user), expiresAt: Date.now() + 8 * 60 * 60 * 1000 };
  if (isSupabaseMode()) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await updateStore((store) => {
      store.sessions = store.sessions.filter((entry) => entry.expiresAt >= Date.now());
      store.sessions.push({ tokenHash, ...session });
    });
  } else {
    localSessions.set(token, session);
  }
  const secure = process.env.VERCEL || process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `sf_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`,
  );
}

async function requireRole(request, response, role) {
  const session = await getSession(request);
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
  const beverageCategories = new Set([
    "Coffee",
    "Frappe",
    "Milk Drinks",
    "Matcha & Tea",
    "Soda & Juices",
  ]);
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
    customizable: beverageCategories.has(item.category || "Other"),
  };
}

function publicOrder(order, includeCustomer = false) {
  const result = {
    id: order.id,
    total: order.total,
    paymentMethod: order.paymentMethod,
    gcashReference: order.gcashReference,
    paymentStatus: order.paymentStatus,
    status: order.status,
    createdAt: order.createdAt,
    verifiedAt: order.verifiedAt || null,
    receiptAvailable: Boolean(order.receiptPath),
    items: order.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      customizations: item.customizations || {},
    })),
  };
  if (includeCustomer) {
    result.customerName = order.customerName;
    result.customerEmail = order.customerEmail;
  }
  return result;
}

function storefrontPaymentConfig(settings) {
  const qrImageUrl = settings.gcash_qr_url || "";
  const merchantNumber = settings.gcash_merchant_number || "";
  return {
    merchantName: settings.gcash_merchant_name || "Suarez Farms",
    merchantNumber,
    qrImageUrl,
    configured: Boolean(merchantNumber && qrImageUrl),
  };
}

function checkOrderLookupRateLimit(request) {
  const forwardedAddress = request.headers["x-forwarded-for"];
  const address = (typeof forwardedAddress === "string" && forwardedAddress.split(",")[0].trim()) ||
    request.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const attempts = (lookupAttempts.get(address) || []).filter((time) => now - time < 60_000);
  if (attempts.length >= 12) return false;
  attempts.push(now);
  lookupAttempts.set(address, attempts);
  return true;
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

function storageObjectPath(folder, filename) {
  return `${folder}/${filename}`;
}

function publicStorageUrl(bucket, objectPath) {
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodedPath}`;
}

async function uploadStorageObject(bucket, objectPath, content, extension) {
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const contentType = {
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  }[extension];
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": contentType,
        "x-upsert": "false",
      },
      body: content,
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Supabase Storage upload failed (${response.status}): ${detail}`);
    error.statusCode = 502;
    throw error;
  }
}

async function deleteStorageObject(bucket, objectPath) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}`,
    {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [objectPath] }),
    },
  );
  if (!response.ok && response.status !== 404) {
    const detail = await response.text();
    const error = new Error(`Supabase Storage delete failed (${response.status}): ${detail}`);
    error.statusCode = 502;
    throw error;
  }
}

async function downloadStorageObject(bucket, objectPath) {
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    const error = new Error(`Supabase Storage download failed (${response.status}): ${detail}`);
    error.statusCode = response.status === 404 ? 400 : 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}

async function validateStoredImage(bucket, folder, objectPath) {
  const match = typeof objectPath === "string" &&
    objectPath.match(new RegExp(`^${folder}/([a-f0-9]{32}\\.(?:jpg|png|webp))$`));
  if (!match) {
    const error = new Error("The uploaded image reference is invalid.");
    error.statusCode = 400;
    throw error;
  }
  const content = await downloadStorageObject(bucket, objectPath);
  const extension = path.extname(match[1]).slice(1);
  const dataUrl = `data:image/${extension === "jpg" ? "jpeg" : extension};base64,${content.toString("base64")}`;
  const parsed = parseMenuPhoto(dataUrl);
  if (typeof parsed === "string") {
    const error = new Error(parsed);
    error.statusCode = 400;
    throw error;
  }
  return { filename: match[1], parsed };
}

async function createSignedUpload(kind, contentType, size) {
  const settings = {
    "menu-photo": { bucket: PUBLIC_BUCKET, folder: "menu-photos" },
    "payment-qr": { bucket: PUBLIC_BUCKET, folder: "payment-assets" },
    receipt: { bucket: PRIVATE_BUCKET, folder: "order-receipts" },
  };
  const config = settings[kind];
  if (!config || !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
    !Number.isInteger(size) || size < 1 || size > 5 * 1024 * 1024) {
    const error = new Error("Choose a JPG, PNG or WebP image no larger than 5 MB.");
    error.statusCode = 400;
    throw error;
  }
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType];
  const objectPath = storageObjectPath(config.folder, `${randomBytes(16).toString("hex")}.${extension}`);
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${config.bucket}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    },
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      `Could not create an image upload link (${response.status}): ${payload.message || payload.error || response.statusText}`,
    );
    error.statusCode = 502;
    throw error;
  }
  const signedPath = payload.signedURL || payload.signedUrl || payload.url;
  if (typeof signedPath !== "string") {
    throw new Error("Supabase did not return a signed upload URL.");
  }
  const uploadUrl = /^https?:\/\//i.test(signedPath)
    ? signedPath
    : `${SUPABASE_URL}/storage/v1${signedPath.startsWith("/") ? signedPath : `/${signedPath}`}`;
  return {
    uploadUrl,
    objectPath,
    publicUrl: config.bucket === PUBLIC_BUCKET
      ? publicStorageUrl(config.bucket, objectPath)
      : null,
  };
}

async function saveMenuPhoto(photo) {
  if (isSupabaseMode() && typeof photo === "string" && !photo.startsWith("data:")) {
    await validateStoredImage(PUBLIC_BUCKET, "menu-photos", photo);
    return publicStorageUrl(PUBLIC_BUCKET, storageObjectPath("menu-photos", path.basename(photo)));
  }
  const parsed = parseMenuPhoto(photo);
  if (typeof parsed === "string") {
    const error = new Error(parsed);
    error.statusCode = 400;
    throw error;
  }
  if (!parsed) return null;
  const filename = `${randomBytes(16).toString("hex")}.${parsed.extension}`;
  if (isSupabaseMode()) {
    const objectPath = storageObjectPath("menu-photos", filename);
    await uploadStorageObject(PUBLIC_BUCKET, objectPath, parsed.content, parsed.extension);
    return publicStorageUrl(PUBLIC_BUCKET, objectPath);
  }
  await fs.mkdir(MENU_PHOTO_DIR, { recursive: true });
  await fs.writeFile(path.join(MENU_PHOTO_DIR, filename), parsed.content, { flag: "wx" });
  return `/uploads/${filename}`;
}

async function saveImageDataUrl(dataUrl, directory) {
  if (isSupabaseMode() && typeof dataUrl === "string" && !dataUrl.startsWith("data:")) {
    const folder = path.basename(directory);
    const bucket = folder === "order-receipts" ? PRIVATE_BUCKET : PUBLIC_BUCKET;
    const { filename } = await validateStoredImage(bucket, folder, dataUrl);
    return filename;
  }
  const parsed = parseMenuPhoto(dataUrl);
  if (typeof parsed === "string") {
    const error = new Error(parsed);
    error.statusCode = 400;
    throw error;
  }
  if (!parsed) return null;
  const filename = `${randomBytes(16).toString("hex")}.${parsed.extension}`;
  if (isSupabaseMode()) {
    const folder = path.basename(directory);
    const bucket = folder === "order-receipts" ? PRIVATE_BUCKET : PUBLIC_BUCKET;
    await uploadStorageObject(bucket, storageObjectPath(folder, filename), parsed.content, parsed.extension);
    return filename;
  }
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), parsed.content, { flag: "wx" });
  return filename;
}

async function removeImageAsset(directory, filename) {
  if (isSupabaseMode()) {
    const folder = path.basename(directory);
    const bucket = folder === "order-receipts" ? PRIVATE_BUCKET : PUBLIC_BUCKET;
    const publicPrefix = `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${folder}/`;
    const objectName = typeof filename === "string" && filename.startsWith(publicPrefix)
      ? decodeURIComponent(filename.slice(publicPrefix.length))
      : filename;
    if (typeof objectName !== "string" || !/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(objectName)) return;
    await deleteStorageObject(bucket, storageObjectPath(folder, objectName));
    return;
  }
  if (typeof filename !== "string" || !/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(filename)) return;
  try {
    await fs.unlink(path.join(directory, filename));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function removeMenuPhoto(photoUrl) {
  if (isSupabaseMode()) {
    const prefix = `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/menu-photos/`;
    if (typeof photoUrl !== "string" || !photoUrl.startsWith(prefix)) return;
    const filename = decodeURIComponent(photoUrl.slice(prefix.length));
    if (!/^[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(filename)) return;
    await deleteStorageObject(PUBLIC_BUCKET, storageObjectPath("menu-photos", filename));
    return;
  }
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
  const isStoredPhoto = isSupabaseMode() && typeof body.photo === "string" &&
    /^menu-photos\/[a-f0-9]{32}\.(?:jpg|png|webp)$/.test(body.photo);
  const photoError = isStoredPhoto ? null : parseMenuPhoto(body.photo);
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
  const paymentAssetMatch = pathname.match(/^\/payment-assets\/([a-f0-9]{32}\.(?:jpg|png|webp))$/);
  if (!filePath && paymentAssetMatch) filePath = path.join(PAYMENT_ASSET_DIR, paymentAssetMatch[1]);
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

async function serveProtectedImage(filename, directory, response) {
  if (isSupabaseMode()) {
    const folder = path.basename(directory);
    const objectPath = storageObjectPath(folder, filename);
    const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
    const bucket = folder === "order-receipts" ? PRIVATE_BUCKET : PUBLIC_BUCKET;
    const result = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodedPath}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (result.status === 404) {
      const error = new Error("Stored image not found.");
      error.code = "ENOENT";
      throw error;
    }
    if (!result.ok) {
      const detail = await result.text();
      const error = new Error(`Supabase Storage download failed (${result.status}): ${detail}`);
      error.statusCode = 502;
      throw error;
    }
    const content = Buffer.from(await result.arrayBuffer());
    const type = mimeType(filename);
    response.writeHead(200, {
      "Content-Type": type || "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
    return;
  }
  const filePath = path.join(directory, filename);
  const content = await fs.readFile(filePath);
  const type = mimeType(filePath);
  response.writeHead(200, {
    "Content-Type": type || "application/octet-stream",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
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
    const session = await getSession(request);
    jsonResponse(response, 200, { user: session ? session.user : null });
    return;
  }

  if (request.method === "POST" && pathname === "/api/uploads/sign") {
    const body = await readJson(request);
    if (!isSupabaseMode()) {
      jsonResponse(response, 200, { directUploads: false });
      return;
    }
    if (body.kind === "menu-photo" || body.kind === "payment-qr") {
      if (!(await requireRole(request, response, "admin"))) return;
    } else if (body.kind === "receipt" && !checkOrderLookupRateLimit(request)) {
      sendError(response, 429, "Too many upload attempts. Please wait and try again.");
      return;
    }
    const upload = await createSignedUpload(body.kind, body.contentType, body.size);
    jsonResponse(response, 200, { directUploads: true, ...upload });
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

  if (request.method === "GET" && pathname === "/api/storefront-config") {
    const store = await readStore();
    jsonResponse(response, 200, storefrontPaymentConfig(store.settings));
    return;
  }

  if (request.method === "GET" && pathname === "/api/addons") {
    const store = await readStore();
    jsonResponse(response, 200, {
      addons: store.addons.filter((addon) => addon.available),
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/settings/gcash") {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    jsonResponse(response, 200, storefrontPaymentConfig(store.settings));
    return;
  }

  if (request.method === "PUT" && pathname === "/api/admin/settings/gcash") {
    if (!(await requireRole(request, response, "admin"))) return;
    const body = await readJson(request);
    if (!validText(body.merchantName, 80)) {
      sendError(response, 400, "Enter a merchant name (up to 80 characters).");
      return;
    }
    if (typeof body.merchantNumber !== "string" ||
      (body.merchantNumber.trim() !== "" &&
        !/^(?:09\d{9}|\+639\d{9})$/.test(body.merchantNumber.trim()))) {
      sendError(response, 400, "Enter a valid GCash number (09XXXXXXXXX or +639XXXXXXXXX).");
      return;
    }

    const qrFilename = body.qrImage === undefined
      ? null
      : await saveImageDataUrl(body.qrImage, PAYMENT_ASSET_DIR);
    let previousQrUrl = "";
    let result;
    try {
      result = await updateStore((store) => {
        previousQrUrl = store.settings.gcash_qr_url || "";
        store.settings.gcash_merchant_name = body.merchantName.trim();
        store.settings.gcash_merchant_number = body.merchantNumber.trim();
        if (qrFilename) {
          store.settings.gcash_qr_url = isSupabaseMode()
            ? publicStorageUrl(PUBLIC_BUCKET, storageObjectPath("payment-assets", qrFilename))
            : `/payment-assets/${qrFilename}`;
        }
        return { config: storefrontPaymentConfig(store.settings) };
      });
    } catch (error) {
      await removeImageAsset(PAYMENT_ASSET_DIR, qrFilename);
      throw error;
    }
    if (qrFilename && previousQrUrl !== result.config.qrImageUrl) {
      const previousFilename = isSupabaseMode()
        ? previousQrUrl
        : previousQrUrl.match(/^\/payment-assets\/([a-f0-9]{32}\.(?:jpg|png|webp))$/)?.[1];
      await removeImageAsset(PAYMENT_ASSET_DIR, previousFilename);
    }
    jsonResponse(response, 200, result.config);
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
    await setSession(response, result.user);
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
      await setSession(response, admin);
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
    await setSession(response, user);
    jsonResponse(response, 200, { user: safeUser(user) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const session = await getSession(request);
    if (session) {
      if (isSupabaseMode()) {
        const tokenHash = createHash("sha256").update(session.token).digest("hex");
        await updateStore((store) => {
          store.sessions = store.sessions.filter((entry) => entry.tokenHash !== tokenHash);
        });
      } else {
        localSessions.delete(session.token);
      }
    }
    response.setHeader("Set-Cookie", "sf_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/menu") {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    jsonResponse(response, 200, { menu: store.menu.map(publicMenuItem) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/categories") {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    jsonResponse(response, 200, { categories: store.categories });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/categories") {
    if (!(await requireRole(request, response, "admin"))) return;
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
    if (!(await requireRole(request, response, "admin"))) return;
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
    if (!(await requireRole(request, response, "admin"))) return;
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
    if (!(await requireRole(request, response, "admin"))) return;
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
    const customer = await requireRole(request, response, "customer");
    if (!customer) return;
    const store = await readStore();
    const orders = store.orders
      .filter((order) => order.customerId === customer.id)
      .map((order) => publicOrder(order));
    jsonResponse(response, 200, { orders });
    return;
  }

  if (request.method === "GET" && pathname === "/api/orders/lookup") {
    if (!checkOrderLookupRateLimit(request)) {
      sendError(response, 429, "Too many lookup attempts. Please wait and try again.");
      return;
    }
    const reference = url.searchParams.get("reference") || "";
    if (!/^\d{13}$/.test(reference)) {
      sendError(response, 400, "Enter the 13-digit GCash reference number.");
      return;
    }
    const store = await readStore();
    const order = store.orders.find((candidate) => candidate.gcashReference === reference);
    if (!order) {
      sendError(response, 404, "No order was found for that GCash reference number.");
      return;
    }
    jsonResponse(response, 200, { order: publicOrder(order) });
    return;
  }

  const receiptMatch = pathname.match(/^\/api\/orders\/([A-F0-9]{16})\/receipt$/);
  if (request.method === "GET" && receiptMatch) {
    const store = await readStore();
    const order = store.orders.find((candidate) => candidate.id === receiptMatch[1]);
    if (!order || !order.receiptPath) {
      sendError(response, 404, "Receipt image not found.");
      return;
    }
    const session = await getSession(request);
    const reference = url.searchParams.get("reference") || "";
    const isOwner = session?.user.role === "customer" && session.user.id === order.customerId;
    const isAdmin = session?.user.role === "admin";
    const isGuestWithReference = reference.length > 0 && reference === order.gcashReference;
    if (!isOwner && !isAdmin && !isGuestWithReference) {
      sendError(response, 404, "Receipt image not found.");
      return;
    }
    try {
      await serveProtectedImage(order.receiptPath, ORDER_RECEIPT_DIR, response);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendError(response, 404, "Receipt image not found.");
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders") {
    const session = await getSession(request);
    if (session?.user.role === "admin") {
      sendError(response, 403, "Sign out of the admin account before placing a customer order.");
      return;
    }
    const customer = session?.user.role === "customer" ? session.user : null;
    const body = await readJson(request);
    if (body.paymentMethod !== "gcash") {
      sendError(response, 400, "GCash is the required payment method.");
      return;
    }
    if (typeof body.gcashReference !== "string" || !/^\d{13}$/.test(body.gcashReference.trim())) {
      sendError(response, 400, "Enter the 13-digit GCash reference number.");
      return;
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) {
      sendError(response, 400, "Add at least one menu item to your order.");
      return;
    }
    if (!customer && (!validText(body.customerName, 80) || !validEmail(body.customerEmail))) {
      sendError(response, 400, "Enter your name and a valid email address for guest checkout.");
      return;
    }
    const paymentConfig = storefrontPaymentConfig((await readStore()).settings);
    if (!paymentConfig.configured) {
      sendError(response, 503, "GCash merchant details and QR code have not been configured by the shop.");
      return;
    }
    if (body.items.some((item) => !item || typeof item.id !== "string" ||
      item.id.length > 64 || !Number.isInteger(item.quantity) ||
      item.quantity < 1 || item.quantity > 20)) {
      sendError(response, 400, "Each order item needs a valid quantity from 1 to 20.");
      return;
    }

    const receiptFilename = body.receiptImage === undefined
      ? null
      : await saveImageDataUrl(body.receiptImage, ORDER_RECEIPT_DIR);
    let result;
    try {
      result = await updateStore((store) => {
        if (store.orders.some((order) => order.gcashReference === body.gcashReference.trim())) {
          return {
            error: "That GCash reference number has already been submitted.",
            statusCode: 409,
          };
        }
        const orderItems = [];
        for (const requested of body.items) {
          const item = store.menu.find((candidate) =>
            candidate.id === requested.id && candidate.available,
          );
          if (!item) {
            return { error: "An item in your cart is no longer available.", statusCode: 400 };
          }
          const options = requested.options && typeof requested.options === "object"
            ? requested.options
            : {};
          const addons = Array.isArray(options.addons) ? options.addons : [];
          if (addons.length > 8 || addons.some((id) => typeof id !== "string") ||
            new Set(addons).size !== addons.length) {
            return { error: "Choose valid add-ons for each drink.", statusCode: 400 };
          }
          const isCustomizable = publicMenuItem(item).customizable;
          const size = options.size || "12 oz";
          const temperature = options.temperature || "Iced";
          const milk = options.milk || "Whole milk";
          const sugar = options.sugar || "100%";
          if (isCustomizable && (
            !["12 oz", "16 oz", "22 oz"].includes(size) ||
            !["Hot", "Iced"].includes(temperature) ||
            !["Whole milk", "Oat milk", "Almond milk", "None"].includes(milk) ||
            !["0%", "25%", "50%", "75%", "100%"].includes(sugar)
          )) {
            return { error: "Choose valid drink customizations.", statusCode: 400 };
          }
          if (!isCustomizable && addons.length) {
            return { error: "Add-ons are only available for drinks.", statusCode: 400 };
          }
          const selectedAddons = addons.map((id) =>
            store.addons.find((addon) => addon.id === id && addon.available),
          );
          if (selectedAddons.some((addon) => !addon)) {
            return { error: "An add-on is no longer available.", statusCode: 400 };
          }
          const addonTotal = selectedAddons.reduce(
            (sum, addon) => sum + Math.round(addon.price * 100),
            0,
          );
          orderItems.push({
            id: item.id,
            name: item.name,
            description: item.description || "",
            unitPrice: (Math.round(item.price * 100) + addonTotal) / 100,
            quantity: requested.quantity,
            customizations: isCustomizable ? {
              size,
              temperature,
              milk,
              sugar,
              addons: selectedAddons.map(({ id, name, price }) => ({ id, name, price })),
            } : {},
          });
        }
        const totalInCents = orderItems.reduce(
          (sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity,
          0,
        );
        const order = {
          id: randomBytes(8).toString("hex").toUpperCase(),
          customerId: customer?.id || `guest_${randomBytes(12).toString("hex")}`,
          customerName: customer?.name || body.customerName.trim(),
          customerEmail: customer?.email || body.customerEmail.trim().toLowerCase(),
          items: orderItems,
          total: totalInCents / 100,
          paymentMethod: "gcash",
          gcashReference: body.gcashReference.trim(),
          paymentStatus: "pending",
          status: "pending_verification",
          createdAt: new Date().toISOString(),
          receiptPath: receiptFilename,
          verifiedAt: null,
        };
        store.orders.unshift(order);
        return { order };
      });
    } catch (error) {
      await removeImageAsset(ORDER_RECEIPT_DIR, receiptFilename);
      throw error;
    }
    if (result.error) {
      await removeImageAsset(ORDER_RECEIPT_DIR, receiptFilename);
      sendError(response, result.statusCode, result.error);
      return;
    }
    jsonResponse(response, 201, { order: publicOrder(result.order) });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/dashboard") {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    const shopDate = (value) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(value));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    };
    const today = shopDate(Date.now());
    const itemSales = new Map();
    for (const order of store.orders) {
      if (order.status === "cancelled") continue;
      for (const item of order.items) {
        const current = itemSales.get(item.name) || 0;
        itemSales.set(item.name, current + item.quantity);
      }
    }
    const bestSelling = [...itemSales.entries()].sort((left, right) => right[1] - left[1])[0];
    jsonResponse(response, 200, {
      todayRevenue: store.orders
        .filter((order) => shopDate(order.createdAt) === today &&
          order.paymentStatus === "paid" && order.status !== "cancelled")
        .reduce((sum, order) => sum + order.total, 0),
      pendingVerifications: store.orders.filter((order) =>
        order.paymentStatus === "pending" && order.status === "pending_verification",
      ).length,
      totalOrders: store.orders.length,
      bestSellingItem: bestSelling ? { name: bestSelling[0], quantity: bestSelling[1] } : null,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/orders") {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    const search = (url.searchParams.get("q") || "").trim().toLocaleLowerCase();
    const status = url.searchParams.get("status") || "";
    const paymentStatus = url.searchParams.get("paymentStatus") || "";
    const validStatuses = ["pending_verification", "received", "preparing", "ready", "completed", "cancelled"];
    if (search.length > 120 || (status && !validStatuses.includes(status)) ||
      (paymentStatus && !["pending", "paid", "rejected"].includes(paymentStatus))) {
      sendError(response, 400, "Invalid order search or filter.");
      return;
    }
    const orders = store.orders.filter((order) => {
      if (status && order.status !== status) return false;
      if (paymentStatus && order.paymentStatus !== paymentStatus) return false;
      if (!search) return true;
      return [
        order.id,
        order.customerName,
        order.customerEmail,
        order.gcashReference,
        ...order.items.map((item) => item.name),
      ].some((value) => value.toLocaleLowerCase().includes(search));
    }).map((order) => publicOrder(order, true));
    jsonResponse(response, 200, { orders });
    return;
  }

  const adminReceiptMatch = pathname.match(/^\/api\/admin\/orders\/([A-F0-9]{16})\/receipt$/);
  if (request.method === "GET" && adminReceiptMatch) {
    if (!(await requireRole(request, response, "admin"))) return;
    const store = await readStore();
    const order = store.orders.find((candidate) => candidate.id === adminReceiptMatch[1]);
    if (!order || !order.receiptPath) {
      sendError(response, 404, "Receipt image not found.");
      return;
    }
    try {
      await serveProtectedImage(order.receiptPath, ORDER_RECEIPT_DIR, response);
    } catch (error) {
      if (error.code === "ENOENT") {
        sendError(response, 404, "Receipt image not found.");
        return;
      }
      throw error;
    }
    return;
  }

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/([A-F0-9]{16})$/);
  if (orderMatch && request.method === "PATCH") {
    if (!(await requireRole(request, response, "admin"))) return;
    const body = await readJson(request);
    const validStatuses = ["pending_verification", "received", "preparing", "ready", "completed", "cancelled"];
    if (body.status !== undefined && !validStatuses.includes(body.status)) {
      sendError(response, 400, "Choose a valid order status.");
      return;
    }
    if (body.paymentStatus !== undefined && !["pending", "paid", "rejected"].includes(body.paymentStatus)) {
      sendError(response, 400, "Choose a valid payment status.");
      return;
    }
    if (body.action !== undefined && !["verify", "reject"].includes(body.action)) {
      sendError(response, 400, "Choose a valid payment action.");
      return;
    }
    const result = await updateStore((store) => {
      const order = store.orders.find((candidate) => candidate.id === orderMatch[1]);
      if (!order) return { error: "Order not found.", statusCode: 404 };
      if (body.action === "verify") {
        order.paymentStatus = "paid";
        order.status = "preparing";
        order.verifiedAt = new Date().toISOString();
      } else if (body.action === "reject") {
        order.paymentStatus = "rejected";
        order.status = "cancelled";
      }
      if (body.status !== undefined) order.status = body.status;
      if (body.paymentStatus !== undefined) order.paymentStatus = body.paymentStatus;
      return { order: publicOrder(order, true) };
    });
    if (result.error) {
      sendError(response, result.statusCode, result.error);
      return;
    }
    jsonResponse(response, 200, result);
    return;
  }

  sendError(response, 404, "API endpoint not found.");
}

function isDemoOrder(order) {
  return (
    (order.customerId === "demo_customer_1" &&
      order.customerEmail === "demo1@example.test" &&
      order.gcashReference === "1234567890123") ||
    (order.customerId === "demo_customer_2" &&
      order.customerEmail === "demo2@example.test" &&
      order.gcashReference === "1234567890124")
  );
}

async function initializeStore() {
  await initializeDatabase();
  const store = await readStore();
  if (store.menuCatalogVersion < 10) {
    await updateStore((currentStore) => {
      if (currentStore.menuCatalogVersion >= 10) return;
      currentStore.menu = [];
      currentStore.categories = [];
      currentStore.orders = currentStore.orders.filter((order) => !isDemoOrder(order));
      currentStore.menuCatalogVersion = 10;
    });
  }
}

let initializationPromise;

async function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initializeStore();
  }
  try {
    await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}

async function requestHandler(request, response) {
  try {
    await ensureInitialized();
    await handleRequest(request, response);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    console.error("Request failed:", error);
    if (error.statusCode) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    sendError(response, 500, "An unexpected server error occurred.");
  }
}

if (require.main === module) {
  ensureInitialized().then(() => {
    http.createServer(requestHandler).listen(PORT, "127.0.0.1", () => {
      console.log(`Suarez Farms ordering system is available at http://127.0.0.1:${PORT}`);
    });
  }).catch((error) => {
    console.error("Could not initialize the menu catalog:", error);
    process.exitCode = 1;
  });
} else {
  module.exports = requestHandler;
}
app.use(express.json());

app.post("/api/auth/login", (req, res) => {
  const { role, username, password } = req.body || {};

  if (role === "admin") {
    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      return res.json({
        success: true,
        user: { name: "Admin", role: "admin", username },
      });
    }
    return res.status(401).json({ message: "Invalid admin credentials" });
  }

  return res.status(400).json({ message: "Unsupported login role" });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;