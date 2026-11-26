document.addEventListener("DOMContentLoaded", () => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const orderConfirmationDialog = document.getElementById("order-confirmation-dialog");
  const orderConfirmationMessage = document.getElementById("order-confirmation-message");
  const digitalReceipt = document.getElementById("digital-receipt");
  const productDialog = document.getElementById("product-dialog");
  const paymentDialog = document.getElementById("payment-dialog");
  const authForm = document.getElementById("auth-form");
  const authMessage = document.getElementById("auth-message");
  const accountButton = document.getElementById("account-button");
  const logoutButton = document.getElementById("logout-button");
  const registerToggle = document.getElementById("register-toggle");
  const customerStorefront = document.getElementById("customer-storefront");
  const storeMessage = document.getElementById("store-message");
  const menuCategories = document.getElementById("menu-categories");
  const menuGrid = document.getElementById("menu-grid");
  const cartItems = document.getElementById("cart-items");
  const cartTotal = document.getElementById("cart-total");
  const cartCount = document.getElementById("cart-count");
  const cartDrawer = document.getElementById("cart-panel");
  const cartToggle = document.getElementById("cart-toggle");
  const menuStorefront = document.querySelector(".menu-storefront");
  const checkoutStart = document.getElementById("checkout-start");
  const checkoutForm = document.getElementById("checkout-form");
  const checkoutButton = checkoutForm.querySelector(".checkout-button");
  const checkoutHelp = document.getElementById("checkout-help");
  const checkoutMessage = document.getElementById("checkout-message");
  const guestCustomerFields = document.getElementById("guest-customer-fields");
  const receiptUpload = document.getElementById("receipt-upload");
  const receiptPreview = document.getElementById("receipt-preview");
  const guestLookupForm = document.getElementById("guest-order-lookup-form");
  const guestLookupMessage = document.getElementById("guest-lookup-message");
  const guestOrderResult = document.getElementById("guest-order-result");
  const accountOrderHistory = document.getElementById("account-order-history");
  const customerOrders = document.getElementById("customer-orders");
  const adminDashboard = document.getElementById("admin-dashboard");
  const adminKpis = {
    revenue: document.getElementById("today-revenue"),
    pending: document.getElementById("pending-verifications"),
    orders: document.getElementById("total-orders"),
    bestSeller: document.getElementById("best-selling-item"),
  };
  const adminOrders = document.getElementById("admin-orders");
  const menuForm = document.getElementById("menu-form");
  const menuCategorySelect = document.getElementById("menu-category");
  const newCategoryLabel = document.getElementById("menu-new-category-label");
  const newCategoryInput = document.getElementById("menu-new-category");
  const adminMenuList = document.getElementById("admin-menu-list");
  const menuPhotoInput = document.getElementById("menu-photo");
  const menuPhotoPreview = document.getElementById("menu-photo-preview");
  const menuPhotoPlaceholder = document.getElementById("menu-photo-placeholder");
  const removePhotoLabel = document.getElementById("remove-photo-label");
  const removeMenuPhoto = document.getElementById("remove-menu-photo");
  const gcashSettingsForm = document.getElementById("gcash-settings-form");
  const gcashQrUpload = document.getElementById("gcash-qr-upload");
  const gcashQrPreview = document.getElementById("gcash-qr-preview");

  let currentUser = null;
  let activePage = "overview";
  let menu = [];
  let cart = new Map();
  let placingOrder = false;
  let selectedCategory = null;
  let selectedSubcategory = "All items";
  let adminCategories = [];
  const menuCategoryOrder = [
    "Coffee",
    "Frappe",
    "Rice Meals",
    "Fried Chicken",
    "Milk Drinks",
    "Matcha & Tea",
    "Soda & Juices",
    "Desserts",
    "Pasta",
    "Kimchi Series",
    "Appetizers",
  ];
  let authRole = "customer";
  let isRegistering = false;
  let existingPhotoUrl = null;
  let photoPreviewUrl = null;
  let receiptPreviewUrl = null;
  let gcashQrPreviewUrl = null;
  let currentProduct = null;
  let currentPaymentConfig = null;
  let customerOrdersCache = [];
  let lastGuestOrder = null;
  let addons = [];
  let adminOrderFilterTimer = null;

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);

  const money = (amount) =>
    new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount);

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
    return result;
  }

  function showStoreMessage(message = "", isError = false) {
    storeMessage.textContent = message;
    storeMessage.classList.toggle("error-message", isError);
    storeMessage.hidden = !message;
  }

  function setAuthRole(role) {
    authRole = role;
    const isAdmin = role === "admin";
    document.querySelectorAll(".auth-role").forEach((button) => {
      const active = button.dataset.role === role;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    document.getElementById("name-label").hidden = isAdmin || !isRegistering;
    document.getElementById("auth-name").hidden = isAdmin || !isRegistering;
    document.getElementById("auth-name").required = !isAdmin && isRegistering;
    document.getElementById("email-label").hidden = isAdmin;
    document.getElementById("auth-email").hidden = isAdmin;
    document.getElementById("auth-email").required = !isAdmin;
    document.getElementById("username-label").hidden = !isAdmin;
    document.getElementById("auth-username").hidden = !isAdmin;
    document.getElementById("auth-username").required = isAdmin;
    registerToggle.hidden = isAdmin;
    registerToggle.textContent = isRegistering
      ? "Already have an account? Sign in"
      : "New here? Create a customer account";
    document.getElementById("auth-title").textContent = isAdmin
      ? "Admin sign in"
      : isRegistering ? "Create a customer account" : "Customer sign in";
    authForm.querySelector(".auth-submit").textContent = isRegistering && !isAdmin
      ? "Create account"
      : "Sign in";
    authMessage.textContent = "";
  }

  function openAuth(role = "customer", register = false) {
    isRegistering = register && role === "customer";
    setAuthRole(role);
    authForm.reset();
    setAuthRole(role);
    authMessage.textContent = "";
    window.location.hash = "login";
    document.getElementById(role === "admin" ? "auth-username" : "auth-email").focus();
  }

  function showPage() {
    const requestedPage = window.location.hash.slice(1);
    const page = document.querySelector(`[data-page-view="${requestedPage}"]`)
      ? requestedPage
      : "overview";
    activePage = page;
    document.querySelectorAll("[data-page-view]").forEach((view) => {
      view.hidden = view.dataset.pageView !== page;
    });
    document.querySelectorAll(".main-nav a").forEach((link) => {
      if (link.hash === `#${page}`) {
        link.setAttribute("aria-current", "page");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    window.scrollTo(0, 0);
  }

  function updateAccountDisplay() {
    if (!currentUser) {
      accountButton.textContent = "Login";
      accountButton.hidden = false;
      logoutButton.hidden = true;
      adminDashboard.hidden = true;
      customerStorefront.hidden = false;
      accountOrderHistory.hidden = true;
      guestCustomerFields.hidden = false;
      document.getElementById("guest-customer-name").required = true;
      document.getElementById("guest-customer-email").required = true;
      checkoutHelp.textContent = "Your order will be saved as Pending Verification until the shop confirms payment.";
      return;
    }

    accountButton.hidden = true;
    logoutButton.hidden = false;
    logoutButton.textContent = `Sign out (${currentUser.name})`;
    const isAdmin = currentUser.role === "admin";
    adminDashboard.hidden = !isAdmin;
    customerStorefront.hidden = isAdmin;
    accountOrderHistory.hidden = isAdmin;
    guestCustomerFields.hidden = true;
    document.getElementById("guest-customer-name").required = false;
    document.getElementById("guest-customer-email").required = false;
    checkoutHelp.textContent = "Your order will be saved as Pending Verification until the shop confirms payment.";
    if (isAdmin) {
      loadAdminData().catch((error) => showStoreMessage(error.message, true));
    } else {
      loadCustomerOrders().catch((error) => showStoreMessage(error.message, true));
    }
  }

  function renderMenu() {
    if (!menu.length) {
      menuCategories.hidden = true;
      menuGrid.innerHTML = `<p class="empty-state">Our online menu is being prepared. Check back soon or contact the café directly.</p>`;
      return;
    }

    const categories = [...new Set(menu.map((item) => item.category || "Other"))]
      .sort((left, right) => {
        const leftIndex = menuCategoryOrder.indexOf(left);
        const rightIndex = menuCategoryOrder.indexOf(right);
        if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      });
    if (!categories.includes(selectedCategory)) selectedCategory = categories[0];
    const items = menu.filter((item) =>
      (item.category || "Other") === selectedCategory,
    );
    const subcategories = [...new Set(items.map((item) => item.subcategory || "Other"))];
    const subcategoryOptions = ["All items", ...subcategories];
    if (!subcategoryOptions.includes(selectedSubcategory)) selectedSubcategory = "All items";
    menuCategories.hidden = false;
    menuCategories.innerHTML = categories.map((category) => {
      const count = menu.filter((item) =>
        (item.category || "Other") === category,
      ).length;
      return `
        <button class="menu-category-button${category === selectedCategory ? " active" : ""}" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === selectedCategory}">
          <span>${escapeHtml(category)}</span>
          <span class="menu-category-count">${count}</span>
        </button>
      `;
    }
    ).join("");
    const visibleItems = selectedSubcategory === "All items"
      ? items
      : items.filter((item) => (item.subcategory || "Other") === selectedSubcategory);
    const itemGroups = new Map();
    for (const item of visibleItems) {
      const group = selectedSubcategory === "All items"
        ? item.subcategory || "Other"
        : selectedSubcategory;
      if (!itemGroups.has(group)) itemGroups.set(group, []);
      itemGroups.get(group).push(item);
    }
    const renderItems = (groupItems) => groupItems.map((item) => {
      const photoAltText = item.photoAltText || item.name;
      const itemPhoto = item.photoUrl
        ? `<img class="menu-item-photo" src="${escapeHtml(item.photoUrl)}" alt="${escapeHtml(photoAltText)}" loading="lazy" />`
        : `<span class="menu-item-photo-fallback" role="img" aria-label="${escapeHtml(photoAltText)}"><span>Photo coming soon</span><strong>${escapeHtml(photoAltText)}</strong></span>`;
      return `
        <button class="menu-card add-to-cart" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="${item.customizable ? "Customize" : "Add"} ${escapeHtml(item.name)} ${money(item.price)}">
          <span class="menu-item-image-wrap">
            ${itemPhoto}
            <strong class="menu-price-badge">${money(item.price)}</strong>
            <span class="menu-in-cart-badge" data-cart-indicator hidden></span>
          </span>
          <span class="menu-card-details">
            <span class="menu-item-name">${escapeHtml(item.name)}</span>
            <span class="menu-item-description">${escapeHtml(item.description || "Freshly prepared at Suarez Farms.")}</span>
            <span class="menu-card-footer">
              <span class="menu-card-action">${item.customizable ? "Customize" : "Add to order"} <span aria-hidden="true">+</span></span>
            </span>
          </span>
        </button>
      `;
    }).join("");
    menuGrid.innerHTML = `
      <section class="menu-category" aria-labelledby="menu-category-title">
        <div class="menu-category-heading">
          <div>
            <p class="eyebrow">Browse menu</p>
            <h4 id="menu-category-title">${escapeHtml(selectedCategory)}</h4>
          </div>
          <span>${visibleItems.length} ${visibleItems.length === 1 ? "item" : "items"}</span>
        </div>
        <nav class="menu-subcategories" aria-label="${escapeHtml(selectedCategory)} subcategories">
          ${subcategoryOptions.map((subcategory) => `
            <button class="menu-subcategory-button${subcategory === selectedSubcategory ? " active" : ""}" type="button" data-subcategory="${escapeHtml(subcategory)}" aria-pressed="${subcategory === selectedSubcategory}">
              ${escapeHtml(subcategory)}
            </button>
          `).join("")}
        </nav>
        <div class="menu-category-groups">
          ${[...itemGroups.entries()].map(([groupName, groupItems], index) => {
            const groupId = `menu-group-${index}`;
            return `
              <section class="menu-group" aria-labelledby="${escapeHtml(groupId)}">
                <div class="menu-group-heading">
                  <h5 id="${escapeHtml(groupId)}">${escapeHtml(groupName)}</h5>
                  <span>${groupItems.length} ${groupItems.length === 1 ? "item" : "items"}</span>
                </div>
                <div class="menu-category-items">${renderItems(groupItems)}</div>
              </section>
            `;
          }).join("")}
        </div>
      </section>
    `;
    updateMenuCartBadges();
  }

  function renderCart() {
    const entries = [...cart.values()];
    if (!entries.length) {
      cartItems.innerHTML = `<p class="empty-state">Your order is empty. Add something from the menu.</p>`;
    } else {
      cartItems.innerHTML = entries.map((entry) => {
        const item = menu.find((candidate) => candidate.id === entry.id);
        if (!item) return "";
        const addonNames = (entry.options.addons || [])
          .map((id) => addons.find((addon) => addon.id === id)?.name)
          .filter(Boolean);
        const customization = item.customizable
          ? [entry.options.size, entry.options.temperature, entry.options.milk, `${entry.options.sugar} sugar`, ...addonNames].filter(Boolean).join(" · ")
          : "";
        const unitPrice = item.price + (entry.options.addons || []).reduce((sum, id) =>
          sum + (addons.find((addon) => addon.id === id)?.price || 0), 0);
        return `
          <div class="cart-row">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              ${customization ? `<span>${escapeHtml(customization)}</span>` : ""}
              <span>${money(unitPrice)} each</span>
            </div>
            <div class="quantity-controls">
              <button type="button" data-cart-action="decrease" data-cart-key="${escapeHtml(entry.key)}" aria-label="Remove one ${escapeHtml(item.name)}">−</button>
              <span>${entry.quantity}</span>
              <button type="button" data-cart-action="increase" data-cart-key="${escapeHtml(entry.key)}" aria-label="Add one ${escapeHtml(item.name)}">+</button>
            </div>
          </div>
        `;
      }).join("");
    }
    const totalInCents = entries.reduce((sum, entry) => {
      const item = menu.find((candidate) => candidate.id === entry.id);
      if (!item) return sum;
      const addonCents = (entry.options.addons || []).reduce((addonSum, id) =>
        addonSum + Math.round((addons.find((addon) => addon.id === id)?.price || 0) * 100), 0);
      return sum + (Math.round(item.price * 100) + addonCents) * entry.quantity;
    }, 0);
    const totalItems = entries.reduce((sum, entry) => sum + entry.quantity, 0);
    cartCount.textContent = `${totalItems} ${totalItems === 1 ? "item" : "items"}`;
    cartTotal.textContent = money(totalInCents / 100);
    checkoutStart.disabled = entries.length === 0;
    checkoutButton.disabled = entries.length === 0 || placingOrder;
    const drawerCheckout = document.querySelector(".cart-drawer-footer .checkout-help");
    if (drawerCheckout) drawerCheckout.textContent = currentPaymentConfig?.configured
      ? "GCash only. Enter the 13-digit reference after sending payment."
      : "GCash details are being configured by the shop.";
    const paymentAmount = document.getElementById("payment-amount");
    if (paymentAmount) paymentAmount.textContent = money(totalInCents / 100);
    updateMenuCartBadges();
  }

  function updateMenuCartBadges() {
    const quantities = new Map();
    for (const entry of cart.values()) {
      quantities.set(entry.id, (quantities.get(entry.id) || 0) + entry.quantity);
    }
    menuGrid.querySelectorAll(".add-to-cart").forEach((card) => {
      const count = quantities.get(card.dataset.itemId) || 0;
      const badge = card.querySelector("[data-cart-indicator]");
      if (!badge) return;
      badge.hidden = count === 0;
      badge.textContent = count ? `${count} in cart` : "";
      card.classList.toggle("in-cart", count > 0);
    });
  }

  function cartKey(id, options) {
    return `${id}:${JSON.stringify(options)}`;
  }

  function addToCart(id, options = {}, quantityToAdd = 1) {
    const item = menu.find((candidate) => candidate.id === id);
    if (!item) return;
    const normalizedOptions = item.customizable ? {
      size: options.size || "12 oz",
      temperature: options.temperature || "Iced",
      milk: options.milk || "Whole milk",
      sugar: options.sugar || "100%",
      addons: [...(options.addons || [])].sort(),
    } : { addons: [] };
    const key = cartKey(id, normalizedOptions);
    const current = cart.get(key);
    if ((current?.quantity || 0) + quantityToAdd > 20) {
      showStoreMessage("You can order up to 20 of each item.", true);
      return;
    }
    cart.set(key, {
      key,
      id,
      options: normalizedOptions,
      quantity: (current?.quantity || 0) + quantityToAdd,
    });
    renderCart();
    setCartDrawer(true);
    showStoreMessage(`${item.name} added to your order.`);
  }

  function openCustomization(item) {
    currentProduct = item;
    document.getElementById("product-dialog-title").textContent = item.name;
    document.getElementById("product-dialog-description").textContent = item.description || "";
    document.getElementById("customization-quantity").value = "1";
    document.getElementById("product-options").innerHTML = `
      <label class="field-label" for="drink-size">Size</label>
      <select id="drink-size"><option>12 oz</option><option>16 oz</option><option>22 oz</option></select>
      <label class="field-label" for="drink-temperature">Temperature</label>
      <select id="drink-temperature"><option>Hot</option><option selected>Iced</option></select>
      <label class="field-label" for="drink-milk">Milk</label>
      <select id="drink-milk"><option>Whole milk</option><option>Oat milk</option><option>Almond milk</option><option>None</option></select>
      <label class="field-label" for="drink-sugar">Sugar</label>
      <select id="drink-sugar"><option>0%</option><option>25%</option><option>50%</option><option>75%</option><option selected>100%</option></select>
      <fieldset class="addon-options"><legend class="field-label">Add-ons</legend>
        ${addons.length ? addons.map((addon) => `
          <label class="checkbox-label">
            <input type="checkbox" value="${escapeHtml(addon.id)}" data-addon-option />
            ${escapeHtml(addon.name)} (+${money(addon.price)})
          </label>
        `).join("") : `<span class="muted-copy">No add-ons are available right now.</span>`}
      </fieldset>
    `;
    productDialog.showModal();
  }

  function setCartDrawer(open, shouldFocus = false) {
    cartDrawer.hidden = !open;
    cartDrawer.setAttribute("aria-hidden", String(!open));
    cartToggle.setAttribute("aria-expanded", String(open));
    menuStorefront.classList.toggle("cart-visible", open);
    if (open && shouldFocus) document.getElementById("cart-close").focus();
    else if (!open) cartToggle.focus();
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result !== "string") {
          reject(new Error("Could not read the selected image."));
          return;
        }
        resolve(reader.result);
      }, { once: true });
      reader.addEventListener("error", () => reject(new Error("Could not read the selected image.")), { once: true });
      reader.readAsDataURL(file);
    });
  }

  async function uploadImageFile(file, kind) {
    const ticket = await api("/api/uploads/sign", {
      method: "POST",
      body: JSON.stringify({ kind, contentType: file.type, size: file.size }),
    });
    if (!ticket.directUploads) return fileAsDataUrl(file);
    const response = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Image upload failed (${response.status}): ${detail}`);
    }
    return ticket.objectPath;
  }

  function renderOrder(order, adminView) {
    const lines = order.items.map((item) => {
      const custom = item.customizations || {};
      const choices = [
        custom.size,
        custom.temperature,
        custom.milk,
        custom.sugar ? `${custom.sugar} sugar` : "",
        ...(custom.addons || []).map((addon) => addon.name),
      ].filter(Boolean).join(" · ");
      return `<li>${escapeHtml(item.name)} × ${item.quantity} — ${money(item.unitPrice * item.quantity)}${choices ? `<span class="order-item-description">${escapeHtml(choices)}</span>` : ""}</li>`;
    }).join("");
    const reference = escapeHtml(order.gcashReference || "Not provided");
    const statusLabels = {
      pending_verification: "Pending Verification",
      received: "Received",
      preparing: "Preparing",
      ready: "Ready",
      completed: "Completed",
      cancelled: "Cancelled",
    };
    if (adminView) {
      const statusOptions = ["pending_verification", "received", "preparing", "ready", "completed", "cancelled"];
      const action = order.paymentStatus === "pending"
        ? `<button class="primary-btn verify-order" type="button" data-order-id="${escapeHtml(order.id)}">Verify &amp; Prepare</button>
           <button class="secondary-btn reject-order" type="button" data-order-id="${escapeHtml(order.id)}">Reject / Cancel</button>`
        : `<label class="sr-only" for="status-${escapeHtml(order.id)}">Order status</label>
           <select id="status-${escapeHtml(order.id)}" class="order-status" data-order-id="${escapeHtml(order.id)}">
             ${statusOptions.map((status) => `<option value="${status}" ${order.status === status ? "selected" : ""}>${escapeHtml(statusLabels[status])}</option>`).join("")}
           </select>
           <button class="secondary-btn save-order-status" type="button" data-order-id="${escapeHtml(order.id)}">Update</button>`;
      return `<tr>
        <td><strong>#${escapeHtml(order.id)}</strong><span>${escapeHtml(order.customerName)} · ${escapeHtml(order.customerEmail)}</span><span>${escapeHtml(formatDate(order.createdAt))}</span></td>
        <td><ul>${lines}</ul></td>
        <td>${money(order.total)}</td>
        <td>${reference}<span class="payment-detail">${escapeHtml(order.paymentStatus)}</span>
          ${order.receiptAvailable ? `<a href="/api/admin/orders/${encodeURIComponent(order.id)}/receipt" target="_blank" rel="noreferrer"><img class="admin-receipt-preview" src="/api/admin/orders/${encodeURIComponent(order.id)}/receipt" alt="Payment receipt for order ${escapeHtml(order.id)}" loading="lazy" /></a>` : ""}
        </td>
        <td><span class="order-badge">${escapeHtml(statusLabels[order.status] || order.status)}</span><div class="order-actions">${action}</div></td>
      </tr>`;
    }

    return `<article class="order-card">
      <div class="order-card-heading">
        <div><strong>Order #${escapeHtml(order.id)}</strong><span>${escapeHtml(formatDate(order.createdAt))}</span></div>
        <span class="order-badge">${escapeHtml(statusLabels[order.status] || order.status)}</span>
      </div>
      <ul>${lines}</ul>
      <p class="order-total"><span>Total</span><strong>${money(order.total)}</strong></p>
      <p class="payment-detail"><strong>GCash:</strong> ${escapeHtml(order.paymentStatus)} · Reference: ${reference}</p>
      <button class="secondary-btn print-order-receipt" type="button" data-order-id="${escapeHtml(order.id)}">Print receipt</button>
      <button class="secondary-btn order-again" type="button" data-order-id="${escapeHtml(order.id)}">Order Again</button>
    </article>`;
  }

  function renderGuestOrder(order) {
    guestOrderResult.innerHTML = renderOrder(order, false);
  }

  async function loadMenu() {
    const result = await api("/api/menu");
    menu = result.menu;
    for (const [key, entry] of cart) {
      if (!menu.some((item) => item.id === entry.id)) cart.delete(key);
    }
    renderMenu();
    renderCart();
  }

  function renderAdminCategories(selectedCategory = "") {
    menuCategorySelect.innerHTML = `
      <option value="">Select a category</option>
      ${adminCategories.map((category) =>
        `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`,
      ).join("")}
      <option value="__new__">Create a new category...</option>
    `;
    menuCategorySelect.value = selectedCategory;
    const creatingCategory = selectedCategory === "__new__";
    newCategoryLabel.hidden = !creatingCategory;
    newCategoryInput.hidden = !creatingCategory;
    newCategoryInput.required = creatingCategory;
    if (!creatingCategory) newCategoryInput.value = "";
  }

  function renderAdminMenu(items) {
    if (!items.length) {
      adminMenuList.innerHTML = `<p class="empty-state">No menu items yet. Add your first item above.</p>`;
      return;
    }
    adminMenuList.innerHTML = items.map((item) => `
      <article class="admin-menu-row">
        ${item.photoUrl ? `<img class="admin-menu-photo" src="${escapeHtml(item.photoUrl)}" alt="${escapeHtml(item.photoAltText || item.name)}" loading="lazy" />` : ""}
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <span>${escapeHtml(item.category || "Other")}${item.subcategory ? ` · ${escapeHtml(item.subcategory)}` : ""} · ${money(item.price)} · ${item.available ? "Available" : "Unavailable"}</span>
        </div>
        <div class="form-actions">
          <button class="secondary-btn edit-menu-item" type="button" data-item-id="${escapeHtml(item.id)}">Edit</button>
          <button class="secondary-btn delete-menu-item" type="button" data-item-id="${escapeHtml(item.id)}">Delete</button>
        </div>
      </article>
    `).join("");
    adminMenuList.dataset.items = JSON.stringify(items);
  }

  function formatDate(date) {
    return new Date(date).toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  async function loadAdminData() {
    const [menuResult, orderResult, categoryResult, dashboard, paymentConfig] = await Promise.all([
      api("/api/admin/menu"),
      fetchAdminOrders(),
      api("/api/admin/categories"),
      api("/api/admin/dashboard"),
      api("/api/admin/settings/gcash"),
    ]);
    adminCategories = categoryResult.categories;
    renderAdminCategories(menuCategorySelect.value);
    renderAdminMenu(menuResult.menu);
    adminOrders.innerHTML = orderResult.length
      ? orderResult.map((order) => renderOrder(order, true)).join("")
      : `<p class="empty-state">No orders received yet.</p>`;
    adminKpis.revenue.textContent = money(dashboard.todayRevenue);
    adminKpis.pending.textContent = String(dashboard.pendingVerifications);
    adminKpis.orders.textContent = String(dashboard.totalOrders);
    adminKpis.bestSeller.textContent = dashboard.bestSellingItem
      ? `${dashboard.bestSellingItem.name} (${dashboard.bestSellingItem.quantity})`
      : "—";
    currentPaymentConfig = paymentConfig;
    document.getElementById("gcash-merchant-name").value = paymentConfig.merchantName || "";
    document.getElementById("gcash-merchant-number").value = paymentConfig.merchantNumber || "";
    gcashQrPreview.src = paymentConfig.qrImageUrl || "";
    gcashQrPreview.hidden = !paymentConfig.qrImageUrl;
  }

  async function fetchAdminOrders() {
    const params = new URLSearchParams();
    const query = document.getElementById("admin-order-search").value.trim();
    const status = document.getElementById("admin-order-status-filter").value;
    const paymentStatus = document.getElementById("admin-payment-filter").value;
    if (query) params.set("q", query);
    if (status) params.set("status", status);
    if (paymentStatus) params.set("paymentStatus", paymentStatus);
    const result = await api(`/api/admin/orders${params.size ? `?${params}` : ""}`);
    return result.orders;
  }

  async function loadAdminOrders() {
    const orders = await fetchAdminOrders();
    adminOrders.innerHTML = orders.length
      ? orders.map((order) => renderOrder(order, true)).join("")
      : `<p class="empty-state">No orders received yet.</p>`;
  }

  async function loadCustomerOrders() {
    const result = await api("/api/orders/mine");
    customerOrdersCache = result.orders;
    customerOrders.innerHTML = result.orders.length
      ? result.orders.map((order) => renderOrder(order, false)).join("")
      : `<p class="empty-state">You have not placed an order yet.</p>`;
  }

  function reorder(order) {
    for (const item of order.items) {
      const custom = item.customizations || {};
      addToCart(item.id, {
        size: custom.size,
        temperature: custom.temperature,
        milk: custom.milk,
        sugar: custom.sugar,
        addons: (custom.addons || []).map((addon) => addon.id),
      }, item.quantity);
    }
    window.location.hash = "orders";
    setCartDrawer(true);
  }

  function printReceipt(order) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      showStoreMessage("Allow pop-ups to print your receipt.", true);
      return;
    }
    const rows = order.items.map((item) =>
      `<li><span>${escapeHtml(item.name)} × ${item.quantity}</span><strong>${money(item.unitPrice * item.quantity)}</strong></li>`,
    ).join("");
    printWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Receipt ${escapeHtml(order.id)}</title>
      <style>body{font:16px Arial,sans-serif;max-width:560px;margin:36px auto;padding:20px;color:#222}h1{font-size:24px}p{display:flex;justify-content:space-between;gap:14px}ul{padding:14px 0;border-top:1px solid #ccc;border-bottom:1px solid #ccc;list-style:none}li{display:flex;justify-content:space-between;gap:14px;margin:10px 0}.total{font-size:20px;font-weight:bold}</style>
      </head><body><h1>Suarez Farms</h1><p><span>Order ID</span><strong>#${escapeHtml(order.id)}</strong></p>
      <p><span>GCash Reference</span><strong>${escapeHtml(order.gcashReference || "")}</strong></p>
      <p><span>Status</span><strong>${escapeHtml(order.status)}</strong></p><ul>${rows}</ul>
      <p class="total"><span>Total</span><span>${money(order.total)}</span></p><script>window.onload=()=>window.print();</script></body></html>`);
    printWindow.document.close();
  }

  async function refreshSession() {
    const result = await api("/api/session");
    currentUser = result.user;
    updateAccountDisplay();
  }

  document.querySelectorAll(".auth-role").forEach((button) => {
    button.addEventListener("click", () => {
      isRegistering = false;
      setAuthRole(button.dataset.role);
    });
  });

  window.addEventListener("hashchange", showPage);
  showPage();
  document.getElementById("order-confirmation-close").addEventListener("click", () => {
    orderConfirmationDialog.close();
    checkoutForm.reset();
    window.location.hash = "orders";
    document.getElementById("menu").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  guestLookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    guestLookupMessage.textContent = "";
    guestLookupMessage.classList.remove("error-message");
    guestOrderResult.innerHTML = "";
    const reference = document.getElementById("guest-order-reference").value.trim();
    try {
      const result = await api(`/api/orders/lookup?reference=${encodeURIComponent(reference)}`);
      lastGuestOrder = result.order;
      renderGuestOrder(result.order);
    } catch (error) {
      lastGuestOrder = null;
      guestLookupMessage.textContent = error.message;
      guestLookupMessage.classList.add("error-message");
    }
  });

  function handleReorder(event) {
    const button = event.target.closest(".order-again, .print-order-receipt");
    if (!button) return;
    const order = customerOrdersCache.find((candidate) => candidate.id === button.dataset.orderId)
      || (lastGuestOrder?.id === button.dataset.orderId ? lastGuestOrder : null);
    if (!order) return;
    if (button.classList.contains("print-order-receipt")) printReceipt(order);
    else reorder(order);
  }
  customerOrders.addEventListener("click", handleReorder);
  guestOrderResult.addEventListener("click", handleReorder);

  registerToggle.addEventListener("click", () => {
    isRegistering = !isRegistering;
    registerToggle.textContent = isRegistering
      ? "Already have an account? Sign in"
      : "New here? Create a customer account";
    setAuthRole("customer");
  });
  accountButton.addEventListener("click", () => openAuth("customer", false));

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authMessage.textContent = "";
    const form = new FormData(authForm);
    const payload = authRole === "admin"
      ? { role: "admin", username: form.get("username"), password: form.get("password") }
      : isRegistering
        ? { name: form.get("name"), email: form.get("email"), password: form.get("password") }
        : { role: "customer", email: form.get("email"), password: form.get("password") };

    try {
      const result = await api(
        isRegistering && authRole === "customer" ? "/api/auth/register" : "/api/auth/login",
        { method: "POST", body: JSON.stringify(payload) },
      );
      currentUser = result.user;
      updateAccountDisplay();
      window.location.hash = "orders";
      showStoreMessage(`Welcome, ${currentUser.name}.`);
    } catch (error) {
      authMessage.textContent = error.message;
    }
  });

  logoutButton.addEventListener("click", async () => {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      currentUser = null;
      updateAccountDisplay();
      showStoreMessage("You have signed out.");
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });

  menuGrid.addEventListener("click", (event) => {
    const button = event.target.closest(".add-to-cart");
    if (!button) return;
    const item = menu.find((candidate) => candidate.id === button.dataset.itemId);
    if (!item) return;
    if (item.customizable) openCustomization(item);
    else addToCart(item.id);
  });

  menuCategorySelect.addEventListener("change", () =>
    renderAdminCategories(menuCategorySelect.value),
  );

  menuCategories.addEventListener("click", (event) => {
    const button = event.target.closest(".menu-category-button");
    if (!button || button.dataset.category === selectedCategory) return;
    selectedCategory = button.dataset.category;
    selectedSubcategory = "All items";
    renderMenu();
  });

  menuGrid.addEventListener("click", (event) => {
    const button = event.target.closest(".menu-subcategory-button");
    if (!button || button.dataset.subcategory === selectedSubcategory) return;
    selectedSubcategory = button.dataset.subcategory;
    renderMenu();
  });

  cartItems.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cart-action]");
    if (!button) return;
    const key = button.dataset.cartKey;
    const entry = cart.get(key);
    if (!entry) return;
    if (button.dataset.cartAction === "increase" && entry.quantity < 20) {
      entry.quantity += 1;
    } else if (entry.quantity <= 1) {
      cart.delete(key);
    } else {
      entry.quantity -= 1;
    }
    renderCart();
  });

  cartToggle.addEventListener("click", () => setCartDrawer(true, true));
  document.getElementById("cart-close").addEventListener("click", () => setCartDrawer(false));
  document.getElementById("customization-add").addEventListener("click", () => {
    if (!currentProduct) return;
    const quantity = Number(document.getElementById("customization-quantity").value);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      showStoreMessage("Choose a quantity from 1 to 20.", true);
      return;
    }
    const options = {
      size: document.getElementById("drink-size").value,
      temperature: document.getElementById("drink-temperature").value,
      milk: document.getElementById("drink-milk").value,
      sugar: document.getElementById("drink-sugar").value,
      addons: [...document.querySelectorAll("[data-addon-option]:checked")].map((input) => input.value),
    };
    addToCart(currentProduct.id, options, quantity);
    productDialog.close();
  });
  document.getElementById("product-dialog-close").addEventListener("click", () => productDialog.close());

  checkoutStart.addEventListener("click", async () => {
    checkoutMessage.textContent = "";
    try {
      currentPaymentConfig = await api("/api/storefront-config");
      document.getElementById("gcash-merchant-display").textContent = currentPaymentConfig.merchantName;
      document.getElementById("gcash-number-display").textContent = currentPaymentConfig.merchantNumber || "Not configured";
      const qr = document.getElementById("checkout-gcash-qr");
      qr.src = currentPaymentConfig.qrImageUrl || "";
      qr.hidden = !currentPaymentConfig.qrImageUrl;
      document.getElementById("gcash-config-message").textContent = currentPaymentConfig.configured
        ? "Scan the shop's QR code or pay to the number above, then enter your GCash reference."
        : "The shop has not configured its GCash number and QR code yet. Please check back later.";
      checkoutButton.disabled = !currentPaymentConfig.configured || cart.size === 0;
      renderCart();
      setCartDrawer(false);
      paymentDialog.showModal();
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });
  document.getElementById("payment-close").addEventListener("click", () => paymentDialog.close());
  receiptUpload.addEventListener("change", () => {
    if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
    receiptPreviewUrl = null;
    const file = receiptUpload.files[0];
    if (!file) {
      receiptPreview.hidden = true;
      receiptPreview.removeAttribute("src");
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      receiptUpload.value = "";
      receiptPreview.hidden = true;
      checkoutMessage.textContent = "Choose a JPG, PNG or WebP receipt image no larger than 5 MB.";
      return;
    }
    receiptPreviewUrl = URL.createObjectURL(file);
    receiptPreview.src = receiptPreviewUrl;
    receiptPreview.hidden = false;
    checkoutMessage.textContent = "";
  });

  async function placeCustomerOrder() {
    if (placingOrder) return;
    if (currentUser?.role === "admin") {
      checkoutMessage.textContent = "Sign out of the admin account before placing a customer order.";
      return;
    }
    if (!currentPaymentConfig?.configured) {
      checkoutMessage.textContent = "GCash details are not configured. Please contact the shop.";
      return;
    }

    const receiptFile = receiptUpload.files[0];
    if (receiptFile && receiptFile.size > 5 * 1024 * 1024) {
      checkoutMessage.textContent = "Receipt images must be no larger than 5 MB.";
      return;
    }
    const items = [...cart.values()].map(({ id, quantity, options }) => ({ id, quantity, options }));
    const payload = {
      items,
      paymentMethod: "gcash",
      gcashReference: document.getElementById("gcash-reference").value.trim(),
    };
    if (!currentUser) {
      payload.customerName = document.getElementById("guest-customer-name").value.trim();
      payload.customerEmail = document.getElementById("guest-customer-email").value.trim();
    }
    placingOrder = true;
    checkoutButton.disabled = true;
    checkoutButton.textContent = "Submitting payment...";
    try {
      if (receiptFile) payload.receiptImage = await uploadImageFile(receiptFile, "receipt");
      const result = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      cart.clear();
      checkoutForm.reset();
      if (receiptPreviewUrl) URL.revokeObjectURL(receiptPreviewUrl);
      receiptPreviewUrl = null;
      receiptPreview.hidden = true;
      receiptPreview.removeAttribute("src");
      renderCart();
      paymentDialog.close();
      const statusText = "Pending Verification";
      const receiptItems = result.order.items.map((item) =>
        `<li>${escapeHtml(item.name)} × ${item.quantity} <span>${money(item.unitPrice * item.quantity)}</span></li>`,
      ).join("");
      digitalReceipt.innerHTML = `
        <p><span>Order ID</span><strong>#${escapeHtml(result.order.id)}</strong></p>
        <p><span>GCash reference</span><strong>${escapeHtml(result.order.gcashReference)}</strong></p>
        <p><span>Status</span><strong>${statusText}</strong></p>
        <ul>${receiptItems}</ul>
        <p class="order-total"><span>Total paid</span><strong>${money(result.order.total)}</strong></p>
      `;
      orderConfirmationMessage.textContent = "Thank you. Your order is saved and the shop will verify your GCash payment.";
      orderConfirmationDialog.showModal();
      if (currentUser?.role === "customer") loadCustomerOrders().catch((error) =>
        showStoreMessage(`Order #${result.order.id} was placed, but order history could not be refreshed: ${error.message}`, true));
    } catch (error) {
      checkoutMessage.textContent = error.message;
    } finally {
      placingOrder = false;
      checkoutButton.textContent = "Submit GCash payment";
      checkoutButton.disabled = cart.size === 0 || !currentPaymentConfig?.configured;
    }
  }

  checkoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await placeCustomerOrder();
  });

  menuForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = document.getElementById("menu-item-id").value;
    const selectedPhoto = menuPhotoInput.files[0];
    if (selectedPhoto && selectedPhoto.size > 5 * 1024 * 1024) {
      showStoreMessage("Menu photos must be no larger than 5 MB.", true);
      return;
    }
    let category = menuCategorySelect.value;
    try {
      if (category === "__new__") {
        const categoryResult = await api("/api/admin/categories", {
          method: "POST",
          body: JSON.stringify({ name: newCategoryInput.value.trim() }),
        });
        category = categoryResult.category;
        if (!adminCategories.some((existing) =>
          existing.toLocaleLowerCase() === category.toLocaleLowerCase(),
        )) {
          adminCategories.push(category);
        }
        renderAdminCategories(category);
      }
      const name = document.getElementById("menu-name").value.trim();
      const payload = {
        name,
        category,
        subcategory: document.getElementById("menu-subcategory").value.trim(),
        description: document.getElementById("menu-description").value.trim(),
        photoAltText: document.getElementById("menu-photo-alt-text").value.trim() || name,
        price: Number(document.getElementById("menu-price").value),
        available: document.getElementById("menu-available").checked,
        removePhoto: removeMenuPhoto.checked,
      };
      if (selectedPhoto) {
        payload.photo = await uploadImageFile(selectedPhoto, "menu-photo");
        payload.removePhoto = false;
      }
      await api(id ? `/api/admin/menu/${id}` : "/api/admin/menu", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      resetMenuForm();
      await Promise.all([loadAdminData(), loadMenu()]);
      showStoreMessage(id ? "Menu item updated." : "Menu item added.");
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });

  document.getElementById("cancel-menu-edit").addEventListener("click", () => {
    resetMenuForm();
  });

  function resetMenuForm() {
    menuForm.reset();
    renderAdminCategories();
    existingPhotoUrl = null;
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = null;
    menuPhotoPreview.hidden = true;
    menuPhotoPreview.removeAttribute("src");
    menuPhotoPlaceholder.hidden = false;
    removePhotoLabel.hidden = true;
    document.getElementById("menu-item-id").value = "";
    document.getElementById("menu-available").checked = true;
    document.getElementById("menu-form-title").textContent = "Add a menu item";
    document.getElementById("cancel-menu-edit").hidden = true;
  }

  menuPhotoInput.addEventListener("change", () => {
    const selectedPhoto = menuPhotoInput.files[0];
    if (!selectedPhoto) {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
      photoPreviewUrl = null;
      menuPhotoPreview.src = existingPhotoUrl || "";
      menuPhotoPreview.hidden = !existingPhotoUrl;
      menuPhotoPlaceholder.hidden = Boolean(existingPhotoUrl);
      return;
    }
    if (selectedPhoto.size > 5 * 1024 * 1024) {
      menuPhotoInput.value = "";
      showStoreMessage("Menu photos must be no larger than 5 MB.", true);
      return;
    }
    if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
    photoPreviewUrl = URL.createObjectURL(selectedPhoto);
    menuPhotoPreview.src = photoPreviewUrl;
    menuPhotoPreview.hidden = false;
    menuPhotoPlaceholder.hidden = true;
    removeMenuPhoto.checked = false;
  });

  removeMenuPhoto.addEventListener("change", () => {
    if (removeMenuPhoto.checked) {
      menuPhotoInput.value = "";
      menuPhotoPreview.hidden = true;
      menuPhotoPlaceholder.hidden = false;
    } else if (existingPhotoUrl) {
      menuPhotoPreview.src = existingPhotoUrl;
      menuPhotoPreview.hidden = false;
      menuPhotoPlaceholder.hidden = true;
    }
  });

  adminMenuList.addEventListener("click", async (event) => {
    const editButton = event.target.closest(".edit-menu-item");
    const deleteButton = event.target.closest(".delete-menu-item");
    if (!editButton && !deleteButton) return;
    const items = JSON.parse(adminMenuList.dataset.items || "[]");
    const item = items.find((candidate) =>
      candidate.id === (editButton || deleteButton).dataset.itemId,
    );
    if (!item) return;

    if (editButton) {
      if (photoPreviewUrl) URL.revokeObjectURL(photoPreviewUrl);
      photoPreviewUrl = null;
      menuPhotoInput.value = "";
      document.getElementById("menu-item-id").value = item.id;
      document.getElementById("menu-name").value = item.name;
      renderAdminCategories(item.category || "Other");
      document.getElementById("menu-subcategory").value = item.subcategory || "";
      document.getElementById("menu-description").value = item.description;
      document.getElementById("menu-photo-alt-text").value = item.photoAltText || item.name;
      document.getElementById("menu-price").value = item.price;
      document.getElementById("menu-available").checked = item.available;
      existingPhotoUrl = item.photoUrl;
      menuPhotoPreview.src = item.photoUrl || "";
      menuPhotoPreview.hidden = !item.photoUrl;
      menuPhotoPlaceholder.hidden = Boolean(item.photoUrl);
      removePhotoLabel.hidden = !item.photoUrl;
      removeMenuPhoto.checked = false;
      document.getElementById("menu-form-title").textContent = "Edit menu item";
      document.getElementById("cancel-menu-edit").hidden = false;
      document.getElementById("menu-form-title").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    if (!window.confirm(`Delete "${item.name}" from the menu?`)) return;
    try {
      await api(`/api/admin/menu/${item.id}`, { method: "DELETE" });
      await Promise.all([loadAdminData(), loadMenu()]);
      showStoreMessage("Menu item deleted.");
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });

  adminOrders.addEventListener("click", async (event) => {
    const verifyButton = event.target.closest(".verify-order");
    const rejectButton = event.target.closest(".reject-order");
    const statusButton = event.target.closest(".save-order-status");
    if (!statusButton && !verifyButton && !rejectButton) return;

    const button = statusButton || verifyButton || rejectButton;
    const orderId = button.dataset.orderId;
    const payload = verifyButton
      ? { action: "verify" }
      : rejectButton
        ? { action: "reject" }
        : { status: document.getElementById(`status-${orderId}`).value };
    try {
      await api(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await Promise.all([loadAdminData(), loadCustomerOrders()]);
      showStoreMessage(verifyButton ? "Payment verified. Order moved to Preparing." : rejectButton ? "Payment rejected and order cancelled." : "Order status updated.");
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });

  const scheduleAdminFilter = () => {
    window.clearTimeout(adminOrderFilterTimer);
    adminOrderFilterTimer = window.setTimeout(() => {
      loadAdminOrders().catch((error) => showStoreMessage(error.message, true));
    }, 250);
  };
  document.getElementById("admin-order-search").addEventListener("input", scheduleAdminFilter);
  document.getElementById("admin-order-status-filter").addEventListener("change", scheduleAdminFilter);
  document.getElementById("admin-payment-filter").addEventListener("change", scheduleAdminFilter);

  gcashQrUpload.addEventListener("change", () => {
    if (gcashQrPreviewUrl) URL.revokeObjectURL(gcashQrPreviewUrl);
    gcashQrPreviewUrl = null;
    const file = gcashQrUpload.files[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      gcashQrUpload.value = "";
      showStoreMessage("Choose a JPG, PNG or WebP QR image no larger than 5 MB.", true);
      return;
    }
    gcashQrPreviewUrl = URL.createObjectURL(file);
    gcashQrPreview.src = gcashQrPreviewUrl;
    gcashQrPreview.hidden = false;
  });

  gcashSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = gcashQrUpload.files[0];
    const payload = {
      merchantName: document.getElementById("gcash-merchant-name").value.trim(),
      merchantNumber: document.getElementById("gcash-merchant-number").value.trim(),
    };
    try {
      if (file) payload.qrImage = await uploadImageFile(file, "payment-qr");
      const config = await api("/api/admin/settings/gcash", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      currentPaymentConfig = config;
      gcashQrUpload.value = "";
      if (gcashQrPreviewUrl) URL.revokeObjectURL(gcashQrPreviewUrl);
      gcashQrPreviewUrl = null;
      gcashQrPreview.src = config.qrImageUrl || "";
      gcashQrPreview.hidden = !config.qrImageUrl;
      renderCart();
      const settingsMessage = document.getElementById("gcash-settings-message");
      settingsMessage.classList.remove("error-message");
      settingsMessage.textContent = config.configured
        ? "GCash payment details saved."
        : "Merchant name saved. Add a valid number and QR code to enable checkout.";
    } catch (error) {
      document.getElementById("gcash-settings-message").textContent = error.message;
      document.getElementById("gcash-settings-message").classList.add("error-message");
    }
  });

  Promise.all([
    loadMenu(),
    refreshSession(),
    api("/api/addons").then((result) => { addons = result.addons; }),
  ]).catch((error) => {
    showStoreMessage(`Ordering service unavailable: ${error.message}`, true);
  });

  window.setInterval(() => {
    if (activePage !== "orders") return;
    if (currentUser?.role === "admin" && !adminDashboard.hidden) {
      loadAdminOrders().catch((error) => showStoreMessage(error.message, true));
    } else if (currentUser?.role === "customer" && !customerStorefront.hidden) {
      loadCustomerOrders().catch((error) => showStoreMessage(error.message, true));
    }
    if (lastGuestOrder?.gcashReference) {
      api(`/api/orders/lookup?reference=${encodeURIComponent(lastGuestOrder.gcashReference)}`)
        .then((result) => {
          lastGuestOrder = result.order;
          renderGuestOrder(result.order);
        })
        .catch((error) => showStoreMessage(error.message, true));
    }
  }, 10000);
});
