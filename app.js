const STORAGE_KEY = "laundryku_data_v1";
const SESSION_KEY = "laundryku_session_v1";

const money = n =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(n) || 0);

const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);

const nowDateTime = () => {
  const d = new Date();
  const datePart = today();
  const timePart = d.toTimeString().slice(0, 5);
  return `${datePart} ${timePart}`;
};

const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const seed = {
  customers: [],
  orders: [],
  payments: []
};

/* ---------- Tahapan Tracking Laundry ---------- */

const TRACKING_STAGES = [
  {
    key: "Menunggu",
    title: "Menunggu",
    desc: "Pesanan diterima & masuk antrean"
  },
  {
    key: "Diproses",
    title: "Diproses / Dicuci",
    desc: "Pakaian sedang dalam proses pencucian"
  },
  {
    key: "Sedang Dikeringkan",
    title: "Sedang Dikeringkan",
    desc: "Proses pengeringan pakaian"
  },
  {
    key: "Sedang Disetrika",
    title: "Sedang Disetrika",
    desc: "Disetrika & dirapikan dengan pewangi"
  },
  {
    key: "Siap Diambil",
    title: "Siap Diambil",
    desc: "Dikemas rapi & siap diambil pelanggan"
  },
  {
    key: "Selesai",
    title: "Selesai",
    desc: "Laundry telah selesai & diserahkan"
  }
];

function getStageIndex(status) {
  if (status === "Sedang Dicuci") return 1;
  const idx = TRACKING_STAGES.findIndex(s => s.key === status);
  return idx === -1 ? 0 : idx;
}

function isProcessingStatus(status) {
  return status !== "Menunggu" && status !== "Selesai";
}

function formatOrderCode(id) {
  return `#${id} (BL-${String(id).padStart(4, "0")})`;
}

function estimateCompletionDate(order) {
  if (!order || !order.date) return "-";
  const base = new Date(order.date + "T00:00:00");
  if (Number.isNaN(base.getTime())) return order.date;
  const daysToAdd = order.service === "Laundry Express" ? 1 : 2;
  base.setDate(base.getDate() + daysToAdd);
  const yyyy = base.getFullYear();
  const mm = String(base.getMonth() + 1).padStart(2, "0");
  const dd = String(base.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} (${daysToAdd} hari kerja)`;
}

/* ---------- Data & Migrasi Local Storage ---------- */

function cloneSeed() {
  return {
    customers: seed.customers.map(c => ({ ...c })),
    orders: seed.orders.map(o => ({ ...o })),
    payments: seed.payments.map(p => ({ ...p }))
  };
}

function migrateData(parsed) {
  const customers = Array.isArray(parsed.customers) ? parsed.customers : [];
  const orders = Array.isArray(parsed.orders)
    ? parsed.orders.map(o => ({
        ...o,
        paymentMethod: o.paymentMethod || (o.payment === "Lunas" ? "Tunai / Terverifikasi" : ""),
        paidAt: o.paidAt || (o.payment === "Lunas" ? o.date : "")
      }))
    : [];
  const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
  return { customers, orders, payments };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return cloneSeed();
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      Array.isArray(parsed.customers) &&
      Array.isArray(parsed.orders)
    ) {
      return migrateData(parsed);
    }
    return cloneSeed();
  } catch (e) {
    return cloneSeed();
  }
}

let db = loadData();
let currentSession = loadSession();
let selectedCustomerOrderId = null;
let matchedCustomerOrders = [];

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function renderAll() {
  renderDashboard();
  renderOrders();
  renderCustomers();
  renderReports();
  renderCustomerQuickChips();
  renderCustomerHistory();
  if (selectedCustomerOrderId) {
    const stillExists = db.orders.some(o => o.id === selectedCustomerOrderId);
    if (stillExists) {
      renderCustomerOrderDetail(selectedCustomerOrderId);
    }
  }
}

/* ---------- Autentikasi & Proteksi Role ---------- */

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.role === "admin" || parsed.role === "customer")) {
      return parsed;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function saveSession(session) {
  currentSession = session;
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

function requireAdmin() {
  if (!currentSession || currentSession.role !== "admin") {
    toast("Akses ditolak: Fitur ini hanya untuk Admin.");
    return false;
  }
  return true;
}

function selectLoginRole(role) {
  const roleInput = document.getElementById("login-role");
  if (roleInput) roleInput.value = role;

  document.querySelectorAll(".role-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.role === role);
  });

  const errEl = document.getElementById("login-error");
  if (errEl) errEl.hidden = true;
}

function fillDemoAccount(role) {
  selectLoginRole(role);
  const userEl = document.getElementById("login-username");
  const passEl = document.getElementById("login-password");
  if (!userEl || !passEl) return;

  if (role === "admin") {
    userEl.value = "admin";
    passEl.value = "admin123";
  } else {
    userEl.value = "customer";
    passEl.value = "customer123";
  }
  toast(`Kredensial demo ${role === "admin" ? "Admin" : "Customer"} telah diisi.`);
}

function handleLogin(e) {
  e.preventDefault();
  const role = document.getElementById("login-role")?.value || "admin";
  const username = (document.getElementById("login-username")?.value || "").trim();
  const password = (document.getElementById("login-password")?.value || "").trim();
  const errEl = document.getElementById("login-error");

  const showError = msg => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    toast(msg);
  };

  if (!username || !password) {
    showError("Username dan password wajib diisi.");
    return;
  }

  if (role === "admin") {
    if (username.toLowerCase() === "admin" && password === "admin123") {
      saveSession({
        role: "admin",
        username: "admin",
        displayName: "Admin Laundry"
      });
      if (errEl) errEl.hidden = true;
      applySessionUI();
      showView("dashboard");
      toast("Berhasil masuk sebagai Admin.");
    } else {
      showError("Kredensial Admin tidak valid. Gunakan akun demo: admin / admin123.");
    }
    return;
  }

  // Login Customer: mendukung akun demo (customer / customer123) atau nama pelanggan terdaftar
  const matchedCustomer = db.customers.find(
    c => c.name.toLowerCase() === username.toLowerCase()
  );

  const isDemoCustomer =
    username.toLowerCase() === "customer" && password === "customer123";
  const isNamedCustomer =
    matchedCustomer &&
    (password === "customer123" || password === matchedCustomer.phone);

  if (isDemoCustomer || isNamedCustomer) {
    const displayName = matchedCustomer ? matchedCustomer.name : "Pelanggan Laundry";
    saveSession({
      role: "customer",
      username,
      displayName,
      customerName: matchedCustomer ? matchedCustomer.name : ""
    });
    if (errEl) errEl.hidden = true;
    applySessionUI();
    showView("customer-dashboard");
    if (matchedCustomer) {
      const qInput = document.getElementById("track-query");
      if (qInput) qInput.value = matchedCustomer.name;
      searchCustomerOrders(matchedCustomer.name, matchedCustomer.phone);
    }
    toast(`Selamat datang, ${displayName}!`);
  } else {
    showError("Kredensial Customer tidak valid. Gunakan akun demo: customer / customer123.");
  }
}

function handleLogout() {
  saveSession(null);
  selectedCustomerOrderId = null;
  matchedCustomerOrders = [];
  closeOrderModal();
  closeCustomerModal();
  closeReceiptModal();
  resetCustomerSearch(true);

  const loginForm = document.getElementById("login-form");
  loginForm?.reset();
  selectLoginRole("admin");

  applySessionUI();
  toast("Anda telah keluar dari sesi.");
}

function applySessionUI() {
  const loginScreen = document.getElementById("login-screen");
  const appShell = document.getElementById("app-shell");
  const adminNav = document.getElementById("admin-nav");
  const customerNav = document.getElementById("customer-nav");
  const roleBadge = document.getElementById("active-role-badge");
  const userAvatar = document.getElementById("active-user-avatar");
  const userName = document.getElementById("active-user-name");
  const sidebarSubtitle = document.getElementById("sidebar-subtitle");
  const topEyebrow = document.getElementById("top-eyebrow");
  const sidebarNoteText = document.getElementById("sidebar-note-text");

  if (!currentSession) {
    if (loginScreen) loginScreen.hidden = false;
    if (appShell) appShell.hidden = true;
    return;
  }

  if (loginScreen) loginScreen.hidden = true;
  if (appShell) appShell.hidden = false;

  const isAdmin = currentSession.role === "admin";
  if (adminNav) adminNav.hidden = !isAdmin;
  if (customerNav) customerNav.hidden = isAdmin;

  if (roleBadge) {
    roleBadge.textContent = isAdmin ? "ADMIN" : "CUSTOMER";
    roleBadge.classList.toggle("customer", !isAdmin);
  }
  if (userAvatar) {
    userAvatar.textContent = (currentSession.displayName || "U")
      .trim()
      .charAt(0)
      .toUpperCase();
  }
  if (userName) {
    userName.textContent = currentSession.displayName || (isAdmin ? "Admin Laundry" : "Customer");
  }
  if (sidebarSubtitle) {
    sidebarSubtitle.textContent = isAdmin ? "Management System" : "Customer Portal";
  }
  if (topEyebrow) {
    topEyebrow.textContent = isAdmin
      ? "LAUNDRY MANAGEMENT SYSTEM"
      : "CUSTOMER TRACKING & PAYMENT PORTAL";
  }
  if (sidebarNoteText) {
    sidebarNoteText.textContent = isAdmin
      ? "Perbarui status pesanan secara berkala agar pelanggan mendapatkan informasi yang tepat."
      : "Gunakan nama pelanggan atau ID pesanan untuk memantau status laundry dan melakukan simulasi pembayaran.";
  }
}

/* ---------- Helpers ---------- */

function nextId(list) {
  return list.length ? Math.max(...list.map(x => Number(x.id) || 0)) + 1 : 1;
}

function customerById(id) {
  return db.customers.find(c => c.id === Number(id)) || null;
}

function customerName(id) {
  return customerById(id)?.name || "Pelanggan dihapus";
}

function customerPhone(id) {
  return customerById(id)?.phone || "-";
}

function orderTotal(o) {
  return Math.round(Number(o.weight) * Number(o.price));
}

let toastTimer = null;

function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function statusClass(s) {
  if (s === "Selesai") return "status-selesai";
  if (s === "Siap Diambil") return "status-siap";
  if (s === "Menunggu") return "status-menunggu";
  return "status-diproses";
}

function paymentClass(s) {
  return s === "Lunas" ? "pay-lunas" : "pay-belum";
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function downloadCSV(filename, headers, rows) {
  const escapeCSV = val => {
    const raw = String(val ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const csvContent =
    "\uFEFF" +
    [headers, ...rows].map(row => row.map(escapeCSV).join(",")).join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportOrdersCSV() {
  if (!requireAdmin()) return;
  if (!db.orders.length) {
    toast("Belum ada data pesanan untuk diekspor.");
    return;
  }
  const headers = [
    "ID Pesanan",
    "Tanggal",
    "Pelanggan",
    "Layanan",
    "Berat (kg)",
    "Harga/kg (Rp)",
    "Total (Rp)",
    "Status",
    "Pembayaran",
    "Metode Pembayaran",
    "Catatan"
  ];
  const rows = [...db.orders]
    .sort((a, b) => a.id - b.id)
    .map(o => [
      o.id,
      o.date,
      customerName(o.customerId),
      o.service,
      o.weight,
      o.price,
      orderTotal(o),
      o.status,
      o.payment,
      o.paymentMethod || "-",
      o.note || ""
    ]);
  downloadCSV(`pesanan-laundry-${today()}.csv`, headers, rows);
  toast("Data pesanan berhasil diekspor ke CSV.");
}

function exportCustomersCSV() {
  if (!requireAdmin()) return;
  if (!db.customers.length) {
    toast("Belum ada data pelanggan untuk diekspor.");
    return;
  }
  const headers = [
    "ID Pelanggan",
    "Nama Pelanggan",
    "Nomor Telepon",
    "Alamat",
    "Jumlah Pesanan"
  ];
  const rows = [...db.customers]
    .sort((a, b) => a.id - b.id)
    .map(c => [
      c.id,
      c.name,
      c.phone,
      c.address,
      db.orders.filter(o => o.customerId === c.id).length
    ]);
  downloadCSV(`pelanggan-laundry-${today()}.csv`, headers, rows);
  toast("Data pelanggan berhasil diekspor ke CSV.");
}

/* ---------- Navigasi ---------- */

const ADMIN_VIEWS = ["dashboard", "orders", "customers", "reports"];
const CUSTOMER_VIEWS = ["customer-dashboard", "customer-history"];

function showView(page) {
  if (!currentSession) {
    applySessionUI();
    return;
  }

  // Proteksi navigasi berdasarkan role
  if (currentSession.role === "customer" && ADMIN_VIEWS.includes(page)) {
    toast("Akses ditolak: Halaman khusus Admin.");
    page = "customer-dashboard";
  } else if (currentSession.role === "admin" && CUSTOMER_VIEWS.includes(page)) {
    page = "dashboard";
  }

  document.querySelectorAll(".view").forEach(v => (v.hidden = v.dataset.view !== page));
  document
    .querySelectorAll(".nav-list a")
    .forEach(a => a.classList.toggle("active", a.dataset.page === page));

  const titles = {
    dashboard: "Dashboard",
    orders: "Manajemen Pesanan",
    customers: "Data Pelanggan",
    reports: "Laporan",
    "customer-dashboard": "Lacak & Bayar Pesanan",
    "customer-history": "Riwayat Pembayaran"
  };
  setText("top-title", titles[page] || "Dashboard");
  document.querySelector(".sidebar")?.classList.remove("open");
}

function navSetup() {
  document.querySelectorAll(".nav-list a").forEach(a =>
    a.addEventListener("click", e => {
      e.preventDefault();
      showView(a.dataset.page);
    })
  );

  const sidebar = document.querySelector(".sidebar");
  const menu = document.querySelector(".mobile-menu");
  menu?.addEventListener("click", e => {
    e.stopPropagation();
    sidebar?.classList.toggle("open");
  });

  document.addEventListener("click", e => {
    if (
      sidebar?.classList.contains("open") &&
      !sidebar.contains(e.target) &&
      e.target !== menu
    ) {
      sidebar.classList.remove("open");
    }
  });
}

/* ---------- Admin: Dashboard ---------- */

function renderDashboard() {
  const total = db.orders.length;
  const processing = db.orders.filter(o => isProcessingStatus(o.status)).length;
  const done = db.orders.filter(o => o.status === "Selesai").length;
  const revenue = db.orders
    .filter(o => o.payment === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);

  setText("stat-orders", total);
  setText("stat-process", processing);
  setText("stat-done", done);
  setText("stat-revenue", money(revenue));

  const tbody = document.getElementById("recent-orders");
  if (tbody) {
    const rows = [...db.orders].sort((a, b) => b.id - a.id).slice(0, 5);
    tbody.innerHTML = rows.length
      ? rows
          .map(
            o =>
              `<tr><td><strong>#${o.id}</strong></td><td>${esc(customerName(o.customerId))}</td><td>${esc(o.service)}</td><td><span class="status ${statusClass(o.status)}">${esc(o.status)}</span></td><td><span class="pay ${paymentClass(o.payment)}">${esc(o.payment)}</span></td><td>${money(orderTotal(o))}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="6" class="empty">Belum ada pesanan.</td></tr>`;
  }
}

/* ---------- Admin: Pesanan ---------- */

function renderOrders() {
  const tbody = document.getElementById("orders-body");
  if (!tbody) return;

  const q = (document.getElementById("order-search")?.value || "").toLowerCase();
  const status = document.getElementById("status-filter")?.value || "";

  const rows = [...db.orders]
    .sort((a, b) => b.id - a.id)
    .filter(
      o =>
        (String(o.id).includes(q) ||
          formatOrderCode(o.id).toLowerCase().includes(q) ||
          customerName(o.customerId).toLowerCase().includes(q) ||
          o.service.toLowerCase().includes(q)) &&
        (!status || o.status === status)
    );

  tbody.innerHTML = rows.length
    ? rows
        .map(
          o =>
            `<tr><td><strong>#${o.id}</strong></td><td><div class="customer-cell"><span class="mini-avatar">${esc(customerName(o.customerId).trim().charAt(0).toUpperCase() || "?")}</span>${esc(customerName(o.customerId))}</div></td><td>${esc(o.service)}</td><td>${o.weight} kg</td><td>${money(orderTotal(o))}</td><td><span class="status ${statusClass(o.status)}">${esc(o.status)}</span></td><td><span class="pay ${paymentClass(o.payment)}">${esc(o.payment)}</span></td><td><div class="actions"><button class="icon-btn" title="Edit" onclick="editOrder(${o.id})">✎</button><button class="icon-btn" title="Hapus" onclick="deleteOrder(${o.id})">⌫</button></div></td></tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="empty">Data pesanan tidak ditemukan.</td></tr>`;
}

function openOrderModal(id = null) {
  if (!requireAdmin()) return;

  if (!db.customers.length) {
    toast("Tambahkan pelanggan terlebih dahulu.");
    showView("customers");
    openCustomerModal();
    return;
  }

  const modal = document.getElementById("order-modal");
  const form = document.getElementById("order-form");
  if (!modal || !form) return;

  form.reset();
  document.getElementById("order-id").value = id || "";
  document.getElementById("order-customer").innerHTML = db.customers
    .map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.phone)})</option>`)
    .join("");

  const o = db.orders.find(x => x.id === id);
  document.getElementById("modal-title").textContent = o ? "Edit Pesanan" : "Tambah Pesanan";

  if (o) {
    const fields = {
      customer: o.customerId,
      service: o.service,
      weight: o.weight,
      price: o.price,
      status: o.status,
      payment: o.payment,
      date: o.date,
      note: o.note || ""
    };
    for (const [key, val] of Object.entries(fields)) {
      const el = document.getElementById("order-" + key);
      if (el) el.value = val;
    }
  } else {
    document.getElementById("order-date").value = today();
  }

  modal.classList.add("show");
}

function editOrder(id) {
  if (!requireAdmin()) return;
  openOrderModal(id);
}

function closeOrderModal() {
  document.getElementById("order-modal")?.classList.remove("show");
}

function deleteOrder(id) {
  if (!requireAdmin()) return;
  if (confirm("Yakin ingin menghapus pesanan ini?")) {
    db.orders = db.orders.filter(o => o.id !== id);
    save();
    renderAll();
    toast("Pesanan berhasil dihapus.");
  }
}

function submitOrder(e) {
  e.preventDefault();
  if (!requireAdmin()) return;

  const id = Number(document.getElementById("order-id").value);
  const customerId = Number(document.getElementById("order-customer").value);
  const weight = Number(document.getElementById("order-weight").value);
  const price = Number(document.getElementById("order-price").value);
  const date = document.getElementById("order-date").value;

  if (!customerId) {
    toast("Tambahkan pelanggan terlebih dahulu.");
    return;
  }
  if (!Number.isFinite(weight) || !Number.isFinite(price) || weight <= 0 || price <= 0) {
    toast("Berat dan harga harus lebih dari 0.");
    return;
  }
  if (!date) {
    toast("Tanggal masuk wajib diisi.");
    return;
  }

  const existing = id ? db.orders.find(o => o.id === id) : null;
  const newPayment = document.getElementById("order-payment").value;

  const item = {
    id: id || nextId(db.orders),
    customerId,
    service: document.getElementById("order-service").value,
    weight,
    price,
    status: document.getElementById("order-status").value,
    payment: newPayment,
    date,
    note: document.getElementById("order-note").value.trim(),
    paymentMethod:
      newPayment === "Lunas"
        ? existing?.paymentMethod || "Input Admin"
        : "",
    paidAt:
      newPayment === "Lunas"
        ? existing?.paidAt || nowDateTime()
        : ""
  };

  if (id) {
    db.orders = db.orders.map(o => (o.id === id ? item : o));
    toast("Pesanan berhasil diperbarui.");
  } else {
    db.orders.push(item);
    toast("Pesanan baru berhasil ditambahkan.");
  }

  save();
  closeOrderModal();
  renderAll();
}

/* ---------- Admin: Pelanggan ---------- */

function renderCustomers() {
  const tbody = document.getElementById("customers-body");
  if (!tbody) return;

  const q = (document.getElementById("customer-search")?.value || "").toLowerCase();
  const rows = db.customers.filter(c =>
    (c.name + " " + c.phone + " " + c.address).toLowerCase().includes(q)
  );

  tbody.innerHTML = rows.length
    ? rows
        .map(
          c =>
            `<tr><td><div class="customer-cell"><span class="mini-avatar">${esc(c.name.trim().charAt(0).toUpperCase() || "?")}</span><strong>${esc(c.name)}</strong></div></td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td>${db.orders.filter(o => o.customerId === c.id).length} pesanan</td><td><div class="actions"><button class="icon-btn" onclick="editCustomer(${c.id})" title="Edit">✎</button><button class="icon-btn" onclick="deleteCustomer(${c.id})" title="Hapus">⌫</button></div></td></tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">Pelanggan tidak ditemukan.</td></tr>`;
}

function openCustomerModal(id = null) {
  if (!requireAdmin()) return;

  const modal = document.getElementById("customer-modal");
  const form = document.getElementById("customer-form");
  if (!modal || !form) return;

  form.reset();
  document.getElementById("customer-id").value = id || "";

  const c = db.customers.find(x => x.id === id);
  document.getElementById("customer-modal-title").textContent = c
    ? "Edit Pelanggan"
    : "Tambah Pelanggan";

  if (c) {
    document.getElementById("customer-name").value = c.name;
    document.getElementById("customer-phone").value = c.phone;
    document.getElementById("customer-address").value = c.address;
  }

  modal.classList.add("show");
}

function editCustomer(id) {
  if (!requireAdmin()) return;
  openCustomerModal(id);
}

function closeCustomerModal() {
  document.getElementById("customer-modal")?.classList.remove("show");
}

function submitCustomer(e) {
  e.preventDefault();
  if (!requireAdmin()) return;

  const id = Number(document.getElementById("customer-id").value);
  const name = document.getElementById("customer-name").value.trim();
  const phone = document.getElementById("customer-phone").value.trim();
  const address = document.getElementById("customer-address").value.trim();

  if (name.length < 2 || address.length < 3) {
    toast("Nama (min. 2 huruf) dan alamat (min. 3 karakter) wajib diisi.");
    return;
  }
  if (!/^(\+62|0)[0-9]{8,13}$/.test(phone)) {
    toast("Nomor telepon tidak valid. Gunakan 08xxxxxxxxxx atau +62xxxxxxxxxx.");
    return;
  }

  const c = { id: id || nextId(db.customers), name, phone, address };

  if (id) {
    db.customers = db.customers.map(x => (x.id === id ? c : x));
    toast("Data pelanggan diperbarui.");
  } else {
    db.customers.push(c);
    toast("Pelanggan berhasil ditambahkan.");
  }

  save();
  closeCustomerModal();
  renderAll();
}

function deleteCustomer(id) {
  if (!requireAdmin()) return;

  if (db.orders.some(o => o.customerId === id)) {
    alert("Pelanggan masih memiliki pesanan. Hapus atau pindahkan pesanan terlebih dahulu.");
    return;
  }

  if (confirm("Yakin ingin menghapus pelanggan ini?")) {
    db.customers = db.customers.filter(c => c.id !== id);
    save();
    renderAll();
    toast("Pelanggan berhasil dihapus.");
  }
}

/* ---------- Admin: Laporan ---------- */

function renderReports() {
  const total = db.orders.reduce((s, o) => s + orderTotal(o), 0);
  const paid = db.orders
    .filter(o => o.payment === "Lunas")
    .reduce((s, o) => s + orderTotal(o), 0);
  const unpaid = total - paid;

  setText("report-total", money(total));
  setText("report-paid", money(paid));
  setText("report-unpaid", money(unpaid));
  setText("report-count", db.orders.length);

  const counts = TRACKING_STAGES.map(st => ({
    s: st.key,
    n: db.orders.filter(o =>
      st.key === "Diproses"
        ? o.status === "Diproses" || o.status === "Sedang Dicuci"
        : o.status === st.key
    ).length
  }));
  const max = Math.max(1, ...counts.map(x => x.n));

  const el = document.getElementById("status-bars");
  if (el) {
    el.innerHTML = counts
      .map(
        x =>
          `<div><div class="bar-label"><span>${esc(x.s)}</span><strong>${x.n} pesanan</strong></div><div class="bar-track"><div class="bar-fill" style="width:${(x.n / max) * 100}%"></div></div></div>`
      )
      .join("");
  }

  const tbody = document.getElementById("report-body");
  if (tbody) {
    tbody.innerHTML = db.orders.length
      ? [...db.orders]
          .sort((a, b) => b.id - a.id)
          .map(
            o =>
              `<tr><td>#${o.id}</td><td>${esc(o.date)}</td><td>${esc(customerName(o.customerId))}</td><td>${esc(o.service)}</td><td><span class="status ${statusClass(o.status)}">${esc(o.status)}</span></td><td>${money(orderTotal(o))}</td><td><span class="pay ${paymentClass(o.payment)}">${esc(o.payment)}</span></td></tr>`
          )
          .join("")
      : `<tr><td colspan="7" class="empty">Belum ada transaksi.</td></tr>`;
  }
}

/* ---------- Customer: Search, Tracking & Payment Simulation ---------- */

function renderCustomerQuickChips() {
  const wrap = document.getElementById("customer-quick-chips");
  if (!wrap) return;

  if (!db.orders.length) {
    wrap.innerHTML = `<span class="quick-chip-label">Belum ada pesanan tercatat di Local Storage. Masuk sebagai Admin terlebih dahulu untuk membuat pesanan.</span>`;
    return;
  }

  const sampleOrders = [...db.orders].sort((a, b) => b.id - a.id).slice(0, 5);
  wrap.innerHTML =
    `<span class="quick-chip-label">Pintasan Uji Pesanan:</span>` +
    sampleOrders
      .map(o => {
        const cName = customerName(o.customerId);
        return `<button type="button" class="quick-chip" onclick="quickSelectOrder(${o.id})">#${o.id} · ${esc(cName)}</button>`;
      })
      .join("");
}

function quickSelectOrder(orderId) {
  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o) return;
  const c = customerById(o.customerId);
  const qEl = document.getElementById("track-query");
  const pEl = document.getElementById("track-phone");
  if (qEl) qEl.value = c ? c.name : `#${o.id}`;
  if (pEl) pEl.value = c ? c.phone : "";
  searchCustomerOrders(c ? c.name : `#${o.id}`, c ? c.phone : "", o.id);
}

function handleCustomerTrackSubmit(e) {
  e.preventDefault();
  const query = (document.getElementById("track-query")?.value || "").trim();
  const phone = (document.getElementById("track-phone")?.value || "").trim();

  if (!query) {
    toast("Masukkan nama pelanggan atau ID pesanan untuk mencari.");
    return;
  }
  searchCustomerOrders(query, phone);
}

function searchCustomerOrders(query, phoneInput = "", preferredOrderId = null) {
  const feedbackEl = document.getElementById("customer-search-feedback");
  const matchesPanel = document.getElementById("customer-matches-panel");
  const matchesList = document.getElementById("customer-matches-list");
  const orderView = document.getElementById("customer-order-view");

  const qRaw = query.trim().toLowerCase();
  const qIdClean = qRaw.replace(/^(#|bl-0*)/i, "");
  const pClean = phoneInput.replace(/\s|-/g, "");

  // Cari pesanan berdasarkan ID pesanan, kode BL-xxxx, atau nama pelanggan
  const candidateOrders = [...db.orders]
    .sort((a, b) => b.id - a.id)
    .filter(o => {
      const c = customerById(o.customerId);
      const cName = (c?.name || "").toLowerCase();
      const idMatch =
        String(o.id) === qIdClean ||
        formatOrderCode(o.id).toLowerCase().includes(qRaw);
      const nameMatch = cName.includes(qRaw);
      return idMatch || nameMatch;
    });

  if (!candidateOrders.length) {
    selectedCustomerOrderId = null;
    matchedCustomerOrders = [];
    if (matchesPanel) matchesPanel.hidden = true;
    if (orderView) orderView.hidden = true;
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.className = "notice demo-warning";
      feedbackEl.innerHTML = `Pesanan dengan kata kunci <strong>"${esc(query)}"</strong> tidak ditemukan. Pastikan nama pelanggan atau kode pesanan sudah benar.`;
    }
    toast("Pesanan tidak ditemukan.");
    return;
  }

  // Verifikasi nomor telepon jika diisi oleh pelanggan
  const verifiedOrders = pClean
    ? candidateOrders.filter(o => {
        const cPhone = (customerById(o.customerId)?.phone || "").replace(/\s|-/g, "");
        return cPhone.endsWith(pClean) || cPhone === pClean || cPhone.includes(pClean);
      })
    : candidateOrders;

  if (!verifiedOrders.length) {
    selectedCustomerOrderId = null;
    matchedCustomerOrders = [];
    if (matchesPanel) matchesPanel.hidden = true;
    if (orderView) orderView.hidden = true;
    if (feedbackEl) {
      feedbackEl.hidden = false;
      feedbackEl.className = "notice demo-warning";
      feedbackEl.innerHTML = `Pesanan ditemukan, namun <strong>Nomor Telepon Verifikasi</strong> tidak cocok dengan data pelanggan.`;
    }
    toast("Verifikasi nomor telepon tidak cocok.");
    return;
  }

  matchedCustomerOrders = verifiedOrders;
  if (feedbackEl) feedbackEl.hidden = true;

  const targetId =
    preferredOrderId && verifiedOrders.some(o => o.id === preferredOrderId)
      ? preferredOrderId
      : verifiedOrders[0].id;

  selectedCustomerOrderId = targetId;

  if (verifiedOrders.length > 1 && matchesPanel && matchesList) {
    matchesPanel.hidden = false;
    renderCustomerMatchesList();
  } else if (matchesPanel) {
    matchesPanel.hidden = true;
  }

  renderCustomerOrderDetail(targetId);
}

function renderCustomerMatchesList() {
  const matchesList = document.getElementById("customer-matches-list");
  if (!matchesList) return;

  matchesList.innerHTML = matchedCustomerOrders
    .map(o => {
      const active = o.id === selectedCustomerOrderId ? "active" : "";
      return `<button type="button" class="match-card ${active}" onclick="selectMatchedOrder(${o.id})">
        <div class="match-card-top">
          <strong>${esc(formatOrderCode(o.id))}</strong>
          <span class="status ${statusClass(o.status)}">${esc(o.status)}</span>
        </div>
        <div><strong>${esc(customerName(o.customerId))}</strong></div>
        <small>${esc(o.service)} · ${o.weight} kg · ${money(orderTotal(o))}</small>
        <small>Tanggal: ${esc(o.date)} · Pembayaran: <strong>${esc(o.payment)}</strong></small>
      </button>`;
    })
    .join("");
}

function selectMatchedOrder(orderId) {
  selectedCustomerOrderId = Number(orderId);
  renderCustomerMatchesList();
  renderCustomerOrderDetail(selectedCustomerOrderId);
}

function renderCustomerOrderDetail(orderId) {
  const orderView = document.getElementById("customer-order-view");
  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o || !orderView) return;

  orderView.hidden = false;
  const cName = customerName(o.customerId);
  const cPhone = customerPhone(o.customerId);
  const total = orderTotal(o);
  const code = formatOrderCode(o.id);

  // 1. Update Tracking Timeline
  const stageIdx = getStageIndex(o.status);
  const progressPercent = Math.round(((stageIdx + 1) / TRACKING_STAGES.length) * 100);
  const fillEl = document.getElementById("cust-tracking-fill");
  if (fillEl) fillEl.style.width = `${progressPercent}%`;

  const statusBadge = document.getElementById("cust-current-status-badge");
  if (statusBadge) {
    statusBadge.className = `status ${statusClass(o.status)}`;
    statusBadge.textContent = `${o.status} (${progressPercent}%)`;
  }

  const stepsWrap = document.getElementById("cust-tracking-steps");
  if (stepsWrap) {
    stepsWrap.innerHTML = TRACKING_STAGES.map((st, idx) => {
      const stateClass =
        idx < stageIdx || o.status === "Selesai"
          ? "done"
          : idx === stageIdx
            ? "current"
            : "";
      const iconText =
        idx < stageIdx || o.status === "Selesai" ? "✓" : String(idx + 1);
      return `<div class="track-step ${stateClass}">
        <div class="track-step-num">${iconText}</div>
        <strong>${esc(st.title)}</strong>
        <small>${esc(st.desc)}</small>
      </div>`;
    }).join("");
  }

  // 2. Update Order Detail Card
  setText("cust-detail-code", `#${o.id}`);
  setText("cust-detail-name", cName);
  setText("cust-detail-id", code);
  setText("cust-detail-phone", cPhone);
  setText("cust-detail-date", o.date);
  setText("cust-detail-eta", estimateCompletionDate(o));
  setText("cust-detail-service", o.service);
  setText("cust-detail-weight", `${o.weight} kg`);
  setText("cust-detail-price", `${money(o.price)} / kg`);
  setText("cust-detail-note", o.note || "-");
  setText("cust-detail-total", money(total));

  const detailPayBadge = document.getElementById("cust-detail-pay-badge");
  if (detailPayBadge) {
    detailPayBadge.className = `pay ${paymentClass(o.payment)}`;
    detailPayBadge.textContent = o.payment;
  }

  // 3. Update Payment Simulation Panel
  setText("pay-order-code", code);
  setText("pay-customer-name", cName);
  setText("pay-total-amount", money(total));

  const payStatusBadge = document.getElementById("pay-status-badge");
  if (payStatusBadge) {
    payStatusBadge.className = `pay ${paymentClass(o.payment)}`;
    payStatusBadge.textContent = o.payment;
  }

  const actionArea = document.getElementById("payment-action-area");
  const paidArea = document.getElementById("payment-paid-area");
  const isPaid = o.payment === "Lunas";

  if (actionArea) actionArea.hidden = isPaid;
  if (paidArea) {
    paidArea.hidden = !isPaid;
    const methodText = o.paymentMethod || "Tunai / Simulasi";
    const paidAtText = o.paidAt || o.date;
    setText(
      "paid-info-text",
      `Metode: ${methodText} · Waktu: ${paidAtText}`
    );
  }
}

function resetCustomerSearch(silent = false) {
  const form = document.getElementById("customer-track-form");
  form?.reset();
  selectedCustomerOrderId = null;
  matchedCustomerOrders = [];

  const feedbackEl = document.getElementById("customer-search-feedback");
  const matchesPanel = document.getElementById("customer-matches-panel");
  const orderView = document.getElementById("customer-order-view");

  if (feedbackEl) feedbackEl.hidden = true;
  if (matchesPanel) matchesPanel.hidden = true;
  if (orderView) orderView.hidden = true;
  if (!silent) toast("Pencarian pesanan direset.");
}

function updatePaymentMethodPreview() {
  const selected =
    document.querySelector('input[name="sim-pay-method"]:checked')?.value ||
    "QRIS (Simulasi)";
  const isQRIS = selected.includes("QRIS");

  document
    .getElementById("label-method-qris")
    ?.classList.toggle("active", isQRIS);
  document
    .getElementById("label-method-bank")
    ?.classList.toggle("active", !isQRIS);

  const qrisPreview = document.getElementById("pay-preview-qris");
  const bankPreview = document.getElementById("pay-preview-bank");
  if (qrisPreview) qrisPreview.hidden = !isQRIS;
  if (bankPreview) bankPreview.hidden = isQRIS;
}

function processSimulatedPayment() {
  if (!selectedCustomerOrderId) {
    toast("Pilih pesanan terlebih dahulu.");
    return;
  }

  const order = db.orders.find(o => o.id === selectedCustomerOrderId);
  if (!order) return;

  if (order.payment === "Lunas") {
    toast("Pesanan ini sudah berstatus Lunas.");
    openReceiptModal(order.id);
    return;
  }

  const method =
    document.querySelector('input[name="sim-pay-method"]:checked')?.value ||
    "QRIS (Simulasi)";
  const amount = orderTotal(order);
  const timestamp = nowDateTime();
  const paymentId = nextId(db.payments);
  const refCode = `DEMO-${today().replace(/-/g, "")}-${String(paymentId).padStart(3, "0")}`;

  // Perbarui status pesanan menjadi Lunas
  order.payment = "Lunas";
  order.paymentMethod = method;
  order.paidAt = timestamp;
  order.paymentRef = refCode;

  // Simpan ke riwayat pembayaran
  db.payments.push({
    id: paymentId,
    refCode,
    orderId: order.id,
    customerId: order.customerId,
    customerName: customerName(order.customerId),
    method,
    amount,
    date: timestamp
  });

  save();
  renderAll();
  if (matchedCustomerOrders.length > 1) {
    renderCustomerMatchesList();
  }
  toast("Simulasi pembayaran DEMO berhasil! Status pesanan kini Lunas.");
  openReceiptModal(order.id);
}

function openReceiptModal(orderId = selectedCustomerOrderId) {
  const o = db.orders.find(x => x.id === Number(orderId));
  if (!o) return;

  const paymentRecord = [...db.payments]
    .reverse()
    .find(p => p.orderId === o.id);

  const refCode =
    paymentRecord?.refCode ||
    o.paymentRef ||
    `DEMO-${String(o.id).padStart(4, "0")}`;
  const method =
    paymentRecord?.method || o.paymentMethod || "Simulasi / Terverifikasi";
  const paidDate = paymentRecord?.date || o.paidAt || o.date;

  setText("rcp-ref", refCode);
  setText("rcp-order-id", formatOrderCode(o.id));
  setText("rcp-customer", customerName(o.customerId));
  setText("rcp-service", `${o.service} (${o.weight} kg × ${money(o.price)})`);
  setText("rcp-method", method);
  setText("rcp-date", paidDate);
  setText("rcp-total", money(orderTotal(o)));

  document.getElementById("receipt-modal")?.classList.add("show");
}

function closeReceiptModal() {
  document.getElementById("receipt-modal")?.classList.remove("show");
}

function renderCustomerHistory() {
  const tbody = document.getElementById("customer-history-body");
  if (!tbody) return;

  const q = (document.getElementById("cust-history-search")?.value || "").toLowerCase();

  // Gabungkan data dari db.payments dan pesanan yang sudah Lunas
  const historyItems = [...db.payments].sort((a, b) => b.id - a.id).filter(p => {
    const code = formatOrderCode(p.orderId).toLowerCase();
    return (
      p.refCode.toLowerCase().includes(q) ||
      code.includes(q) ||
      (p.customerName || "").toLowerCase().includes(q) ||
      (p.method || "").toLowerCase().includes(q)
    );
  });

  tbody.innerHTML = historyItems.length
    ? historyItems
        .map(
          p =>
            `<tr>
              <td><code>${esc(p.refCode)}</code></td>
              <td><strong>#${p.orderId}</strong></td>
              <td>${esc(p.customerName)}</td>
              <td>${esc(p.method)}</td>
              <td>${esc(p.date)}</td>
              <td><strong>${money(p.amount)}</strong></td>
              <td><span class="pay pay-lunas">Lunas (DEMO)</span></td>
              <td><button type="button" class="btn btn-light btn-sm" onclick="openReceiptModal(${p.orderId})">⎙ Bukti</button></td>
            </tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="empty">Belum ada riwayat pembayaran simulasi.</td></tr>`;
}

/* ---------- Init ---------- */

document.addEventListener("DOMContentLoaded", () => {
  navSetup();
  renderAll();

  document.getElementById("login-form")?.addEventListener("submit", handleLogin);
  document.getElementById("order-search")?.addEventListener("input", renderOrders);
  document.getElementById("status-filter")?.addEventListener("change", renderOrders);
  document.getElementById("order-form")?.addEventListener("submit", submitOrder);
  document.getElementById("customer-search")?.addEventListener("input", renderCustomers);
  document.getElementById("customer-form")?.addEventListener("submit", submitCustomer);
  document
    .getElementById("customer-track-form")
    ?.addEventListener("submit", handleCustomerTrackSubmit);
  document
    .getElementById("cust-history-search")
    ?.addEventListener("input", renderCustomerHistory);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeOrderModal();
      closeCustomerModal();
      closeReceiptModal();
      document.querySelector(".sidebar")?.classList.remove("open");
    }
  });

  [
    ["order-modal", closeOrderModal],
    ["customer-modal", closeCustomerModal],
    ["receipt-modal", closeReceiptModal]
  ].forEach(([id, fn]) =>
    document.getElementById(id)?.addEventListener("click", e => {
      if (e.target.id === id) fn();
    })
  );

  // Sinkronisasi otomatis antar-tab browser apabila Local Storage berubah
  window.addEventListener("storage", e => {
    if (e.key === STORAGE_KEY) {
      db = loadData();
      renderAll();
    } else if (e.key === SESSION_KEY) {
      currentSession = loadSession();
      applySessionUI();
    }
  });

  applySessionUI();
  if (currentSession) {
    showView(
      currentSession.role === "customer" ? "customer-dashboard" : "dashboard"
    );
  }
});
