document.addEventListener("DOMContentLoaded", () => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const authDialog = document.getElementById("auth-dialog");
  const orderConfirmationDialog = document.getElementById("order-confirmation-dialog");
  const orderConfirmationMessage = document.getElementById("order-confirmation-message");
  const authForm = document.getElementById("auth-form");
  const authMessage = document.getElementById("auth-message");
  const accountButton = document.getElementById("account-button");
  const logoutButton = document.getElementById("logout-button");
  const registerToggle = document.getElementById("register-toggle");
  const storeMessage = document.getElementById("store-message");
  const menuCategories = document.getElementById("menu-categories");
  const menuGrid = document.getElementById("menu-grid");
  const cartItems = document.getElementById("cart-items");
  const cartTotal = document.getElementById("cart-total");
  const cartCount = document.getElementById("cart-count");
  const checkoutForm = document.getElementById("checkout-form");
  const checkoutButton = checkoutForm.querySelector(".checkout-button");
  const checkoutHelp = document.getElementById("checkout-help");
  const adminDashboard = document.getElementById("admin-dashboard");
  const orderHistory = document.getElementById("order-history");
  const menuForm = document.getElementById("menu-form");
  const menuCategorySelect = document.getElementById("menu-category");
  const newCategoryLabel = document.getElementById("menu-new-category-label");
  const newCategoryInput = document.getElementById("menu-new-category");
  const adminMenuList = document.getElementById("admin-menu-list");
  const adminOrders = document.getElementById("admin-orders");
  const menuPhotoInput = document.getElementById("menu-photo");
  const menuPhotoPreview = document.getElementById("menu-photo-preview");
  const menuPhotoPlaceholder = document.getElementById("menu-photo-placeholder");
  const removePhotoLabel = document.getElementById("remove-photo-label");
  const removeMenuPhoto = document.getElementById("remove-menu-photo");

  let currentUser = null;
  let menu = [];
  let cart = new Map();
  let checkoutPendingAuthentication = false;
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
    authDialog.showModal();
  }

  function updateAccountDisplay() {
    if (!currentUser) {
      accountButton.textContent = "Sign in / Register";
      accountButton.hidden = false;
      logoutButton.hidden = true;
      adminDashboard.hidden = true;
      orderHistory.hidden = true;
      checkoutButton.textContent = "Sign in to place order";
      checkoutHelp.textContent = "Sign in or create a customer account to send your order. Your cart will be kept.";
      return;
    }

    accountButton.hidden = true;
    logoutButton.hidden = false;
    logoutButton.textContent = `Sign out (${currentUser.name})`;
    adminDashboard.hidden = currentUser.role !== "admin";
    orderHistory.hidden = currentUser.role !== "customer";
    checkoutButton.textContent = currentUser.role === "customer"
      ? "Place GCash order"
      : "Sign in as a customer to order";
    checkoutHelp.textContent = currentUser.role === "customer"
      ? "Your order will be sent to Suarez Farms when you place it."
      : "Customer accounts are required to place an order.";
    if (currentUser.role === "admin") {
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
    const subcategories = [...new Set(items.map((item) => item.subcategory).filter(Boolean))];
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
      : items.filter((item) => item.subcategory === selectedSubcategory);
    const renderItems = (groupItems) => groupItems.map((item) => {
      const photoAltText = item.photoAltText || item.name;
      const itemPhoto = item.photoUrl
        ? `<img class="menu-item-photo" src="${escapeHtml(item.photoUrl)}" alt="${escapeHtml(photoAltText)}" loading="lazy" />`
        : `<span class="menu-item-photo-fallback" role="img" aria-label="${escapeHtml(photoAltText)}"><span>Photo coming soon</span><strong>${escapeHtml(photoAltText)}</strong></span>`;
      return `
        <button class="menu-card add-to-cart" type="button" data-item-id="${escapeHtml(item.id)}" aria-label="Add ${escapeHtml(item.name)} to your order for ${money(item.price)}">
          <span class="menu-item-image-wrap">
            ${itemPhoto}
            <strong class="menu-price-badge">${money(item.price)}</strong>
          </span>
          <span class="menu-card-details">
            <span class="menu-item-name">${escapeHtml(item.name)}</span>
            <span class="menu-item-description">${escapeHtml(item.description || "Freshly prepared at Suarez Farms.")}</span>
            <span class="menu-card-footer">
              <span class="menu-card-action">Add to order <span aria-hidden="true">+</span></span>
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
        <div class="menu-category-items">
          ${renderItems(visibleItems)}
        </div>
      </section>
    `;
  }

  function renderCart() {
    const entries = [...cart.entries()];
    if (!entries.length) {
      cartItems.innerHTML = `<p class="empty-state">Your order is empty. Add something from the menu.</p>`;
    } else {
      cartItems.innerHTML = entries.map(([id, quantity]) => {
        const item = menu.find((candidate) => candidate.id === id);
        if (!item) return "";
        return `
          <div class="cart-row">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              ${item.description ? `<span>${escapeHtml(item.description)}</span>` : ""}
              <span>${money(item.price)} each</span>
            </div>
            <div class="quantity-controls">
              <button type="button" data-cart-action="decrease" data-item-id="${escapeHtml(id)}" aria-label="Remove one ${escapeHtml(item.name)}">−</button>
              <span>${quantity}</span>
              <button type="button" data-cart-action="increase" data-item-id="${escapeHtml(id)}" aria-label="Add one ${escapeHtml(item.name)}">+</button>
            </div>
          </div>
        `;
      }).join("");
    }
    const totalInCents = entries.reduce((sum, [id, quantity]) => {
      const item = menu.find((candidate) => candidate.id === id);
      return sum + (item ? Math.round(item.price * 100) * quantity : 0);
    }, 0);
    const totalItems = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
    cartCount.textContent = `${totalItems} ${totalItems === 1 ? "item" : "items"}`;
    cartTotal.textContent = money(totalInCents / 100);
    checkoutForm.querySelector(".checkout-button").disabled = entries.length === 0;
  }

  function addToCart(id) {
    const item = menu.find((candidate) => candidate.id === id);
    if (!item) return;
    const quantity = cart.get(id) || 0;
    if (quantity >= 20) {
      showStoreMessage("You can order up to 20 of each item.", true);
      return;
    }
    cart.set(id, quantity + 1);
    renderCart();
    showStoreMessage(`${item.name} added to your order.`);
  }

  async function loadMenu() {
    const result = await api("/api/menu");
    menu = result.menu;
    for (const id of cart.keys()) {
      if (!menu.some((item) => item.id === id)) cart.delete(id);
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

  function renderOrder(order, adminView) {
    const lines = order.items.map((item) =>
      `<li>${escapeHtml(item.name)} × ${item.quantity} — ${money(item.unitPrice * item.quantity)}${item.description ? `<span class="order-item-description">${escapeHtml(item.description)}</span>` : ""}</li>`,
    ).join("");
    const reference = order.gcashReference
      ? escapeHtml(order.gcashReference)
      : "Not provided";
    const adminActions = adminView ? `
      <div class="order-actions">
        <label class="field-label" for="status-${escapeHtml(order.id)}">Order status</label>
        <select id="status-${escapeHtml(order.id)}" class="order-status">
          ${["received", "preparing", "ready", "completed", "cancelled"].map((status) =>
            `<option value="${status}" ${order.status === status ? "selected" : ""}>${status[0].toUpperCase()}${status.slice(1)}</option>`,
          ).join("")}
        </select>
        <button class="secondary-btn save-order-status" type="button" data-order-id="${escapeHtml(order.id)}">Update status</button>
        <button class="secondary-btn save-payment-status" type="button" data-order-id="${escapeHtml(order.id)}" data-payment-status="${order.paymentStatus === "paid" ? "pending" : "paid"}">
          Mark GCash ${order.paymentStatus === "paid" ? "pending" : "paid"}
        </button>
      </div>
    ` : "";

    return `
      <article class="order-card">
        <div class="order-card-heading">
          <div><strong>Order #${escapeHtml(order.id)}</strong><span>${escapeHtml(formatDate(order.createdAt))}</span></div>
          <span class="order-badge">${escapeHtml(order.status)}</span>
        </div>
        ${adminView ? `<p class="order-customer">${escapeHtml(order.customerName)} · ${escapeHtml(order.customerEmail)}</p>` : ""}
        <ul>${lines}</ul>
        <p class="order-total"><span>Total</span><strong>${money(order.total)}</strong></p>
        <p class="payment-detail"><strong>GCash:</strong> ${escapeHtml(order.paymentStatus)} · Reference: ${reference}</p>
        ${adminActions}
      </article>
    `;
  }

  async function loadAdminData() {
    const [menuResult, orderResult, categoryResult] = await Promise.all([
      api("/api/admin/menu"),
      api("/api/admin/orders"),
      api("/api/admin/categories"),
    ]);
    adminCategories = categoryResult.categories;
    renderAdminCategories(menuCategorySelect.value);
    renderAdminMenu(menuResult.menu);
    adminOrders.innerHTML = orderResult.orders.length
      ? orderResult.orders.map((order) => renderOrder(order, true)).join("")
      : `<p class="empty-state">No orders received yet.</p>`;
  }

  async function loadAdminOrders() {
    const result = await api("/api/admin/orders");
    adminOrders.innerHTML = result.orders.length
      ? result.orders.map((order) => renderOrder(order, true)).join("")
      : `<p class="empty-state">No orders received yet.</p>`;
  }

  async function loadCustomerOrders() {
    const result = await api("/api/orders/mine");
    const customerOrders = document.getElementById("customer-orders");
    customerOrders.innerHTML = result.orders.length
      ? result.orders.map((order) => renderOrder(order, false)).join("")
      : `<p class="empty-state">You have not placed an order yet.</p>`;
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

  accountButton.addEventListener("click", () => openAuth());
  document.getElementById("auth-close").addEventListener("click", () => authDialog.close());
  document.getElementById("order-confirmation-close").addEventListener("click", () =>
    orderConfirmationDialog.close(),
  );
  authDialog.addEventListener("close", () => {
    if (currentUser?.role !== "customer") checkoutPendingAuthentication = false;
  });
  authDialog.addEventListener("click", (event) => {
    if (event.target === authDialog) authDialog.close();
  });

  registerToggle.addEventListener("click", () => {
    isRegistering = !isRegistering;
    registerToggle.textContent = isRegistering
      ? "Already have an account? Sign in"
      : "New here? Create a customer account";
    setAuthRole("customer");
  });

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
      authDialog.close();
      updateAccountDisplay();
      if (checkoutPendingAuthentication && currentUser.role === "customer") {
        checkoutPendingAuthentication = false;
        await placeCustomerOrder();
        return;
      }
      checkoutPendingAuthentication = false;
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
    if (button) addToCart(button.dataset.itemId);
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
    const id = button.dataset.itemId;
    const quantity = cart.get(id) || 0;
    if (button.dataset.cartAction === "increase" && quantity < 20) {
      cart.set(id, quantity + 1);
    } else if (quantity <= 1) {
      cart.delete(id);
    } else {
      cart.set(id, quantity - 1);
    }
    renderCart();
  });

  async function placeCustomerOrder() {
    if (placingOrder) return;
    if (!currentUser || currentUser.role !== "customer") {
      showStoreMessage("Sign in with a customer account to place your order.", true);
      return;
    }
    if (!checkoutForm.elements.paymentMethod.value) {
      showStoreMessage("Select GCash to place your order.", true);
      return;
    }

    const items = [...cart.entries()].map(([id, quantity]) => ({ id, quantity }));
    placingOrder = true;
    checkoutButton.disabled = true;
    checkoutButton.textContent = "Sending your order...";
    try {
      const result = await api("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          items,
          paymentMethod: checkoutForm.elements.paymentMethod.value,
          gcashReference: document.getElementById("gcash-reference").value.trim(),
        }),
      });
      cart.clear();
      document.getElementById("gcash-reference").value = "";
      renderCart();
      showStoreMessage();
      orderConfirmationMessage.textContent =
        `Order #${result.order.id} has been sent to Suarez Farms. The shop will confirm it shortly.`;
      orderConfirmationDialog.showModal();
      loadCustomerOrders().catch((error) =>
        showStoreMessage(`Order #${result.order.id} was placed, but order history could not be refreshed: ${error.message}`, true),
      );
    } catch (error) {
      showStoreMessage(error.message, true);
      if (error.message.includes("sign in")) {
        checkoutPendingAuthentication = true;
        openAuth("customer", false);
        authMessage.textContent = "Your cart is ready. Sign in to send this order.";
      }
    } finally {
      placingOrder = false;
      checkoutButton.textContent = currentUser?.role === "customer"
        ? "Place GCash order"
        : currentUser ? "Sign in as a customer to order" : "Sign in to place order";
      checkoutButton.disabled = cart.size === 0;
    }
  }

  checkoutForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser || currentUser.role !== "customer") {
      checkoutPendingAuthentication = true;
      openAuth("customer", !currentUser);
      authMessage.textContent = currentUser
        ? "Sign in with a customer account to send your order."
        : "Create a customer account or sign in to send your order. Your cart will be kept.";
      return;
    }
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
        payload.photo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => {
            if (typeof reader.result !== "string") {
              reject(new Error("Could not read the selected photo."));
              return;
            }
            resolve(reader.result);
          }, { once: true });
          reader.addEventListener("error", () => reject(new Error("Could not read the selected photo.")), { once: true });
          reader.readAsDataURL(selectedPhoto);
        });
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
    const statusButton = event.target.closest(".save-order-status");
    const paymentButton = event.target.closest(".save-payment-status");
    if (!statusButton && !paymentButton) return;

    const orderId = (statusButton || paymentButton).dataset.orderId;
    const payload = statusButton
      ? { status: document.getElementById(`status-${orderId}`).value }
      : { paymentStatus: paymentButton.dataset.paymentStatus };
    try {
      await api(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await loadAdminData();
      showStoreMessage("Order updated.");
    } catch (error) {
      showStoreMessage(error.message, true);
    }
  });

  Promise.all([loadMenu(), refreshSession()]).catch((error) => {
    showStoreMessage(`Ordering service unavailable: ${error.message}`, true);
  });

  window.setInterval(() => {
    if (currentUser?.role !== "admin" || adminDashboard.hidden) return;
    loadAdminOrders().catch((error) => showStoreMessage(error.message, true));
  }, 10000);
});
